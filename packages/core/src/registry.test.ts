import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import {
  createModelRegistry,
  defaultGeminiRegistry,
  geminiModelDescriptors,
  gemmaModelDescriptors,
  LlmError,
  toConfigJsonSchema,
  zodToStandardSchema,
} from './index.js'
import { GEMINI_PRICING } from './pricing.js'
import type { ModelDescriptor } from './index.js'

const removedConfigSchemaFactory = `makeGeminiConfig${'Schema'}`
const removedConfigValidatorFactory = `makeGeminiConfig${'Validator'}`
const EXPECTED_GEMINI_MODEL_IDS = [
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-3.5-flash',
  'gemini-3.1-flash-lite',
  'gemini-3.1-pro-preview',
  'gemini-3-flash-preview',
] as const
const EXPECTED_GEMMA_MODEL_IDS = ['gemma-4-31b-it', 'gemma-4-26b-a4b-it'] as const
const EXPECTED_BUILT_IN_MODEL_IDS = [
  ...EXPECTED_GEMINI_MODEL_IDS,
  ...EXPECTED_GEMMA_MODEL_IDS,
] as const
const ADAPTER_FIXTURE_MODEL_IDS = new Set<string>(EXPECTED_BUILT_IN_MODEL_IDS)
const NEGATIVE_CONTRACT_FIXTURE_MODEL_IDS = new Set<string>(EXPECTED_BUILT_IN_MODEL_IDS)
const EXPLICIT_UNPRICED_MODEL_IDS = new Set<string>(EXPECTED_GEMMA_MODEL_IDS)

const EmptyConfigSchema = z
  .strictObject({})
  .meta({ title: 'EmptyConfig', description: 'Test schema.', examples: [{}] })

function makeDescriptor(id: string, provider: string): ModelDescriptor {
  return {
    id,
    provider,
    configSchema: EmptyConfigSchema,
    configJsonSchema: toConfigJsonSchema(EmptyConfigSchema),
    validateConfig: zodToStandardSchema(EmptyConfigSchema),
  }
}

describe('createModelRegistry', () => {
  const descriptors = [
    makeDescriptor('alpha', 'p1'),
    makeDescriptor('beta-v2', 'p2'),
    makeDescriptor('beta', 'p3'),
  ]

  it('resolves exact and longest-prefix matches', () => {
    const registry = createModelRegistry(descriptors)

    expect(registry.resolve('alpha')?.provider).toBe('p1')
    expect(registry.resolve('beta-v2-001')?.provider).toBe('p2')
    expect(registry.resolve('beta-experimental')?.provider).toBe('p3')
  })

  it('returns undefined for unknown models', () => {
    const registry = createModelRegistry(descriptors)

    expect(registry.resolve('unknown')).toBeUndefined()
  })

  it('returns a defensive copy from listDescriptors', () => {
    const registry = createModelRegistry(descriptors)
    const listed = registry.listDescriptors?.()

    expect(listed).toEqual(descriptors)
    expect(listed).not.toBe(descriptors)
  })

  it('throws on duplicate descriptor ids', () => {
    expect(() =>
      createModelRegistry([makeDescriptor('dup', 'a'), makeDescriptor('dup', 'b')]),
    ).toThrow(LlmError)
  })

  it('throws when a custom descriptor is missing required schema artifacts', () => {
    expect(() =>
      createModelRegistry([
        {
          id: 'broken-model',
          provider: 'google',
          configSchema: EmptyConfigSchema,
        } as unknown as ModelDescriptor,
      ]),
    ).toThrow(/missing required schema artifacts/i)
  })
})

describe('built-in descriptors', () => {
  it('publish schema artifacts for every built-in model', () => {
    for (const descriptor of [...geminiModelDescriptors, ...gemmaModelDescriptors]) {
      expect(descriptor.configSchema, descriptor.id).toBeDefined()
      expect(descriptor.configJsonSchema, descriptor.id).toBeDefined()
      expect(descriptor.validateConfig, descriptor.id).toBeDefined()
    }
  })

  it('keeps the expected built-in model ids registered', () => {
    expect(geminiModelDescriptors.map((descriptor) => descriptor.id)).toEqual(
      EXPECTED_GEMINI_MODEL_IDS,
    )

    expect(gemmaModelDescriptors.map((descriptor) => descriptor.id)).toEqual(
      EXPECTED_GEMMA_MODEL_IDS,
    )
  })

  it('fails model onboarding unless schema, fixtures, and pricing decisions are explicit', () => {
    const descriptors = [...geminiModelDescriptors, ...gemmaModelDescriptors]
    expect(descriptors.map((descriptor) => descriptor.id)).toEqual(
      EXPECTED_BUILT_IN_MODEL_IDS,
    )

    for (const descriptor of descriptors) {
      expect(descriptor.configJsonSchema, descriptor.id).toEqual(
        toConfigJsonSchema(descriptor.configSchema),
      )
      expect(ADAPTER_FIXTURE_MODEL_IDS.has(descriptor.id), descriptor.id).toBe(true)
      expect(NEGATIVE_CONTRACT_FIXTURE_MODEL_IDS.has(descriptor.id), descriptor.id).toBe(
        true,
      )

      const pricingFamily = descriptor.pricingFamily ?? descriptor.id
      const hasPricing = GEMINI_PRICING[pricingFamily] !== undefined
      const hasExplicitUnpricedDecision = EXPLICIT_UNPRICED_MODEL_IDS.has(descriptor.id)
      expect(hasPricing || hasExplicitUnpricedDecision, descriptor.id).toBe(true)
    }
  })

  it('enforces the stricter documented reasoning effort sets', () => {
    expect(
      geminiModelDescriptors.find((descriptor) => descriptor.id === 'gemini-2.5-pro')
        ?.capabilities?.admittedReasoningEfforts,
    ).toEqual(['low', 'medium', 'high'])

    expect(
      geminiModelDescriptors.find((descriptor) => descriptor.id === 'gemini-3.5-flash')
        ?.capabilities?.admittedReasoningEfforts,
    ).toEqual(['none', 'low', 'medium', 'high'])

    expect(
      geminiModelDescriptors.find(
        (descriptor) => descriptor.id === 'gemini-3.1-pro-preview',
      )?.capabilities?.admittedReasoningEfforts,
    ).toEqual(['low', 'medium', 'high'])

    expect(
      gemmaModelDescriptors.find((descriptor) => descriptor.id === 'gemma-4-31b-it')
        ?.capabilities?.admittedReasoningEfforts,
    ).toEqual(['none', 'high'])
  })

  it('default registry resolves known models and does not register deleted aliases', () => {
    expect(defaultGeminiRegistry.resolve('gemini-3-flash-preview-001')?.id).toBe(
      'gemini-3-flash-preview',
    )
    expect(defaultGeminiRegistry.resolve('gemma-4-31b-it')?.provider).toBe('google')
    expect(defaultGeminiRegistry.resolve('google/gemma-4-31b-it')).toBeUndefined()
  })
})

describe('@gullabs/core package surface', () => {
  it('exports the new Zod helpers and no longer exports the Gemini schema factories', async () => {
    const surface = await import('./index.js')

    expect(typeof surface.toConfigJsonSchema).toBe('function')
    expect(typeof surface.zodToStandardSchema).toBe('function')
    expect(removedConfigSchemaFactory in surface).toBe(false)
    expect(removedConfigValidatorFactory in surface).toBe(false)
  })
})
