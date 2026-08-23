import { TaskRouter } from "@opencode-ai/core/task-router"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { Effect, Schema } from "effect"
import path from "path"
import * as Tool from "./tool"
import DESCRIPTION from "./task-state.txt"
import { costMetadata } from "./task-usage"

const NonNegativeIntParameter = Schema.Union([
  TaskRouter.Input.fields.number_of_files,
  Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
])

const StartParameters = Schema.Struct({
  action: Schema.Literal("start"),
  task_id: Schema.optional(TaskRouter.TaskID).annotate({
    description: "Stable identifier such as AUTH-014; defaults to the current OpenCode session ID",
  }),
  ...TaskRouter.Input.fields,
  number_of_files: NonNegativeIntParameter.annotate({
    description: "Estimated number of files affected; numeric strings are accepted for provider compatibility",
  }),
  previous_failures: NonNegativeIntParameter.annotate({
    description: "Prior failed attempts; numeric strings are accepted for provider compatibility",
  }),
})

const ReadParameters = Schema.Struct({
  action: Schema.Literal("read"),
  task_id: TaskRouter.TaskID,
})

const RecordValidationParameters = Schema.Struct({
  action: Schema.Literal("record_validation"),
  task_id: TaskRouter.TaskID,
  role: TaskRouter.Role,
  checks: Schema.Array(TaskRouter.ValidationCheck).annotate({
    description: "Actual test, lint, typecheck, or build commands and their outcomes",
  }),
  summary: Schema.optional(Schema.String).annotate({ description: "Short root-cause or validation summary" }),
})

const RecordUsageParameters = Schema.Struct({
  action: Schema.Literal("record_usage"),
  task_id: TaskRouter.TaskID,
  session_id: SessionID.annotate({ description: "Completed delegated task session ID returned by the task tool" }),
  role: TaskRouter.Role,
})

const PrepareReviewParameters = Schema.Struct({
  action: Schema.Literal("prepare_review"),
  task_id: TaskRouter.TaskID,
})

const RecordReviewParameters = Schema.Struct({
  action: Schema.Literal("record_review"),
  task_id: TaskRouter.TaskID,
  ...TaskRouter.RecordReview.fields,
})

export const Parameters = Schema.Union([
  StartParameters,
  ReadParameters,
  RecordValidationParameters,
  RecordUsageParameters,
  PrepareReviewParameters,
  RecordReviewParameters,
])

type Metadata = {
  filepath: string
  state: TaskRouter.State
  summary: TaskRouter.CostSummary
}

export const TaskStateTool = Tool.define<
  typeof Parameters,
  Metadata,
  FSUtil.Service | Config.Service | Session.Service | Agent.Service | Provider.Service
>(
  "task_state",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const config = yield* Config.Service
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const providers = yield* Provider.Service

    const load = Effect.fn("TaskStateTool.load")(function* (filepath: string) {
      const raw = yield* fs.readJson(filepath).pipe(Effect.orDie)
      const state = yield* Schema.decodeUnknownEffect(TaskRouter.State)(raw).pipe(Effect.orDie)
      return TaskRouter.assertConsistent(state)
    })

    const persist = Effect.fn("TaskStateTool.persist")(function* (filepath: string, state: TaskRouter.State) {
      yield* fs.writeWithDirs(filepath, JSON.stringify(state, null, 2)).pipe(Effect.orDie)
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const taskID = params.action === "start" ? (params.task_id ?? String(ctx.sessionID)) : params.task_id
          const filepath = statePath(instance.worktree, taskID)

          if (params.action === "read") {
            const state = yield* load(filepath)
            return result(filepath, state)
          }

          if (params.action === "start") {
            if (yield* fs.existsSafe(filepath)) throw new Error(`Task state already exists: ${taskID}`)
            const cfg = yield* config.get()
            const state = TaskRouter.start(
              taskID,
              {
                task_type: params.task_type,
                complexity: params.complexity,
                risk: params.risk,
                scope: params.scope,
                context_size: params.context_size,
                number_of_files: params.number_of_files,
                test_availability: params.test_availability,
                previous_failures: params.previous_failures,
                requirements_clarity: params.requirements_clarity,
              },
              TaskRouter.resolvePolicy(cfg.cost_aware),
            )
            yield* ctx.ask({
              permission: "edit",
              patterns: [path.relative(instance.worktree, filepath)],
              always: ["*"],
              metadata: { filepath },
            })
            yield* persist(filepath, state)
            return result(filepath, state)
          }

          const current = yield* load(filepath)
          if (params.action === "record_usage") {
            const session = yield* sessions.get(params.session_id).pipe(Effect.orDie)
            const tokens = session.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
            const usageTokens = {
              input_tokens: tokens.input,
              output_tokens: tokens.output,
              reasoning_tokens: tokens.reasoning,
              cache_read_tokens: tokens.cache.read,
              cache_write_tokens: tokens.cache.write,
            }
            const cfg = yield* config.get()
            const provider = session.model ? String(session.model.providerID) : "unknown"
            const model = session.model ? String(session.model.id) : "unknown"
            const modelRef = `${provider}/${model}`
            const pricing = cfg.cost_aware?.pricing_usd_per_million?.[modelRef]
            const loadCatalog = session.model
              ? providers.getModel(session.model.providerID, session.model.id).pipe(
                  Effect.catchIf(
                    (error): error is Provider.ModelNotFoundError => Provider.ModelNotFoundError.isInstance(error),
                    () => Effect.succeed(undefined),
                  ),
                )
              : Effect.succeed(undefined)
            const catalog = yield* loadCatalog
            const cost = costMetadata({
              tokens: usageTokens,
              sessionCost: session.cost,
              billingMode: cfg.cost_aware?.billing_mode,
              configured: pricing,
              provider: catalog?.cost,
            })
            const state = TaskRouter.recordUsage(current, {
              session_id: String(params.session_id),
              role: params.role,
              provider,
              model,
              ...usageTokens,
              ...cost,
            })
            yield* ctx.ask({
              permission: "edit",
              patterns: [path.relative(instance.worktree, filepath)],
              always: ["*"],
              metadata: { filepath },
            })
            yield* persist(filepath, state)
            return result(filepath, state)
          }

          if (params.action === "prepare_review") {
            const cfg = yield* config.get()
            const reviewer = yield* agents.get("reviewer")
            const primary = reviewer?.model ? `${reviewer.model.providerID}/${reviewer.model.modelID}` : undefined
            const candidates = TaskRouter.resolveModelPool(cfg.cost_aware, "reviewer", primary).filter(
              (item) =>
                !current.model_failures.some(
                  (failure) => failure.role === "reviewer" && `${failure.provider}/${failure.model}` === item,
                ),
            )
            const attempt = current.attempts.at(-1)
            const author = attempt ? current.usage.findLast((item) => item.role === attempt.role) : undefined
            const candidate =
              candidates.find((item) => item !== `${author?.provider}/${author?.model}`) ?? candidates[0]
            const model = candidate ? Provider.parseModel(candidate) : undefined
            const state = TaskRouter.prepareReview(
              current,
              model
                ? {
                    provider: String(model.providerID),
                    model: String(model.modelID),
                  }
                : undefined,
            )
            yield* ctx.ask({
              permission: "edit",
              patterns: [path.relative(instance.worktree, filepath)],
              always: ["*"],
              metadata: { filepath },
            })
            yield* persist(filepath, state)
            return result(filepath, state)
          }

          if (params.action === "record_review") {
            const state = TaskRouter.recordReview(current, {
              reviewer_session_id: params.reviewer_session_id,
              decision: params.decision,
              ...(params.summary ? { summary: params.summary } : {}),
            })
            yield* ctx.ask({
              permission: "edit",
              patterns: [path.relative(instance.worktree, filepath)],
              always: ["*"],
              metadata: { filepath },
            })
            yield* persist(filepath, state)
            return result(filepath, state)
          }

          const state = TaskRouter.recordValidation(current, {
            role: params.role,
            checks: params.checks,
            ...(params.summary ? { summary: params.summary } : {}),
          })
          yield* ctx.ask({
            permission: "edit",
            patterns: [path.relative(instance.worktree, filepath)],
            always: ["*"],
            metadata: { filepath },
          })
          yield* persist(filepath, state)
          return result(filepath, state)
        }).pipe(Effect.orDie),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)

function statePath(worktree: string, taskID: string) {
  return path.join(worktree, ".opencode", "task-state", `${taskID}.json`)
}

function result(filepath: string, state: TaskRouter.State): Tool.ExecuteResult<Metadata> {
  const summary = TaskRouter.summarize(state)
  return {
    title: `Task ${state.task_id}: ${state.status}`,
    metadata: { filepath, state, summary },
    output: JSON.stringify({
      ...summary,
      assigned_role: state.assigned_role,
      transition_reason: state.transition_reason,
      review_required: state.initial_decision.review_required,
    }),
  }
}
