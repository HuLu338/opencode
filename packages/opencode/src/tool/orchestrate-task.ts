import { TaskRouter } from "@opencode-ai/core/task-router"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { Agent } from "@/agent/agent"
import { Effect, Schema } from "effect"
import path from "path"
import { Tool } from "./tool"
import { TaskTool } from "./task"
import { ShellTool } from "./shell"
import DESCRIPTION from "./orchestrate-task.txt"

const NonNegativeIntParameter = Schema.Union([
  TaskRouter.Input.fields.number_of_files,
  Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
])

const PositiveIntParameter = Schema.Union([
  Schema.Int.check(Schema.isGreaterThan(0)),
  Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThan(0)),
])

const ValidationCommand = Schema.Struct({
  name: Schema.String.annotate({ description: "What the command validates" }),
  command: Schema.String.annotate({ description: "Exact deterministic command to run" }),
  workdir: Schema.optional(Schema.String).annotate({ description: "Working directory, relative to the repository" }),
  timeout: Schema.optional(PositiveIntParameter).annotate({ description: "Optional timeout in milliseconds" }),
})

export const Parameters = Schema.Struct({
  task_id: TaskRouter.TaskID.annotate({ description: "Stable identifier such as AUTH-014" }),
  request: Schema.String.annotate({ description: "The original user request without orchestration instructions" }),
  ...TaskRouter.Input.fields,
  number_of_files: NonNegativeIntParameter.annotate({
    description: "Estimated affected file count; numeric strings are accepted for provider compatibility",
  }),
  previous_failures: NonNegativeIntParameter.annotate({
    description: "Prior failed attempts; numeric strings are accepted for provider compatibility",
  }),
  allowed_files: Schema.Array(Schema.String).annotate({
    description: "Exact repository-relative files the implementation may modify",
  }),
  validation_commands: Schema.Array(ValidationCommand).annotate({
    description: "Deterministic commands run by the controller after every implementation attempt",
  }),
  repository_evidence: Schema.optional(Schema.String).annotate({
    description: "Concise repository facts the delegated roles need",
  }),
  resume: Schema.optional(Schema.Boolean).annotate({
    description: "Continue an existing state file after an interrupted call",
  }),
})

type Metadata = {
  filepath: string
  state: TaskRouter.State
  summary: TaskRouter.CostSummary
  author_outputs: string[]
  reviewer_outputs: string[]
}

export const OrchestrateTaskTool = Tool.define(
  "orchestrate_task",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const config = yield* Config.Service
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const task = yield* TaskTool
    const shell = yield* ShellTool

    const load = Effect.fn("OrchestrateTaskTool.load")(function* (filepath: string) {
      const raw = yield* fs.readJson(filepath).pipe(Effect.orDie)
      const state = yield* Schema.decodeUnknownEffect(TaskRouter.State)(raw).pipe(Effect.orDie)
      return TaskRouter.assertConsistent(state)
    })

    const persist = Effect.fn("OrchestrateTaskTool.persist")(function* (filepath: string, state: TaskRouter.State) {
      yield* fs.writeWithDirs(filepath, JSON.stringify(state, null, 2)).pipe(Effect.orDie)
      return state
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const taskDef = yield* Tool.init(task)
          const shellDef = yield* Tool.init(shell)
          const filepath = path.join(instance.worktree, ".opencode", "task-state", `${params.task_id}.json`)
          const exists = yield* fs.existsSafe(filepath)
          if (exists && !params.resume) throw new Error(`Task state already exists: ${params.task_id}`)
          if (!exists && params.resume) throw new Error(`Task state does not exist: ${params.task_id}`)
          yield* ctx.ask({
            permission: "orchestrate_task",
            patterns: [params.task_id],
            always: [params.task_id],
            metadata: { task_id: params.task_id, resume: params.resume === true },
          })
          yield* ctx.ask({
            permission: "edit",
            patterns: [path.relative(instance.worktree, filepath)],
            always: ["*"],
            metadata: { filepath },
          })

          const initial = exists
            ? yield* load(filepath)
            : yield* persist(
                filepath,
                TaskRouter.start(
                  params.task_id,
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
                  TaskRouter.resolvePolicy((yield* config.get()).cost_aware),
                ),
              )

          const authorOutputs: string[] = []
          const reviewerOutputs: string[] = []
          const nestedContext = {
            ...ctx,
            extra: { ...ctx.extra, bypassAgentCheck: true },
          }

          const recordUsage = Effect.fn("OrchestrateTaskTool.recordUsage")(function* (
            state: TaskRouter.State,
            sessionID: string,
            role: TaskRouter.Role,
          ) {
            const session = yield* sessions.get(SessionID.make(sessionID)).pipe(Effect.orDie)
            const tokens = session.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
            return yield* persist(
              filepath,
              TaskRouter.recordUsage(state, {
                session_id: sessionID,
                role,
                provider: session.model ? String(session.model.providerID) : "unknown",
                model: session.model ? String(session.model.id) : "unknown",
                input_tokens: tokens.input,
                output_tokens: tokens.output,
                reasoning_tokens: tokens.reasoning,
                cache_read_tokens: tokens.cache.read,
                cache_write_tokens: tokens.cache.write,
                estimated_cost_usd: session.cost ?? 0,
              }),
            )
          })

          const delegate = Effect.fn("OrchestrateTaskTool.delegate")(function* (
            role: TaskRouter.Role,
            prompt: string,
            sessionID?: string,
          ) {
            const result = yield* taskDef.execute(
              {
                description: `${params.task_id} ${role}`,
                prompt,
                subagent_type: role,
                ...(sessionID ? { task_id: sessionID } : {}),
                background: false,
              },
              nestedContext,
            )
            return {
              sessionID: String(result.metadata.sessionId),
              output: result.output,
            }
          })

          const validate = Effect.fn("OrchestrateTaskTool.validate")(function* () {
            return yield* Effect.forEach(
              params.validation_commands,
              Effect.fnUntraced(function* (command) {
                const result = yield* shellDef.execute(
                  {
                    command: command.command,
                    ...(command.workdir ? { workdir: command.workdir } : {}),
                    ...(command.timeout ? { timeout: command.timeout } : {}),
                  },
                  ctx,
                )
                return {
                  name: command.name,
                  command: command.command,
                  status: result.metadata.exit === 0 ? ("passed" as const) : ("failed" as const),
                  summary: concise(result.output),
                }
              }),
              { concurrency: 1 },
            )
          })

          const codingCycle: (
            state: TaskRouter.State,
            authorSessionID?: string,
            repair?: string,
          ) => Effect.Effect<TaskRouter.State> = (state, authorSessionID, repair) =>
            Effect.gen(function* () {
              if (state.status === "blocked" || state.status === "completed") return state

              if (state.status === "ready_for_review") {
                const reviewer = yield* agents.get("reviewer")
                const prepared =
                  state.review.status === "in_progress"
                    ? state
                    : yield* persist(
                        filepath,
                        TaskRouter.prepareReview(
                          state,
                          reviewer?.model
                            ? { provider: String(reviewer.model.providerID), model: String(reviewer.model.modelID) }
                            : undefined,
                        ),
                      )
                if (prepared.review.status !== "in_progress") return prepared

                const reviewed = yield* delegate("reviewer", reviewPrompt(params, filepath, prepared, repair))
                reviewerOutputs.push(reviewed.output)
                const withUsage = yield* recordUsage(prepared, reviewed.sessionID, "reviewer")
                const decision = parseReviewDecision(reviewed.output)
                if (!decision) return withUsage
                const recorded = yield* persist(
                  filepath,
                  TaskRouter.recordReview(withUsage, {
                    reviewer_session_id: reviewed.sessionID,
                    decision: decision === "PASS" ? "passed" : "changes_requested",
                    summary: concise(reviewed.output),
                  }),
                )
                if (recorded.status !== "retrying") return recorded
                return yield* codingCycle(recorded, authorSessionID, concise(reviewed.output))
              }

              const role = state.assigned_role
              if (role !== "cheap-coder" && role !== "strong-coder") {
                const delegated = yield* delegate(role, implementationPrompt(params, filepath, state, repair))
                authorOutputs.push(delegated.output)
                return yield* recordUsage(state, delegated.sessionID, role)
              }

              if (params.validation_commands.length === 0) {
                throw new Error("At least one deterministic validation command is required for coding roles")
              }
              const delegated = yield* delegate(
                role,
                implementationPrompt(params, filepath, state, repair),
                authorSessionID,
              )
              authorOutputs.push(delegated.output)
              const withUsage = yield* recordUsage(state, delegated.sessionID, role)
              if (withUsage.status === "blocked") return withUsage
              const checks = yield* validate()
              const validated = yield* persist(
                filepath,
                TaskRouter.recordValidation(withUsage, {
                  role,
                  checks,
                  summary: checks.map((check) => `${check.name}: ${check.status}`).join(", "),
                }),
              )
              if (validated.status === "retrying") {
                const sameRole = validated.assigned_role === role
                const failures = checks
                  .filter((check) => check.status !== "passed")
                  .map((check) => check.summary)
                  .join("\n")
                return yield* codingCycle(validated, sameRole ? delegated.sessionID : undefined, failures)
              }
              return yield* codingCycle(validated, delegated.sessionID)
            })

          const latestAuthorUsage = initial.usage.findLast(
            (item) => item.role === initial.assigned_role && item.role !== "reviewer",
          )
          const state = yield* codingCycle(initial, latestAuthorUsage?.session_id)
          const summary = TaskRouter.summarize(state)
          return {
            title: `Task ${state.task_id}: ${state.status}`,
            metadata: { filepath, state, summary, author_outputs: authorOutputs, reviewer_outputs: reviewerOutputs },
            output: JSON.stringify(
              {
                ...summary,
                assigned_role: state.assigned_role,
                transition_reason: state.transition_reason,
                state_path: filepath,
                validation: state.attempts.at(-1)?.checks ?? [],
                review: state.review,
                unresolved_risks: unresolvedRisks(state, reviewerOutputs),
              },
              null,
              2,
            ),
          }
        }).pipe(Effect.orDie),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)

function implementationPrompt(
  params: Schema.Schema.Type<typeof Parameters>,
  filepath: string,
  state: TaskRouter.State,
  repair?: string,
) {
  return [
    "Implement the original request. Do not perform orchestration or independent review.",
    `Original request:\n${params.request}`,
    `Routing: role=${state.assigned_role}, reason=${state.initial_decision.reason}`,
    `Controller-owned state (never read or modify): ${filepath}`,
    `Only these files may be modified:\n${params.allowed_files.map((file) => `- ${file}`).join("\n")}`,
    params.repository_evidence ? `Repository evidence:\n${params.repository_evidence}` : "",
    repair ? `Repair every recorded validation or review finding:\n${repair}` : "",
    "Keep the implementation narrow. The controller will run deterministic validation after you finish.",
  ]
    .filter(Boolean)
    .join("\n\n")
}

function reviewPrompt(
  params: Schema.Schema.Type<typeof Parameters>,
  filepath: string,
  state: TaskRouter.State,
  repair?: string,
) {
  return [
    "Review only; do not modify any file.",
    `Original request:\n${params.request}`,
    `Routing: role=${state.assigned_role}, reason=${state.initial_decision.reason}`,
    `Controller-owned state (read-only): ${filepath}`,
    `Exact implementation scope:\n${params.allowed_files.map((file) => `- ${file}`).join("\n")}`,
    `Deterministic validation:\n${JSON.stringify(state.attempts.at(-1)?.checks ?? [], null, 2)}`,
    repair ? `Prior findings supplied to the author:\n${repair}` : "",
    "Inspect the complete scoped files and relevant diff. Report actionable findings, then end with exactly one final line: DECISION: PASS or DECISION: FAIL.",
  ]
    .filter(Boolean)
    .join("\n\n")
}

export function parseReviewDecision(output: string): "PASS" | "FAIL" | undefined {
  const line = output
    .split(/\r?\n/)
    .map((item) => item.trim())
    .findLast((item) => /^DECISION:\s*(PASS|FAIL)$/i.test(item))
  if (!line) return undefined
  return line.toUpperCase().endsWith("PASS") ? ("PASS" as const) : ("FAIL" as const)
}

function concise(output: string) {
  const text = output.trim()
  return text.length > 2_000 ? text.slice(-2_000) : text
}

function unresolvedRisks(state: TaskRouter.State, reviewerOutputs: string[]) {
  return [
    ...(state.status === "needs_validation" ? ["Deterministic validation is unavailable."] : []),
    ...(state.review.status === "unavailable"
      ? [`Independent review unavailable: ${state.review.unavailable_reason ?? "unknown reason"}.`]
      : []),
    ...(state.review.status === "in_progress" && reviewerOutputs.length > 0
      ? ["Reviewer did not return an explicit DECISION: PASS or DECISION: FAIL line."]
      : []),
    ...(state.status === "blocked" ? [`Workflow blocked: ${state.transition_reason ?? "unknown reason"}.`] : []),
  ]
}
