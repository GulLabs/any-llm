/**
 * Model descriptor registry for @gullabs/core.
 *
 * Centralises model/provider knowledge. Descriptors are keyed by the pair
 * (`provider`, `model`); unknown pairs fail fast at call time.
 *
 * @module
 */

import type * as z from 'zod'

import { LlmError } from './errors.js'
import {
  Gemma426bA4bItConfigSchema,
  Gemma431bItConfigSchema,
  Gemini25FlashConfigSchema,
  Gemini25FlashLiteConfigSchema,
  Gemini25ProConfigSchema,
  Gemini31FlashLiteConfigSchema,
  Gemini31ProPreviewConfigSchema,
  Gemini35FlashConfigSchema,
  Gemini3FlashPreviewConfigSchema,
  toConfigJsonSchema,
  zodToStandardSchema,
} from './model-config/index.js'
import type { StandardSchemaV1 } from './standard-schema.js'
import type { JsonValue, ReasoningEffort } from './types.js'

export interface ModelDescriptor {
  /**
   * Bare provider-native model identifier — used as the exact-match key and
   * as the prefix for longest-prefix matching (e.g. `"gemini-2.5-pro"` also
   * matches `"gemini-2.5-pro-001"`). Identity for a descriptor is the pair
   * (`provider`, `model`); the same bare `model` string may be registered
   * under multiple providers with different config schemas.
   */
  model: string
  /** Provider identifier (e.g. `"google"`). Must match the adapter's `id`. */
  provider: string
  /**
   * Key into the pricing table (e.g. `"gemini-2.5-pro"`).
   * When omitted, cost computation falls back to the pricing table's own
   * prefix-match logic.
   */
  pricingFamily?: string
  /** Capability flags for routing and adapter logic. */
  capabilities?: {
    reasoning?: boolean
    structuredOutput?: boolean
    nativeStructuredOutput?: boolean
    vision?: boolean
    audioInput?: boolean
    reasoningApi?: 'budget' | 'level'
    admittedReasoningEfforts?: ReadonlyArray<ReasoningEffort>
    sampling?: 'tunable' | 'fixed'
    caching?: { explicit: boolean; minTokens: number }
    grounding?: boolean
    serviceTiers?: ('flex' | 'standard')[]
  }
  /** Zod runtime schema for the full per-model config contract. */
  configSchema: z.ZodType
  /** JSON Schema derived from {@link configSchema}. */
  configJsonSchema: JsonValue
  /** Standard Schema adapter derived from {@link configSchema}. */
  validateConfig: StandardSchemaV1
}

export interface ModelRegistry {
  resolve(provider: string, model: string): ModelDescriptor | undefined
  listDescriptors?(): readonly ModelDescriptor[]
}

function assertDescriptorSchemaArtifacts(descriptor: Partial<ModelDescriptor>): void {
  const missing: string[] = []
  if (descriptor.configSchema === undefined) missing.push('configSchema')
  if (descriptor.configJsonSchema === undefined) missing.push('configJsonSchema')
  if (descriptor.validateConfig === undefined) missing.push('validateConfig')

  if (missing.length > 0) {
    throw new LlmError(
      `Model descriptor for provider "${descriptor.provider ?? '<unknown>'}" model "${
        descriptor.model ?? '<unknown>'
      }" is missing required schema artifacts: ${missing.join(', ')}.`,
      {
        kind: 'bad_request',
        retryable: false,
      },
    )
  }
}

/** Composite key for the exact (provider, model) match map. */
function descriptorKey(provider: string, model: string): string {
  return `${provider}\u0000${model}`
}

export function createModelRegistry(descriptors: ModelDescriptor[]): ModelRegistry {
  const exactMap = new Map<string, ModelDescriptor>()
  // Grouped per-provider so longest-prefix matching never crosses providers.
  const byProvider = new Map<string, Map<string, ModelDescriptor>>()

  for (const descriptor of descriptors) {
    assertDescriptorSchemaArtifacts(descriptor)

    const key = descriptorKey(descriptor.provider, descriptor.model)
    if (exactMap.has(key)) {
      throw new LlmError(
        `Duplicate model descriptor for provider "${descriptor.provider}" model "${descriptor.model}"`,
        {
          kind: 'bad_request',
          retryable: false,
        },
      )
    }
    exactMap.set(key, descriptor)

    let providerMap = byProvider.get(descriptor.provider)
    if (providerMap === undefined) {
      providerMap = new Map<string, ModelDescriptor>()
      byProvider.set(descriptor.provider, providerMap)
    }
    providerMap.set(descriptor.model, descriptor)
  }

  return {
    resolve(provider: string, model: string): ModelDescriptor | undefined {
      const exact = exactMap.get(descriptorKey(provider, model))
      if (exact !== undefined) return exact

      const providerMap = byProvider.get(provider)
      if (providerMap === undefined) return undefined

      let best: ModelDescriptor | undefined
      let bestLen = 0
      for (const [candidateModel, descriptor] of providerMap) {
        if (model.startsWith(candidateModel) && candidateModel.length > bestLen) {
          best = descriptor
          bestLen = candidateModel.length
        }
      }
      return best
    },
    listDescriptors(): readonly ModelDescriptor[] {
      return descriptors.slice()
    },
  }
}

const GEMINI_25_PRO_REASONING_EFFORTS = [
  'low',
  'medium',
  'high',
] as const satisfies ReadonlyArray<ReasoningEffort>
const GEMINI_LEVEL_REASONING_EFFORTS = [
  'none',
  'low',
  'medium',
  'high',
] as const satisfies ReadonlyArray<ReasoningEffort>
const GEMINI_LEVEL_PRO_PREVIEW_REASONING_EFFORTS = [
  'low',
  'medium',
  'high',
] as const satisfies ReadonlyArray<ReasoningEffort>
const GEMINI_25_FLASH_REASONING_EFFORTS = [
  'none',
  'low',
  'medium',
  'high',
] as const satisfies ReadonlyArray<ReasoningEffort>
const GEMMA_REASONING_EFFORTS = [
  'none',
  'high',
] as const satisfies ReadonlyArray<ReasoningEffort>

export const geminiModelDescriptors: ModelDescriptor[] = [
  {
    model: 'gemini-2.5-pro',
    provider: 'google',
    pricingFamily: 'gemini-2.5-pro',
    capabilities: {
      reasoning: true,
      structuredOutput: true,
      nativeStructuredOutput: true,
      vision: true,
      reasoningApi: 'budget',
      admittedReasoningEfforts: GEMINI_25_PRO_REASONING_EFFORTS,
      sampling: 'tunable',
      caching: { explicit: true, minTokens: 2048 },
      grounding: true,
      serviceTiers: ['flex', 'standard'],
    },
    configSchema: Gemini25ProConfigSchema,
    configJsonSchema: toConfigJsonSchema(Gemini25ProConfigSchema),
    validateConfig: zodToStandardSchema(Gemini25ProConfigSchema),
  },
  {
    model: 'gemini-2.5-flash',
    provider: 'google',
    pricingFamily: 'gemini-2.5-flash',
    capabilities: {
      reasoning: true,
      structuredOutput: true,
      nativeStructuredOutput: true,
      vision: true,
      reasoningApi: 'budget',
      admittedReasoningEfforts: GEMINI_25_FLASH_REASONING_EFFORTS,
      sampling: 'tunable',
      caching: { explicit: true, minTokens: 2048 },
      grounding: true,
      serviceTiers: ['flex', 'standard'],
    },
    configSchema: Gemini25FlashConfigSchema,
    configJsonSchema: toConfigJsonSchema(Gemini25FlashConfigSchema),
    validateConfig: zodToStandardSchema(Gemini25FlashConfigSchema),
  },
  {
    model: 'gemini-2.5-flash-lite',
    provider: 'google',
    pricingFamily: 'gemini-2.5-flash-lite',
    capabilities: {
      reasoning: true,
      structuredOutput: true,
      nativeStructuredOutput: true,
      vision: true,
      reasoningApi: 'budget',
      admittedReasoningEfforts: GEMINI_25_FLASH_REASONING_EFFORTS,
      sampling: 'tunable',
      caching: { explicit: true, minTokens: 2048 },
      grounding: true,
      serviceTiers: ['flex', 'standard'],
    },
    configSchema: Gemini25FlashLiteConfigSchema,
    configJsonSchema: toConfigJsonSchema(Gemini25FlashLiteConfigSchema),
    validateConfig: zodToStandardSchema(Gemini25FlashLiteConfigSchema),
  },
  {
    model: 'gemini-3.5-flash',
    provider: 'google',
    pricingFamily: 'gemini-3.5-flash',
    capabilities: {
      reasoning: true,
      structuredOutput: true,
      nativeStructuredOutput: true,
      vision: true,
      reasoningApi: 'level',
      admittedReasoningEfforts: GEMINI_LEVEL_REASONING_EFFORTS,
      sampling: 'fixed',
      caching: { explicit: true, minTokens: 2048 },
      grounding: true,
      serviceTiers: ['flex', 'standard'],
    },
    configSchema: Gemini35FlashConfigSchema,
    configJsonSchema: toConfigJsonSchema(Gemini35FlashConfigSchema),
    validateConfig: zodToStandardSchema(Gemini35FlashConfigSchema),
  },
  {
    model: 'gemini-3.1-flash-lite',
    provider: 'google',
    pricingFamily: 'gemini-3.1-flash-lite',
    capabilities: {
      reasoning: true,
      structuredOutput: true,
      nativeStructuredOutput: true,
      vision: true,
      reasoningApi: 'level',
      admittedReasoningEfforts: GEMINI_LEVEL_REASONING_EFFORTS,
      sampling: 'fixed',
      caching: { explicit: true, minTokens: 2048 },
      grounding: true,
      serviceTiers: ['flex', 'standard'],
    },
    configSchema: Gemini31FlashLiteConfigSchema,
    configJsonSchema: toConfigJsonSchema(Gemini31FlashLiteConfigSchema),
    validateConfig: zodToStandardSchema(Gemini31FlashLiteConfigSchema),
  },
  {
    model: 'gemini-3.1-pro-preview',
    provider: 'google',
    pricingFamily: 'gemini-3.1-pro-preview',
    capabilities: {
      reasoning: true,
      structuredOutput: true,
      nativeStructuredOutput: true,
      vision: true,
      reasoningApi: 'level',
      admittedReasoningEfforts: GEMINI_LEVEL_PRO_PREVIEW_REASONING_EFFORTS,
      sampling: 'fixed',
      caching: { explicit: true, minTokens: 2048 },
      grounding: true,
      serviceTiers: ['flex', 'standard'],
    },
    configSchema: Gemini31ProPreviewConfigSchema,
    configJsonSchema: toConfigJsonSchema(Gemini31ProPreviewConfigSchema),
    validateConfig: zodToStandardSchema(Gemini31ProPreviewConfigSchema),
  },
  {
    model: 'gemini-3-flash-preview',
    provider: 'google',
    pricingFamily: 'gemini-3-flash-preview',
    capabilities: {
      reasoning: true,
      structuredOutput: true,
      nativeStructuredOutput: true,
      vision: true,
      reasoningApi: 'level',
      admittedReasoningEfforts: GEMINI_LEVEL_REASONING_EFFORTS,
      sampling: 'fixed',
      caching: { explicit: true, minTokens: 2048 },
      grounding: true,
      serviceTiers: ['flex', 'standard'],
    },
    configSchema: Gemini3FlashPreviewConfigSchema,
    configJsonSchema: toConfigJsonSchema(Gemini3FlashPreviewConfigSchema),
    validateConfig: zodToStandardSchema(Gemini3FlashPreviewConfigSchema),
  },
]

export const gemmaModelDescriptors: ModelDescriptor[] = [
  {
    model: 'gemma-4-31b-it',
    provider: 'google',
    capabilities: {
      reasoning: true,
      reasoningApi: 'level',
      admittedReasoningEfforts: GEMMA_REASONING_EFFORTS,
      structuredOutput: true,
      nativeStructuredOutput: true,
      grounding: true,
      vision: true,
      sampling: 'tunable',
    },
    configSchema: Gemma431bItConfigSchema,
    configJsonSchema: toConfigJsonSchema(Gemma431bItConfigSchema),
    validateConfig: zodToStandardSchema(Gemma431bItConfigSchema),
  },
  {
    model: 'gemma-4-26b-a4b-it',
    provider: 'google',
    capabilities: {
      reasoning: true,
      reasoningApi: 'level',
      admittedReasoningEfforts: GEMMA_REASONING_EFFORTS,
      structuredOutput: true,
      nativeStructuredOutput: true,
      grounding: true,
      vision: true,
      sampling: 'tunable',
    },
    configSchema: Gemma426bA4bItConfigSchema,
    configJsonSchema: toConfigJsonSchema(Gemma426bA4bItConfigSchema),
    validateConfig: zodToStandardSchema(Gemma426bA4bItConfigSchema),
  },
]

export const defaultGeminiRegistry: ModelRegistry = createModelRegistry([
  ...geminiModelDescriptors,
  ...gemmaModelDescriptors,
])
