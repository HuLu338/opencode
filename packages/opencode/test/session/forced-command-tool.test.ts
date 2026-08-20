import { describe, expect, test } from "bun:test"
import { forcedCommandToolPolicy } from "@/session/prompt"

describe("forced command tools", () => {
  const tools = {
    read: { id: "read" },
    edit: { id: "edit" },
    orchestrate_task: { id: "orchestrate_task" },
  }

  test("exposes only the required command tool before execution", () => {
    expect(forcedCommandToolPolicy(tools, "orchestrate_task")).toEqual({
      tools: { orchestrate_task: { id: "orchestrate_task" } },
      toolChoice: "required",
    })
  })

  test("disables all tools after the forced tool settles", () => {
    expect(forcedCommandToolPolicy(tools, "orchestrate_task", true)).toEqual({
      tools: {},
      toolChoice: "none",
    })
  })

  test("fails closed when a configured command tool is unavailable", () => {
    expect(() => forcedCommandToolPolicy(tools, "missing_tool")).toThrow("Forced command tool is not available")
  })
})
