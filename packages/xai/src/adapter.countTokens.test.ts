/**
 * @gullabs/xai — xaiAdapter.countTokens contract tests.
 *
 * @module
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import type { AdapterCtx, TokenCountRequest } from '@gullabs/core'
import { xaiAdapter } from './adapter.js'

const FAKE_CTX: AdapterCtx = {
  auth: { apiKey: 'test-key' },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
}

const tokenizeFixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('./__fixtures__/16-tokenize-text.json', import.meta.url)),
    'utf8',
  ),
) as { body: { token_ids: unknown[] } }

function makeCountReq(overrides: Partial<TokenCountRequest> = {}): TokenCountRequest {
  return {
    provider: 'xai',
    model: 'grok-4.5',
    messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hello' }] }],
    ...overrides,
  }
}

function makeFetch(
  impl: (url: string, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return impl as unknown as typeof fetch
}

describe('xaiAdapter.countTokens — happy path', () => {
  it('POSTs concatenated text to /v1/tokenize-text and reports lower-bound', async () => {
    let captured: { url: string; body: unknown } | undefined
    const adapter = xaiAdapter({
      _fetch: makeFetch(async (url, init) => {
        captured = { url, body: JSON.parse(String(init?.body)) }
        return new Response(JSON.stringify(tokenizeFixture.body), { status: 200 })
      }),
    })

    const result = await adapter.countTokens!(
      makeCountReq({
        system: 'Be brief.',
        messages: [
          { role: 'user', parts: [{ kind: 'text', text: 'Hello' }] },
          { role: 'assistant', parts: [{ kind: 'text', text: 'Hi' }] },
        ],
      }),
      FAKE_CTX,
    )

    expect(captured?.url).toBe('https://api.x.ai/v1/tokenize-text')
    expect(captured?.body).toEqual({
      model: 'grok-4.5',
      text: 'Be brief.\nHello\nHi',
    })
    expect(result.accuracy).toBe('lower-bound')
    expect(result.totalTokens).toBe(tokenizeFixture.body.token_ids.length)
    expect(result.details).toEqual({ textTokens: tokenizeFixture.body.token_ids.length })
    expect(result.raw).toEqual(tokenizeFixture.body)
  })
})

describe('xaiAdapter.countTokens — non-text rejects', () => {
  it.each([
    [
      'inline-media',
      { kind: 'inline-media' as const, mimeType: 'image/png', data: 'abc' },
    ],
    [
      'file-uri',
      {
        kind: 'file-uri' as const,
        uri: 'https://example.com/a.png',
        mimeType: 'image/png',
      },
    ],
    ['file-ref', { kind: 'file-ref' as const, fileId: 'file_abc' }],
  ])('rejects %s parts', async (_label, part) => {
    const adapter = xaiAdapter({
      _fetch: makeFetch(async () => {
        throw new Error('fetch should not be called')
      }),
    })
    await expect(
      adapter.countTokens!(
        makeCountReq({
          messages: [{ role: 'user', parts: [part] }],
        }),
        FAKE_CTX,
      ),
    ).rejects.toMatchObject({
      kind: 'bad_request',
      message: expect.stringContaining(_label),
    })
  })
})

describe('xaiAdapter.countTokens — error classification', () => {
  it('classifies 400 invalid-key as invalid_auth', async () => {
    const adapter = xaiAdapter({
      _fetch: makeFetch(async () => {
        return new Response(
          JSON.stringify({
            code: 'invalid-argument',
            error: 'Incorrect API key provided. Please check.',
          }),
          { status: 400 },
        )
      }),
    })
    await expect(adapter.countTokens!(makeCountReq(), FAKE_CTX)).rejects.toMatchObject({
      kind: 'invalid_auth',
      provider: 'xai',
    })
  })
})
