import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { TaskRouter } from "@opencode-ai/core/task-router"

const baseline: TaskRouter.Input = {
  task_type: "implementation",
  complexity: "low",
  risk: "low",
  scope: "small",
  context_size: "small",
  number_of_files: 1,
  test_availability: "good",
  previous_failures: 0,
  requirements_clarity: "clear",
}

describe("TaskRouter.route", () => {
  test.each([
    {
      name: "sends explicit reviews to the reviewer",
      input: { task_type: "review" } satisfies Partial<TaskRouter.Input>,
      expected: { role: "reviewer", reason: "review_request", review_required: false },
    },
    {
      name: "sends architecture work to the architect",
      input: { task_type: "architecture" } satisfies Partial<TaskRouter.Input>,
      expected: { role: "architect", reason: "architecture_or_unclear", review_required: false },
    },
    {
      name: "sends unclear requirements to the architect before considering risk",
      input: { requirements_clarity: "unclear", risk: "high" } satisfies Partial<TaskRouter.Input>,
      expected: { role: "architect", reason: "architecture_or_unclear", review_required: false },
    },
    {
      name: "sends security work to the strong coder with review required",
      input: { task_type: "security" } satisfies Partial<TaskRouter.Input>,
      expected: { role: "strong-coder", reason: "critical_domain", review_required: true },
    },
    {
      name: "sends high-risk work to the strong coder with review required",
      input: { risk: "high" } satisfies Partial<TaskRouter.Input>,
      expected: { role: "strong-coder", reason: "high_risk", review_required: true },
    },
    {
      name: "sends high-complexity low-risk work to the strong coder",
      input: { complexity: "high" } satisfies Partial<TaskRouter.Input>,
      expected: { role: "strong-coder", reason: "high_complexity", review_required: false },
    },
    {
      name: "sends large-scope work to the strong coder",
      input: { scope: "large" } satisfies Partial<TaskRouter.Input>,
      expected: { role: "strong-coder", reason: "large_scope", review_required: false },
    },
    {
      name: "escalates after two previous failures",
      input: { previous_failures: 2 } satisfies Partial<TaskRouter.Input>,
      expected: { role: "strong-coder", reason: "repeated_failures", review_required: false },
    },
    {
      name: "keeps a first retry on the cheap coder",
      input: { complexity: "medium", previous_failures: 1 } satisfies Partial<TaskRouter.Input>,
      expected: { role: "cheap-coder", reason: "cheap_first", review_required: false },
    },
    {
      name: "sends large-context multi-file work to the strong coder",
      input: { context_size: "large", number_of_files: 8 } satisfies Partial<TaskRouter.Input>,
      expected: { role: "strong-coder", reason: "large_context_many_files", review_required: false },
    },
    {
      name: "keeps large context with few files on the cheap coder",
      input: { context_size: "large", number_of_files: 3 } satisfies Partial<TaskRouter.Input>,
      expected: { role: "cheap-coder", reason: "cheap_first", review_required: false },
    },
    {
      name: "strengthens medium-risk work when no tests exist",
      input: { risk: "medium", test_availability: "none" } satisfies Partial<TaskRouter.Input>,
      expected: { role: "strong-coder", reason: "medium_risk_without_tests", review_required: true },
    },
    {
      name: "tries the cheap coder first for ordinary medium-complexity work",
      input: {
        complexity: "medium",
        scope: "medium",
        context_size: "medium",
        number_of_files: 5,
      } satisfies Partial<TaskRouter.Input>,
      expected: { role: "cheap-coder", reason: "cheap_first", review_required: false },
    },
  ])("$name", ({ input, expected }) => {
    expect(TaskRouter.route({ ...baseline, ...input })).toEqual(expected)
  })

  test("rejects negative counts at the schema boundary", () => {
    expect(() => Schema.decodeUnknownSync(TaskRouter.Input)({ ...baseline, previous_failures: -1 })).toThrow()
    expect(() => Schema.decodeUnknownSync(TaskRouter.Input)({ ...baseline, number_of_files: -1 })).toThrow()
  })
})

describe("TaskRouter validation state", () => {
  const passingCheck: TaskRouter.ValidationCheck = {
    name: "focused tests",
    command: "bun test test/auth.test.ts",
    status: "passed",
  }
  const failingCheck: TaskRouter.ValidationCheck = {
    name: "focused tests",
    command: "bun test test/auth.test.ts",
    status: "failed",
    summary: "expected 200, received 401",
  }

  test("uses the configured Cheap Coder escalation threshold during initial routing", () => {
    expect(
      TaskRouter.route(
        { ...baseline, previous_failures: 1 },
        { ...TaskRouter.DEFAULT_POLICY, cheap_coder_failures_before_escalation: 1 },
      ),
    ).toEqual({
      role: "strong-coder",
      reason: "repeated_failures",
      review_required: false,
    })
  })

  test("moves a validated task to review without relying on model confidence", () => {
    const result = TaskRouter.recordValidation(TaskRouter.start("AUTH-001", baseline), {
      role: "cheap-coder",
      checks: [passingCheck],
    })

    expect(result.status).toBe("ready_for_review")
    expect(result.transition_reason).toBe("validation_passed")
    expect(result.attempts).toEqual([
      {
        role: "cheap-coder",
        checks: [passingCheck],
        result: "passed",
      },
    ])
  })

  test("rejects a review-ready state that was not produced by passed validation", () => {
    const state = TaskRouter.start("AUTH-001", baseline)

    expect(() => TaskRouter.assertConsistent({ ...state, status: "ready_for_review" })).toThrow(
      "without a passed validation attempt",
    )
  })

  test("does not consume an attempt when deterministic validation is unavailable", () => {
    const result = TaskRouter.recordValidation(TaskRouter.start("AUTH-001", baseline), {
      role: "cheap-coder",
      checks: [{ ...passingCheck, status: "unavailable" }],
    })

    expect(result.status).toBe("needs_validation")
    expect(result.transition_reason).toBe("validation_incomplete")
    expect(result.attempts).toEqual([])
  })

  test("round-trips persisted task state through its schema", () => {
    const state = TaskRouter.recordValidation(TaskRouter.start("AUTH-001", baseline), {
      role: "cheap-coder",
      checks: [passingCheck],
    })

    expect(Schema.decodeUnknownSync(TaskRouter.State)(JSON.parse(JSON.stringify(state)))).toEqual(state)
  })

  test("does not treat planning or review as an implementation retry", () => {
    const state = TaskRouter.start("AUTH-001", { ...baseline, task_type: "architecture" })

    expect(() =>
      TaskRouter.recordValidation(state, {
        role: "architect",
        checks: [failingCheck],
      }),
    ).toThrow("Only coding roles")
  })

  test("retries the Cheap Coder once and then escalates to the Strong Coder", () => {
    const first = TaskRouter.recordValidation(TaskRouter.start("AUTH-001", baseline), {
      role: "cheap-coder",
      checks: [failingCheck],
    })
    const second = TaskRouter.recordValidation(first, {
      role: "cheap-coder",
      checks: [failingCheck],
    })

    expect(first).toMatchObject({
      assigned_role: "cheap-coder",
      status: "retrying",
      transition_reason: "retry_same_role",
    })
    expect(second).toMatchObject({
      assigned_role: "strong-coder",
      escalations: 1,
      status: "retrying",
      transition_reason: "cheap_coder_escalation",
    })
  })

  test("stops after the configured attempt budget", () => {
    const state = TaskRouter.start("AUTH-001", baseline, {
      ...TaskRouter.DEFAULT_POLICY,
      max_attempts: 1,
    })
    const result = TaskRouter.recordValidation(state, {
      role: "cheap-coder",
      checks: [failingCheck],
    })

    expect(result).toMatchObject({ status: "blocked", transition_reason: "max_attempts_reached" })
  })

  test("stops a Strong Coder after its configured failure limit", () => {
    const state = TaskRouter.start(
      "AUTH-001",
      { ...baseline, complexity: "high" },
      {
        ...TaskRouter.DEFAULT_POLICY,
        max_attempts: 3,
        strong_coder_failures_before_human: 1,
      },
    )
    const result = TaskRouter.recordValidation(state, {
      role: "strong-coder",
      checks: [failingCheck],
    })

    expect(result).toMatchObject({ status: "blocked", transition_reason: "strong_coder_failure_limit" })
  })

  test("uses the latest cumulative session usage instead of double-counting a resumed child session", () => {
    const state = TaskRouter.start("AUTH-001", baseline)
    const first = TaskRouter.recordUsage(state, {
      session_id: "ses_cheap",
      role: "cheap-coder",
      provider: "provider-a",
      model: "model-a",
      input_tokens: 100,
      output_tokens: 20,
      reasoning_tokens: 0,
      cache_read_tokens: 10,
      cache_write_tokens: 0,
      estimated_cost_usd: 0.01,
    })
    const result = TaskRouter.recordUsage(first, {
      session_id: "ses_cheap",
      role: "cheap-coder",
      provider: "provider-a",
      model: "model-a",
      input_tokens: 160,
      output_tokens: 35,
      reasoning_tokens: 0,
      cache_read_tokens: 20,
      cache_write_tokens: 5,
      estimated_cost_usd: 0.02,
    })

    expect(TaskRouter.summarize(result)).toMatchObject({
      estimated_cost_usd: 0.02,
      tokens: { input: 160, output: 35, reasoning: 0, cache_read: 20, cache_write: 5 },
      usage: [{ role: "cheap-coder", provider: "provider-a", model: "model-a", sessions: 1 }],
    })
  })

  test("blocks later retries after the configured cost budget is exceeded", () => {
    const state = TaskRouter.start("AUTH-001", baseline, {
      ...TaskRouter.DEFAULT_POLICY,
      max_cost_usd: 0.01,
    })
    const result = TaskRouter.recordUsage(state, {
      session_id: "ses_cheap",
      role: "cheap-coder",
      provider: "provider-a",
      model: "model-a",
      input_tokens: 100,
      output_tokens: 20,
      reasoning_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      estimated_cost_usd: 0.02,
    })

    expect(result).toMatchObject({ status: "blocked", transition_reason: "max_cost_reached" })
    expect(TaskRouter.summarize(result)).toMatchObject({ max_cost_usd: 0.01, remaining_cost_usd: 0 })
  })

  test("does not start an independent review after the author exhausts the task budget", () => {
    const validated = TaskRouter.recordValidation(
      TaskRouter.start("AUTH-001", baseline, { ...TaskRouter.DEFAULT_POLICY, max_cost_usd: 0.01 }),
      {
        role: "cheap-coder",
        checks: [passingCheck],
      },
    )
    const result = TaskRouter.recordUsage(validated, {
      session_id: "ses_cheap",
      role: "cheap-coder",
      provider: "provider-a",
      model: "model-a",
      input_tokens: 100,
      output_tokens: 20,
      reasoning_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      estimated_cost_usd: 0.02,
    })

    expect(result).toMatchObject({ status: "blocked", transition_reason: "max_cost_reached" })
    expect(() => TaskRouter.prepareReview(result, { provider: "provider-b", model: "model-b" })).toThrow(
      "cannot start review while blocked",
    )
  })

  test("records a reviewer call that crosses the budget without allowing another model call", () => {
    const validated = TaskRouter.recordValidation(
      TaskRouter.start("AUTH-001", baseline, { ...TaskRouter.DEFAULT_POLICY, max_cost_usd: 0.015 }),
      {
        role: "cheap-coder",
        checks: [passingCheck],
      },
    )
    const withAuthorUsage = TaskRouter.recordUsage(validated, {
      session_id: "ses_cheap",
      role: "cheap-coder",
      provider: "provider-a",
      model: "model-a",
      input_tokens: 100,
      output_tokens: 20,
      reasoning_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      estimated_cost_usd: 0.01,
    })
    const prepared = TaskRouter.prepareReview(withAuthorUsage, { provider: "provider-b", model: "model-b" })
    const withReviewerUsage = TaskRouter.recordUsage(prepared, {
      session_id: "ses_reviewer",
      role: "reviewer",
      provider: "provider-b",
      model: "model-b",
      input_tokens: 75,
      output_tokens: 10,
      reasoning_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      estimated_cost_usd: 0.01,
    })

    expect(withReviewerUsage).toMatchObject({ status: "ready_for_review", review: { status: "in_progress" } })
    expect(
      TaskRouter.recordReview(withReviewerUsage, {
        reviewer_session_id: "ses_reviewer",
        decision: "passed",
      }),
    ).toMatchObject({ status: "completed", transition_reason: "review_passed" })
  })

  test("decodes Phase 3 state files without usage data", () => {
    const { usage: _usage, ...legacy } = TaskRouter.start("AUTH-001", baseline)

    expect(Schema.decodeUnknownSync(TaskRouter.State)(legacy).usage).toEqual([])
  })

  test("prepares an independent reviewer from the actual author model", () => {
    const validated = TaskRouter.recordValidation(TaskRouter.start("AUTH-001", baseline), {
      role: "cheap-coder",
      checks: [passingCheck],
    })
    const withAuthorUsage = TaskRouter.recordUsage(validated, {
      session_id: "ses_cheap",
      role: "cheap-coder",
      provider: "provider-a",
      model: "model-a",
      input_tokens: 100,
      output_tokens: 20,
      reasoning_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      estimated_cost_usd: 0.01,
    })
    const result = TaskRouter.prepareReview(withAuthorUsage, { provider: "provider-b", model: "model-b" })

    expect(result).toMatchObject({
      status: "ready_for_review",
      transition_reason: "reviewer_assigned",
      review: {
        status: "in_progress",
        author: { provider: "provider-a", model: "model-a" },
        reviewer: { provider: "provider-b", model: "model-b" },
        independent: true,
      },
    })
  })

  test("refuses the author model as the only reviewer", () => {
    const validated = TaskRouter.recordValidation(TaskRouter.start("AUTH-001", baseline), {
      role: "cheap-coder",
      checks: [passingCheck],
    })
    const withAuthorUsage = TaskRouter.recordUsage(validated, {
      session_id: "ses_cheap",
      role: "cheap-coder",
      provider: "provider-a",
      model: "model-a",
      input_tokens: 100,
      output_tokens: 20,
      reasoning_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      estimated_cost_usd: 0.01,
    })
    const result = TaskRouter.prepareReview(withAuthorUsage, { provider: "provider-a", model: "model-a" })

    expect(result).toMatchObject({
      status: "ready_for_review",
      transition_reason: "review_unavailable",
      review: {
        status: "unavailable",
        independent: false,
        unavailable_reason: "reviewer_matches_author",
      },
      review_history: [{ status: "unavailable" }],
    })
  })

  test("fails closed when the Reviewer session resolves to the author model", () => {
    const validated = TaskRouter.recordValidation(TaskRouter.start("AUTH-001", baseline), {
      role: "cheap-coder",
      checks: [passingCheck],
    })
    const withAuthorUsage = TaskRouter.recordUsage(validated, {
      session_id: "ses_cheap",
      role: "cheap-coder",
      provider: "provider-a",
      model: "model-a",
      input_tokens: 100,
      output_tokens: 20,
      reasoning_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      estimated_cost_usd: 0.01,
    })
    const prepared = TaskRouter.prepareReview(withAuthorUsage, { provider: "provider-b", model: "model-b" })
    const withReviewerUsage = TaskRouter.recordUsage(prepared, {
      session_id: "ses_reviewer",
      role: "reviewer",
      provider: "provider-a",
      model: "model-a",
      input_tokens: 75,
      output_tokens: 10,
      reasoning_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      estimated_cost_usd: 0.01,
    })
    const result = TaskRouter.recordReview(withReviewerUsage, {
      reviewer_session_id: "ses_reviewer",
      decision: "passed",
    })

    expect(result).toMatchObject({
      status: "ready_for_review",
      transition_reason: "review_unavailable",
      review: {
        status: "unavailable",
        independent: false,
        unavailable_reason: "reviewer_matches_author",
      },
    })
  })

  test("completes a task only after an independently recorded review passes", () => {
    const validated = TaskRouter.recordValidation(TaskRouter.start("AUTH-001", baseline), {
      role: "cheap-coder",
      checks: [passingCheck],
    })
    const withAuthorUsage = TaskRouter.recordUsage(validated, {
      session_id: "ses_cheap",
      role: "cheap-coder",
      provider: "provider-a",
      model: "model-a",
      input_tokens: 100,
      output_tokens: 20,
      reasoning_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      estimated_cost_usd: 0.01,
    })
    const prepared = TaskRouter.prepareReview(withAuthorUsage, { provider: "provider-b", model: "model-b" })
    const withReviewerUsage = TaskRouter.recordUsage(prepared, {
      session_id: "ses_reviewer",
      role: "reviewer",
      provider: "provider-b",
      model: "model-b",
      input_tokens: 75,
      output_tokens: 10,
      reasoning_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      estimated_cost_usd: 0.01,
    })
    const result = TaskRouter.recordReview(withReviewerUsage, {
      reviewer_session_id: "ses_reviewer",
      decision: "passed",
      summary: "No actionable findings.",
    })

    expect(result).toMatchObject({
      status: "completed",
      transition_reason: "review_passed",
      review: {
        status: "passed",
        reviewer_session_id: "ses_reviewer",
        independent: true,
      },
      review_history: [{ status: "passed" }],
    })
  })

  test("uses the remaining implementation attempt budget to repair review findings", () => {
    const validated = TaskRouter.recordValidation(TaskRouter.start("AUTH-001", baseline), {
      role: "cheap-coder",
      checks: [passingCheck],
    })
    const withAuthorUsage = TaskRouter.recordUsage(validated, {
      session_id: "ses_cheap",
      role: "cheap-coder",
      provider: "provider-a",
      model: "model-a",
      input_tokens: 100,
      output_tokens: 20,
      reasoning_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      estimated_cost_usd: 0.01,
    })
    const prepared = TaskRouter.prepareReview(withAuthorUsage, { provider: "provider-b", model: "model-b" })
    const withReviewerUsage = TaskRouter.recordUsage(prepared, {
      session_id: "ses_reviewer",
      role: "reviewer",
      provider: "provider-b",
      model: "model-b",
      input_tokens: 75,
      output_tokens: 10,
      reasoning_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      estimated_cost_usd: 0.01,
    })
    const reviewed = TaskRouter.recordReview(withReviewerUsage, {
      reviewer_session_id: "ses_reviewer",
      decision: "changes_requested",
      summary: "Add the missing validation branch.",
    })
    const repaired = TaskRouter.recordValidation(reviewed, {
      role: "cheap-coder",
      checks: [passingCheck],
    })

    expect(reviewed).toMatchObject({
      assigned_role: "cheap-coder",
      status: "retrying",
      transition_reason: "review_changes_requested",
    })
    expect(repaired).toMatchObject({
      status: "ready_for_review",
      review: { status: "not_started" },
      review_history: [{ status: "changes_requested" }],
    })
  })

  test("stops instead of creating an unbounded review repair loop", () => {
    const validated = TaskRouter.recordValidation(
      TaskRouter.start("AUTH-001", baseline, { ...TaskRouter.DEFAULT_POLICY, max_attempts: 1 }),
      {
        role: "cheap-coder",
        checks: [passingCheck],
      },
    )
    const withAuthorUsage = TaskRouter.recordUsage(validated, {
      session_id: "ses_cheap",
      role: "cheap-coder",
      provider: "provider-a",
      model: "model-a",
      input_tokens: 100,
      output_tokens: 20,
      reasoning_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      estimated_cost_usd: 0.01,
    })
    const prepared = TaskRouter.prepareReview(withAuthorUsage, { provider: "provider-b", model: "model-b" })
    const withReviewerUsage = TaskRouter.recordUsage(prepared, {
      session_id: "ses_reviewer",
      role: "reviewer",
      provider: "provider-b",
      model: "model-b",
      input_tokens: 75,
      output_tokens: 10,
      reasoning_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      estimated_cost_usd: 0.01,
    })
    const result = TaskRouter.recordReview(withReviewerUsage, {
      reviewer_session_id: "ses_reviewer",
      decision: "changes_requested",
    })

    expect(result).toMatchObject({ status: "blocked", transition_reason: "review_attempt_limit_reached" })
  })

  test("decodes Phase 4 state files without review fields", () => {
    const { review: _review, review_history: _reviewHistory, ...legacy } = TaskRouter.start("AUTH-001", baseline)

    expect(Schema.decodeUnknownSync(TaskRouter.State)(legacy)).toMatchObject({
      review: { status: "not_started" },
      review_history: [],
    })
  })
})
