/**
 * Unit tests for `requireApiKey` and the auth-rejection path of
 * `buildXaiClient`.
 *
 * `buildXaiClient`'s happy path is NOT tested here — it would need a real
 * `openai` client / network. `requireApiKey` is called before the dynamic
 * `import('openai')` inside `buildXaiClient`, so the auth-rejection path can
 * be tested without ever touching the SDK.
 *
 * @module
 */

import { describe, it, expect } from 'vitest'
import { LlmError } from '@gullabs/core'
import { buildXaiClient, requireApiKey } from './client.js'

describe('requireApiKey', () => {
  it('returns the key on valid ApiKeyAuth', () => {
    expect(requireApiKey({ apiKey: 'xai-secret' })).toBe('xai-secret')
  })

  it('rejects CliSessionAuth', () => {
    let thrown: unknown
    try {
      requireApiKey({ cliSession: true })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(LlmError)
    expect((thrown as LlmError).kind).toBe('invalid_auth')
    expect((thrown as LlmError).provider).toBe('xai')
    expect((thrown as LlmError).retryable).toBe(false)
  })

  it('rejects a missing apiKey', () => {
    let thrown: unknown
    try {
      requireApiKey({} as unknown as { apiKey: string })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(LlmError)
    expect((thrown as LlmError).kind).toBe('invalid_auth')
  })

  it('rejects an empty-string apiKey', () => {
    let thrown: unknown
    try {
      requireApiKey({ apiKey: '   ' })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(LlmError)
    expect((thrown as LlmError).kind).toBe('invalid_auth')
  })
})

describe('buildXaiClient — auth rejection (no network / SDK import)', () => {
  it('rejects CliSessionAuth before importing the openai SDK', async () => {
    await expect(buildXaiClient({ cliSession: true })).rejects.toMatchObject({
      kind: 'invalid_auth',
      provider: 'xai',
    })
  })

  it('rejects a missing apiKey before importing the openai SDK', async () => {
    await expect(
      buildXaiClient({} as unknown as { apiKey: string }),
    ).rejects.toMatchObject({
      kind: 'invalid_auth',
      provider: 'xai',
    })
  })
})
