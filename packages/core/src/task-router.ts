export * as TaskRouter from "./task-router"

import { Effect, Schema } from "effect"
import { NonNegativeInt, PositiveInt } from "./schema"

const LARGE_CONTEXT_FILE_THRESHOLD = 8

export const TaskType = Schema.Literals([
  "architecture",
  "implementation",
  "bugfix",
  "refactor",
  "documentation",
  "configuration",
  "testing",
  "review",
  "security",
  "migration",
  "contract",
  "unknown",
])
export type TaskType = typeof TaskType.Type

export const Level = Schema.Literals(["low", "medium", "high"])
export type Level = typeof Level.Type

export const Size = Schema.Literals(["small", "medium", "large"])
export type Size = typeof Size.Type

export const TestAvailability = Schema.Literals(["none", "partial", "good"])
export type TestAvailability = typeof TestAvailability.Type

export const RequirementsClarity = Schema.Literals(["clear", "unclear"])
export type RequirementsClarity = typeof RequirementsClarity.Type

export const Role = Schema.Literals(["architect", "cheap-coder", "strong-coder", "reviewer"])
export type Role = typeof Role.Type

export const TaskID = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/))
export type TaskID = typeof TaskID.Type

export const Reason = Schema.Literals([
  "review_request",
  "architecture_or_unclear",
  "critical_domain",
  "high_risk",
  "high_complexity",
  "large_scope",
  "repeated_failures",
  "large_context_many_files",
  "medium_risk_without_tests",
  "cheap_first",
])
export type Reason = typeof Reason.Type

export const Input = Schema.Struct({
  task_type: TaskType.annotate({ description: "The primary kind of work requested" }),
  complexity: Level.annotate({ description: "Reasoning and implementation complexity" }),
  risk: Level.annotate({ description: "Impact if the implementation is wrong" }),
  scope: Size.annotate({ description: "Estimated breadth of the change" }),
  context_size: Size.annotate({ description: "Estimated repository context needed" }),
  number_of_files: NonNegativeInt.annotate({ description: "Estimated number of files affected" }),
  test_availability: TestAvailability.annotate({ description: "Quality of existing automated validation" }),
  previous_failures: NonNegativeInt.annotate({ description: "Prior failed implementation or validation attempts" }),
  requirements_clarity: RequirementsClarity.annotate({ description: "Whether the requested behavior is unambiguous" }),
})
export type Input = typeof Input.Type

export const Decision = Schema.Struct({
  role: Role,
  reason: Reason,
  review_required: Schema.Boolean,
})
export type Decision = typeof Decision.Type

export const Policy = Schema.Struct({
  max_attempts: PositiveInt.annotate({ description: "Maximum implementation attempts for one task" }),
  max_escalations: NonNegativeInt.annotate({ description: "Maximum role escalations for one task" }),
  max_cost_usd: Schema.optional(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))).annotate({
    description: "Optional estimated USD budget; omitted means tracking without a cost cap",
  }),
  cheap_coder_failures_before_escalation: PositiveInt.annotate({
    description: "Failed Cheap Coder validations before escalating to Strong Coder",
  }),
  strong_coder_failures_before_human: PositiveInt.annotate({
    description: "Failed Strong Coder validations before stopping for human direction",
  }),
})
export type Policy = typeof Policy.Type

export const PolicyConfig = Schema.Struct({
  max_attempts: Schema.optional(PositiveInt),
  max_escalations: Schema.optional(NonNegativeInt),
  max_cost_usd: Schema.optional(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
  cheap_coder_failures_before_escalation: Schema.optional(PositiveInt),
  strong_coder_failures_before_human: Schema.optional(PositiveInt),
})
export type PolicyConfig = typeof PolicyConfig.Type

export const DEFAULT_POLICY: Policy = {
  max_attempts: 3,
  max_escalations: 1,
  cheap_coder_failures_before_escalation: 2,
  strong_coder_failures_before_human: 2,
}

export const CheckStatus = Schema.Literals(["passed", "failed", "unavailable"])
export type CheckStatus = typeof CheckStatus.Type

export const ValidationCheck = Schema.Struct({
  name: Schema.String.annotate({ description: "What was validated, such as focused tests or typecheck" }),
  command: Schema.String.annotate({ description: "The exact command that was run" }),
  status: CheckStatus,
  summary: Schema.optional(Schema.String).annotate({ description: "Short outcome or failure summary" }),
})
export type ValidationCheck = typeof ValidationCheck.Type

const CurrencyAmount = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))

export const SessionUsage = Schema.Struct({
  session_id: Schema.String,
  role: Role,
  provider: Schema.String,
  model: Schema.String,
  input_tokens: NonNegativeInt,
  output_tokens: NonNegativeInt,
  reasoning_tokens: NonNegativeInt,
  cache_read_tokens: NonNegativeInt,
  cache_write_tokens: NonNegativeInt,
  estimated_cost_usd: CurrencyAmount,
})
export type SessionUsage = typeof SessionUsage.Type

export const ModelIdentity = Schema.Struct({
  provider: Schema.String,
  model: Schema.String,
})
export type ModelIdentity = typeof ModelIdentity.Type

export const ReviewStatus = Schema.Literals([
  "not_started",
  "in_progress",
  "passed",
  "changes_requested",
  "unavailable",
])
export type ReviewStatus = typeof ReviewStatus.Type

export const ReviewUnavailableReason = Schema.Literals([
  "author_model_unknown",
  "reviewer_model_unconfigured",
  "reviewer_model_unknown",
  "reviewer_matches_author",
])
export type ReviewUnavailableReason = typeof ReviewUnavailableReason.Type

export const Review = Schema.Struct({
  status: ReviewStatus,
  author: Schema.optional(ModelIdentity),
  reviewer: Schema.optional(ModelIdentity),
  reviewer_session_id: Schema.optional(Schema.String),
  independent: Schema.optional(Schema.Boolean),
  summary: Schema.optional(Schema.String),
  unavailable_reason: Schema.optional(ReviewUnavailableReason),
})
export type Review = typeof Review.Type

const DEFAULT_REVIEW: Review = { status: "not_started" }

export const Attempt = Schema.Struct({
  role: Role,
  checks: Schema.Array(ValidationCheck),
  result: Schema.Literals(["passed", "failed"]),
  summary: Schema.optional(Schema.String),
})
export type Attempt = typeof Attempt.Type

export const StateStatus = Schema.Literals([
  "ready",
  "retrying",
  "needs_validation",
  "ready_for_review",
  "completed",
  "blocked",
])
export type StateStatus = typeof StateStatus.Type

export const TransitionReason = Schema.Literals([
  "validation_passed",
  "validation_incomplete",
  "retry_same_role",
  "cheap_coder_escalation",
  "max_attempts_reached",
  "max_escalations_reached",
  "max_cost_reached",
  "strong_coder_failure_limit",
  "reviewer_assigned",
  "review_passed",
  "review_changes_requested",
  "review_attempt_limit_reached",
  "review_unavailable",
])
export type TransitionReason = typeof TransitionReason.Type

export const State = Schema.Struct({
  version: Schema.Literal(1),
  task_id: TaskID,
  input: Input,
  policy: Policy,
  initial_decision: Decision,
  assigned_role: Role,
  attempts: Schema.Array(Attempt),
  usage: Schema.Array(SessionUsage).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  review: Review.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_REVIEW))),
  review_history: Schema.Array(Review).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  escalations: NonNegativeInt,
  status: StateStatus,
  transition_reason: Schema.optional(TransitionReason),
})
export type State = typeof State.Type

export const RecordValidation = Schema.Struct({
  role: Role,
  checks: Schema.Array(ValidationCheck),
  summary: Schema.optional(Schema.String),
})
export type RecordValidation = typeof RecordValidation.Type

export const RecordReview = Schema.Struct({
  reviewer_session_id: Schema.String,
  decision: Schema.Literals(["passed", "changes_requested"]),
  summary: Schema.optional(Schema.String),
})
export type RecordReview = typeof RecordReview.Type

export type CostSummary = {
  task_id: TaskID
  status: StateStatus
  routing: Decision
  attempts: number
  escalations: number
  review: Review
  review_cycles: number
  max_cost_usd?: number
  estimated_cost_usd: number
  remaining_cost_usd?: number
  tokens: {
    input: number
    output: number
    reasoning: number
    cache_read: number
    cache_write: number
  }
  usage: Array<{
    role: Role
    provider: string
    model: string
    sessions: number
    estimated_cost_usd: number
    input_tokens: number
    output_tokens: number
    reasoning_tokens: number
    cache_read_tokens: number
    cache_write_tokens: number
  }>
}

export function resolvePolicy(input?: PolicyConfig): Policy {
  return { ...DEFAULT_POLICY, ...input }
}

export function route(input: Input, policy = DEFAULT_POLICY): Decision {
  if (input.task_type === "review") return decision("reviewer", "review_request", false)
  if (input.task_type === "architecture" || input.requirements_clarity === "unclear") {
    return decision("architect", "architecture_or_unclear", false)
  }
  if (["security", "migration", "contract"].includes(input.task_type)) {
    return decision("strong-coder", "critical_domain", true)
  }
  if (input.risk === "high") return decision("strong-coder", "high_risk", true)
  if (input.complexity === "high") return decision("strong-coder", "high_complexity", requiresReview(input))
  if (input.scope === "large") return decision("strong-coder", "large_scope", requiresReview(input))
  if (input.previous_failures >= policy.cheap_coder_failures_before_escalation) {
    return decision("strong-coder", "repeated_failures", requiresReview(input))
  }
  if (input.context_size === "large" && input.number_of_files >= LARGE_CONTEXT_FILE_THRESHOLD) {
    return decision("strong-coder", "large_context_many_files", requiresReview(input))
  }
  if (input.risk === "medium" && input.test_availability === "none") {
    return decision("strong-coder", "medium_risk_without_tests", true)
  }
  return decision("cheap-coder", "cheap_first", requiresReview(input))
}

export function start(taskID: TaskID, input: Input, policy = DEFAULT_POLICY): State {
  const initialDecision = route(input, policy)
  return {
    version: 1,
    task_id: taskID,
    input,
    policy,
    initial_decision: initialDecision,
    assigned_role: initialDecision.role,
    attempts: [],
    usage: [],
    review: DEFAULT_REVIEW,
    review_history: [],
    escalations: 0,
    status: "ready",
  }
}

export function assertConsistent(state: State): State {
  const latestAttempt = state.attempts.at(-1)
  if (["ready_for_review", "completed"].includes(state.status) && latestAttempt?.result !== "passed") {
    throw new Error(`Task ${state.task_id} cannot be ${state.status} without a passed validation attempt`)
  }
  if (state.status === "completed" && state.review.status !== "passed") {
    throw new Error(`Task ${state.task_id} cannot be completed without a passed independent review`)
  }
  if (state.review.status === "passed" && state.review.independent !== true) {
    throw new Error(`Task ${state.task_id} cannot record a passed non-independent review`)
  }
  if (state.review.status === "in_progress" && state.status !== "ready_for_review") {
    throw new Error(`Task ${state.task_id} cannot have a review in progress while ${state.status}`)
  }
  return state
}

export function recordValidation(state: State, input: RecordValidation): State {
  if (state.status === "blocked" || state.status === "ready_for_review" || state.status === "completed") {
    throw new Error(`Task ${state.task_id} cannot accept validation while ${state.status}`)
  }
  if (input.role !== "cheap-coder" && input.role !== "strong-coder") {
    throw new Error(`Only coding roles can record implementation validation, received ${input.role}`)
  }
  if (state.assigned_role !== input.role) {
    throw new Error(`Task ${state.task_id} is assigned to ${state.assigned_role}, not ${input.role}`)
  }
  if (input.checks.length === 0) throw new Error("At least one deterministic validation check is required")

  const hasFailure = input.checks.some((check) => check.status === "failed")
  const hasUnavailable = input.checks.some((check) => check.status === "unavailable")
  if (!hasFailure && hasUnavailable) {
    return {
      ...state,
      status: "needs_validation",
      transition_reason: "validation_incomplete",
    }
  }

  const attempt: Attempt = {
    role: input.role,
    checks: input.checks,
    result: hasFailure ? "failed" : "passed",
    ...(input.summary ? { summary: input.summary } : {}),
  }
  const attempts: Attempt[] = [...state.attempts, attempt]
  if (!hasFailure) {
    return {
      ...state,
      attempts,
      review: DEFAULT_REVIEW,
      status: "ready_for_review",
      transition_reason: "validation_passed",
    }
  }
  if (attempts.length >= state.policy.max_attempts) {
    return blocked(state, attempts, "max_attempts_reached")
  }

  const failures = attempts.filter((attempt) => attempt.role === input.role && attempt.result === "failed").length
  if (input.role === "cheap-coder" && failures >= state.policy.cheap_coder_failures_before_escalation) {
    if (state.escalations >= state.policy.max_escalations) return blocked(state, attempts, "max_escalations_reached")
    return {
      ...state,
      attempts,
      assigned_role: "strong-coder",
      escalations: state.escalations + 1,
      status: "retrying",
      transition_reason: "cheap_coder_escalation",
    }
  }
  if (input.role === "strong-coder" && failures >= state.policy.strong_coder_failures_before_human) {
    return blocked(state, attempts, "strong_coder_failure_limit")
  }
  return {
    ...state,
    attempts,
    status: "retrying",
    transition_reason: "retry_same_role",
  }
}

export function recordUsage(state: State, input: SessionUsage): State {
  const existing = state.usage.find((usage) => usage.session_id === input.session_id)
  if (existing && existing.role !== input.role) {
    throw new Error(`Session ${input.session_id} is already tracked as ${existing.role}`)
  }
  const next = { ...state, usage: [...state.usage.filter((item) => item.session_id !== input.session_id), input] }
  if (next.policy.max_cost_usd === undefined || summarize(next).estimated_cost_usd <= next.policy.max_cost_usd) {
    return next
  }
  if (next.review.status === "in_progress" || next.status === "completed") return next
  return { ...next, status: "blocked", transition_reason: "max_cost_reached" }
}

export function prepareReview(state: State, reviewer?: ModelIdentity): State {
  if (state.status !== "ready_for_review") {
    throw new Error(`Task ${state.task_id} cannot start review while ${state.status}`)
  }
  if (state.review.status === "in_progress") {
    throw new Error(`Task ${state.task_id} already has a review in progress`)
  }

  const author = reviewAuthor(state)
  if (!author) return reviewUnavailable(state, "author_model_unknown")
  if (!reviewer) return reviewUnavailable(state, "reviewer_model_unconfigured", author)
  if (!knownModel(reviewer)) return reviewUnavailable(state, "reviewer_model_unknown", author, reviewer)
  if (sameModel(author, reviewer)) return reviewUnavailable(state, "reviewer_matches_author", author, reviewer)

  return {
    ...state,
    review: {
      status: "in_progress",
      author,
      reviewer,
      independent: true,
    },
    transition_reason: "reviewer_assigned",
  }
}

export function recordReview(state: State, input: RecordReview): State {
  if (state.status !== "ready_for_review" || state.review.status !== "in_progress") {
    throw new Error(`Task ${state.task_id} cannot record a review while ${state.status}`)
  }

  const usage = state.usage.find((item) => item.session_id === input.reviewer_session_id)
  if (!usage || usage.role !== "reviewer") {
    throw new Error(`Reviewer session ${input.reviewer_session_id} has not been recorded`)
  }

  const reviewer: ModelIdentity = { provider: usage.provider, model: usage.model }
  const author = state.review.author
  if (!author || !knownModel(reviewer)) {
    return reviewUnavailable(state, "reviewer_model_unknown", author, reviewer, input.reviewer_session_id)
  }
  if (sameModel(author, reviewer)) {
    return reviewUnavailable(state, "reviewer_matches_author", author, reviewer, input.reviewer_session_id)
  }

  const review: Review = {
    status: input.decision,
    author,
    reviewer,
    reviewer_session_id: input.reviewer_session_id,
    independent: true,
    ...(input.summary ? { summary: input.summary } : {}),
  }
  const review_history = [...state.review_history, review]
  if (input.decision === "passed") {
    return {
      ...state,
      review,
      review_history,
      status: "completed",
      transition_reason: "review_passed",
    }
  }
  if (state.attempts.length >= state.policy.max_attempts) {
    return {
      ...state,
      review,
      review_history,
      status: "blocked",
      transition_reason: "review_attempt_limit_reached",
    }
  }
  return {
    ...state,
    review,
    review_history,
    status: "retrying",
    transition_reason: "review_changes_requested",
  }
}

export function summarize(state: State): CostSummary {
  const tokens = state.usage.reduce(
    (total, usage) => ({
      input: total.input + usage.input_tokens,
      output: total.output + usage.output_tokens,
      reasoning: total.reasoning + usage.reasoning_tokens,
      cache_read: total.cache_read + usage.cache_read_tokens,
      cache_write: total.cache_write + usage.cache_write_tokens,
    }),
    { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
  )
  const usage = Object.values(
    state.usage.reduce<Record<string, CostSummary["usage"][number]>>((result, item) => {
      const key = [item.role, item.provider, item.model].join("\u0000")
      const current = result[key]
      result[key] = current
        ? {
            ...current,
            sessions: current.sessions + 1,
            estimated_cost_usd: current.estimated_cost_usd + item.estimated_cost_usd,
            input_tokens: current.input_tokens + item.input_tokens,
            output_tokens: current.output_tokens + item.output_tokens,
            reasoning_tokens: current.reasoning_tokens + item.reasoning_tokens,
            cache_read_tokens: current.cache_read_tokens + item.cache_read_tokens,
            cache_write_tokens: current.cache_write_tokens + item.cache_write_tokens,
          }
        : {
            role: item.role,
            provider: item.provider,
            model: item.model,
            sessions: 1,
            estimated_cost_usd: item.estimated_cost_usd,
            input_tokens: item.input_tokens,
            output_tokens: item.output_tokens,
            reasoning_tokens: item.reasoning_tokens,
            cache_read_tokens: item.cache_read_tokens,
            cache_write_tokens: item.cache_write_tokens,
          }
      return result
    }, {}),
  ).toSorted((a, b) => {
    const left = [a.role, a.provider, a.model].join("\u0000")
    const right = [b.role, b.provider, b.model].join("\u0000")
    return left.localeCompare(right)
  })
  const estimatedCost = state.usage.reduce((total, item) => total + item.estimated_cost_usd, 0)
  const maxCost = state.policy.max_cost_usd

  return {
    task_id: state.task_id,
    status: state.status,
    routing: state.initial_decision,
    attempts: state.attempts.length,
    escalations: state.escalations,
    review: state.review,
    review_cycles: state.review_history.length,
    ...(maxCost === undefined
      ? {}
      : { max_cost_usd: maxCost, remaining_cost_usd: Math.max(0, maxCost - estimatedCost) }),
    estimated_cost_usd: estimatedCost,
    tokens,
    usage,
  }
}

function blocked(state: State, attempts: Attempt[], reason: TransitionReason): State {
  return {
    ...state,
    attempts,
    status: "blocked",
    transition_reason: reason,
  }
}

function reviewAuthor(state: State): ModelIdentity | undefined {
  const attempt = state.attempts.at(-1)
  if (!attempt) return undefined
  const usage = state.usage.findLast((item) => item.role === attempt.role)
  if (!usage) return undefined
  const author = { provider: usage.provider, model: usage.model }
  if (!knownModel(author)) return undefined
  return author
}

function reviewUnavailable(
  state: State,
  reason: ReviewUnavailableReason,
  author?: ModelIdentity,
  reviewer?: ModelIdentity,
  reviewerSessionID?: string,
): State {
  const review: Review = {
    status: "unavailable",
    ...(author ? { author } : {}),
    ...(reviewer ? { reviewer } : {}),
    ...(reviewerSessionID ? { reviewer_session_id: reviewerSessionID } : {}),
    independent: false,
    unavailable_reason: reason,
  }
  return {
    ...state,
    review,
    review_history: [...state.review_history, review],
    transition_reason: "review_unavailable",
  }
}

function knownModel(model: ModelIdentity) {
  return model.provider !== "unknown" && model.model !== "unknown"
}

function sameModel(left: ModelIdentity, right: ModelIdentity) {
  return left.provider === right.provider && left.model === right.model
}

function requiresReview(input: Input) {
  return input.risk === "high" || ["security", "migration", "contract"].includes(input.task_type)
}

function decision(role: Role, reason: Reason, review_required: boolean): Decision {
  return { role, reason, review_required }
}
