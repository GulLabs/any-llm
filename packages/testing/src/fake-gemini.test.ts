import { describe, it, expect } from 'vitest'
import {
  fakeGeminiResponse,
  fakeGeminiBlocked,
  makeFakeGemini,
  type GeminiResponseLike,
} from './fake-gemini.js'

// ---------------------------------------------------------------------------
// fakeGeminiResponse
// ---------------------------------------------------------------------------

describe('fakeGeminiResponse', () => {
  it('returns a valid GeminiResponseLike with defaults (no opts)', () => {
    const r = fakeGeminiResponse()
    expect(r.candidates).toHaveLength(1)
    expect(r.usageMetadata).toBeDefined()
    expect(r.candidates?.[0]?.content?.parts).toEqual([])
  })

  it('builds text output in a non-thought part', () => {
    const r = fakeGeminiResponse({ text: 'Hello world' })
    const parts = r.candidates?.[0]?.content?.parts ?? []
    expect(parts).toHaveLength(1)
    expect(parts[0]).toEqual({ text: 'Hello world' })
  })

  it('builds a thought-summary part before the main text', () => {
    const r = fakeGeminiResponse({ text: 'answer', thoughtText: 'thinking...' })
    const parts = r.candidates?.[0]?.content?.parts ?? []
    expect(parts).toHaveLength(2)
    expect(parts[0]).toEqual({ text: 'thinking...', thought: true })
    expect(parts[1]).toEqual({ text: 'answer' })
  })

  it('places structuredJson in a plain text part', () => {
    const json = '{"key":"value"}'
    const r = fakeGeminiResponse({ structuredJson: json })
    const parts = r.candidates?.[0]?.content?.parts ?? []
    expect(parts).toHaveLength(1)
    expect(parts[0]).toEqual({ text: json })
  })

  it('prefers structuredJson over text when both are provided', () => {
    const r = fakeGeminiResponse({ text: 'ignored', structuredJson: '{"ok":true}' })
    const parts = r.candidates?.[0]?.content?.parts ?? []
    expect(parts[0]?.text).toBe('{"ok":true}')
  })

  it('populates all usage metadata fields', () => {
    const r = fakeGeminiResponse({
      promptTokenCount: 100,
      candidatesTokenCount: 50,
      cachedContentTokenCount: 20,
      thoughtsTokenCount: 10,
      totalTokenCount: 150,
    })
    expect(r.usageMetadata).toEqual({
      promptTokenCount: 100,
      candidatesTokenCount: 50,
      cachedContentTokenCount: 20,
      thoughtsTokenCount: 10,
      totalTokenCount: 150,
    })
  })

  it('omits usage metadata keys that were not specified', () => {
    const r = fakeGeminiResponse({ promptTokenCount: 5 })
    expect(r.usageMetadata).toEqual({ promptTokenCount: 5 })
    expect(r.usageMetadata).not.toHaveProperty('candidatesTokenCount')
  })

  it('sets finishReason on the candidate', () => {
    const r = fakeGeminiResponse({ finishReason: 'STOP' })
    expect(r.candidates?.[0]?.finishReason).toBe('STOP')
  })

  it('sets modelVersion and responseId at the top level', () => {
    const r = fakeGeminiResponse({ modelVersion: 'gemini-2.5-pro-001', responseId: 'resp-abc' })
    expect(r.modelVersion).toBe('gemini-2.5-pro-001')
    expect(r.responseId).toBe('resp-abc')
  })

  it('omits modelVersion/responseId when not specified', () => {
    const r = fakeGeminiResponse()
    expect(r).not.toHaveProperty('modelVersion')
    expect(r).not.toHaveProperty('responseId')
  })
})

// ---------------------------------------------------------------------------
// fakeGeminiBlocked
// ---------------------------------------------------------------------------

describe('fakeGeminiBlocked', () => {
  it('produces an empty candidates array and a promptFeedback with blockReason', () => {
    const r = fakeGeminiBlocked()
    expect(r.candidates).toEqual([])
    expect(r.promptFeedback).toBeDefined()
    expect(r.promptFeedback?.blockReason).toBe('SAFETY')
  })

  it('defaults blockReason to "SAFETY" when opts is omitted', () => {
    const r = fakeGeminiBlocked()
    expect(r.promptFeedback?.blockReason).toBe('SAFETY')
  })

  it('accepts a custom blockReason', () => {
    const r = fakeGeminiBlocked({ blockReason: 'PROHIBITED_CONTENT' })
    expect(r.promptFeedback?.blockReason).toBe('PROHIBITED_CONTENT')
  })

  it('omits usageMetadata (blocked before generation)', () => {
    const r = fakeGeminiBlocked()
    expect(r.usageMetadata).toBeUndefined()
  })

  it('has no text content in candidates', () => {
    const r = fakeGeminiBlocked()
    expect(r.candidates?.length).toBe(0)
  })

  it('includes safetyRatings in promptFeedback when provided', () => {
    const ratings = [{ category: 'HARM_CATEGORY_DANGEROUS_CONTENT', probability: 'HIGH' }]
    const r = fakeGeminiBlocked({ safetyRatings: ratings })
    expect(r.promptFeedback?.safetyRatings).toEqual(ratings)
  })

  it('omits safetyRatings from promptFeedback when not provided', () => {
    const r = fakeGeminiBlocked()
    expect(r.promptFeedback).not.toHaveProperty('safetyRatings')
  })

  it('is structurally assignable to GeminiResponseLike', () => {
    // Compile-time + runtime check: if this assignment compiles and runs, the type is correct.
    const r: GeminiResponseLike = fakeGeminiBlocked({ blockReason: 'SAFETY' })
    expect(r).toBeDefined()
  })

  it('can be scripted into makeFakeGemini', async () => {
    const client = makeFakeGemini(fakeGeminiBlocked())
    const resp = await client.models.generateContent({})
    expect(resp.candidates).toEqual([])
    expect(resp.promptFeedback?.blockReason).toBe('SAFETY')
    expect(client.calls).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// makeFakeGemini — single response
// ---------------------------------------------------------------------------

describe('makeFakeGemini — single response', () => {
  it('returns the same response on every call', async () => {
    const resp = fakeGeminiResponse({ text: 'hello' })
    const client = makeFakeGemini(resp)
    const r1 = await client.models.generateContent({})
    const r2 = await client.models.generateContent({})
    expect(r1).toBe(resp)
    expect(r2).toBe(resp)
  })

  it('records params in the calls array', async () => {
    const client = makeFakeGemini(fakeGeminiResponse())
    const params = { model: 'gemini-2.5-pro', contents: [] }
    await client.models.generateContent(params)
    expect(client.calls).toHaveLength(1)
    expect(client.calls[0]).toBe(params)
  })
})

// ---------------------------------------------------------------------------
// makeFakeGemini — array (sequential)
// ---------------------------------------------------------------------------

describe('makeFakeGemini — array of responses', () => {
  it('serves responses sequentially', async () => {
    const r1 = fakeGeminiResponse({ text: 'first' })
    const r2 = fakeGeminiResponse({ text: 'second' })
    const client = makeFakeGemini([r1, r2])
    expect(await client.models.generateContent({})).toBe(r1)
    expect(await client.models.generateContent({})).toBe(r2)
  })

  it('throws RangeError when the script is exhausted', async () => {
    const client = makeFakeGemini([fakeGeminiResponse()])
    await client.models.generateContent({}) // first call OK
    await expect(client.models.generateContent({})).rejects.toThrow(RangeError)
  })

  it('records all call params in order', async () => {
    const client = makeFakeGemini([fakeGeminiResponse(), fakeGeminiResponse()])
    const p1 = { n: 1 }
    const p2 = { n: 2 }
    await client.models.generateContent(p1)
    await client.models.generateContent(p2)
    expect(client.calls).toEqual([p1, p2])
  })
})

// ---------------------------------------------------------------------------
// makeFakeGemini — function script
// ---------------------------------------------------------------------------

describe('makeFakeGemini — function script', () => {
  it('calls the function with the params and returns its result', async () => {
    let receivedParams: unknown
    const fn = (p: unknown): GeminiResponseLike => {
      receivedParams = p
      return fakeGeminiResponse({ text: 'dynamic' })
    }
    const client = makeFakeGemini(fn)
    const params = { model: 'gemini-2.5-pro' }
    const resp = await client.models.generateContent(params)
    expect(resp.candidates?.[0]?.content?.parts?.[0]?.text).toBe('dynamic')
    expect(receivedParams).toBe(params)
  })

  it('records params even when the function throws', async () => {
    const client = makeFakeGemini((_p: unknown): GeminiResponseLike => {
      throw { status: 429 }
    })
    const params = { model: 'gemini-2.5-pro' }
    await expect(client.models.generateContent(params)).rejects.toMatchObject({ status: 429 })
    expect(client.calls).toHaveLength(1)
    expect(client.calls[0]).toBe(params)
  })

  it('propagates injected plain-object errors (status: 429)', async () => {
    const client = makeFakeGemini(() => { throw { status: 429 } })
    await expect(client.models.generateContent({})).rejects.toMatchObject({ status: 429 })
  })

  it('propagates injected Error instances', async () => {
    const err = new Error('internal server error')
    const client = makeFakeGemini(() => { throw err })
    await expect(client.models.generateContent({})).rejects.toThrow('internal server error')
  })

  it('accumulates params from multiple function calls', async () => {
    let callCount = 0
    const client = makeFakeGemini((): GeminiResponseLike => {
      callCount += 1
      return fakeGeminiResponse({ text: `call ${callCount}` })
    })
    await client.models.generateContent({ n: 1 })
    await client.models.generateContent({ n: 2 })
    expect(client.calls).toHaveLength(2)
    expect(callCount).toBe(2)
  })
})
