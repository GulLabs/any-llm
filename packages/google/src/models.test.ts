import { describe, expect, it } from 'vitest'
import { toConfigJsonSchema } from '@gullabs/core'

import {
  defaultGeminiRegistry,
  gemmaModelDescriptors,
  geminiModelDescriptors,
} from './models.js'
import { GEMINI_PRICING } from './pricing.js'

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
