/**
 * Package-surface importability tests for @gullabs/codex-cli.
 *
 * @module
 */

import { describe, it, expect } from 'vitest'
import {
  codexCliAdapter,
  codexCliRegistry,
  codexCliProvider,
  toOpenAiStrictOutputSchema,
} from './index.js'

describe('@gullabs/codex-cli package surface', () => {
  it('codexCliAdapter is a function', () => {
    expect(typeof codexCliAdapter).toBe('function')
  })

  it('codexCliProvider is a function', () => {
    expect(typeof codexCliProvider).toBe('function')
  })

  it('codexCliRegistry.resolve("gpt-5.4-mini") is defined', () => {
    expect(codexCliRegistry.resolve('codex-cli', 'gpt-5.4-mini')).toBeDefined()
  })

  it('toOpenAiStrictOutputSchema is a function', () => {
    expect(typeof toOpenAiStrictOutputSchema).toBe('function')
  })
})
