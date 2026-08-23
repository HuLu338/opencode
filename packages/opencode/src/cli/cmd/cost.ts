import { TaskRouter } from "@opencode-ai/core/task-router"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect, Option, Schema } from "effect"
import path from "path"
import { InstanceRef } from "@/effect/instance-ref"
import { buildTaskReport, formatTaskReport, type Entry, type InvalidState } from "@/cost-aware/report"
import { effectCmd, fail } from "../effect-cmd"

export const CostCommand = effectCmd({
  command: "cost",
  aliases: "costs",
  describe: "show cost-aware task history and cost statistics",
  builder: (yargs) =>
    yargs
      .option("json", {
        describe: "emit the full report as JSON",
        type: "boolean",
        default: false,
      })
      .option("status", {
        describe: "include only tasks with this status",
        type: "string",
        choices: TaskRouter.StateStatus.literals,
      })
      .option("task", {
        describe: "include only this task ID",
        type: "string",
      })
      .option("limit", {
        describe: "maximum recent tasks shown in the text report",
        type: "number",
        default: 20,
      })
      .option("state-dir", {
        describe: "task-state directory relative to the repository, or an absolute path",
        type: "string",
      }),
  handler: Effect.fn("Cli.cost")(function* (args) {
    const ctx = yield* InstanceRef
    if (!ctx) return yield* fail("Could not load instance context")
    if (!Number.isInteger(args.limit) || args.limit < 1) return yield* fail("--limit must be a positive integer")

    const fs = yield* FSUtil.Service
    const state_directory = args.stateDir
      ? path.resolve(ctx.worktree, args.stateDir)
      : path.join(ctx.worktree, ".opencode", "task-state")
    const files = !(yield* fs.existsSafe(state_directory))
      ? []
      : yield* fs
          .readDirectoryEntries(state_directory)
          .pipe(Effect.catch((error) => fail(`Could not read task state directory: ${error}`)))
    const loaded = yield* Effect.forEach(
      files.filter((item) => item.type === "file" && item.name.endsWith(".json")),
      (item) => {
        const filepath = path.join(state_directory, item.name)
        return Effect.gen(function* () {
          const state = yield* fs.readJson(filepath).pipe(Effect.flatMap(Schema.decodeUnknownEffect(TaskRouter.State)))
          const stat = yield* fs.stat(filepath)
          return {
            entry: {
              state: yield* Effect.try({
                try: () => TaskRouter.assertConsistent(state),
                catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
              }),
              filepath,
              updated_at: Option.getOrElse(stat.mtime, () => new Date(0)).getTime(),
            } satisfies Entry,
          }
        }).pipe(
          Effect.catch((error) =>
            Effect.succeed({
              invalid: {
                filepath,
                error: String(error).split("\n")[0],
              } satisfies InvalidState,
            }),
          ),
        )
      },
      { concurrency: 8 },
    )
    const entries = loaded
      .filter((item): item is { entry: Entry } => "entry" in item)
      .map((item) => item.entry)
      .filter((item) => !args.task || item.state.task_id === args.task)
      .filter((item) => !args.status || item.state.status === args.status)
    if (args.task && entries.length === 0) return yield* fail(`Task state not found: ${args.task}`)

    const report = buildTaskReport(
      entries,
      loaded.filter((item): item is { invalid: InvalidState } => "invalid" in item).map((item) => item.invalid),
    )
    if (args.json) {
      console.log(JSON.stringify({ state_directory, ...report }, null, 2))
      return
    }
    console.log(`${formatTaskReport(report, args.limit)}\n\nState directory: ${state_directory}`)
  }),
})
