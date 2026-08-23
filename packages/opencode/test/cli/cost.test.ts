import { describe, expect, test } from "bun:test"
import { TaskRouter } from "@opencode-ai/core/task-router"
import { buildTaskReport, formatTaskReport, type Entry } from "@/cost-aware/report"

const input: TaskRouter.Input = {
  task_type: "documentation",
  complexity: "low",
  risk: "low",
  scope: "small",
  context_size: "small",
  number_of_files: 1,
  test_availability: "good",
  previous_failures: 0,
  requirements_clarity: "clear",
}

describe("cost-aware task report", () => {
  test("aggregates task history by status, model, cost source, and budget", () => {
    const completed = completedState()
    const blocked = TaskRouter.recordUsage(
      TaskRouter.start("COST-BLOCKED", input, { ...TaskRouter.DEFAULT_POLICY, max_cost_usd: 0.5 }),
      usage("blocked-author", "cheap-coder", "metered", "model-b", 1, "configured"),
    )
    const entries: Entry[] = [
      { state: blocked, filepath: "COST-BLOCKED.json", updated_at: 100 },
      { state: completed, filepath: "COST-COMPLETE.json", updated_at: 200 },
    ]

    const report = buildTaskReport(entries, [{ filepath: "invalid.json", error: "invalid JSON" }])

    expect(report.tasks).toBe(2)
    expect(report.statuses.completed).toBe(1)
    expect(report.statuses.blocked).toBe(1)
    expect(report.attempts).toBe(1)
    expect(report.review_cycles).toBe(1)
    expect(report.estimated_cost_usd).toBe(1)
    expect(report.cost_status).toBe("estimated")
    expect(report.cost_sources.subscription).toBe(2)
    expect(report.cost_sources.configured).toBe(1)
    expect(report.budget).toEqual({ configured_tasks: 1, blocked_tasks: 1 })
    expect(report.tokens.input).toBe(3_000)
    expect(report.models).toHaveLength(3)
    expect(report.history.map((item) => item.task_id)).toEqual(["COST-COMPLETE", "COST-BLOCKED"])
    expect(report.invalid_states).toEqual([{ filepath: "invalid.json", error: "invalid JSON" }])
  })

  test("renders a concise text history", () => {
    const report = buildTaskReport([{ state: completedState(), filepath: "state.json", updated_at: 200 }])
    const output = formatTaskReport(report, 1)

    expect(output).toContain("Cost-aware task report")
    expect(output).toContain("COST-COMPLETE")
    expect(output).toContain("cheap-coder subscription/model-a")
    expect(output).toContain("reviewer subscription/model-r")
  })
})

function completedState() {
  const authored = TaskRouter.recordUsage(
    TaskRouter.start("COST-COMPLETE", input),
    usage("author", "cheap-coder", "subscription", "model-a", 0, "subscription"),
  )
  const validated = TaskRouter.recordValidation(authored, {
    role: "cheap-coder",
    checks: [{ name: "diff check", command: "git diff --check", status: "passed" }],
  })
  const reviewing = TaskRouter.prepareReview(validated, { provider: "subscription", model: "model-r" })
  const reviewed = TaskRouter.recordUsage(
    reviewing,
    usage("reviewer", "reviewer", "subscription", "model-r", 0, "subscription"),
  )
  return TaskRouter.recordReview(reviewed, { reviewer_session_id: "reviewer", decision: "passed" })
}

function usage(
  session_id: string,
  role: TaskRouter.Role,
  provider: string,
  model: string,
  estimated_cost_usd: number,
  cost_source: TaskRouter.CostSource,
): TaskRouter.SessionUsage {
  return {
    session_id,
    role,
    provider,
    model,
    input_tokens: 1_000,
    output_tokens: 100,
    reasoning_tokens: 10,
    cache_read_tokens: 50,
    cache_write_tokens: 5,
    estimated_cost_usd,
    cost_status: "estimated",
    cost_source,
  }
}
