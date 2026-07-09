/**
 * @gullabs/claude-cli — model config schema + registry tests.
 *
 * @module
 */

import { describe, it, expect } from 'vitest'
import {
  claudeCliModelDescriptors,
  claudeCliRegistry,
  ClaudeHaiku45ConfigSchema,
} from './models.js'

describe('config schema', () => {
  it('rejects an unknown key (strict object)', () => {
    const result = ClaudeHaiku45ConfigSchema.safeParse({ temperature: 0.5 })
    expect(result.success).toBe(false)
  })

  it('rejects a bad effort value', () => {
    const result = ClaudeHaiku45ConfigSchema.safeParse({
      reasoning: { effort: 'extreme' },
    })
    expect(result.success).toBe(false)
  })

  it('accepts a valid config', () => {
    const result = ClaudeHaiku45ConfigSchema.safeParse({
      reasoning: { effort: 'high' },
      timeoutMs: 60_000,
    })
    expect(result.success).toBe(true)
  })

  it('accepts an empty config', () => {
    const result = ClaudeHaiku45ConfigSchema.safeParse({})
    expect(result.success).toBe(true)
  })
})

describe('registry', () => {
  const ids = [
    'claude-fable-5',
    'claude-opus-4-8',
    'claude-sonnet-5',
    'claude-haiku-4-5-20251001',
  ] as const

  it('has exactly 4 descriptors', () => {
    expect(claudeCliModelDescriptors).toHaveLength(4)
  })

  it.each(ids)('resolves descriptor for %s', (id) => {
    const descriptor = claudeCliRegistry.resolve('claude-cli', id)
    expect(descriptor).toBeDefined()
    expect(descriptor?.model).toBe(id)
    expect(descriptor?.provider).toBe('claude-cli')
  })

  it('validateConfig accepts a valid config via the Standard Schema surface', () => {
    const descriptor = claudeCliRegistry.resolve(
      'claude-cli',
      'claude-haiku-4-5-20251001',
    )
    const result = descriptor?.validateConfig['~standard'].validate({
      reasoning: { effort: 'medium' },
    })
    expect(result).toBeDefined()
    if (result !== undefined && !(result instanceof Promise)) {
      expect(result.issues).toBeUndefined()
    }
  })

  it('validateConfig rejects an invalid config via the Standard Schema surface', () => {
    const descriptor = claudeCliRegistry.resolve(
      'claude-cli',
      'claude-haiku-4-5-20251001',
    )
    const result = descriptor?.validateConfig['~standard'].validate({
      temperature: 0.7,
    })
    expect(result).toBeDefined()
    if (result !== undefined && !(result instanceof Promise)) {
      expect(result.issues).toBeDefined()
    }
  })
})
