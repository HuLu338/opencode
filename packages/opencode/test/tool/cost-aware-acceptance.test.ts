import { TaskRouter } from "@opencode-ai/core/task-router"
import { describe, expect, test } from "bun:test"
import { Schema } from "effect"

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

describe("cost-aware orchestration acceptance", () => {
  test("completes the normal cheap-author and independent-reviewer path", () => {
    const authored = usage(TaskRouter.start("E2E-NORMAL", input), "cheap-coder", "author-1", "gpt-5.4-mini")
    const validated = validation(authored, "cheap-coder", "passed")
    const completed = passReview(validated, "reviewer-1")

    expect(completed.status).toBe("completed")
    expect(completed.review).toMatchObject({
      status: "passed",
      independent: true,
      author: { provider: "openai", model: "gpt-5.4-mini" },
      reviewer: { provider: "openai", model: "gpt-5.6-luna" },
    })
  })

  test("falls back after a classified primary-model failure", () => {
    const primary = usage(TaskRouter.start("E2E-FALLBACK", input), "cheap-coder", "author-primary", "missing-model")
    const failed = TaskRouter.recordModelFailure(primary, {
      role: "cheap-coder",
      provider: "openai",
      model: "missing-model",
      category: TaskRouter.classifyModelFailure("model not found"),
      summary: "model not found",
    })
    const fallback = usage(failed, "cheap-coder", "author-fallback", "gpt-5.4-mini")
    const completed = passReview(validation(fallback, "cheap-coder", "passed"), "reviewer-fallback")

    expect(TaskRouter.canFallback(failed.model_failures[0]!.category)).toBeTrue()
    expect(completed.status).toBe("completed")
    expect(completed.review.author?.model).toBe("gpt-5.4-mini")
    expect(completed.model_failures).toHaveLength(1)
  })

  test("escalates from Cheap Coder to Strong Coder after deterministic failure", () => {
    const started = TaskRouter.start("E2E-ESCALATION", input, {
      ...TaskRouter.DEFAULT_POLICY,
      cheap_coder_failures_before_escalation: 1,
    })
    const cheap = usage(started, "cheap-coder", "author-cheap", "gpt-5.4-mini")
    const escalated = validation(cheap, "cheap-coder", "failed")
    const strong = usage(escalated, "strong-coder", "author-strong", "gpt-5.5")
    const completed = passReview(validation(strong, "strong-coder", "passed"), "reviewer-escalation")

    expect(escalated).toMatchObject({ status: "retrying", assigned_role: "strong-coder", escalations: 1 })
    expect(completed.status).toBe("completed")
    expect(completed.attempts.map((attempt) => attempt.result)).toEqual(["failed", "passed"])
  })

  test("repairs an explicit Reviewer failure and passes a second independent review", () => {
    const authored = usage(TaskRouter.start("E2E-REVIEW-REPAIR", input), "cheap-coder", "author-repair", "gpt-5.4-mini")
    const validated = validation(authored, "cheap-coder", "passed")
    const requested = review(validated, "reviewer-fail", "changes_requested")
    const repaired = usage(requested, "cheap-coder", "author-repair", "gpt-5.4-mini", 2_000)
    const completed = passReview(validation(repaired, "cheap-coder", "passed"), "reviewer-pass")

    expect(requested).toMatchObject({ status: "retrying", transition_reason: "review_changes_requested" })
    expect(completed.status).toBe("completed")
    expect(completed.review_history.map((item) => item.status)).toEqual(["changes_requested", "passed"])
    expect(completed.attempts).toHaveLength(2)
  })

  test("blocks immediately after author usage exceeds the configured cost budget", () => {
    const started = TaskRouter.start("E2E-BUDGET", input, {
      ...TaskRouter.DEFAULT_POLICY,
      max_cost_usd: 0.001,
    })
    const blocked = usage(started, "cheap-coder", "author-budget", "gpt-5.4-mini", 1_000, 0.01)

    expect(blocked).toMatchObject({
      status: "blocked",
      transition_reason: "max_cost_reached",
      attempts: [],
      review: { status: "not_started" },
    })
    expect(TaskRouter.summarize(blocked)).toMatchObject({
      budget_status: "enforced",
      remaining_cost_usd: 0,
      estimated_cost_usd: 0.01,
    })
  })

  test("persists Docker unavailability without consuming an attempt and resumes to completion", () => {
    const authored = usage(TaskRouter.start("E2E-DOCKER-RESUME", input), "cheap-coder", "author-resume", "gpt-5.4-mini")
    const unavailable = validation(authored, "cheap-coder", "unavailable")
    const resumed = Schema.decodeUnknownSync(TaskRouter.State)(JSON.parse(JSON.stringify(unavailable)))
    const completed = passReview(validation(resumed, "cheap-coder", "passed"), "reviewer-resume")

    expect(unavailable).toMatchObject({ status: "needs_validation", attempts: [] })
    expect(completed.status).toBe("completed")
    expect(completed.attempts).toHaveLength(1)
  })
})

function usage(
  state: TaskRouter.State,
  role: TaskRouter.Role,
  sessionID: string,
  model: string,
  inputTokens = 1_000,
  cost = 0,
) {
  return TaskRouter.recordUsage(state, {
    session_id: sessionID,
    role,
    provider: "openai",
    model,
    input_tokens: inputTokens,
    output_tokens: 100,
    reasoning_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    estimated_cost_usd: cost,
    cost_status: "estimated",
    cost_source: "configured",
  })
}

function validation(state: TaskRouter.State, role: "cheap-coder" | "strong-coder", status: TaskRouter.CheckStatus) {
  return TaskRouter.recordValidation(state, {
    role,
    checks: [{ name: "deterministic acceptance", command: "verify", status, executor: "docker" }],
  })
}

function passReview(state: TaskRouter.State, sessionID: string) {
  return review(state, sessionID, "passed")
}

function review(state: TaskRouter.State, sessionID: string, decision: "passed" | "changes_requested") {
  const prepared = TaskRouter.prepareReview(state, { provider: "openai", model: "gpt-5.6-luna" })
  const reviewed = usage(prepared, "reviewer", sessionID, "gpt-5.6-luna")
  return TaskRouter.recordReview(reviewed, { reviewer_session_id: sessionID, decision })
}
