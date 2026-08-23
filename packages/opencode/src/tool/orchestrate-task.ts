import { TaskRouter } from "@opencode-ai/core/task-router"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { AppProcess } from "@opencode-ai/core/process"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { Effect, Schema } from "effect"
import { ChildProcess } from "effect/unstable/process"
import path from "path"
import { Tool } from "./tool"
import { TaskTool } from "./task"
import { ShellTool } from "./shell"
import { costMetadata } from "./task-usage"
import { TaskSandbox } from "./task-sandbox"
import DESCRIPTION from "./orchestrate-task.txt"

const NonNegativeIntParameter = Schema.Union([
  TaskRouter.Input.fields.number_of_files,
  Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
])

const SANDBOX_STARTUP_TIMEOUT = 2 * 60 * 1000

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
    const providers = yield* Provider.Service
    const processes = yield* AppProcess.Service
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
          const cfg = yield* config.get()
          const costAware = cfg.cost_aware
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
                  TaskRouter.resolvePolicy(costAware),
                ),
              )

          const authorOutputs: string[] = []
          const reviewerOutputs: string[] = []
          const modelPool = Effect.fn("OrchestrateTaskTool.modelPool")(function* (role: TaskRouter.Role) {
            const agent = yield* agents.get(role)
            const primary = agent?.model ? `${agent.model.providerID}/${agent.model.modelID}` : undefined
            return TaskRouter.resolveModelPool(costAware, role, primary)
          })
          const recordUsage = Effect.fn("OrchestrateTaskTool.recordUsage")(function* (
            state: TaskRouter.State,
            sessionID: string,
            role: TaskRouter.Role,
            expectedModel: ReturnType<typeof Provider.parseModel>,
          ) {
            const session = yield* sessions.get(SessionID.make(sessionID)).pipe(Effect.orDie)
            const tokens = session.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
            const usageTokens = {
              input_tokens: tokens.input,
              output_tokens: tokens.output,
              reasoning_tokens: tokens.reasoning,
              cache_read_tokens: tokens.cache.read,
              cache_write_tokens: tokens.cache.write,
            }
            const provider = session.model ? String(session.model.providerID) : String(expectedModel.providerID)
            const model = session.model ? String(session.model.id) : String(expectedModel.modelID)
            const modelRef = `${provider}/${model}`
            const pricing = costAware?.pricing_usd_per_million?.[modelRef]
            const identity = Provider.parseModel(modelRef)
            const loadCatalog = providers.getModel(identity.providerID, identity.modelID).pipe(
              Effect.catchIf(
                (error): error is Provider.ModelNotFoundError => Provider.ModelNotFoundError.isInstance(error),
                () => Effect.succeed(undefined),
              ),
            )
            const catalog = pricing ? undefined : yield* loadCatalog
            const cost = costMetadata({
              tokens: usageTokens,
              sessionCost: session.cost,
              billingMode: costAware?.billing_mode,
              configured: pricing,
              provider: catalog?.cost,
            })
            return yield* persist(
              filepath,
              TaskRouter.recordUsage(state, {
                session_id: sessionID,
                role,
                provider,
                model,
                ...usageTokens,
                ...cost,
              }),
            )
          })

          const delegate = Effect.fn("OrchestrateTaskTool.delegate")(function* (
            state: TaskRouter.State,
            role: TaskRouter.Role,
            prompt: string,
            sessionID?: string,
            requestedModels?: string[],
          ) {
            const resumed = sessionID ? state.usage.find((item) => item.session_id === sessionID) : undefined
            const pool = [
              ...(resumed ? [`${resumed.provider}/${resumed.model}`] : []),
              ...(requestedModels ?? (yield* modelPool(role))),
            ].filter((item, index, items) => items.indexOf(item) === index)
            const candidates = pool.filter(
              (item) =>
                !state.model_failures.some(
                  (failure) => failure.role === role && `${failure.provider}/${failure.model}` === item,
                ),
            )
            const runCandidate = Effect.fnUntraced(function* (
              current: {
                state: TaskRouter.State
                complete: boolean
                sessionID: string | undefined
                output: string | undefined
              },
              item: { candidate: string; index: number },
            ) {
              if (current.complete || current.state.status === "blocked") return current
              const model = Provider.parseModel(item.candidate)
              const result = yield* taskDef.execute(
                {
                  description: `${params.task_id} ${role}`,
                  prompt,
                  subagent_type: role,
                  ...(item.index === 0 && sessionID ? { task_id: sessionID } : {}),
                  background: false,
                },
                {
                  ...ctx,
                  extra: {
                    ...ctx.extra,
                    bypassAgentCheck: true,
                    captureTaskErrors: true,
                    taskModel: model,
                  },
                },
              )
              const childSessionID = String(result.metadata.sessionId)
              const withUsage = yield* recordUsage(current.state, childSessionID, role, model)
              if (withUsage.status === "blocked") return { ...current, state: withUsage, complete: true }

              const error = taskError(result.metadata)
              if (!error) {
                return {
                  state: withUsage,
                  complete: true,
                  sessionID: childSessionID,
                  output: result.output,
                }
              }

              const category = TaskRouter.classifyModelFailure(error)
              const failed = yield* persist(
                filepath,
                TaskRouter.recordModelFailure(withUsage, {
                  role,
                  provider: String(model.providerID),
                  model: String(model.modelID),
                  category,
                  summary: concise(error),
                }),
              )
              if (TaskRouter.canFallback(category)) return { ...current, state: failed }
              return {
                ...current,
                state: yield* persist(filepath, TaskRouter.blockModelFailure(failed, "model_execution_failed")),
                complete: true,
              }
            })
            const outcome = yield* candidates
              .map((candidate, index) => ({ candidate, index }))
              .reduce(
                (effect, item) => effect.pipe(Effect.flatMap((current) => runCandidate(current, item))),
                Effect.succeed({
                  state,
                  complete: false,
                  sessionID: undefined as string | undefined,
                  output: undefined as string | undefined,
                }),
              )
            if (outcome.complete) return outcome
            return {
              ...outcome,
              state: yield* persist(filepath, TaskRouter.blockModelFailure(outcome.state, "model_pool_exhausted")),
            }
          })

          const prepareSandboxArchive = Effect.fn("OrchestrateTaskTool.prepareSandboxArchive")(function* (
            archive: string,
            manifest: string,
          ) {
            const options = {
              cwd: instance.worktree,
              combineOutput: true,
              maxOutputBytes: 50 * 1024 * 1024,
              timeout: 60_000,
            }
            const listing = yield* processes.run(
              ChildProcess.make("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
                cwd: instance.worktree,
              }),
              options,
            )
            const deleted = yield* processes.run(
              ChildProcess.make("git", ["ls-files", "-z", "--deleted"], { cwd: instance.worktree }),
              options,
            )
            if (listing.exitCode !== 0 || deleted.exitCode !== 0) {
              return yield* Effect.fail(new Error("Could not enumerate repository files for sandbox validation"))
            }
            const allowedFiles = (yield* Effect.forEach(
              TaskSandbox.archiveEntries(`${params.allowed_files.join("\0")}\0`),
              Effect.fnUntraced(function* (file) {
                return (yield* fs.isFile(path.join(instance.worktree, file))) ? file : undefined
              }),
            )).filter((file): file is string => file !== undefined)
            const files = [
              ...new Set([
                ...TaskSandbox.archiveEntries(
                  listing.output?.toString("utf8") ?? "",
                  deleted.output?.toString("utf8") ?? "",
                ),
                ...allowedFiles,
              ]),
            ]
            if (files.length === 0) return yield* Effect.fail(new Error("Sandbox archive would contain no files"))
            yield* fs.writeWithDirs(manifest, `${files.join("\0")}\0`).pipe(Effect.orDie)
            const result = yield* processes.run(
              ChildProcess.make("tar", ["-cf", archive, "--null", "-T", manifest], { cwd: instance.worktree }),
              { combineOutput: true, maxOutputBytes: 51_200, timeout: 2 * 60 * 1000 },
            )
            if (result.exitCode !== 0) {
              return yield* Effect.fail(
                new Error(`Could not prepare sandbox archive: ${concise(result.output?.toString("utf8") ?? "")}`),
              )
            }
            return { archive, manifest }
          })

          const validate = Effect.fn("OrchestrateTaskTool.validate")(function* () {
            const commands = TaskSandbox.deduplicateCommands(params.validation_commands)
            const run = (archive?: string) =>
              Effect.forEach(
                commands,
                Effect.fnUntraced(function* (command) {
                  if (costAware?.sandbox?.enabled) {
                    const name = `opencode-validation-${crypto.randomUUID()}`
                    const timeout = command.timeout ?? 2 * 60 * 1000
                    const sandbox = TaskSandbox.command({
                      repository: instance.worktree,
                      archive,
                      workdir: command.workdir,
                      command: command.command,
                      name,
                      timeout,
                      config: costAware.sandbox,
                    })
                    const cleanup = processes
                      .run(ChildProcess.make("docker", ["rm", "-f", name], { cwd: instance.worktree }), {
                        combineOutput: true,
                        maxOutputBytes: 4096,
                        timeout: 30_000,
                      })
                      .pipe(Effect.ignore)
                    const result = yield* processes
                      .run(ChildProcess.make(sandbox.executable, sandbox.args, { cwd: instance.worktree }), {
                        combineOutput: true,
                        maxOutputBytes: 51_200,
                        timeout: timeout + SANDBOX_STARTUP_TIMEOUT,
                      })
                      .pipe(
                        Effect.ensuring(cleanup),
                        Effect.map((output) => ({
                          exitCode: output.exitCode,
                          output: output.output?.toString("utf8") ?? "",
                          unavailable: false,
                        })),
                        Effect.catch((error) =>
                          Effect.succeed({ exitCode: 125, output: error.message, unavailable: true }),
                        ),
                      )
                    return {
                      name: command.name,
                      command: command.command,
                      status: result.unavailable ? ("unavailable" as const) : TaskSandbox.status(result.exitCode),
                      executor: "docker" as const,
                      summary: concise(result.output),
                    }
                  }
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
                    executor: "host" as const,
                    summary: concise(result.output),
                  }
                }),
                { concurrency: 1 },
              )

            if (!costAware?.sandbox?.enabled) return yield* run()
            const id = crypto.randomUUID()
            const archive = path.join(instance.worktree, ".tmp", "task-sandbox", `${id}.tar`)
            const manifest = `${archive}.files`
            const cleanup = Effect.all([fs.remove(archive), fs.remove(manifest)]).pipe(Effect.ignore)
            return yield* Effect.acquireUseRelease(
              prepareSandboxArchive(archive, manifest),
              () => run(archive),
              () => Effect.void,
            ).pipe(
              Effect.ensuring(cleanup),
              Effect.catch((error) =>
                Effect.succeed(
                  commands.map((command) => ({
                    name: command.name,
                    command: command.command,
                    status: "unavailable" as const,
                    executor: "docker" as const,
                    summary: concise(error.message),
                  })),
                ),
              ),
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
                const availableReviewers = (yield* modelPool("reviewer")).filter(
                  (item) =>
                    !state.model_failures.some(
                      (failure) => failure.role === "reviewer" && `${failure.provider}/${failure.model}` === item,
                    ),
                )
                if (availableReviewers.length === 0) {
                  return yield* persist(filepath, TaskRouter.blockModelFailure(state, "model_pool_exhausted"))
                }
                const latestAttempt = state.attempts.at(-1)
                const authorUsage = latestAttempt
                  ? state.usage.findLast((item) => item.role === latestAttempt.role)
                  : undefined
                const independentReviewers = authorUsage
                  ? availableReviewers.filter((item) => item !== `${authorUsage.provider}/${authorUsage.model}`)
                  : availableReviewers
                const reviewCandidates = independentReviewers.length > 0 ? independentReviewers : availableReviewers
                const expectedReviewer = Provider.parseModel(reviewCandidates[0])
                const prepared =
                  state.review.status === "in_progress"
                    ? state
                    : yield* persist(
                        filepath,
                        TaskRouter.prepareReview(state, {
                          provider: String(expectedReviewer.providerID),
                          model: String(expectedReviewer.modelID),
                        }),
                      )
                if (prepared.review.status !== "in_progress") return prepared

                const reviewed = yield* delegate(
                  prepared,
                  "reviewer",
                  reviewPrompt(params, filepath, prepared, repair),
                  undefined,
                  reviewCandidates,
                )
                if (!reviewed.output || !reviewed.sessionID) return reviewed.state
                reviewerOutputs.push(reviewed.output)
                const decision = parseReviewDecision(reviewed.output)
                if (!decision) return reviewed.state
                const recorded = yield* persist(
                  filepath,
                  TaskRouter.recordReview(reviewed.state, {
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
                const delegated = yield* delegate(state, role, implementationPrompt(params, filepath, state, repair))
                if (delegated.output) authorOutputs.push(delegated.output)
                return delegated.state
              }

              if (params.validation_commands.length === 0) {
                throw new Error("At least one deterministic validation command is required for coding roles")
              }
              const delegated = yield* delegate(
                state,
                role,
                implementationPrompt(params, filepath, state, repair),
                authorSessionID,
              )
              if (!delegated.output || !delegated.sessionID) return delegated.state
              authorOutputs.push(delegated.output)
              const checks = yield* validate()
              const validated = yield* persist(
                filepath,
                TaskRouter.recordValidation(delegated.state, {
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
          const scopedChanges = yield* processes
            .run(
              ChildProcess.make(
                "git",
                [
                  "status",
                  "--porcelain=v1",
                  "-z",
                  "--untracked-files=all",
                  "--ignored=matching",
                  "--",
                  ...params.allowed_files,
                ],
                { cwd: instance.worktree },
              ),
              { combineOutput: true, maxOutputBytes: 1024 * 1024, timeout: 30_000 },
            )
            .pipe(
              Effect.map((result) => {
                if (result.exitCode !== 0) return { status: "unknown" as const, files: [] as string[] }
                const files = parseChangedFiles(result.output?.toString("utf8") ?? "")
                return { status: files.length > 0 ? ("detected" as const) : ("none" as const), files }
              }),
              Effect.catch(() => Effect.succeed({ status: "unknown" as const, files: [] as string[] })),
            )
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
                scoped_changes: scopedChanges,
                unresolved_risks: unresolvedRisks(state, reviewerOutputs, scopedChanges),
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

export function parseChangedFiles(output: string) {
  return [
    ...new Set(
      output
        .split("\0")
        .filter(Boolean)
        .map((item) => (/^[ MADRCU?!]{2} /.test(item) ? item.slice(3) : item))
        .map((item) => item.replaceAll("\\", "/")),
    ),
  ]
}

function taskError(metadata: unknown) {
  if (typeof metadata !== "object" || metadata === null || !("error" in metadata)) return undefined
  return typeof metadata.error === "string" && metadata.error.trim() ? metadata.error : undefined
}

function concise(output: string) {
  const text = output.trim()
  return text.length > 2_000 ? text.slice(-2_000) : text
}

export function unresolvedRisks(
  state: TaskRouter.State,
  reviewerOutputs: string[],
  scopedChanges: { status: "detected" | "none" | "unknown"; files: string[] },
) {
  return [
    ...(state.status === "needs_validation" ? ["Deterministic validation is unavailable."] : []),
    ...(state.review.status === "unavailable"
      ? [`Independent review unavailable: ${state.review.unavailable_reason ?? "unknown reason"}.`]
      : []),
    ...(state.review.status === "in_progress" && reviewerOutputs.length > 0
      ? ["Reviewer did not return an explicit DECISION: PASS or DECISION: FAIL line."]
      : []),
    ...(state.status === "blocked" ? [`Workflow blocked: ${state.transition_reason ?? "unknown reason"}.`] : []),
    ...(state.transition_reason === "max_cost_reached" && scopedChanges.status === "detected"
      ? ["Scoped files are modified after the author session, but the cost budget was reached before validation."]
      : []),
  ]
}
