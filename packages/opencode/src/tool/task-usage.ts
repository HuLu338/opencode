import { TaskRouter } from "@opencode-ai/core/task-router"
import type { Provider } from "@/provider/provider"

type Tokens = Pick<
  TaskRouter.SessionUsage,
  "input_tokens" | "output_tokens" | "reasoning_tokens" | "cache_read_tokens" | "cache_write_tokens"
>

export function costMetadata(input: {
  tokens: Tokens
  sessionCost?: number
  configured?: TaskRouter.ModelPricing
  provider?: Provider.Model["cost"]
}) {
  if (input.configured) {
    return {
      estimated_cost_usd: TaskRouter.estimateCost(input.tokens, input.configured),
      cost_status: "estimated" as const,
      cost_source: "configured" as const,
    }
  }
  if (publishedPricing(input.provider) || (input.sessionCost ?? 0) > 0) {
    return {
      estimated_cost_usd: input.sessionCost ?? 0,
      cost_status: "estimated" as const,
      cost_source: "provider" as const,
    }
  }
  return {
    estimated_cost_usd: 0,
    cost_status: "unavailable" as const,
    cost_source: "unavailable" as const,
  }
}

export function publishedPricing(cost?: Provider.Model["cost"]) {
  if (!cost) return false
  return [
    cost.input,
    cost.output,
    cost.cache.read,
    cost.cache.write,
    ...(cost.tiers?.flatMap((item) => [item.input, item.output, item.cache.read, item.cache.write]) ?? []),
    ...(cost.experimentalOver200K
      ? [
          cost.experimentalOver200K.input,
          cost.experimentalOver200K.output,
          cost.experimentalOver200K.cache.read,
          cost.experimentalOver200K.cache.write,
        ]
      : []),
  ].some((price) => price > 0)
}
