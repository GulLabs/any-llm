/**
 * @gullabs/xai — model descriptor + registry tests.
 *
 * `assertRegistryInvariants` from `@gullabs/testing` does not exist yet on
 * this branch (a later phase-1 commit), so the equivalent invariant checks
 * described by the commit-3 task brief are hand-rolled here instead.
 *
 * @module
 */

import { describe, it, expect } from 'vitest'
import {
  Grok45ConfigSchema,
  grok45ModelDescriptor,
  xaiModelDescriptors,
  xaiRegistry,
} from './models.js'
import { xaiPricingSource } from './pricing.js'

describe('grok45ModelDescriptor', () => {
  it('is keyed by provider "xai" and model "grok-4.5"', () => {
    expect(grok45ModelDescriptor.provider).toBe('xai')
    expect(grok45ModelDescriptor.model).toBe('grok-4.5')
    expect(grok45ModelDescriptor.pricingFamily).toBe('grok-4.5')
  })

  it('capabilities match what the adapter actually enforces', () => {
    expect(grok45ModelDescriptor.capabilities).toMatchObject({
      reasoning: true,
      reasoningApi: 'level',
      admittedReasoningEfforts: ['low', 'high'],
      structuredOutput: true,
      nativeStructuredOutput: true,
      vision: true,
      audioInput: false,
      sampling: 'tunable',
      caching: { explicit: false, minTokens: 0 },
      grounding: false,
    })
    expect(grok45ModelDescriptor.capabilities?.serviceTiers).toBeUndefined()
  })

  it('configJsonSchema is structurally derived from Grok45ConfigSchema', () => {
    expect(grok45ModelDescriptor.configJsonSchema).toBeDefined()
    const jsonSchema = grok45ModelDescriptor.configJsonSchema as {
      properties?: Record<string, unknown>
    }
    expect(jsonSchema.properties).toBeDefined()
    expect(Object.keys(jsonSchema.properties ?? {})).toEqual(
      expect.arrayContaining([
        'temperature',
        'topP',
        'maxOutputTokens',
        'reasoning',
        'timeoutMs',
        'providerOptions',
      ]),
    )
  })

  it('uses the same schema instance as Grok45ConfigSchema', () => {
    expect(grok45ModelDescriptor.configSchema).toBe(Grok45ConfigSchema)
  })
})

describe('xaiModelDescriptors', () => {
  it('is pinned to exactly ["grok-4.5"]', () => {
    expect(xaiModelDescriptors.map((d) => d.model)).toEqual(['grok-4.5'])
  })

  it('is priced (xaiPricingSource knows grok-4.5)', () => {
    expect(xaiPricingSource().hasModel('grok-4.5')).toBe(true)
  })
})

describe('xaiRegistry', () => {
  it('resolves (xai, grok-4.5)', () => {
    const descriptor = xaiRegistry.resolve('xai', 'grok-4.5')
    expect(descriptor).toBeDefined()
    expect(descriptor?.model).toBe('grok-4.5')
    expect(descriptor?.provider).toBe('xai')
  })

  it('returns undefined for an unregistered model', () => {
    expect(xaiRegistry.resolve('xai', 'grok-99')).toBeUndefined()
  })

  it('validateConfig accepts a valid config via the Standard Schema surface', () => {
    const descriptor = xaiRegistry.resolve('xai', 'grok-4.5')
    const result = descriptor?.validateConfig['~standard'].validate({
      reasoning: { effort: 'high' },
    })
    expect(result).toBeDefined()
    if (result !== undefined && !(result instanceof Promise)) {
      expect(result.issues).toBeUndefined()
    }
  })

  it('validateConfig rejects an invalid config via the Standard Schema surface', () => {
    const descriptor = xaiRegistry.resolve('xai', 'grok-4.5')
    const result = descriptor?.validateConfig['~standard'].validate({
      reasoning: { effort: 'medium' },
    })
    expect(result).toBeDefined()
    if (result !== undefined && !(result instanceof Promise)) {
      expect(result.issues).toBeDefined()
    }
  })
})
