import { describe, expect, test } from "bun:test"
import { TaskRouter } from "@opencode-ai/core/task-router"
import { Schema } from "effect"
import { Parameters, parseChangedFiles, parseReviewDecision, unresolvedRisks } from "@/tool/orchestrate-task"

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

  test("reports tracked, untracked, and renamed scoped changes from git status", () => {
    expect(parseChangedFiles(" M docs/roles.md\0?? budget.txt\0!! ignored.log\0R  new name.md\0old name.md\0")).toEqual(
      ["docs/roles.md", "budget.txt", "ignored.log", "new name.md", "old name.md"],
    )
  })

  test("does not hide unvalidated scoped changes after a cost-budget block", () => {
    const started = TaskRouter.start(
      "BUDGET-SUMMARY",
      {
        task_type: "documentation",
        complexity: "low",
        risk: "low",
        scope: "small",
        context_size: "small",
        number_of_files: 1,
        test_availability: "none",
        previous_failures: 0,
        requirements_clarity: "clear",
      },
      { ...TaskRouter.DEFAULT_POLICY, max_cost_usd: 0 },
    )
    const blocked = TaskRouter.recordUsage(started, {
      session_id: "author-budget",
      role: "cheap-coder",
      provider: "openai",
      model: "gpt-5.4-mini",
      input_tokens: 1,
      output_tokens: 1,
      reasoning_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      estimated_cost_usd: 0.01,
      cost_status: "estimated",
      cost_source: "configured",
    })

    expect(unresolvedRisks(blocked, [], { status: "detected", files: ["budget.txt"] })).toContain(
      "Scoped files are modified after the author session, but the cost budget was reached before validation.",
    )
  })
})
