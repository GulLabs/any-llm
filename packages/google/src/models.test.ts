import { describe, expect, it } from 'vitest'
import { assertRegistryInvariants } from '@gullabs/testing'

import {
  defaultGeminiRegistry,
  gemmaModelDescriptors,
  geminiModelDescriptors,
} from './models.js'
import { geminiPricingSource } from './cost.js'

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
const ADAPTER_FIXTURE_MODEL_IDS = EXPECTED_BUILT_IN_MODEL_IDS
const NEGATIVE_CONTRACT_FIXTURE_MODEL_IDS = EXPECTED_BUILT_IN_MODEL_IDS
const EXPLICIT_UNPRICED_MODEL_IDS = new Set<string>(EXPECTED_GEMMA_MODEL_IDS)

describe('built-in descriptors', () => {
  it('keeps the expected built-in model ids registered', () => {
    expect(geminiModelDescriptors.map((descriptor) => descriptor.model)).toEqual(
      EXPECTED_GEMINI_MODEL_IDS,
    )

    expect(gemmaModelDescriptors.map((descriptor) => descriptor.model)).toEqual(
      EXPECTED_GEMMA_MODEL_IDS,
    )
  })

  it('fails model onboarding unless schema, fixtures, and pricing decisions are explicit', () => {
    assertRegistryInvariants({
      descriptors: [...geminiModelDescriptors, ...gemmaModelDescriptors],
      expectedModelIds: EXPECTED_BUILT_IN_MODEL_IDS,
      pricingSource: geminiPricingSource(),
      explicitlyUnpriced: EXPLICIT_UNPRICED_MODEL_IDS,
      adapterFixtureModelIds: ADAPTER_FIXTURE_MODEL_IDS,
      negativeContractFixtureModelIds: NEGATIVE_CONTRACT_FIXTURE_MODEL_IDS,
    })
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
