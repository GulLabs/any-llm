/**
 * @gullabs/codex-cli model config schema + registry tests.
 *
 * @module
 */

import { describe, it, expect } from 'vitest'
import { CODEX_CLI_MODEL_IDS, Gpt54MiniConfigSchema, codexCliRegistry } from './models.js'

describe('codex-cli config schemas', () => {
  it('rejects unknown keys (strict object)', () => {
    const result = Gpt54MiniConfigSchema.safeParse({ notARealKey: true })
    expect(result.success).toBe(false)
  })

  it('rejects a bad reasoning effort', () => {
    const result = Gpt54MiniConfigSchema.safeParse({
      reasoning: { effort: 'ultra-mega' },
    })
    expect(result.success).toBe(false)
  })

  it('rejects reasoning.effort "none" (not admitted by codex-cli, unlike core)', () => {
    const result = Gpt54MiniConfigSchema.safeParse({ reasoning: { effort: 'none' } })
    expect(result.success).toBe(false)
  })

  it('accepts each admitted reasoning effort', () => {
    for (const effort of ['low', 'medium', 'high', 'xhigh']) {
      const result = Gpt54MiniConfigSchema.safeParse({ reasoning: { effort } })
      expect(result.success).toBe(true)
    }
  })

  it('accepts a valid timeoutMs', () => {
    const result = Gpt54MiniConfigSchema.safeParse({ timeoutMs: 60_000 })
    expect(result.success).toBe(true)
  })

  it('rejects a timeoutMs above the 30-minute cap', () => {
    const result = Gpt54MiniConfigSchema.safeParse({ timeoutMs: 1_800_001 })
    expect(result.success).toBe(false)
  })

  it('rejects temperature/topP/topK/maxOutputTokens/stopSequences on every model', () => {
    for (const key of [
      'temperature',
      'topP',
      'topK',
      'maxOutputTokens',
      'stopSequences',
    ]) {
      const result = Gpt54MiniConfigSchema.safeParse({ [key]: 1 })
      expect(result.success).toBe(false)
    }
  })

  it('accepts an empty config object', () => {
    const result = Gpt54MiniConfigSchema.safeParse({})
    expect(result.success).toBe(true)
  })
})

describe('codexCliRegistry', () => {
  it('resolves every supported model id without throwing at construction', () => {
    for (const id of CODEX_CLI_MODEL_IDS) {
      const descriptor = codexCliRegistry.resolve(id)
      expect(descriptor).toBeDefined()
      expect(descriptor?.provider).toBe('codex-cli')
    }
  })

  it('validateConfig["~standard"].validate accepts a good config', async () => {
    const descriptor = codexCliRegistry.resolve('gpt-5.4-mini')
    expect(descriptor).toBeDefined()
    const result = await descriptor?.validateConfig['~standard'].validate({
      reasoning: { effort: 'high' },
    })
    expect(result?.issues).toBeUndefined()
  })

  it('validateConfig["~standard"].validate rejects a bad config', async () => {
    const descriptor = codexCliRegistry.resolve('gpt-5.4-mini')
    expect(descriptor).toBeDefined()
    const result = await descriptor?.validateConfig['~standard'].validate({
      temperature: 0.5,
    })
    expect(result?.issues).toBeDefined()
    expect(result?.issues?.length).toBeGreaterThan(0)
  })
})
