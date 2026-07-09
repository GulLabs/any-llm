/**
 * Package-surface importability tests for @gullabs/codex-cli.
 *
 * @module
 */

import { describe, it, expect } from 'vitest'
import { codexCliAdapter, codexCliRegistry } from './index.js'

describe('@gullabs/codex-cli package surface', () => {
  it('codexCliAdapter is a function', () => {
    expect(typeof codexCliAdapter).toBe('function')
  })

  it('codexCliRegistry.resolve("gpt-5.4-mini") is defined', () => {
    expect(codexCliRegistry.resolve('codex-cli', 'gpt-5.4-mini')).toBeDefined()
  })
})
