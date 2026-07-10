/**
 * Compile-time type shape assertions for types.ts.
 *
 * Uses vitest's `expectTypeOf` to assert that the public types have the exact
 * shapes promised by SPEC.  These tests fail at compile time (tsc) or at
 * vitest run time if the type shapes change.
 */

import { describe, it, expect, expectTypeOf } from 'vitest'
import type {
  LlmResult,
  Usage,
  Cost,
  Warning,
  FinishReason,
  JsonValue,
  TextPart,
  InlineMediaPart,
  FileUriPart,
  Part,
  Message,
  GenConfig,
  ProviderOptions,
  ProviderOptionsMap,
  ReasoningIntent,
} from './types.js'
import type { ResolvedRequest } from './ports.js'
import { isTextPart, isInlineMediaPart, isFileUriPart } from './types.js'

describe('LlmResult type shape', () => {
  it('output is unknown | undefined', () => {
    expectTypeOf<LlmResult['output']>().toEqualTypeOf<unknown | undefined>()
    expectTypeOf<LlmResult['outputParsed']>().toEqualTypeOf<boolean | undefined>()
  })

  it('text is string | undefined', () => {
    expectTypeOf<LlmResult['text']>().toEqualTypeOf<string | undefined>()
  })

  it('reasoningText is string | undefined', () => {
    expectTypeOf<LlmResult['reasoningText']>().toEqualTypeOf<string | undefined>()
  })

  it('usage is Usage (required)', () => {
    expectTypeOf<LlmResult['usage']>().toEqualTypeOf<Usage>()
  })

  it('cost is Cost | undefined', () => {
    expectTypeOf<LlmResult['cost']>().toEqualTypeOf<Cost | undefined>()
  })

  it('model is string (required)', () => {
    expectTypeOf<LlmResult['model']>().toEqualTypeOf<string>()
  })

  it('latencyMs is number (required)', () => {
    expectTypeOf<LlmResult['latencyMs']>().toEqualTypeOf<number>()
  })

  it('queueDelayMs is number | undefined', () => {
    expectTypeOf<LlmResult['queueDelayMs']>().toEqualTypeOf<number | undefined>()
  })

  it('warnings is Warning[] (required, never undefined)', () => {
    expectTypeOf<LlmResult['warnings']>().toEqualTypeOf<Warning[]>()
  })

  it('finishReason is FinishReason | undefined', () => {
    expectTypeOf<LlmResult['finishReason']>().toEqualTypeOf<FinishReason | undefined>()
  })

  it('responseId is string | undefined', () => {
    expectTypeOf<LlmResult['responseId']>().toEqualTypeOf<string | undefined>()
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
  it('has only the other member', () => {
    expectTypeOf<Warning>().toEqualTypeOf<{ type: 'other'; message: string }>()
  })
})

describe('FinishReason type shape', () => {
  it('is a union of known values', () => {
    expectTypeOf<FinishReason>().toEqualTypeOf<
      'stop' | 'length' | 'content_filter' | 'other'
    >()
  })
})

describe('TextPart type shape', () => {
  it('has kind and text', () => {
    expectTypeOf<TextPart>().toEqualTypeOf<{ kind: 'text'; text: string }>()
  })
})

describe('InlineMediaPart type shape', () => {
  it('has kind, mimeType, data, and optional mediaResolution', () => {
    expectTypeOf<InlineMediaPart>().toEqualTypeOf<{
      kind: 'inline-media'
      mimeType: string
      data: string
      mediaResolution?: 'low' | 'medium' | 'high'
    }>()
  })
})

describe('FileUriPart type shape', () => {
  it('has kind, uri, mimeType, and optional mediaResolution', () => {
    expectTypeOf<FileUriPart>().toEqualTypeOf<{
      kind: 'file-uri'
      uri: string
      mimeType: string
      mediaResolution?: 'low' | 'medium' | 'high'
    }>()
  })
})

describe('Part type shape', () => {
  it('is the union of TextPart | InlineMediaPart | FileUriPart', () => {
    expectTypeOf<Part>().toEqualTypeOf<TextPart | InlineMediaPart | FileUriPart>()
  })
})

describe('Message type shape', () => {
  it('has role and parts (Part[] — heterogeneous union)', () => {
    expectTypeOf<Message>().toEqualTypeOf<{
      role: 'user' | 'assistant'
      parts: Part[]
    }>()
  })
})

describe('part type guards', () => {
  it('isTextPart narrows to TextPart', () => {
    const p: Part = { kind: 'text', text: 'hello' }
    if (isTextPart(p)) {
      expectTypeOf(p).toEqualTypeOf<TextPart>()
      expect(p.text).toBe('hello')
    }
    expect(isTextPart(p)).toBe(true)
    expect(isTextPart({ kind: 'inline-media', mimeType: 'image/png', data: 'abc' })).toBe(
      false,
    )
    expect(
      isTextPart({ kind: 'file-uri', uri: 'gs://b/f', mimeType: 'image/jpeg' }),
    ).toBe(false)
  })

  it('isInlineMediaPart narrows to InlineMediaPart', () => {
    const p: Part = { kind: 'inline-media', mimeType: 'image/png', data: 'abc123' }
    if (isInlineMediaPart(p)) {
      expectTypeOf(p).toEqualTypeOf<InlineMediaPart>()
      expect(p.data).toBe('abc123')
    }
    expect(isInlineMediaPart(p)).toBe(true)
    expect(isInlineMediaPart({ kind: 'text', text: 'hi' })).toBe(false)
    expect(
      isInlineMediaPart({ kind: 'file-uri', uri: 'gs://b/f', mimeType: 'image/jpeg' }),
    ).toBe(false)
  })

  it('isFileUriPart narrows to FileUriPart', () => {
    const p: Part = { kind: 'file-uri', uri: 'gs://bucket/file', mimeType: 'video/mp4' }
    if (isFileUriPart(p)) {
      expectTypeOf(p).toEqualTypeOf<FileUriPart>()
      expect(p.uri).toBe('gs://bucket/file')
    }
    expect(isFileUriPart(p)).toBe(true)
    expect(isFileUriPart({ kind: 'text', text: 'hi' })).toBe(false)
    expect(
      isFileUriPart({ kind: 'inline-media', mimeType: 'image/png', data: 'abc' }),
    ).toBe(false)
  })
})

describe('ReasoningIntent type shape', () => {
  it('effort is the expected union | undefined', () => {
    expectTypeOf<ReasoningIntent['effort']>().toEqualTypeOf<
      'none' | 'low' | 'medium' | 'high' | undefined
    >()
  })

  it('includeThoughts is boolean | undefined', () => {
    expectTypeOf<ReasoningIntent['includeThoughts']>().toEqualTypeOf<
      boolean | undefined
    >()
  })
})

describe('GenConfig type shape', () => {
  it('serviceTier is an opaque provider-defined string | undefined', () => {
    expectTypeOf<GenConfig['serviceTier']>().toEqualTypeOf<string | undefined>()
  })

  it('providerOptions is the schema-admitted provider options shape', () => {
    expectTypeOf<GenConfig['providerOptions']>().toEqualTypeOf<
      ProviderOptions | undefined
    >()
  })
})

describe('ProviderOptionsMap type shape', () => {
  it('ProviderOptions is a plain alias for the augmentable ProviderOptionsMap', () => {
    // Note: this repo's root tsconfig.json includes all packages/*/src/**/*.ts
    // in one compilation, so packages/google/src/types.ts's `declare module
    // '@gullabs/core'` augmentation is always part of the program graph here —
    // ambient module augmentations apply to the whole compilation unit once
    // the declaring file is included, not just where it's imported from. So
    // `ProviderOptionsMap` cannot be asserted "empty" in *this* typecheck; a
    // real downstream consumer that only depends on @gullabs/core (and never
    // imports @gullabs/google) would see it empty, per the module's doc comment.
    expectTypeOf<ProviderOptions>().toEqualTypeOf<ProviderOptionsMap>()
  })
})

describe('ResolvedRequest type shape', () => {
  it('config does not require serviceTier', () => {
    expectTypeOf<ResolvedRequest['config']>().toEqualTypeOf<GenConfig>()
  })
})
