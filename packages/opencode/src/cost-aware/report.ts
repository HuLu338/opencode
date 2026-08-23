import { TaskRouter } from "@opencode-ai/core/task-router"

export type Entry = {
  state: TaskRouter.State
  filepath: string
  updated_at: number
}

export type InvalidState = {
  filepath: string
  error: string
}

export function buildTaskReport(entries: Entry[], invalid_states: InvalidState[] = []) {
  const sorted = entries.toSorted((left, right) => right.updated_at - left.updated_at)
  const usage = sorted.flatMap((entry) => entry.state.usage.map((item) => ({ ...item, task_id: entry.state.task_id })))
  const cost_status = aggregateCostStatus(usage.map((item) => item.cost_status))
  const statuses = Object.fromEntries(
    TaskRouter.StateStatus.literals.map((status) => [
      status,
      sorted.filter((entry) => entry.state.status === status).length,
    ]),
  ) as Record<TaskRouter.StateStatus, number>
  const cost_sources = Object.fromEntries(
    TaskRouter.CostSource.literals.map((source) => [
      source,
      usage.filter((item) => item.cost_source === source).length,
    ]),
  ) as Record<TaskRouter.CostSource, number>
  const tokens = usage.reduce(
    (total, item) => ({
      input: total.input + item.input_tokens,
      output: total.output + item.output_tokens,
      reasoning: total.reasoning + item.reasoning_tokens,
      cache_read: total.cache_read + item.cache_read_tokens,
      cache_write: total.cache_write + item.cache_write_tokens,
    }),
    { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
  )
  const models = Object.values(
    usage.reduce<
      Record<
        string,
        {
          role: TaskRouter.Role
          provider: string
          model: string
          task_ids: Set<string>
          sessions: number
          estimated_cost_usd: number
          cost_statuses: TaskRouter.CostStatus[]
          tokens: typeof tokens
        }
      >
    >((result, item) => {
      const key = [item.role, item.provider, item.model].join("\0")
      const current = result[key] ?? {
        role: item.role,
        provider: item.provider,
        model: item.model,
        task_ids: new Set<string>(),
        sessions: 0,
        estimated_cost_usd: 0,
        cost_statuses: [],
        tokens: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
      }
      current.task_ids.add(item.task_id)
      current.sessions += 1
      current.estimated_cost_usd += item.estimated_cost_usd
      current.cost_statuses.push(item.cost_status)
      current.tokens.input += item.input_tokens
      current.tokens.output += item.output_tokens
      current.tokens.reasoning += item.reasoning_tokens
      current.tokens.cache_read += item.cache_read_tokens
      current.tokens.cache_write += item.cache_write_tokens
      result[key] = current
      return result
    }, {}),
  )
    .map((item) => ({
      role: item.role,
      provider: item.provider,
      model: item.model,
      tasks: item.task_ids.size,
      sessions: item.sessions,
      estimated_cost_usd: item.estimated_cost_usd,
      cost_status: aggregateCostStatus(item.cost_statuses),
      tokens: item.tokens,
    }))
    .toSorted((left, right) => {
      if (left.estimated_cost_usd !== right.estimated_cost_usd) {
        return right.estimated_cost_usd - left.estimated_cost_usd
      }
      return `${left.role}/${left.provider}/${left.model}`.localeCompare(
        `${right.role}/${right.provider}/${right.model}`,
      )
    })

  return {
    tasks: sorted.length,
    statuses,
    attempts: sorted.reduce((total, entry) => total + entry.state.attempts.length, 0),
    escalations: sorted.reduce((total, entry) => total + entry.state.escalations, 0),
    review_cycles: sorted.reduce((total, entry) => total + entry.state.review_history.length, 0),
    estimated_cost_usd: usage.reduce((total, item) => total + item.estimated_cost_usd, 0),
    cost_status,
    cost_sources,
    budget: {
      configured_tasks: sorted.filter((entry) => entry.state.policy.max_cost_usd !== undefined).length,
      blocked_tasks: sorted.filter((entry) =>
        ["max_cost_reached", "cost_unavailable"].includes(entry.state.transition_reason ?? ""),
      ).length,
    },
    tokens,
    models,
    history: sorted.map((entry) => {
      const summary = TaskRouter.summarize(entry.state)
      return {
        task_id: entry.state.task_id,
        updated_at: entry.updated_at,
        status: entry.state.status,
        assigned_role: entry.state.assigned_role,
        routing_reason: entry.state.initial_decision.reason,
        attempts: entry.state.attempts.length,
        escalations: entry.state.escalations,
        review_status: entry.state.review.status,
        estimated_cost_usd: summary.estimated_cost_usd,
        cost_status: summary.cost_status,
        max_cost_usd: summary.max_cost_usd,
        remaining_cost_usd: summary.remaining_cost_usd,
        tokens: summary.tokens,
        usage: summary.usage,
        transition_reason: entry.state.transition_reason,
        state_path: entry.filepath,
      }
    }),
    invalid_states,
  }
}

export function formatTaskReport(report: ReturnType<typeof buildTaskReport>, limit = 20) {
  const lines = [
    "Cost-aware task report",
    `Tasks: ${report.tasks} | completed: ${report.statuses.completed} | blocked: ${report.statuses.blocked} | active: ${report.tasks - report.statuses.completed - report.statuses.blocked}`,
    `Attempts: ${report.attempts} | escalations: ${report.escalations} | review cycles: ${report.review_cycles}`,
    `Estimated cost: ${formatUsd(report.estimated_cost_usd)} | coverage: ${report.cost_status}`,
    `Cost sources: subscription=${report.cost_sources.subscription}, provider=${report.cost_sources.provider}, configured=${report.cost_sources.configured}, unavailable=${report.cost_sources.unavailable}`,
    `Tokens: input=${formatNumber(report.tokens.input)}, output=${formatNumber(report.tokens.output)}, reasoning=${formatNumber(report.tokens.reasoning)}, cache read=${formatNumber(report.tokens.cache_read)}, cache write=${formatNumber(report.tokens.cache_write)}`,
    `Budgets: configured=${report.budget.configured_tasks}, blocked=${report.budget.blocked_tasks}`,
    "",
    `Recent tasks (${Math.min(limit, report.history.length)} of ${report.history.length})`,
    "UPDATED             TASK                         STATUS             ROLE          COST       REVIEW",
    ...report.history
      .slice(0, limit)
      .map((item) =>
        [
          new Date(item.updated_at).toISOString().slice(0, 19).replace("T", " ").padEnd(19),
          item.task_id.slice(0, 28).padEnd(28),
          item.status.padEnd(18),
          item.assigned_role.padEnd(13),
          formatUsd(item.estimated_cost_usd).padStart(10),
          item.review_status,
        ].join("  "),
      ),
  ]

  if (report.models.length > 0) {
    lines.push("", "Role/model usage")
    lines.push(
      ...report.models.map(
        (item) =>
          `${item.role} ${item.provider}/${item.model}: tasks=${item.tasks}, sessions=${item.sessions}, cost=${formatUsd(item.estimated_cost_usd)} (${item.cost_status})`,
      ),
    )
  }
  if (report.invalid_states.length > 0) {
    lines.push("", `Invalid state files: ${report.invalid_states.length}`)
    lines.push(...report.invalid_states.map((item) => `- ${item.filepath}: ${item.error}`))
  }
  return lines.join("\n")
}

function aggregateCostStatus(statuses: TaskRouter.CostStatus[]) {
  if (statuses.length === 0 || statuses.every((status) => status === "estimated")) return "estimated" as const
  if (statuses.every((status) => status === "unavailable")) return "unavailable" as const
  return "partial" as const
}

function formatUsd(value: number) {
  if (value === 0) return "$0.0000"
  if (value < 0.0001) return "<$0.0001"
  return `$${value.toFixed(4)}`
}

function formatNumber(value: number) {
  return value.toLocaleString("en-US")
}
