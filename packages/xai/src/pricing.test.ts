/**
 * Tests for xai pricing computation (`computeXaiCost` / `xaiPricingSource`).
 *
 * Covers standard-tier cost math, the >200k gt200k boundary, cached-token
 * math, an unpriced/unknown-model path, and `hasModel`/`listModels`.
 *
 * @module
 */

import { describe, it, expect } from 'vitest'
import type { Usage } from '@gullabs/core'
import {
  computeXaiCost,
  xaiPricingSource,
  xaiPricingVersion,
  XAI_PRICING,
} from './pricing.js'

function makeUsage(fields: {
  inputTokens: number
  outputTokens: number
  cachedInputTokens?: number
}): Usage {
  return {
    ...fields,
    details: {},
    raw: null,
  }
}

describe('computeXaiCost — standard tier', () => {
  it('computes exact µUSD for a small usage sample (grok-4.5)', () => {
    // input: 1000 tokens, 200 cached, output: 500 tokens
    const usage = makeUsage({
      inputTokens: 1000,
      outputTokens: 500,
      cachedInputTokens: 200,
    })
    const cost = computeXaiCost('grok-4.5', usage)

    // billableInput = 1000 - 200 = 800
    // inputCost = round(800 * 2_000_000 / 1_000_000) = 1600
    // cachedCost = round(200 * 500_000 / 1_000_000) = 100
    // outputCost = round(500 * 6_000_000 / 1_000_000) = 3000
    expect(cost.confidence).toBe('exact')
    expect(cost.pricingVersion).toBe(xaiPricingVersion)
    expect(cost.details).toEqual({ input: 1600, cached: 100, output: 3000 })
    expect(cost.microUsd).toBe(1600 + 100 + 3000)
    expect(cost.usd).toBe((1600 + 100 + 3000) / 1_000_000)
  })

  it('sum invariant: details.input + details.cached + details.output === microUsd', () => {
    const usage = makeUsage({
      inputTokens: 12345,
      outputTokens: 678,
      cachedInputTokens: 111,
    })
    const cost = computeXaiCost('grok-4.5', usage)
    expect(cost.details.input + cost.details.cached + cost.details.output).toBe(
      cost.microUsd,
    )
  })
})

describe('computeXaiCost — >200k gt200k boundary', () => {
  it('applies standard rates at exactly 200,000 gross input tokens', () => {
    const usage = makeUsage({
      inputTokens: 200_000,
      outputTokens: 100,
      cachedInputTokens: 0,
    })
    const cost = computeXaiCost('grok-4.5', usage)
    // standard inputPerM = 2_000_000 -> inputCost = round(200000 * 2_000_000 / 1e6) = 400_000
    expect(cost.details.input).toBe(400_000)
  })

  it('applies gt200k rates at 200,001 gross input tokens', () => {
    const usage = makeUsage({
      inputTokens: 200_001,
      outputTokens: 100,
      cachedInputTokens: 0,
    })
    const cost = computeXaiCost('grok-4.5', usage)
    // gt200k inputPerM = 4_000_000 -> inputCost = round(200001 * 4_000_000 / 1e6) = 800_004
    expect(cost.details.input).toBe(800_004)
  })
})

describe('computeXaiCost — cached-token math', () => {
  it('bills cached tokens at cachedPerM and non-cached billable input at inputPerM', () => {
    // Below the 200k long-context threshold, so standard rates apply.
    const usage = makeUsage({
      inputTokens: 150_000,
      outputTokens: 0,
      cachedInputTokens: 150_000,
    })
    const cost = computeXaiCost('grok-4.5', usage)
    // billableInput = 0, cachedCost = round(150_000 * 500_000 / 1e6) = 75_000
    expect(cost.details.input).toBe(0)
    expect(cost.details.cached).toBe(75_000)
    expect(cost.details.output).toBe(0)
  })
})

describe('computeXaiCost — unpriced paths', () => {
  it('returns microUsd: null for an unknown model', () => {
    const usage = makeUsage({ inputTokens: 100, outputTokens: 50 })
    const cost = computeXaiCost('grok-99', usage)
    expect(cost.microUsd).toBeNull()
    expect(cost.usd).toBeNull()
    expect(cost.confidence).toBe('estimated')
    expect(cost.unpricedReason).toMatch(/grok-99/)
  })

  it('returns microUsd: null when a tier is supplied (xai has no tiers)', () => {
    const usage = makeUsage({ inputTokens: 100, outputTokens: 50 })
    const cost = computeXaiCost('grok-4.5', usage, 'flex')
    expect(cost.microUsd).toBeNull()
    expect(cost.unpricedReason).toMatch(/flex/)
  })

  it('does NOT prefix-match aliases — grok-4.5-latest is unpriced', () => {
    // Alias ids are deliberately not registered/priced (reject-don't-map);
    // exact-match-only lookup prevents `grok-4.5-latest` from silently
    // pricing as `grok-4.5`.
    const usage = makeUsage({ inputTokens: 1_000_000, outputTokens: 1_000 })
    const cost = computeXaiCost('grok-4.5-latest', usage)
    expect(cost.microUsd).toBeNull()
    expect(cost.usd).toBeNull()
    expect(cost.confidence).toBe('estimated')
    expect(cost.unpricedReason).toMatch(/grok-4\.5-latest/)
  })

  it('does NOT prefix-match grok-build-latest either', () => {
    const usage = makeUsage({ inputTokens: 100, outputTokens: 50 })
    const cost = computeXaiCost('grok-build-latest', usage)
    expect(cost.microUsd).toBeNull()
    expect(cost.unpricedReason).toMatch(/grok-build-latest/)
  })
})

describe('xaiPricingSource', () => {
  it('hasModel is true for grok-4.5 and false for an unknown model', () => {
    const source = xaiPricingSource()
    expect(source.hasModel('grok-4.5')).toBe(true)
    expect(source.hasModel('grok-99')).toBe(false)
  })

  it('hasModel is exact-match only — aliases are not recognized', () => {
    const source = xaiPricingSource()
    expect(source.hasModel('grok-4.5-latest')).toBe(false)
    expect(source.hasModel('grok-build-latest')).toBe(false)
  })

  it('listModels returns the XAI_PRICING keys', () => {
    const source = xaiPricingSource()
    expect(source.listModels()).toEqual(Object.keys(XAI_PRICING))
  })

  it('version matches xaiPricingVersion', () => {
    expect(xaiPricingSource().version).toBe(xaiPricingVersion)
  })

  it('price() delegates to computeXaiCost', () => {
    const usage = makeUsage({ inputTokens: 1000, outputTokens: 500 })
    const cost = xaiPricingSource().price('grok-4.5', usage)
    expect(cost.confidence).toBe('exact')
  })
})
