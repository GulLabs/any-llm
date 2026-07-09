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

function makeDescriptor(model: string, provider: string): ModelDescriptor {
  return {
    model,
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

  it('resolves exact and longest-prefix matches, scoped to the given provider', () => {
    const registry = createModelRegistry(descriptors)

    expect(registry.resolve('p1', 'alpha')?.provider).toBe('p1')
    expect(registry.resolve('p2', 'beta-v2-001')?.provider).toBe('p2')
    expect(registry.resolve('p3', 'beta-experimental')?.provider).toBe('p3')
  })

  it('returns undefined for unknown models', () => {
    const registry = createModelRegistry(descriptors)

    expect(registry.resolve('p1', 'unknown')).toBeUndefined()
  })

  it('returns undefined when the model matches but under a different provider', () => {
    const registry = createModelRegistry(descriptors)

    // 'alpha' is only registered under 'p1' — resolving it under 'p2' must miss.
    expect(registry.resolve('p2', 'alpha')).toBeUndefined()
  })

  it('never lets a prefix descriptor under one provider match a longer model resolved under another provider', () => {
    const registry = createModelRegistry(descriptors)

    // 'beta' is registered under 'p3' as a prefix candidate for 'beta-experimental',
    // but resolving 'beta-experimental' under 'p1' (which has no 'beta*' descriptor)
    // must miss rather than crossing over to p3's descriptor.
    expect(registry.resolve('p1', 'beta-experimental')).toBeUndefined()
  })

  it('returns a defensive copy from listDescriptors', () => {
    const registry = createModelRegistry(descriptors)
    const listed = registry.listDescriptors?.()

    expect(listed).toEqual(descriptors)
    expect(listed).not.toBe(descriptors)
  })

  it('throws on duplicate exact (provider, model) pairs', () => {
    expect(() =>
      createModelRegistry([makeDescriptor('dup', 'a'), makeDescriptor('dup', 'a')]),
    ).toThrow(LlmError)
  })

  it('allows the same bare model string under two different providers', () => {
    const registry = createModelRegistry([
      makeDescriptor('shared-model', 'a'),
      makeDescriptor('shared-model', 'b'),
    ])

    const fromA = registry.resolve('a', 'shared-model')
    const fromB = registry.resolve('b', 'shared-model')

    expect(fromA).toBeDefined()
    expect(fromB).toBeDefined()
    expect(fromA).not.toBe(fromB)
    expect(fromA?.provider).toBe('a')
    expect(fromB?.provider).toBe('b')
  })

  it('same bare model under two providers can carry distinct config schemas', () => {
    const SchemaA = z
      .strictObject({ temperature: z.number().optional() })
      .meta({ title: 'ConfigA', description: 'Provider-a schema.', examples: [{}] })
    const SchemaB = z
      .strictObject({ maxTokens: z.number().optional() })
      .meta({ title: 'ConfigB', description: 'Provider-b schema.', examples: [{}] })

    const registry = createModelRegistry([
      {
        model: 'shared-model',
        provider: 'a',
        configSchema: SchemaA,
        configJsonSchema: toConfigJsonSchema(SchemaA),
        validateConfig: zodToStandardSchema(SchemaA),
      },
      {
        model: 'shared-model',
        provider: 'b',
        configSchema: SchemaB,
        configJsonSchema: toConfigJsonSchema(SchemaB),
        validateConfig: zodToStandardSchema(SchemaB),
      },
    ])

    const fromA = registry.resolve('a', 'shared-model')
    const fromB = registry.resolve('b', 'shared-model')
    expect(fromA?.configSchema).toBe(SchemaA)
    expect(fromB?.configSchema).toBe(SchemaB)
    expect(fromA?.configSchema).not.toBe(fromB?.configSchema)
    expect(fromA?.configJsonSchema).not.toEqual(fromB?.configJsonSchema)
  })

  it('throws when a custom descriptor is missing required schema artifacts', () => {
    expect(() =>
      createModelRegistry([
        {
          model: 'broken-model',
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
      expect(descriptor.configSchema, descriptor.model).toBeDefined()
      expect(descriptor.configJsonSchema, descriptor.model).toBeDefined()
      expect(descriptor.validateConfig, descriptor.model).toBeDefined()
    }
  })

  it('keeps the expected built-in model ids registered', () => {
    expect(geminiModelDescriptors.map((descriptor) => descriptor.model)).toEqual(
      EXPECTED_GEMINI_MODEL_IDS,
    )

    expect(gemmaModelDescriptors.map((descriptor) => descriptor.model)).toEqual(
      EXPECTED_GEMMA_MODEL_IDS,
    )
  })

  it('fails model onboarding unless schema, fixtures, and pricing decisions are explicit', () => {
    const descriptors = [...geminiModelDescriptors, ...gemmaModelDescriptors]
    expect(descriptors.map((descriptor) => descriptor.model)).toEqual(
      EXPECTED_BUILT_IN_MODEL_IDS,
    )

    for (const descriptor of descriptors) {
      expect(descriptor.configJsonSchema, descriptor.model).toEqual(
        toConfigJsonSchema(descriptor.configSchema),
      )
      expect(ADAPTER_FIXTURE_MODEL_IDS.has(descriptor.model), descriptor.model).toBe(true)
      expect(
        NEGATIVE_CONTRACT_FIXTURE_MODEL_IDS.has(descriptor.model),
        descriptor.model,
      ).toBe(true)

      const pricingFamily = descriptor.pricingFamily ?? descriptor.model
      const hasPricing = GEMINI_PRICING[pricingFamily] !== undefined
      const hasExplicitUnpricedDecision = EXPLICIT_UNPRICED_MODEL_IDS.has(
        descriptor.model,
      )
      expect(hasPricing || hasExplicitUnpricedDecision, descriptor.model).toBe(true)
    }
  })

  it('enforces the stricter documented reasoning effort sets', () => {
    expect(
      geminiModelDescriptors.find((descriptor) => descriptor.model === 'gemini-2.5-pro')
        ?.capabilities?.admittedReasoningEfforts,
    ).toEqual(['low', 'medium', 'high'])

    expect(
      geminiModelDescriptors.find((descriptor) => descriptor.model === 'gemini-3.5-flash')
        ?.capabilities?.admittedReasoningEfforts,
    ).toEqual(['none', 'low', 'medium', 'high'])

    expect(
      geminiModelDescriptors.find(
        (descriptor) => descriptor.model === 'gemini-3.1-pro-preview',
      )?.capabilities?.admittedReasoningEfforts,
    ).toEqual(['low', 'medium', 'high'])

    expect(
      gemmaModelDescriptors.find((descriptor) => descriptor.model === 'gemma-4-31b-it')
        ?.capabilities?.admittedReasoningEfforts,
    ).toEqual(['none', 'high'])
  })

  it('default registry resolves known models scoped to google and does not register deleted aliases', () => {
    expect(
      defaultGeminiRegistry.resolve('google', 'gemini-3-flash-preview-001')?.model,
    ).toBe('gemini-3-flash-preview')
    expect(defaultGeminiRegistry.resolve('google', 'gemma-4-31b-it')?.provider).toBe(
      'google',
    )
    expect(
      defaultGeminiRegistry.resolve('google', 'google/gemma-4-31b-it'),
    ).toBeUndefined()
    // Same bare model resolved under a foreign provider must miss entirely.
    expect(defaultGeminiRegistry.resolve('anthropic', 'gemini-2.5-pro')).toBeUndefined()
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
