import { describe, expect, test } from "bun:test"
import { costMetadata, publishedPricing } from "@/tool/task-usage"

const tokens = {
  input_tokens: 1_000,
  output_tokens: 100,
  reasoning_tokens: 50,
  cache_read_tokens: 500,
  cache_write_tokens: 10,
}

const zero = {
  input: 0,
  output: 0,
  cache: { read: 0, write: 0 },
}

describe("task usage cost metadata", () => {
  test("treats explicitly configured zero pricing as a known estimate", () => {
    expect(costMetadata({ tokens, configured: { input: 0, output: 0 }, provider: zero })).toEqual({
      estimated_cost_usd: 0,
      cost_status: "estimated",
      cost_source: "configured",
    })
  })

  test("does not mistake normalized all-zero provider defaults for published pricing", () => {
    expect(publishedPricing(zero)).toBe(false)
    expect(costMetadata({ tokens, sessionCost: 0, provider: zero })).toEqual({
      estimated_cost_usd: 0,
      cost_status: "unavailable",
      cost_source: "unavailable",
    })
  })

  test("accepts non-zero provider pricing and the persisted session estimate", () => {
    const provider = { input: 1, output: 4, cache: { read: 0.25, write: 1 } }

    expect(publishedPricing(provider)).toBe(true)
    expect(costMetadata({ tokens, sessionCost: 0.002, provider })).toEqual({
      estimated_cost_usd: 0.002,
      cost_status: "estimated",
      cost_source: "provider",
    })
  })

  test("accepts a non-zero provider-reported session cost even without catalog pricing", () => {
    expect(costMetadata({ tokens, sessionCost: 0.003, provider: zero })).toEqual({
      estimated_cost_usd: 0.003,
      cost_status: "estimated",
      cost_source: "provider",
    })
  })
})
