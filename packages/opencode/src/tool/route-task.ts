import { TaskRouter } from "@opencode-ai/core/task-router"
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./route-task.txt"

type Metadata = {
  decision: TaskRouter.Decision
}

export const RouteTaskTool = Tool.define<typeof TaskRouter.Input, Metadata, never>(
  "route_task",
  Effect.succeed({
    description: DESCRIPTION,
    parameters: TaskRouter.Input,
    execute(params: Schema.Schema.Type<typeof TaskRouter.Input>) {
      const decision = TaskRouter.route(params)
      return Effect.succeed({
        title: `Route to ${decision.role}`,
        output: JSON.stringify(decision, null, 2),
        metadata: { decision },
      })
    },
  }),
)
