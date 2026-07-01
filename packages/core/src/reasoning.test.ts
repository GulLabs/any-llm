import { describe, it, expect } from 'vitest'
import { LlmError } from './errors.js'
import { createModelRegistry, defaultGeminiRegistry } from './registry.js'
import { resolveReasoning } from './reasoning.js'

describe('resolveReasoning', () => {
  it('returns undefined when budgetTokens is undefined', () => {
    expect(
      resolveReasoning({
        model: 'gemini-2.5-pro',
        budgetTokens: undefined,
        registry: defaultGeminiRegistry,
      }),
    ).toBeUndefined()
  })

  it('passes budgetTokens through unchanged for budget-api models, including 0', () => {
    expect(
      resolveReasoning({
        model: 'gemini-2.5-pro',
        budgetTokens: 0,
        registry: defaultGeminiRegistry,
      }),
    ).toEqual({ budgetTokens: 0 })

    expect(
      resolveReasoning({
        model: 'gemini-2.5-pro',
        budgetTokens: 4096,
        registry: defaultGeminiRegistry,
      }),
    ).toEqual({ budgetTokens: 4096 })
  })

  it('maps level-api budgets into floor buckets for gemini-3.1-flash-lite', () => {
    expect(
      resolveReasoning({
        model: 'gemini-3.1-flash-lite',
        budgetTokens: 0,
        registry: defaultGeminiRegistry,
      }),
    ).toEqual({ effort: 'none' })
    expect(
      resolveReasoning({
        model: 'gemini-3.1-flash-lite',
        budgetTokens: 1024,
        registry: defaultGeminiRegistry,
      }),
    ).toEqual({ effort: 'low' })
    expect(
      resolveReasoning({
        model: 'gemini-3.1-flash-lite',
        budgetTokens: 4000,
        registry: defaultGeminiRegistry,
      }),
    ).toEqual({ effort: 'low' })
    expect(
      resolveReasoning({
        model: 'gemini-3.1-flash-lite',
        budgetTokens: 8192,
        registry: defaultGeminiRegistry,
      }),
    ).toEqual({ effort: 'medium' })
    expect(
      resolveReasoning({
        model: 'gemini-3.1-flash-lite',
        budgetTokens: 24576,
        registry: defaultGeminiRegistry,
      }),
    ).toEqual({ effort: 'high' })
  })

  it('throws for any none-bucket budget on gemini-3.1-pro-preview', () => {
    for (const budgetTokens of [0, 500]) {
      try {
        resolveReasoning({
          model: 'gemini-3.1-pro-preview',
          budgetTokens,
          registry: defaultGeminiRegistry,
        })
        expect.fail('expected resolveReasoning to throw')
      } catch (error) {
        expect(error).toBeInstanceOf(LlmError)
        expect((error as LlmError).kind).toBe('bad_request')
        expect((error as LlmError).retryable).toBe(false)
      }
    }
  })

  it('rounds up to admitted tiers for both Gemma 4 descriptors', () => {
    for (const model of ['gemma-4-31b-it', 'gemma-4-26b-a4b-it'] as const) {
      expect(
        resolveReasoning({
          model,
          budgetTokens: 0,
          registry: defaultGeminiRegistry,
        }),
      ).toEqual({ effort: 'none' })
      expect(
        resolveReasoning({
          model,
          budgetTokens: 2000,
          registry: defaultGeminiRegistry,
        }),
      ).toEqual({ effort: 'high' })
      expect(
        resolveReasoning({
          model,
          budgetTokens: 10000,
          registry: defaultGeminiRegistry,
        }),
      ).toEqual({ effort: 'high' })
    }
  })

  it('throws when the model has no reasoningApi', () => {
    const registry = createModelRegistry([
      {
        id: 'non-reasoning-model',
        provider: 'google',
        capabilities: {},
      },
    ])

    expect(() =>
      resolveReasoning({
        model: 'non-reasoning-model',
        budgetTokens: 1024,
        registry,
      }),
    ).toThrow(/does not support reasoning\/thinkingConfig/)
  })

  it('throws when a level-api model has no admitted tier at or above the bucket', () => {
    const registry = createModelRegistry([
      {
        id: 'none-only-model',
        provider: 'google',
        capabilities: {
          reasoning: true,
          reasoningApi: 'level',
          admittedReasoningEfforts: ['none'],
        },
      },
    ])

    expect(() =>
      resolveReasoning({
        model: 'none-only-model',
        budgetTokens: 2000,
        registry,
      }),
    ).toThrow(/has no admitted reasoning effort at or above bucket "low"/)
  })
})
