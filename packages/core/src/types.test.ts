/**
 * Compile-time type shape assertions for types.ts.
 *
 * Uses vitest's `expectTypeOf` to assert that the public types have the exact
 * shapes promised by SPEC.  These tests fail at compile time (tsc) or at
 * vitest run time if the type shapes change.
 */

import { describe, it, expectTypeOf } from 'vitest'
import type {
  LlmResult,
  Usage,
  Cost,
  Warning,
  FinishReason,
  JsonValue,
  TextPart,
  Message,
  GenConfig,
  ReasoningIntent,
} from './types.js'

describe('LlmResult<T> type shape', () => {
  it('output is T | undefined for a given T', () => {
    expectTypeOf<LlmResult<string>['output']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<LlmResult<number>['output']>().toEqualTypeOf<number | undefined>()
    expectTypeOf<LlmResult<{ id: number }>['output']>().toEqualTypeOf<{ id: number } | undefined>()
    expectTypeOf<LlmResult<boolean[]>['output']>().toEqualTypeOf<boolean[] | undefined>()
  })

  it('text is string | undefined', () => {
    expectTypeOf<LlmResult<unknown>['text']>().toEqualTypeOf<string | undefined>()
  })

  it('reasoningText is string | undefined', () => {
    expectTypeOf<LlmResult<unknown>['reasoningText']>().toEqualTypeOf<string | undefined>()
  })

  it('usage is Usage (required)', () => {
    expectTypeOf<LlmResult<unknown>['usage']>().toEqualTypeOf<Usage>()
  })

  it('cost is Cost | undefined', () => {
    expectTypeOf<LlmResult<unknown>['cost']>().toEqualTypeOf<Cost | undefined>()
  })

  it('model is string (required)', () => {
    expectTypeOf<LlmResult<unknown>['model']>().toEqualTypeOf<string>()
  })

  it('latencyMs is number (required)', () => {
    expectTypeOf<LlmResult<unknown>['latencyMs']>().toEqualTypeOf<number>()
  })

  it('warnings is Warning[] (required, never undefined)', () => {
    expectTypeOf<LlmResult<unknown>['warnings']>().toEqualTypeOf<Warning[]>()
  })

  it('finishReason is FinishReason | undefined', () => {
    expectTypeOf<LlmResult<unknown>['finishReason']>().toEqualTypeOf<FinishReason | undefined>()
  })

  it('responseId is string | undefined', () => {
    expectTypeOf<LlmResult<unknown>['responseId']>().toEqualTypeOf<string | undefined>()
  })
})

describe('Usage type shape', () => {
  it('inputTokens is number (required)', () => {
    expectTypeOf<Usage['inputTokens']>().toEqualTypeOf<number>()
  })

  it('outputTokens is number (required)', () => {
    expectTypeOf<Usage['outputTokens']>().toEqualTypeOf<number>()
  })

  it('cachedInputTokens is number | undefined', () => {
    expectTypeOf<Usage['cachedInputTokens']>().toEqualTypeOf<number | undefined>()
  })

  it('thinkingTokens is number | undefined', () => {
    expectTypeOf<Usage['thinkingTokens']>().toEqualTypeOf<number | undefined>()
  })

  it('totalTokens is number | undefined', () => {
    expectTypeOf<Usage['totalTokens']>().toEqualTypeOf<number | undefined>()
  })

  it('details is Record<string, number>', () => {
    expectTypeOf<Usage['details']>().toEqualTypeOf<Record<string, number>>()
  })

  it('raw is JsonValue', () => {
    expectTypeOf<Usage['raw']>().toEqualTypeOf<JsonValue>()
  })
})

describe('Cost type shape', () => {
  it('microUsd is number | null', () => {
    expectTypeOf<Cost['microUsd']>().toEqualTypeOf<number | null>()
  })

  it('pricingVersion is string', () => {
    expectTypeOf<Cost['pricingVersion']>().toEqualTypeOf<string>()
  })

  it('confidence is exact | estimated', () => {
    expectTypeOf<Cost['confidence']>().toEqualTypeOf<'exact' | 'estimated'>()
  })

  it('details has input, cached, output as numbers', () => {
    expectTypeOf<Cost['details']>().toEqualTypeOf<{
      input: number
      cached: number
      output: number
    }>()
  })
})

describe('Warning type shape', () => {
  it('is a discriminated union', () => {
    expectTypeOf<Warning>().toEqualTypeOf<
      | { type: 'unsupported-setting'; setting: string; details?: string }
      | { type: 'reasoning-mapping'; quality: 'approximate' | 'unsupported'; details?: string }
      | { type: 'other'; message: string }
    >()
  })
})

describe('FinishReason type shape', () => {
  it('is a union of known values', () => {
    expectTypeOf<FinishReason>().toEqualTypeOf<'stop' | 'length' | 'content_filter' | 'other'>()
  })
})

describe('TextPart type shape', () => {
  it('has kind and text', () => {
    expectTypeOf<TextPart>().toEqualTypeOf<{ kind: 'text'; text: string }>()
  })
})

describe('Message type shape', () => {
  it('has role and parts', () => {
    expectTypeOf<Message>().toEqualTypeOf<{
      role: 'user' | 'assistant'
      parts: TextPart[]
    }>()
  })
})

describe('ReasoningIntent type shape', () => {
  it('effort is the expected union | undefined', () => {
    expectTypeOf<ReasoningIntent['effort']>().toEqualTypeOf<
      'none' | 'low' | 'medium' | 'high' | undefined
    >()
  })

  it('includeThoughts is boolean | undefined', () => {
    expectTypeOf<ReasoningIntent['includeThoughts']>().toEqualTypeOf<boolean | undefined>()
  })
})

describe('GenConfig type shape', () => {
  it('serviceTier is flex | standard | undefined', () => {
    expectTypeOf<GenConfig['serviceTier']>().toEqualTypeOf<'flex' | 'standard' | undefined>()
  })

  it('providerOptions is Record<string, JsonValue> | undefined', () => {
    expectTypeOf<GenConfig['providerOptions']>().toEqualTypeOf<
      Record<string, JsonValue> | undefined
    >()
  })
})
