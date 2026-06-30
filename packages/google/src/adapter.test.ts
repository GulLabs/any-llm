/**
 * @gullabs/google — adapter contract tests.
 *
 * All tests use fakes from @gullabs/testing — NO real network calls.
 * makeFakeGemini/fakeGeminiResponse/fakeGeminiBlocked are the sole test doubles.
 *
 * @module
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { z } from 'zod'
import {
  LlmError,
  createClient,
  geminiPricingSource,
  geminiModelDescriptors,
} from '@gullabs/core'
import type { ResolvedRequest, AdapterCtx } from '@gullabs/core'
import {
  fakeGeminiResponse,
  fakeGeminiBlocked,
  makeFakeGemini,
  FakeClock,
  FakeIds,
  RecordingSink,
} from '@gullabs/testing'
import { geminiAdapter } from './adapter.js'
import { zodToGeminiSchema } from './schema.js'
import { FLEX_DEFAULT_TIMEOUT_MS } from './client.js'
import type { GeminiClientLike, GeminiResponseShape } from './client.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal resolved request for unit tests. */
function makeResolvedReq(overrides: Partial<ResolvedRequest> = {}): ResolvedRequest {
  return {
    model: 'gemini-2.5-pro',
    messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hello' }] }],
    config: { serviceTier: 'flex' },
    ...overrides,
  }
}

/** Minimal adapter context for unit tests. */
const FAKE_CTX: AdapterCtx = {
  auth: { apiKey: 'test-key' },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
}

// ---------------------------------------------------------------------------
// 0. Observability — debug log
// ---------------------------------------------------------------------------

describe('observability', () => {
  it('emits llm.adapter.dispatch debug log before SDK call', async () => {
    const debugFn = vi.fn()
    const ctx: AdapterCtx = {
      auth: { apiKey: 'test-key' },
      logger: { info() {}, warn() {}, error() {}, debug: debugFn },
    }
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'hi' }))
    const adapter = geminiAdapter({ client })
    await adapter.run(makeResolvedReq(), ctx)

    expect(debugFn).toHaveBeenCalledOnce()
    const [obj, msg] = debugFn.mock.calls[0]!
    expect(msg).toBe('llm.adapter.dispatch')
    expect(obj).toMatchObject({ model: 'gemini-2.5-pro' })
    expect(Array.isArray(obj.configKeys)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 1. Usage mapping — the #1 correctness rule
// ---------------------------------------------------------------------------

describe('usage mapping', () => {
  it('enforces GROSS convention: outputTokens = candidates + thoughts', async () => {
    const client = makeFakeGemini(
      fakeGeminiResponse({
        text: 'Hello world',
        promptTokenCount: 1000,
        candidatesTokenCount: 5000,
        thoughtsTokenCount: 2000,
        cachedContentTokenCount: 300,
        totalTokenCount: 8300,
        finishReason: 'STOP',
      }),
    )

    const adapter = geminiAdapter({ client })
    const result = await adapter.run(makeResolvedReq(), FAKE_CTX)

    // The #1 rule: outputTokens = candidatesTokenCount + thoughtsTokenCount
    expect(result.usage.outputTokens).toBe(7000) // 5000 + 2000
    expect(result.usage.inputTokens).toBe(1000)
    expect(result.usage.thinkingTokens).toBe(2000)
    // cachedInputTokens = cachedContentTokenCount (subset of inputTokens)
    expect(result.usage.cachedInputTokens).toBe(300)
    expect(result.usage.totalTokens).toBe(8300)
  })

  it('populates details with canonical keys', async () => {
    const client = makeFakeGemini(
      fakeGeminiResponse({
        text: 'hi',
        promptTokenCount: 100,
        candidatesTokenCount: 50,
        thoughtsTokenCount: 20,
        cachedContentTokenCount: 10,
      }),
    )

    const adapter = geminiAdapter({ client })
    const result = await adapter.run(makeResolvedReq(), FAKE_CTX)

    expect(result.usage.details).toMatchObject({
      input: 100,
      output: 70, // 50 + 20
      cached: 10,
      thinking: 20,
    })
  })

  it('populates raw with the original usageMetadata', async () => {
    const client = makeFakeGemini(
      fakeGeminiResponse({
        promptTokenCount: 100,
        candidatesTokenCount: 50,
        thoughtsTokenCount: 20,
      }),
    )

    const adapter = geminiAdapter({ client })
    const result = await adapter.run(makeResolvedReq(), FAKE_CTX)

    expect(result.usage.raw).toMatchObject({
      promptTokenCount: 100,
      candidatesTokenCount: 50,
      thoughtsTokenCount: 20,
    })
  })

  it('handles missing usageMetadata gracefully (all zeroes)', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))

    const adapter = geminiAdapter({ client })
    const result = await adapter.run(makeResolvedReq(), FAKE_CTX)

    expect(result.usage.inputTokens).toBe(0)
    expect(result.usage.outputTokens).toBe(0)
    expect(result.usage.thinkingTokens).toBeUndefined()
    expect(result.usage.cachedInputTokens).toBeUndefined()
  })

  it('outputs no thinkingTokens when thoughtsTokenCount is absent', async () => {
    const client = makeFakeGemini(
      fakeGeminiResponse({
        text: 'plain',
        candidatesTokenCount: 10,
        promptTokenCount: 5,
      }),
    )

    const adapter = geminiAdapter({ client })
    const result = await adapter.run(makeResolvedReq(), FAKE_CTX)

    expect(result.usage.outputTokens).toBe(10) // 10 + 0
    expect(result.usage.thinkingTokens).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 2. Service tier — flex is sent to the SDK
// ---------------------------------------------------------------------------

describe('service tier', () => {
  it('sends serviceTier="flex" when config.serviceTier is flex', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })

    await adapter.run(makeResolvedReq({ config: { serviceTier: 'flex' } }), FAKE_CTX)

    const call = client.calls[0] as { config?: { serviceTier?: string } }
    expect(call?.config?.serviceTier).toBe('flex')
  })

  it('sends serviceTier="standard" when config.serviceTier is standard', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })

    await adapter.run(makeResolvedReq({ config: { serviceTier: 'standard' } }), FAKE_CTX)

    const call = client.calls[0] as { config?: { serviceTier?: string } }
    expect(call?.config?.serviceTier).toBe('standard')
  })
})

// ---------------------------------------------------------------------------
// 3. Reasoning / thinkingConfig mapping
// ---------------------------------------------------------------------------

describe('reasoning mapping', () => {
  it('maps effort to thinkingBudget for gemini-2.5 models', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })

    await adapter.run(
      makeResolvedReq({
        model: 'gemini-2.5-pro',
        modelDescriptor: {
          id: 'gemini-2.5-pro',
          provider: 'google',
          capabilities: {
            reasoning: true,
            structuredOutput: true,
            reasoningApi: 'budget',
          },
        },
        config: {
          serviceTier: 'flex',
          reasoning: { effort: 'high' },
        },
      }),
      FAKE_CTX,
    )

    const call = client.calls[0] as {
      config?: { thinkingConfig?: { thinkingBudget?: number } }
    }
    expect(call?.config?.thinkingConfig?.thinkingBudget).toBe(24576)
  })

  it('uses budgetTokens directly for gemini-2.5 models', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })

    await adapter.run(
      makeResolvedReq({
        model: 'gemini-2.5-flash',
        modelDescriptor: {
          id: 'gemini-2.5-flash',
          provider: 'google',
          capabilities: {
            reasoning: true,
            structuredOutput: true,
            reasoningApi: 'budget',
          },
        },
        config: {
          serviceTier: 'flex',
          reasoning: { budgetTokens: 4096 },
        },
      }),
      FAKE_CTX,
    )

    const call = client.calls[0] as {
      config?: { thinkingConfig?: { thinkingBudget?: number } }
    }
    expect(call?.config?.thinkingConfig?.thinkingBudget).toBe(4096)
  })

  it('maps none effort to thinkingBudget=0 for gemini-2.5', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })

    await adapter.run(
      makeResolvedReq({
        model: 'gemini-2.5-pro',
        modelDescriptor: {
          id: 'gemini-2.5-pro',
          provider: 'google',
          capabilities: {
            reasoning: true,
            structuredOutput: true,
            reasoningApi: 'budget',
          },
        },
        config: { serviceTier: 'flex', reasoning: { effort: 'none' } },
      }),
      FAKE_CTX,
    )

    const call = client.calls[0] as {
      config?: { thinkingConfig?: { thinkingBudget?: number } }
    }
    expect(call?.config?.thinkingConfig?.thinkingBudget).toBe(0)
  })

  it('maps effort to thinkingLevel for gemini-3.x models', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })

    await adapter.run(
      makeResolvedReq({
        model: 'gemini-3.0-pro',
        modelDescriptor: {
          id: 'gemini-3.0-pro',
          provider: 'google',
          capabilities: { reasoning: true, reasoningApi: 'level' },
        },
        config: {
          serviceTier: 'flex',
          reasoning: { effort: 'high' },
        },
      }),
      FAKE_CTX,
    )

    const call = client.calls[0] as {
      config?: { thinkingConfig?: { thinkingLevel?: string } }
    }
    expect(call?.config?.thinkingConfig?.thinkingLevel).toBe('HIGH')
  })

  it('maps low effort to LOW thinkingLevel for gemini-3.x', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })

    await adapter.run(
      makeResolvedReq({
        model: 'gemini-3.5-pro',
        modelDescriptor: {
          id: 'gemini-3.5-pro',
          provider: 'google',
          capabilities: { reasoning: true, reasoningApi: 'level' },
        },
        config: { serviceTier: 'flex', reasoning: { effort: 'low' } },
      }),
      FAKE_CTX,
    )

    const call = client.calls[0] as {
      config?: { thinkingConfig?: { thinkingLevel?: string } }
    }
    expect(call?.config?.thinkingConfig?.thinkingLevel).toBe('LOW')
  })

  it('emits reasoning-mapping warning for gemini-3.x with budgetTokens', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })

    const result = await adapter.run(
      makeResolvedReq({
        model: 'gemini-3.0-ultra',
        modelDescriptor: {
          id: 'gemini-3.0-ultra',
          provider: 'google',
          capabilities: { reasoning: true, reasoningApi: 'level' },
        },
        config: { serviceTier: 'flex', reasoning: { budgetTokens: 1000 } },
      }),
      FAKE_CTX,
    )

    expect(result.warnings).toContainEqual(
      expect.objectContaining({ type: 'reasoning-mapping', quality: 'approximate' }),
    )
  })

  it('captures reasoningText from thought parts when includeThoughts=true', async () => {
    const client = makeFakeGemini(
      fakeGeminiResponse({
        thoughtText: 'I am thinking...',
        text: 'The answer is 42.',
        thoughtsTokenCount: 100,
        candidatesTokenCount: 10,
      }),
    )
    const adapter = geminiAdapter({ client })

    const result = await adapter.run(
      makeResolvedReq({
        model: 'gemini-2.5-pro',
        modelDescriptor: {
          id: 'gemini-2.5-pro',
          provider: 'google',
          capabilities: {
            reasoning: true,
            structuredOutput: true,
            reasoningApi: 'budget',
          },
        },
        config: { serviceTier: 'flex', reasoning: { includeThoughts: true } },
      }),
      FAKE_CTX,
    )

    expect(result.reasoningText).toBe('I am thinking...')
    expect(result.text).toBe('The answer is 42.')
  })

  it('sets includeThoughts in thinkingConfig when reasoning.includeThoughts is true', async () => {
    const client = makeFakeGemini(
      fakeGeminiResponse({ text: 'ok', thoughtText: 'thinking' }),
    )
    const adapter = geminiAdapter({ client })

    await adapter.run(
      makeResolvedReq({
        model: 'gemini-2.5-pro',
        modelDescriptor: {
          id: 'gemini-2.5-pro',
          provider: 'google',
          capabilities: {
            reasoning: true,
            structuredOutput: true,
            reasoningApi: 'budget',
          },
        },
        config: { serviceTier: 'flex', reasoning: { includeThoughts: true } },
      }),
      FAKE_CTX,
    )

    const call = client.calls[0] as {
      config?: { thinkingConfig?: { includeThoughts?: boolean } }
    }
    expect(call?.config?.thinkingConfig?.includeThoughts).toBe(true)
  })

  it('emits reasoning-mapping:unsupported for unknown model generation', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })

    const result = await adapter.run(
      makeResolvedReq({
        model: 'gemini-future-model',
        config: { serviceTier: 'flex', reasoning: { effort: 'medium' } },
      }),
      FAKE_CTX,
    )

    expect(result.warnings).toContainEqual(
      expect.objectContaining({ type: 'reasoning-mapping', quality: 'unsupported' }),
    )
  })
})

// ---------------------------------------------------------------------------
// 4. Structured output
// ---------------------------------------------------------------------------

describe('structured output', () => {
  it('sets responseMimeType=application/json for structured requests', async () => {
    const schema = z.object({ name: z.string() })
    const client = makeFakeGemini(
      fakeGeminiResponse({ structuredJson: '{"name":"Alice"}' }),
    )
    const adapter = geminiAdapter({ client })

    await adapter.run(makeResolvedReq({ outputSchema: schema }), FAKE_CTX)

    const call = client.calls[0] as { config?: { responseMimeType?: string } }
    expect(call?.config?.responseMimeType).toBe('application/json')
  })

  it('produces a responseSchema from a simple Zod object', async () => {
    const schema = z.object({ name: z.string(), age: z.number() })
    const client = makeFakeGemini(
      fakeGeminiResponse({ structuredJson: '{"name":"Alice","age":30}' }),
    )
    const adapter = geminiAdapter({ client })

    await adapter.run(makeResolvedReq({ outputSchema: schema }), FAKE_CTX)

    const call = client.calls[0] as {
      config?: {
        responseSchema?: { type?: string; properties?: Record<string, { type?: string }> }
      }
    }
    expect(call?.config?.responseSchema?.type).toBe('object')
    expect(call?.config?.responseSchema?.properties?.['name']?.type).toBe('string')
    expect(call?.config?.responseSchema?.properties?.['age']?.type).toBe('number')
  })

  it('parses JSON text into rawStructured', async () => {
    const schema = z.object({ name: z.string() })
    const client = makeFakeGemini(
      fakeGeminiResponse({ structuredJson: '{"name":"Bob"}' }),
    )
    const adapter = geminiAdapter({ client })

    const result = await adapter.run(makeResolvedReq({ outputSchema: schema }), FAKE_CTX)

    expect(result.rawStructured).toEqual({ name: 'Bob' })
  })

  it('leaves rawStructured undefined on JSON parse failure', async () => {
    const schema = z.object({ name: z.string() })
    const client = makeFakeGemini(fakeGeminiResponse({ structuredJson: 'not-json' }))
    const adapter = geminiAdapter({ client })

    const result = await adapter.run(makeResolvedReq({ outputSchema: schema }), FAKE_CTX)

    expect(result.rawStructured).toBeUndefined()
  })

  it('emits unsupported-setting warning when schema cannot be converted', async () => {
    // ZodFunction is not supported by zodToGeminiSchema
    const schema = z.function()
    const client = makeFakeGemini(fakeGeminiResponse({ text: '{}' }))
    const adapter = geminiAdapter({ client })

    const result = await adapter.run(makeResolvedReq({ outputSchema: schema }), FAKE_CTX)

    expect(result.warnings).toContainEqual(
      expect.objectContaining({ type: 'unsupported-setting', setting: 'output.schema' }),
    )
  })
})

// ---------------------------------------------------------------------------
// 5. zodToGeminiSchema unit tests
// ---------------------------------------------------------------------------

describe('zodToGeminiSchema', () => {
  it('converts z.string() to {type:"string"}', () => {
    expect(zodToGeminiSchema(z.string())).toEqual({ type: 'string' })
  })

  it('converts z.number() to {type:"number"}', () => {
    expect(zodToGeminiSchema(z.number())).toEqual({ type: 'number' })
  })

  it('converts z.number().int() to {type:"integer"}', () => {
    expect(zodToGeminiSchema(z.number().int())).toEqual({ type: 'integer' })
  })

  it('converts z.boolean() to {type:"boolean"}', () => {
    expect(zodToGeminiSchema(z.boolean())).toEqual({ type: 'boolean' })
  })

  it('converts z.array(z.string()) to {type:"array",items:{type:"string"}}', () => {
    expect(zodToGeminiSchema(z.array(z.string()))).toEqual({
      type: 'array',
      items: { type: 'string' },
    })
  })

  it('converts z.enum(["a","b"]) to {type:"string",enum:["a","b"]}', () => {
    expect(zodToGeminiSchema(z.enum(['a', 'b']))).toEqual({
      type: 'string',
      enum: ['a', 'b'],
    })
  })

  it('converts z.object with required fields', () => {
    const schema = z.object({ name: z.string(), age: z.number() })
    const result = zodToGeminiSchema(schema)
    expect(result).toMatchObject({
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'number' },
      },
      required: expect.arrayContaining(['name', 'age']),
    })
  })

  it('marks optional fields as non-required', () => {
    const schema = z.object({ name: z.string(), bio: z.string().optional() })
    const result = zodToGeminiSchema(schema)
    expect(result?.required).toContain('name')
    expect(result?.required).not.toContain('bio')
  })

  it('marks optional().nullable() fields as non-required (outer ZodNullable must not shadow ZodOptional)', () => {
    // z.string().optional().nullable() → ZodNullable(ZodOptional(ZodString))
    // The outer wrapper is ZodNullable; without recursive unwrapping the field
    // was incorrectly added to required[].
    const schema = z.object({ field: z.string().optional().nullable() })
    const result = zodToGeminiSchema(schema)
    // required is absent (empty) or does not include 'field'.
    expect(result?.required ?? []).not.toContain('field')
  })

  it('marks nullable().optional() fields as non-required (outer ZodOptional)', () => {
    // z.string().nullable().optional() → ZodOptional(ZodNullable(ZodString))
    const schema = z.object({ field: z.string().nullable().optional() })
    const result = zodToGeminiSchema(schema)
    expect(result?.required ?? []).not.toContain('field')
  })

  it('marks default()-wrapped fields as non-required', () => {
    // z.string().default('x') → ZodDefault(ZodString)
    const schema = z.object({ field: z.string().default('fallback') })
    const result = zodToGeminiSchema(schema)
    expect(result?.required ?? []).not.toContain('field')
  })

  it('converts z.nullable(z.string()) to {type:"string",nullable:true}', () => {
    expect(zodToGeminiSchema(z.string().nullable())).toEqual({
      type: 'string',
      nullable: true,
    })
  })

  it('returns undefined for unsupported schema (ZodFunction)', () => {
    expect(zodToGeminiSchema(z.function())).toBeUndefined()
  })

  it('propagates description', () => {
    const result = zodToGeminiSchema(z.string().describe('The user name'))
    expect(result?.description).toBe('The user name')
  })
})

// ---------------------------------------------------------------------------
// 6. FinishReason mapping
// ---------------------------------------------------------------------------

describe('finishReason mapping', () => {
  it.each([
    ['STOP', 'stop'],
    ['MAX_TOKENS', 'length'],
    ['SAFETY', 'content_filter'],
    ['RECITATION', 'content_filter'],
    ['BLOCKLIST', 'content_filter'],
    ['PROHIBITED_CONTENT', 'content_filter'],
    ['OTHER', 'other'],
    ['UNKNOWN_REASON', 'other'],
  ] as const)('maps %s → %s', async (sdkReason, expectedReason) => {
    const client = makeFakeGemini(
      fakeGeminiResponse({ text: 'ok', finishReason: sdkReason }),
    )
    const adapter = geminiAdapter({ client })
    const result = await adapter.run(makeResolvedReq(), FAKE_CTX)
    expect(result.finishReason).toBe(expectedReason)
  })
})

// ---------------------------------------------------------------------------
// 7. Blocked responses
// ---------------------------------------------------------------------------

describe('blocked responses', () => {
  it('throws LlmError content_filter when promptFeedback.blockReason is set', async () => {
    const client = makeFakeGemini(fakeGeminiBlocked({ blockReason: 'SAFETY' }))
    const adapter = geminiAdapter({ client })

    await expect(adapter.run(makeResolvedReq(), FAKE_CTX)).rejects.toMatchObject({
      kind: 'content_filter',
      retryable: false,
      provider: 'google',
    })
  })

  it('throws LlmError content_filter for PROHIBITED_CONTENT block', async () => {
    const client = makeFakeGemini(
      fakeGeminiBlocked({ blockReason: 'PROHIBITED_CONTENT' }),
    )
    const adapter = geminiAdapter({ client })

    await expect(adapter.run(makeResolvedReq(), FAKE_CTX)).rejects.toThrow(LlmError)
  })

  it('throws LlmError content_filter when candidates array is empty (no blockReason)', async () => {
    // Response with empty candidates and no promptFeedback
    const client = makeFakeGemini({
      candidates: [],
    })
    const adapter = geminiAdapter({ client })

    const err = await adapter.run(makeResolvedReq(), FAKE_CTX).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LlmError)
    expect((err as LlmError).kind).toBe('content_filter')
  })

  it('throws LlmError content_filter when candidates is undefined', async () => {
    const client = makeFakeGemini({
      usageMetadata: { promptTokenCount: 10 },
    })
    const adapter = geminiAdapter({ client })

    await expect(adapter.run(makeResolvedReq(), FAKE_CTX)).rejects.toMatchObject({
      kind: 'content_filter',
    })
  })
})

// ---------------------------------------------------------------------------
// 8. Error injection / classification
// ---------------------------------------------------------------------------

describe('error classification', () => {
  it('rethrows {status:429} as LlmError rate_limited retryable', async () => {
    const client = makeFakeGemini(() => {
      throw { status: 429 }
    })
    const adapter = geminiAdapter({ client })

    const err = await adapter.run(makeResolvedReq(), FAKE_CTX).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LlmError)
    const llmErr = err as LlmError
    expect(llmErr.kind).toBe('rate_limited')
    expect(llmErr.retryable).toBe(true)
    expect(llmErr.provider).toBe('google')
  })

  it('rethrows {status:401} as LlmError invalid_auth not retryable', async () => {
    const client = makeFakeGemini(() => {
      throw { status: 401 }
    })
    const adapter = geminiAdapter({ client })

    const err = await adapter.run(makeResolvedReq(), FAKE_CTX).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LlmError)
    const llmErr = err as LlmError
    expect(llmErr.kind).toBe('invalid_auth')
    expect(llmErr.retryable).toBe(false)
    expect(llmErr.provider).toBe('google')
  })

  it('rethrows {status:500} as LlmError server retryable', async () => {
    const client = makeFakeGemini(() => {
      throw { status: 500 }
    })
    const adapter = geminiAdapter({ client })

    const err = await adapter.run(makeResolvedReq(), FAKE_CTX).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LlmError)
    expect((err as LlmError).kind).toBe('server')
    expect((err as LlmError).retryable).toBe(true)
  })

  it('rethrows {status:403} as LlmError invalid_auth', async () => {
    const client = makeFakeGemini(() => {
      throw { status: 403 }
    })
    const adapter = geminiAdapter({ client })

    const err = await adapter.run(makeResolvedReq(), FAKE_CTX).catch((e: unknown) => e)
    expect((err as LlmError).kind).toBe('invalid_auth')
  })

  it('passes through provider tag on all errors', async () => {
    for (const status of [429, 401, 500]) {
      const client = makeFakeGemini(() => {
        throw { status }
      })
      const adapter = geminiAdapter({ client })
      const err = await adapter.run(makeResolvedReq(), FAKE_CTX).catch((e: unknown) => e)
      expect((err as LlmError).provider).toBe('google')
    }
  })

  it('client construction failure → LlmError not raw Error (fix: constructor inside try/catch)', async () => {
    // Simulate buildGoogleClient throwing (e.g. bad credentials, missing SDK)
    // by injecting a _clientFactory that throws a raw Error.
    const adapter = geminiAdapter({
      _clientFactory: () => {
        throw new Error('auth init failed')
      },
    })
    const err = await adapter.run(makeResolvedReq(), FAKE_CTX).catch((e: unknown) => e)
    // Must be a typed LlmError, not a raw Error.
    expect(err).toBeInstanceOf(LlmError)
    expect((err as LlmError).provider).toBe('google')
  })
})

// ---------------------------------------------------------------------------
// 9. providerOptions.google passthrough
// ---------------------------------------------------------------------------

describe('providerOptions.google passthrough', () => {
  it('spreads google providerOptions into the config (last, caller wins)', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })

    await adapter.run(
      makeResolvedReq({
        config: {
          serviceTier: 'flex',
          providerOptions: {
            google: {
              candidateCount: 2,
              seed: 42,
            },
          },
        },
      }),
      FAKE_CTX,
    )

    const call = client.calls[0] as {
      config?: { candidateCount?: number; seed?: number; serviceTier?: string }
    }
    expect(call?.config?.candidateCount).toBe(2)
    expect(call?.config?.seed).toBe(42)
    // Standard config should still be there
    expect(call?.config?.serviceTier).toBe('flex')
  })

  it('providerOptions.google can override serviceTier', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })

    await adapter.run(
      makeResolvedReq({
        config: {
          serviceTier: 'flex',
          providerOptions: {
            google: { serviceTier: 'standard' },
          },
        },
      }),
      FAKE_CTX,
    )

    const call = client.calls[0] as { config?: { serviceTier?: string } }
    // providerOptions spread last, so it wins
    expect(call?.config?.serviceTier).toBe('standard')
  })
})

// ---------------------------------------------------------------------------
// 10. modelVersion and responseId passthrough
// ---------------------------------------------------------------------------

describe('modelVersion and responseId', () => {
  it('passes modelVersion from response', async () => {
    const client = makeFakeGemini(
      fakeGeminiResponse({ text: 'ok', modelVersion: 'gemini-2.5-pro-001' }),
    )
    const adapter = geminiAdapter({ client })
    const result = await adapter.run(makeResolvedReq(), FAKE_CTX)
    expect(result.modelVersion).toBe('gemini-2.5-pro-001')
  })

  it('passes responseId from response', async () => {
    const client = makeFakeGemini(
      fakeGeminiResponse({ text: 'ok', responseId: 'resp-abc-123' }),
    )
    const adapter = geminiAdapter({ client })
    const result = await adapter.run(makeResolvedReq(), FAKE_CTX)
    expect(result.responseId).toBe('resp-abc-123')
  })
})

// ---------------------------------------------------------------------------
// 11. System instruction mapping
// ---------------------------------------------------------------------------

describe('system instruction', () => {
  it('sets systemInstruction in config when req.system is present', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })

    await adapter.run(
      makeResolvedReq({ system: 'You are a helpful assistant.' }),
      FAKE_CTX,
    )

    const call = client.calls[0] as {
      config?: { systemInstruction?: { parts: Array<{ text: string }> } }
    }
    expect(call?.config?.systemInstruction?.parts[0]?.text).toBe(
      'You are a helpful assistant.',
    )
  })
})

// ---------------------------------------------------------------------------
// 12. Message role mapping
// ---------------------------------------------------------------------------

describe('message role mapping', () => {
  it('maps assistant role to "model" for Gemini', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })

    await adapter.run(
      {
        model: 'gemini-2.5-pro',
        messages: [
          { role: 'user', parts: [{ kind: 'text', text: 'Hello' }] },
          { role: 'assistant', parts: [{ kind: 'text', text: 'Hi there' }] },
          { role: 'user', parts: [{ kind: 'text', text: 'How are you?' }] },
        ],
        config: { serviceTier: 'flex' },
      },
      FAKE_CTX,
    )

    const call = client.calls[0] as {
      contents: Array<{ role: string; parts: Array<{ text: string }> }>
    }
    expect(call?.contents[1]?.role).toBe('model')
    expect(call?.contents[0]?.role).toBe('user')
    expect(call?.contents[2]?.role).toBe('user')
  })
})

// ---------------------------------------------------------------------------
// 13. AbortSignal passthrough
// ---------------------------------------------------------------------------

describe('AbortSignal passthrough', () => {
  it('passes the signal to config.abortSignal unchanged on the standard-tier path', async () => {
    // Use serviceTier:'standard' (or any path where timeoutMs is set) so the adapter
    // passes ctx.signal through directly without wrapping it in AbortSignal.any.
    // FIX A-2 only arms a combined signal on the flex-default path (flex + no timeoutMs).
    const controller = new AbortController()
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })

    await adapter.run(
      makeResolvedReq({ signal: controller.signal, config: { serviceTier: 'standard' } }),
      { ...FAKE_CTX, signal: controller.signal },
    )

    const call = client.calls[0] as { config?: { abortSignal?: AbortSignal } }
    expect(call?.config?.abortSignal).toBe(controller.signal)
  })

  it('passes the signal to config.abortSignal unchanged when timeoutMs is set (engine handles timer)', async () => {
    const controller = new AbortController()
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })

    await adapter.run(
      makeResolvedReq({
        signal: controller.signal,
        config: { serviceTier: 'flex', timeoutMs: 60_000 },
      }),
      { ...FAKE_CTX, signal: controller.signal },
    )

    const call = client.calls[0] as { config?: { abortSignal?: AbortSignal } }
    expect(call?.config?.abortSignal).toBe(controller.signal)
  })
})

// ---------------------------------------------------------------------------
// 14. Full-stack integration test (no network)
// ---------------------------------------------------------------------------

describe('full-stack integration', () => {
  it('end-to-end: generate structured call → correct usage + cost + record', async () => {
    const schema = z.object({ answer: z.string(), confidence: z.number() })

    // Script the fake client to return a response with thought tokens
    const fakeClient = makeFakeGemini(
      fakeGeminiResponse({
        structuredJson: JSON.stringify({ answer: 'Paris', confidence: 0.99 }),
        promptTokenCount: 100,
        candidatesTokenCount: 50,
        thoughtsTokenCount: 30,
        cachedContentTokenCount: 20,
        totalTokenCount: 180,
        finishReason: 'STOP',
        modelVersion: 'gemini-2.5-pro-001',
        responseId: 'integration-resp-1',
      }),
    )

    const sink = new RecordingSink()
    const clock = new FakeClock(1000) // start at 1000ms
    const ids = new FakeIds()

    const client = createClient({
      adapters: [geminiAdapter({ client: fakeClient })],
      pricing: geminiPricingSource(),
      sink,
      clock,
      ids,
    })

    // Advance clock so latency > 0
    clock.advance(150)

    const result = await client.generate(
      {
        model: 'gemini-2.5-pro',
        messages: [
          {
            role: 'user',
            parts: [{ kind: 'text', text: 'What is the capital of France?' }],
          },
        ],
        output: { schema },
        config: {
          serviceTier: 'flex',
          reasoning: { includeThoughts: true, budgetTokens: 4096 },
        },
      },
      { auth: { apiKey: 'test-integration-key' } },
    )

    // Validate the result
    expect(result.output).toEqual({ answer: 'Paris', confidence: 0.99 })
    expect(result.modelVersion).toBe('gemini-2.5-pro-001')
    expect(result.responseId).toBe('integration-resp-1')
    expect(result.finishReason).toBe('stop')

    // #1 rule: outputTokens = candidates + thoughts
    expect(result.usage.outputTokens).toBe(80) // 50 + 30
    expect(result.usage.inputTokens).toBe(100)
    expect(result.usage.thinkingTokens).toBe(30)
    expect(result.usage.cachedInputTokens).toBe(20)

    // Cost should be present (gemini-2.5-pro is in the pricing table)
    expect(result.cost).toBeDefined()
    expect(result.cost?.microUsd).not.toBeNull()

    // Sink should have received the record
    expect(sink.records).toHaveLength(1)
    const record = sink.last()!

    expect(record.status).toBe('ok')
    expect(record.callId).toBe('call_1')
    expect(record.attemptId).toBe('attempt_1')
    expect(record.provider).toBe('google')
    expect(record.model).toBe('gemini-2.5-pro')
    expect(record.modelVersion).toBe('gemini-2.5-pro-001')
    expect(record.responseId).toBe('integration-resp-1')

    // Usage on record
    expect(record.outputTokens).toBe(80) // #1 rule enforced
    expect(record.inputTokens).toBe(100)
    expect(record.thinkingTokens).toBe(30)
    expect(record.cachedInputTokens).toBe(20)

    // Cost on record matches result.cost
    expect(record.costMicroUsd).toBe(result.cost?.microUsd)
    expect(record.pricingVersion).toBe(result.cost?.pricingVersion)

    // Service tier on record
    expect(record.serviceTier).toBe('flex')
  })

  it('end-to-end: blocked response → LlmError content_filter, error record persisted', async () => {
    const fakeClient = makeFakeGemini(fakeGeminiBlocked({ blockReason: 'SAFETY' }))
    const sink = new RecordingSink()

    const client = createClient({
      adapters: [geminiAdapter({ client: fakeClient })],
      pricing: geminiPricingSource(),
      sink,
    })

    await expect(
      client.generate(
        {
          model: 'gemini-2.5-pro',
          messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Bad prompt' }] }],
        },
        { auth: { apiKey: 'test-key' } },
      ),
    ).rejects.toMatchObject({ kind: 'content_filter' })

    // Error record should still be persisted (fail-closed call, fail-open sink)
    expect(sink.records).toHaveLength(1)
    expect(sink.last()?.status).toBe('content_filter')
  })
})

// ---------------------------------------------------------------------------
// Standard Schema — non-Zod vendor path
// ---------------------------------------------------------------------------

describe('Standard Schema — non-Zod vendor (e.g. valibot)', () => {
  /**
   * A hand-rolled Standard Schema v1 object with vendor 'valibot'.
   * Validates that the value has a `name` property of type string.
   */
  function makeCustomSchema<
    T extends { name: string },
  >(): import('@gullabs/core').StandardSchemaV1<T, T> {
    return {
      '~standard': {
        version: 1 as const,
        vendor: 'valibot',
        validate(value: unknown) {
          if (
            value !== null &&
            typeof value === 'object' &&
            'name' in value &&
            typeof (value as Record<string, unknown>)['name'] === 'string'
          ) {
            return { value: value as T }
          }
          return { issues: [{ message: 'Expected object with string name' }] }
        },
        types: undefined,
      },
    }
  }

  it('emits a warning when vendor is not zod and skips Gemini native responseSchema', async () => {
    const schema = makeCustomSchema<{ name: string }>()
    const client = makeFakeGemini(
      fakeGeminiResponse({ text: JSON.stringify({ name: 'Alice' }) }),
    )

    const adapter = geminiAdapter({ client })
    const result = await adapter.run(makeResolvedReq({ outputSchema: schema }), FAKE_CTX)

    // The adapter should warn that native schema enforcement was skipped.
    const schemaWarning = result.warnings.find(
      (w) => w.type === 'other' && 'message' in w && w.message.includes('valibot'),
    )
    expect(schemaWarning).toBeDefined()
    expect(schemaWarning?.type).toBe('other')

    // rawStructured should be populated (adapter still parses JSON).
    expect(result.rawStructured).toEqual({ name: 'Alice' })
  })

  it('engine validates output via Standard Schema for non-Zod vendor', async () => {
    const schema = makeCustomSchema<{ name: string }>()
    const client = makeFakeGemini(
      fakeGeminiResponse({ text: JSON.stringify({ name: 'Bob' }) }),
    )

    // Use createClient to test the full engine validation path.
    const llmClient = createClient({
      adapters: [geminiAdapter({ client })],
      pricing: geminiPricingSource(),
    })

    const result = await llmClient.generate(
      {
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Name?' }] }],
        output: { schema },
      },
      { auth: { apiKey: 'test-key' } },
    )

    // Engine validated and returned the typed output.
    expect(result.output).toEqual({ name: 'Bob' })
    // Warning about skipped native schema should propagate to result.
    const schemaWarning = result.warnings.find(
      (w) => w.type === 'other' && 'message' in w && w.message.includes('valibot'),
    )
    expect(schemaWarning).toBeDefined()
  })

  it('engine throws parse_error when non-Zod Standard Schema validation fails', async () => {
    const schema = makeCustomSchema<{ name: string }>()
    const client = makeFakeGemini(
      // Return invalid JSON (missing the name field).
      fakeGeminiResponse({ text: JSON.stringify({ wrong: 'field' }) }),
    )

    const llmClient = createClient({
      adapters: [geminiAdapter({ client })],
      pricing: geminiPricingSource(),
    })

    await expect(
      llmClient.generate(
        {
          model: 'gemini-2.5-pro',
          messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Name?' }] }],
          output: { schema },
        },
        { auth: { apiKey: 'test-key' } },
      ),
    ).rejects.toThrow(LlmError)

    // Verify the error kind
    try {
      await llmClient.generate(
        {
          model: 'gemini-2.5-pro',
          messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Name?' }] }],
          output: { schema },
        },
        { auth: { apiKey: 'test-key' } },
      )
    } catch (err) {
      expect(err).toBeInstanceOf(LlmError)
      expect((err as LlmError).kind).toBe('parse_error')
    }
  })
})

// ---------------------------------------------------------------------------
// 16. Multimodal part mapping
// ---------------------------------------------------------------------------

describe('multimodal part mapping', () => {
  /** Extract the contents array from a captured fake-client call. */
  function getContents(call: unknown): Array<{ role: string; parts: unknown[] }> {
    return (call as { contents: Array<{ role: string; parts: unknown[] }> }).contents
  }

  it('maps a text part to { text }', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })

    await adapter.run(
      makeResolvedReq({
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hello' }] }],
      }),
      FAKE_CTX,
    )

    const parts = getContents(client.calls[0])[0]!.parts
    expect(parts).toEqual([{ text: 'hello' }])
  })

  it('maps an inline-media part to { inlineData: { mimeType, data } }', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })

    await adapter.run(
      makeResolvedReq({
        messages: [
          {
            role: 'user',
            parts: [{ kind: 'inline-media', mimeType: 'image/png', data: 'base64abc' }],
          },
        ],
      }),
      FAKE_CTX,
    )

    const parts = getContents(client.calls[0])[0]!.parts
    expect(parts).toEqual([{ inlineData: { mimeType: 'image/png', data: 'base64abc' } }])
  })

  it('maps a file-uri part to { fileData: { mimeType, fileUri } }', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })

    await adapter.run(
      makeResolvedReq({
        messages: [
          {
            role: 'user',
            parts: [
              {
                kind: 'file-uri',
                uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc',
                mimeType: 'video/mp4',
              },
            ],
          },
        ],
      }),
      FAKE_CTX,
    )

    const parts = getContents(client.calls[0])[0]!.parts
    expect(parts).toEqual([
      {
        fileData: {
          mimeType: 'video/mp4',
          fileUri: 'https://generativelanguage.googleapis.com/v1beta/files/abc',
        },
      },
    ])
  })

  it('preserves mixed part order in one message', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })

    await adapter.run(
      makeResolvedReq({
        messages: [
          {
            role: 'user',
            parts: [
              { kind: 'text', text: 'describe this image:' },
              { kind: 'inline-media', mimeType: 'image/jpeg', data: 'b64data' },
              {
                kind: 'file-uri',
                uri: 'gs://bucket/file.mp4',
                mimeType: 'video/mp4',
              },
              { kind: 'text', text: 'and this video' },
            ],
          },
        ],
      }),
      FAKE_CTX,
    )

    const parts = getContents(client.calls[0])[0]!.parts
    expect(parts).toEqual([
      { text: 'describe this image:' },
      { inlineData: { mimeType: 'image/jpeg', data: 'b64data' } },
      { fileData: { mimeType: 'video/mp4', fileUri: 'gs://bucket/file.mp4' } },
      { text: 'and this video' },
    ])
  })

  it.each([
    ['low', 'MEDIA_RESOLUTION_LOW'],
    ['medium', 'MEDIA_RESOLUTION_MEDIUM'],
    ['high', 'MEDIA_RESOLUTION_HIGH'],
  ] as const)(
    'maps inline-media mediaResolution %s → %s on the emitted part',
    async (level, expected) => {
      const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
      const adapter = geminiAdapter({ client })

      const result = await adapter.run(
        makeResolvedReq({
          messages: [
            {
              role: 'user',
              parts: [
                {
                  kind: 'inline-media',
                  mimeType: 'image/png',
                  data: 'abc',
                  mediaResolution: level,
                },
              ],
            },
          ],
        }),
        FAKE_CTX,
      )

      const parts = getContents(client.calls[0])[0]!.parts
      expect(parts[0]).toMatchObject({ mediaResolution: { level: expected } })
      expect(
        result.warnings.filter((w) => w.type === 'unsupported-setting'),
      ).toHaveLength(0)
    },
  )

  it.each([
    ['low', 'MEDIA_RESOLUTION_LOW'],
    ['medium', 'MEDIA_RESOLUTION_MEDIUM'],
    ['high', 'MEDIA_RESOLUTION_HIGH'],
  ] as const)(
    'maps file-uri mediaResolution %s → %s on the emitted part',
    async (level, expected) => {
      const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
      const adapter = geminiAdapter({ client })

      const result = await adapter.run(
        makeResolvedReq({
          messages: [
            {
              role: 'user',
              parts: [
                {
                  kind: 'file-uri',
                  uri: 'gs://bucket/file.mp4',
                  mimeType: 'video/mp4',
                  mediaResolution: level,
                },
              ],
            },
          ],
        }),
        FAKE_CTX,
      )

      const parts = getContents(client.calls[0])[0]!.parts
      expect(parts[0]).toMatchObject({ mediaResolution: { level: expected } })
      expect(
        result.warnings.filter((w) => w.type === 'unsupported-setting'),
      ).toHaveLength(0)
    },
  )

  it('does not emit warning when mediaResolution is absent', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })

    await adapter.run(
      makeResolvedReq({
        messages: [
          {
            role: 'user',
            parts: [{ kind: 'inline-media', mimeType: 'image/png', data: 'abc' }],
          },
        ],
      }),
      FAKE_CTX,
    )

    const parts = getContents(client.calls[0])[0]!.parts
    expect(parts).toEqual([{ inlineData: { mimeType: 'image/png', data: 'abc' } }])
    expect(parts[0]).not.toHaveProperty('mediaResolution')
  })

  it('omits mediaResolution when unset on file-uri', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })

    await adapter.run(
      makeResolvedReq({
        messages: [
          {
            role: 'user',
            parts: [{ kind: 'file-uri', uri: 'gs://b/f', mimeType: 'image/jpeg' }],
          },
        ],
      }),
      FAKE_CTX,
    )

    const parts = getContents(client.calls[0])[0]!.parts
    expect(parts).toEqual([{ fileData: { mimeType: 'image/jpeg', fileUri: 'gs://b/f' } }])
    expect(parts[0]).not.toHaveProperty('mediaResolution')
  })
})

// ---------------------------------------------------------------------------
// 17. Transport timeout (httpOptions.timeout)
// ---------------------------------------------------------------------------

describe('transport timeout (httpOptions.timeout)', () => {
  it('sets httpOptions.timeout to timeoutMs + TRANSPORT_TIMEOUT_BUFFER_MS when timeoutMs is set', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })

    await adapter.run(
      makeResolvedReq({ config: { serviceTier: 'flex', timeoutMs: 1_200_000 } }),
      FAKE_CTX,
    )

    // Engine AbortSignal fires at 1_200_000 ms; transport sits 5 s above it.
    const call = client.calls[0] as { config?: { httpOptions?: { timeout?: number } } }
    expect(call?.config?.httpOptions?.timeout).toBe(1_205_000)
  })

  it('sets httpOptions.timeout to FLEX_DEFAULT_TIMEOUT_MS (1_500_000) when serviceTier is flex and no timeoutMs', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })

    await adapter.run(makeResolvedReq({ config: { serviceTier: 'flex' } }), FAKE_CTX)

    const call = client.calls[0] as { config?: { httpOptions?: { timeout?: number } } }
    expect(call?.config?.httpOptions?.timeout).toBe(1_500_000)
  })

  it('does NOT set httpOptions.timeout when serviceTier is standard and no timeoutMs', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })

    await adapter.run(makeResolvedReq({ config: { serviceTier: 'standard' } }), FAKE_CTX)

    const call = client.calls[0] as { config?: { httpOptions?: { timeout?: number } } }
    expect(call?.config?.httpOptions).toBeUndefined()
  })

  it('uses timeoutMs + buffer (not FLEX_DEFAULT) when both timeoutMs and flex are set', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })

    await adapter.run(
      makeResolvedReq({ config: { serviceTier: 'flex', timeoutMs: 300_000 } }),
      FAKE_CTX,
    )

    const call = client.calls[0] as { config?: { httpOptions?: { timeout?: number } } }
    expect(call?.config?.httpOptions?.timeout).toBe(305_000)
  })

  it('caller-supplied httpOptions.timeout wins over computed timeout and extra fields are preserved', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })

    // Caller passes httpOptions with a custom timeout AND an extra field.
    // The adapter computes timeoutMs + buffer = 1_205_000, but caller's 42 wins.
    await adapter.run(
      makeResolvedReq({
        config: {
          serviceTier: 'flex',
          timeoutMs: 1_200_000,
          providerOptions: {
            google: {
              httpOptions: { timeout: 42, someOtherField: 'x' },
            },
          },
        },
      }),
      FAKE_CTX,
    )

    const call = client.calls[0] as {
      config?: { httpOptions?: Record<string, unknown> }
    }
    // Caller timeout wins over computed timeout.
    expect(call?.config?.httpOptions?.['timeout']).toBe(42)
    // Extra caller field is preserved.
    expect(call?.config?.httpOptions?.['someOtherField']).toBe('x')
  })
})

// ---------------------------------------------------------------------------
// 18. Grounding — conflict guard
// ---------------------------------------------------------------------------

describe('grounding — conflict guard', () => {
  it('rejects with LlmError bad_request when googleSearch tool + outputSchema both present', async () => {
    const schema = z.object({ answer: z.string() })
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })

    const err = await adapter
      .run(
        makeResolvedReq({
          outputSchema: schema,
          config: {
            serviceTier: 'flex',
            providerOptions: { google: { tools: [{ googleSearch: {} }] } },
          },
        }),
        FAKE_CTX,
      )
      .catch((e: unknown) => e)

    expect(err).toBeInstanceOf(LlmError)
    expect((err as LlmError).kind).toBe('bad_request')
    expect((err as LlmError).retryable).toBe(false)
    expect((err as LlmError).message).toMatch(/grounding.*structured output/i)
  })

  it('rejects with LlmError bad_request when googleSearchRetrieval tool + outputSchema both present', async () => {
    const schema = z.object({ answer: z.string() })
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })

    await expect(
      adapter.run(
        makeResolvedReq({
          outputSchema: schema,
          config: {
            serviceTier: 'flex',
            providerOptions: { google: { tools: [{ googleSearchRetrieval: {} }] } },
          },
        }),
        FAKE_CTX,
      ),
    ).rejects.toMatchObject({ kind: 'bad_request', retryable: false })
  })

  it('audit record is persisted when grounding+schema conflict throws (full-stack)', async () => {
    const schema = z.object({ answer: z.string() })
    const fakeClient = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const sink = new RecordingSink()

    const llmClient = createClient({
      adapters: [geminiAdapter({ client: fakeClient })],
      pricing: geminiPricingSource(),
      sink,
    })

    await expect(
      llmClient.generate(
        {
          model: 'gemini-2.5-pro',
          messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }],
          output: { schema },
          config: {
            providerOptions: { google: { tools: [{ googleSearch: {} }] } },
          },
        },
        { auth: { apiKey: 'test-key' } },
      ),
    ).rejects.toMatchObject({ kind: 'bad_request' })

    expect(sink.records).toHaveLength(1)
    expect(sink.last()?.status).toBe('api_error')
    expect(sink.last()?.errorKind).toBe('bad_request')
  })

  it('succeeds when googleSearch tool is present WITHOUT outputSchema', async () => {
    const fakeGrounding = {
      webSearchQueries: ['what is the capital of France?'],
      groundingChunks: [],
    }
    const client = makeFakeGemini(
      fakeGeminiResponse({ text: 'Paris', groundingMetadata: fakeGrounding }),
    )
    const adapter = geminiAdapter({ client })

    const result = await adapter.run(
      makeResolvedReq({
        config: {
          serviceTier: 'flex',
          providerOptions: { google: { tools: [{ googleSearch: {} }] } },
        },
      }),
      FAKE_CTX,
    )

    expect(result.text).toBe('Paris')
    const meta = result.providerMetadata as { groundingMetadata?: unknown } | undefined
    expect(meta?.groundingMetadata).toEqual(fakeGrounding)
  })
})

// ---------------------------------------------------------------------------
// 19. Grounding — providerMetadata merge
// ---------------------------------------------------------------------------

describe('grounding — providerMetadata merge', () => {
  it('includes only groundingMetadata when no promptFeedback', async () => {
    const fakeGrounding = { webSearchQueries: ['q1'], groundingChunks: [] }
    const client = makeFakeGemini(
      fakeGeminiResponse({ text: 'hi', groundingMetadata: fakeGrounding }),
    )
    const adapter = geminiAdapter({ client })
    const result = await adapter.run(makeResolvedReq(), FAKE_CTX)

    const meta = result.providerMetadata as Record<string, unknown> | undefined
    expect(meta?.['groundingMetadata']).toEqual(fakeGrounding)
    expect(meta?.['promptFeedback']).toBeUndefined()
  })

  it('includes both promptFeedback and groundingMetadata when both are present', async () => {
    const fakeGrounding = { webSearchQueries: ['test query'] }
    const rawResp = {
      candidates: [
        {
          content: { parts: [{ text: 'hello' }] },
          finishReason: 'STOP',
          groundingMetadata: fakeGrounding,
        },
      ],
      promptFeedback: { safetyRatings: [] as unknown[] },
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
    }
    const client = makeFakeGemini(rawResp)
    const adapter = geminiAdapter({ client })
    const result = await adapter.run(makeResolvedReq(), FAKE_CTX)

    const meta = result.providerMetadata as Record<string, unknown> | undefined
    expect(meta?.['promptFeedback']).toBeDefined()
    expect(meta?.['groundingMetadata']).toEqual(fakeGrounding)
  })

  it('omits providerMetadata entirely when neither promptFeedback nor groundingMetadata is present', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'plain' }))
    const adapter = geminiAdapter({ client })
    const result = await adapter.run(makeResolvedReq(), FAKE_CTX)

    expect(result.providerMetadata).toBeUndefined()
  })

  it('grounding metadata is persisted on the record (full-stack)', async () => {
    const fakeGrounding = {
      webSearchQueries: ['capital of France'],
      groundingChunks: [{ web: { uri: 'https://example.com', title: 'Example' } }],
    }
    const fakeClient = makeFakeGemini(
      fakeGeminiResponse({
        text: 'Paris',
        groundingMetadata: fakeGrounding,
        promptTokenCount: 10,
        candidatesTokenCount: 5,
        finishReason: 'STOP',
      }),
    )
    const sink = new RecordingSink()
    const llmClient = createClient({
      adapters: [geminiAdapter({ client: fakeClient })],
      pricing: geminiPricingSource(),
      sink,
    })

    const result = await llmClient.generate(
      {
        model: 'gemini-2.5-pro',
        messages: [
          { role: 'user', parts: [{ kind: 'text', text: 'Capital of France?' }] },
        ],
        config: { providerOptions: { google: { tools: [{ googleSearch: {} }] } } },
      },
      { auth: { apiKey: 'test-key' } },
    )

    const resultMeta = result.providerMetadata as Record<string, unknown> | undefined
    expect(resultMeta?.['groundingMetadata']).toEqual(fakeGrounding)

    expect(sink.records).toHaveLength(1)
    const recordMeta = sink.last()?.providerMetadata as
      | Record<string, unknown>
      | undefined
    expect(recordMeta?.['groundingMetadata']).toEqual(fakeGrounding)
  })
})

// ---------------------------------------------------------------------------
// 20. Grounding — registry capabilities
// ---------------------------------------------------------------------------

describe('grounding — registry capabilities', () => {
  it('all 7 Gemini model descriptors have capabilities.grounding === true', () => {
    expect(geminiModelDescriptors).toHaveLength(7)
    for (const desc of geminiModelDescriptors) {
      expect(desc.capabilities?.grounding).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// Fixed-sampling invariant re-assertion (FIX 4)
// ---------------------------------------------------------------------------

describe('fixed-sampling invariant re-assertion after providerOptions merge', () => {
  it('strips temperature/topP/topK from providerOptions.google for a fixed-sampling model and emits a warning', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })

    const result = await adapter.run(
      {
        model: 'gemini-3.5-flash',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }],
        config: {
          serviceTier: 'flex',
          providerOptions: {
            google: { temperature: 0.9, topP: 0.8, topK: 40 },
          },
        },
        modelDescriptor: {
          id: 'gemini-3.5-flash',
          provider: 'google',
          pricingFamily: 'gemini-3.5-flash',
          capabilities: {
            reasoning: true,
            structuredOutput: true,
            reasoningApi: 'level',
            sampling: 'fixed',
          },
        },
      },
      FAKE_CTX,
    )

    // SDK must NOT receive sampling parameters
    const call = client.calls[0] as {
      config?: { temperature?: number; topP?: number; topK?: number }
    }
    expect(call?.config?.temperature).toBeUndefined()
    expect(call?.config?.topP).toBeUndefined()
    expect(call?.config?.topK).toBeUndefined()

    // A warning must be surfaced
    expect(result.warnings.length).toBeGreaterThanOrEqual(1)
    const samplingWarning = result.warnings.find((w) => w.type === 'unsupported-setting')
    expect(samplingWarning).toBeDefined()
    expect((samplingWarning as { setting?: string }).setting).toContain('temperature')
  })

  it('keeps providerOptions temperature for a tunable-sampling model (gemini-2.5-pro)', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })

    await adapter.run(
      {
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }],
        config: {
          serviceTier: 'flex',
          providerOptions: {
            google: { temperature: 0.7 },
          },
        },
        modelDescriptor: {
          id: 'gemini-2.5-pro',
          provider: 'google',
          pricingFamily: 'gemini-2.5-pro',
          capabilities: {
            reasoning: true,
            structuredOutput: true,
            reasoningApi: 'budget',
            sampling: 'tunable',
          },
        },
      },
      FAKE_CTX,
    )

    // SDK MUST receive temperature for tunable models
    const call = client.calls[0] as { config?: { temperature?: number } }
    expect(call?.config?.temperature).toBe(0.7)
  })
})

// ---------------------------------------------------------------------------
// FIX A-2. Client-side AbortSignal for flex default timeout
// ---------------------------------------------------------------------------

describe('FIX A-2: client-side flex AbortSignal ceiling', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('aborts a hanging flex call at FLEX_DEFAULT_TIMEOUT_MS when no timeoutMs is set', async () => {
    vi.useFakeTimers()

    // A client that hangs until the AbortSignal fires.
    const hangingClient: GeminiClientLike = {
      models: {
        generateContent(params): Promise<GeminiResponseShape> {
          return new Promise<GeminiResponseShape>((_resolve, reject) => {
            const sig = params.config?.abortSignal
            if (sig?.aborted === true) {
              reject(sig.reason)
              return
            }
            sig?.addEventListener('abort', () => reject(sig.reason), { once: true })
          })
        },
      },
    }

    const adapter = geminiAdapter({ client: hangingClient })

    // No timeoutMs — engine arms no AbortSignal; adapter must arm a client-side timer.
    // Attach .catch() BEFORE advancing timers so the rejection is never unhandled.
    const errPromise = adapter
      .run(makeResolvedReq({ config: { serviceTier: 'flex' } }), FAKE_CTX)
      .catch((e: unknown) => e)

    // Advance fake timers past FLEX_DEFAULT_TIMEOUT_MS — triggers the adapter's setTimeout.
    await vi.advanceTimersByTimeAsync(FLEX_DEFAULT_TIMEOUT_MS + 1)

    const err = await errPromise
    expect(err).toBeInstanceOf(LlmError)
    expect((err as LlmError).kind).toBe('timeout')
  })

  it('does NOT arm the flex timer when timeoutMs is set (engine handles that path)', async () => {
    vi.useFakeTimers()

    // Track whether abortSignal is set and what type it is.
    let capturedSignal: AbortSignal | undefined

    const capturingClient: GeminiClientLike = {
      models: {
        generateContent(params): Promise<GeminiResponseShape> {
          capturedSignal = params.config?.abortSignal
          // Resolve immediately — we just want to inspect the config.
          return Promise.resolve({
            candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
            usageMetadata: {},
          })
        },
      },
    }

    const engineController = new AbortController()
    const adapter = geminiAdapter({ client: capturingClient })

    await adapter.run(
      makeResolvedReq({ config: { serviceTier: 'flex', timeoutMs: 60_000 } }),
      { ...FAKE_CTX, signal: engineController.signal },
    )

    // When timeoutMs is set, we pass ctx.signal through (engine handles the deadline).
    // The captured signal should BE the engine signal, not a combined one.
    expect(capturedSignal).toBe(engineController.signal)
  })

  it('combines the flex timer with the incoming caller signal', async () => {
    vi.useFakeTimers()

    let capturedSignal: AbortSignal | undefined

    const capturingClient: GeminiClientLike = {
      models: {
        generateContent(params): Promise<GeminiResponseShape> {
          capturedSignal = params.config?.abortSignal
          // Hang — we'll abort via the caller signal.
          return new Promise<GeminiResponseShape>((_resolve, reject) => {
            const sig = params.config?.abortSignal
            if (sig?.aborted === true) {
              reject(sig.reason)
              return
            }
            sig?.addEventListener('abort', () => reject(sig.reason), { once: true })
          })
        },
      },
    }

    const callerController = new AbortController()
    const adapter = geminiAdapter({ client: capturingClient })

    // Attach .catch() BEFORE advancing timers so the rejection is never unhandled.
    const errPromise = adapter
      .run(makeResolvedReq({ config: { serviceTier: 'flex' } }), {
        ...FAKE_CTX,
        signal: callerController.signal,
      })
      .catch((e: unknown) => e)

    // Abort via caller signal (before the flex timer fires).
    callerController.abort(new DOMException('caller cancelled', 'AbortError'))
    await vi.advanceTimersByTimeAsync(1)

    const err = await errPromise
    expect(err).toBeInstanceOf(LlmError)
    // Caller-triggered abort → kind:'aborted'
    expect((err as LlmError).kind).toBe('aborted')

    // Confirm a combined signal was passed (not the raw callerController signal).
    expect(capturedSignal).not.toBe(callerController.signal)
    expect(capturedSignal?.aborted).toBe(true)
  })
})
