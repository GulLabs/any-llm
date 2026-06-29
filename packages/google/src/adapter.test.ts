/**
 * @gullabs/google — adapter contract tests.
 *
 * All tests use fakes from @gullabs/testing — NO real network calls.
 * makeFakeGemini/fakeGeminiResponse/fakeGeminiBlocked are the sole test doubles.
 *
 * @module
 */

import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import {
  LlmError,
  createClient,
  geminiPricingSource,
} from '@gullabs/core'
import type { ResolvedRequest, AdapterCtx } from '@gullabs/core'
import {
  fakeGeminiResponse,
  fakeGeminiBlocked,
  makeFakeGemini,
  FakeClock,
  FakeIds,
  RecordingSink,
  fakeAuth,
} from '@gullabs/testing'
import { geminiAdapter } from './adapter.js'
import { zodToGeminiSchema } from './schema.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal resolved request for unit tests. */
function makeResolvedReq(
  overrides: Partial<ResolvedRequest> = {},
): ResolvedRequest {
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
  logger: { info() {}, warn() {}, error() {} },
}

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
    const client = makeFakeGemini(
      fakeGeminiResponse({ text: 'ok' }),
    )

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
          id: 'gemini-2.5-pro', provider: 'google',
          capabilities: { reasoning: true, structuredOutput: true, reasoningApi: 'budget' },
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
          id: 'gemini-2.5-flash', provider: 'google',
          capabilities: { reasoning: true, structuredOutput: true, reasoningApi: 'budget' },
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
          id: 'gemini-2.5-pro', provider: 'google',
          capabilities: { reasoning: true, structuredOutput: true, reasoningApi: 'budget' },
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
          id: 'gemini-3.0-pro', provider: 'google',
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
          id: 'gemini-3.5-pro', provider: 'google',
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
          id: 'gemini-3.0-ultra', provider: 'google',
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
          id: 'gemini-2.5-pro', provider: 'google',
          capabilities: { reasoning: true, structuredOutput: true, reasoningApi: 'budget' },
        },
        config: { serviceTier: 'flex', reasoning: { includeThoughts: true } },
      }),
      FAKE_CTX,
    )

    expect(result.reasoningText).toBe('I am thinking...')
    expect(result.text).toBe('The answer is 42.')
  })

  it('sets includeThoughts in thinkingConfig when reasoning.includeThoughts is true', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok', thoughtText: 'thinking' }))
    const adapter = geminiAdapter({ client })

    await adapter.run(
      makeResolvedReq({
        model: 'gemini-2.5-pro',
        modelDescriptor: {
          id: 'gemini-2.5-pro', provider: 'google',
          capabilities: { reasoning: true, structuredOutput: true, reasoningApi: 'budget' },
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

    await adapter.run(
      makeResolvedReq({ outputSchema: schema }),
      FAKE_CTX,
    )

    const call = client.calls[0] as { config?: { responseMimeType?: string } }
    expect(call?.config?.responseMimeType).toBe('application/json')
  })

  it('produces a responseSchema from a simple Zod object', async () => {
    const schema = z.object({ name: z.string(), age: z.number() })
    const client = makeFakeGemini(
      fakeGeminiResponse({ structuredJson: '{"name":"Alice","age":30}' }),
    )
    const adapter = geminiAdapter({ client })

    await adapter.run(
      makeResolvedReq({ outputSchema: schema }),
      FAKE_CTX,
    )

    const call = client.calls[0] as {
      config?: { responseSchema?: { type?: string; properties?: Record<string, { type?: string }> } }
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

    const result = await adapter.run(
      makeResolvedReq({ outputSchema: schema }),
      FAKE_CTX,
    )

    expect(result.rawStructured).toEqual({ name: 'Bob' })
  })

  it('leaves rawStructured undefined on JSON parse failure', async () => {
    const schema = z.object({ name: z.string() })
    const client = makeFakeGemini(
      fakeGeminiResponse({ structuredJson: 'not-json' }),
    )
    const adapter = geminiAdapter({ client })

    const result = await adapter.run(
      makeResolvedReq({ outputSchema: schema }),
      FAKE_CTX,
    )

    expect(result.rawStructured).toBeUndefined()
  })

  it('emits unsupported-setting warning when schema cannot be converted', async () => {
    // ZodFunction is not supported by zodToGeminiSchema
    const schema = z.function()
    const client = makeFakeGemini(
      fakeGeminiResponse({ text: '{}' }),
    )
    const adapter = geminiAdapter({ client })

    const result = await adapter.run(
      makeResolvedReq({ outputSchema: schema }),
      FAKE_CTX,
    )

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
      const client = makeFakeGemini(() => { throw { status } })
      const adapter = geminiAdapter({ client })
      const err = await adapter.run(makeResolvedReq(), FAKE_CTX).catch((e: unknown) => e)
      expect((err as LlmError).provider).toBe('google')
    }
  })

  it('client construction failure → LlmError not raw Error (fix: constructor inside try/catch)', async () => {
    // Simulate buildGoogleClient throwing (e.g. bad credentials, missing SDK)
    // by injecting a _clientFactory that throws a raw Error.
    const adapter = geminiAdapter({
      _clientFactory: () => { throw new Error('auth init failed') },
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
  it('passes the signal to config.abortSignal', async () => {
    const controller = new AbortController()
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })

    await adapter.run(
      makeResolvedReq({ signal: controller.signal }),
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
      auth: fakeAuth({ apiKey: 'test-integration-key' }),
      pricing: geminiPricingSource(),
      sink,
      clock,
      ids,
    })

    // Advance clock so latency > 0
    clock.advance(150)

    const result = await client.generate({
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
    })

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
      auth: fakeAuth({ apiKey: 'test-key' }),
      pricing: geminiPricingSource(),
      sink,
    })

    await expect(
      client.generate({
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Bad prompt' }] }],
      }),
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
  function makeCustomSchema<T extends { name: string }>(): import('@gullabs/core').StandardSchemaV1<T, T> {
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
    const result = await adapter.run(
      makeResolvedReq({ outputSchema: schema }),
      FAKE_CTX,
    )

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
      auth: fakeAuth({ apiKey: 'test-key' }),
      pricing: geminiPricingSource(),
    })

    const result = await llmClient.generate({
      model: 'gemini-2.5-pro',
      messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Name?' }] }],
      output: { schema },
    })

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
      auth: fakeAuth({ apiKey: 'test-key' }),
      pricing: geminiPricingSource(),
    })

    await expect(
      llmClient.generate({
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Name?' }] }],
        output: { schema },
      }),
    ).rejects.toThrow(LlmError)

    // Verify the error kind
    try {
      await llmClient.generate({
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Name?' }] }],
        output: { schema },
      })
    } catch (err) {
      expect(err).toBeInstanceOf(LlmError)
      expect((err as LlmError).kind).toBe('parse_error')
    }
  })
})
