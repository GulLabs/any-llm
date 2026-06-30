/**
 * Tests for ModelRegistry, createModelRegistry, isReasoningModel, and the
 * duplicate-adapter-id guard in createClient.
 *
 * @module
 */

import { describe, it, expect } from 'vitest'
import {
  createModelRegistry,
  geminiModelDescriptors,
  defaultGeminiRegistry,
  LlmError,
  createClient,
  geminiPricingSource,
} from './index.js'
import type { ModelDescriptor } from './index.js'
import { FakeAdapter, FakeIds, FakeClock } from '@gullabs/testing'

// ---------------------------------------------------------------------------
// createModelRegistry
// ---------------------------------------------------------------------------

describe('createModelRegistry', () => {
  const descriptors: ModelDescriptor[] = [
    { id: 'alpha', provider: 'p1' },
    { id: 'beta-v2', provider: 'p2' },
    { id: 'beta', provider: 'p3' },
  ]

  it('exact match returns the correct descriptor', () => {
    const registry = createModelRegistry(descriptors)
    expect(registry.resolve('alpha')?.provider).toBe('p1')
    expect(registry.resolve('beta-v2')?.provider).toBe('p2')
    expect(registry.resolve('beta')?.provider).toBe('p3')
  })

  it('prefix match: "beta-v2-001" matches "beta-v2" (longer prefix wins)', () => {
    const registry = createModelRegistry(descriptors)
    const resolved = registry.resolve('beta-v2-001')
    expect(resolved?.id).toBe('beta-v2')
    expect(resolved?.provider).toBe('p2')
  })

  it('prefix match: "beta-experimental" matches "beta" (shorter prefix)', () => {
    const registry = createModelRegistry(descriptors)
    const resolved = registry.resolve('beta-experimental')
    expect(resolved?.id).toBe('beta')
    expect(resolved?.provider).toBe('p3')
  })

  it('longest prefix wins over shorter prefix', () => {
    const registry = createModelRegistry([
      { id: 'gemini', provider: 'short' },
      { id: 'gemini-2.5', provider: 'medium' },
      { id: 'gemini-2.5-pro', provider: 'long' },
    ])
    expect(registry.resolve('gemini-2.5-pro-001')?.provider).toBe('long')
    expect(registry.resolve('gemini-2.5-flash')?.provider).toBe('medium')
    expect(registry.resolve('gemini-1.0')?.provider).toBe('short')
  })

  it('unknown model returns undefined', () => {
    const registry = createModelRegistry(descriptors)
    expect(registry.resolve('totally-unknown-model')).toBeUndefined()
    expect(registry.resolve('')).toBeUndefined()
  })

  it('throws LlmError on duplicate id', () => {
    expect(() =>
      createModelRegistry([
        { id: 'dup', provider: 'a' },
        { id: 'dup', provider: 'b' },
      ]),
    ).toThrow(LlmError)
  })

  it('duplicate throws with bad_request kind', () => {
    try {
      createModelRegistry([
        { id: 'dup', provider: 'a' },
        { id: 'dup', provider: 'b' },
      ])
      expect.fail('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(LlmError)
      expect((e as LlmError).kind).toBe('bad_request')
    }
  })
})

// ---------------------------------------------------------------------------
// geminiModelDescriptors
// ---------------------------------------------------------------------------

describe('geminiModelDescriptors', () => {
  it('contains all pricing-table models', () => {
    const ids = geminiModelDescriptors.map((d) => d.id)
    expect(ids).toContain('gemini-2.5-pro')
    expect(ids).toContain('gemini-2.5-flash')
    expect(ids).toContain('gemini-2.5-flash-lite')
    expect(ids).toContain('gemini-3.5-flash')
    expect(ids).toContain('gemini-3.1-flash-lite')
    expect(ids).toContain('gemini-3.1-pro-preview')
  })

  it('all descriptors have provider "google"', () => {
    for (const d of geminiModelDescriptors) {
      expect(d.provider).toBe('google')
    }
  })

  it('all descriptors have reasoning: true', () => {
    for (const d of geminiModelDescriptors) {
      expect(d.capabilities?.reasoning).toBe(true)
    }
  })

  it('all descriptors have structuredOutput: true', () => {
    for (const d of geminiModelDescriptors) {
      expect(d.capabilities?.structuredOutput).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// geminiModelDescriptors — cache minTokens
// ---------------------------------------------------------------------------

describe('geminiModelDescriptors — cache minTokens', () => {
  it('2.5-series models have caching minTokens 2048', () => {
    const twoPointFiveIds = ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite']
    for (const id of twoPointFiveIds) {
      const desc = geminiModelDescriptors.find((d) => d.id === id)
      expect(desc?.capabilities?.caching?.minTokens, `${id} minTokens`).toBe(2048)
    }
  })

  it('3.x-series models have caching minTokens 2048 (not 4096)', () => {
    const threeXIds = [
      'gemini-3.5-flash',
      'gemini-3.1-flash-lite',
      'gemini-3.1-pro-preview',
      'gemini-3-flash-preview',
    ]
    for (const id of threeXIds) {
      const desc = geminiModelDescriptors.find((d) => d.id === id)
      expect(desc?.capabilities?.caching?.minTokens, `${id} minTokens`).toBe(2048)
    }
  })

  it('all models have explicit caching enabled', () => {
    for (const d of geminiModelDescriptors) {
      expect(d.capabilities?.caching?.explicit, `${d.id} explicit`).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// createClient — duplicate adapter id guard
// ---------------------------------------------------------------------------

describe('createClient — duplicate adapter id', () => {
  const PRICING = geminiPricingSource()
  const SUCCESS_RESULT = {
    text: 'ok',
    usage: { inputTokens: 1, outputTokens: 1, details: {}, raw: null },
    model: 'gemini-2.5-pro',
    warnings: [] as [],
  }

  it('throws LlmError bad_request when two adapters share the same id', () => {
    const a1 = new FakeAdapter('google', SUCCESS_RESULT)
    const a2 = new FakeAdapter('google', SUCCESS_RESULT)

    expect(() =>
      createClient({
        adapters: [a1, a2],
        pricing: PRICING,
        clock: new FakeClock(),
        ids: new FakeIds(),
      }),
    ).toThrow(LlmError)
  })

  it('thrown error has kind bad_request and retryable false', () => {
    const a1 = new FakeAdapter('google', SUCCESS_RESULT)
    const a2 = new FakeAdapter('google', SUCCESS_RESULT)

    try {
      createClient({ adapters: [a1, a2], pricing: PRICING })
      expect.fail('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(LlmError)
      expect((e as LlmError).kind).toBe('bad_request')
      expect((e as LlmError).retryable).toBe(false)
    }
  })

  it('distinct adapter ids do not throw', () => {
    const a1 = new FakeAdapter('google', SUCCESS_RESULT)
    const a2 = new FakeAdapter('anthropic', SUCCESS_RESULT)

    expect(() =>
      createClient({
        adapters: [a1, a2],
        pricing: PRICING,
        clock: new FakeClock(),
        ids: new FakeIds(),
      }),
    ).not.toThrow()
  })
})
