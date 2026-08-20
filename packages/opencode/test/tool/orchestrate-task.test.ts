import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Parameters, parseReviewDecision } from "@/tool/orchestrate-task"

describe("orchestrate_task", () => {
  test("decodes numeric strings from tool-calling providers", () => {
    const params = Schema.decodeUnknownSync(Parameters)({
      task_id: "PHASE5-SMOKE-004",
      request: "Update one document",
      task_type: "documentation",
      complexity: "low",
      risk: "low",
      scope: "small",
      context_size: "small",
      number_of_files: "1",
      test_availability: "none",
      previous_failures: "0",
      requirements_clarity: "clear",
      allowed_files: [".opencode/COST_AWARE_ROLES.md"],
      validation_commands: [
        {
          name: "diff check",
          command: "git diff --check",
          timeout: "30000",
        },
      ],
    })

    expect(params.number_of_files).toBe(1)
    expect(params.previous_failures).toBe(0)
    expect(params.validation_commands[0]?.timeout).toBe(30_000)
  })

  test("requires an explicit canonical Reviewer decision", () => {
    expect(parseReviewDecision("No findings.\nDECISION: PASS\n</task>")).toBe("PASS")
    expect(parseReviewDecision("One issue.\nDECISION: FAIL")).toBe("FAIL")
    expect(parseReviewDecision("The implementation looks good and should pass.")).toBeUndefined()
  })
})
