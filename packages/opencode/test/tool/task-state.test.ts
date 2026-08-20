import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Parameters } from "@/tool/task-state"

describe("task_state parameters", () => {
  test("decodes numeric strings from tool-calling providers", () => {
    const params = Schema.decodeUnknownSync(Parameters)({
      action: "start",
      task_id: "PHASE5-SMOKE-003",
      task_type: "documentation",
      complexity: "low",
      risk: "low",
      scope: "small",
      context_size: "small",
      number_of_files: "1",
      test_availability: "none",
      previous_failures: "0",
      requirements_clarity: "clear",
    })

    if (params.action !== "start") throw new Error("Expected start parameters")
    expect(params.number_of_files).toBe(1)
    expect(params.previous_failures).toBe(0)
  })

  test("rejects invalid numeric strings", () => {
    expect(() =>
      Schema.decodeUnknownSync(Parameters)({
        action: "start",
        task_type: "documentation",
        complexity: "low",
        risk: "low",
        scope: "small",
        context_size: "small",
        number_of_files: "one",
        test_availability: "none",
        previous_failures: "-1",
        requirements_clarity: "clear",
      }),
    ).toThrow()
  })
})
