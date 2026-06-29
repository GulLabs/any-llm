/**
 * Unit tests for auth.ts — envAuth factory.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { envAuth } from './auth.js'
import { LlmError } from './errors.js'

describe('envAuth', () => {
  // Save and restore process.env around each test for isolation.
  let savedEnv: NodeJS.ProcessEnv

  beforeEach(() => {
    savedEnv = { ...process.env }
  })

  afterEach(() => {
    // Remove keys added during the test, restore originals.
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) {
        delete process.env[key]
      }
    }
    Object.assign(process.env, savedEnv)
  })

  it('returns { apiKey } when the default env var is set', async () => {
    process.env['GEMINI_API_KEY'] = 'test-key-123'
    const auth = envAuth()
    const material = await auth.credentials('google')
    expect(material).toEqual({ apiKey: 'test-key-123' })
  })

  it('throws invalid_auth when the default env var is missing', async () => {
    delete process.env['GEMINI_API_KEY']
    const auth = envAuth()
    await expect(auth.credentials('google')).rejects.toSatisfy(
      (e: unknown) => e instanceof LlmError && e.kind === 'invalid_auth' && !e.retryable,
    )
  })

  it('throws invalid_auth for a provider not in the map', async () => {
    const auth = envAuth()
    await expect(auth.credentials('openai')).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof LlmError &&
        e.kind === 'invalid_auth' &&
        !e.retryable &&
        (e.message as string).includes('openai'),
    )
  })

  it('uses a custom map and reads the correct env var', async () => {
    process.env['MY_CUSTOM_KEY'] = 'custom-value'
    const auth = envAuth({ myProvider: 'MY_CUSTOM_KEY' })
    const material = await auth.credentials('myProvider')
    expect(material).toEqual({ apiKey: 'custom-value' })
  })
})
