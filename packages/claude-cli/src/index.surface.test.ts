/**
 * Package-surface importability tests for @gullabs/claude-cli.
 *
 * Proves that key exports are reachable from the package root index —
 * catching export/re-export mismatches at test time rather than at consumer
 * build time.
 *
 * @module
 */

import { describe, it, expect } from 'vitest'
import { claudeCliAdapter, claudeCliRegistry, buildClaudeCliRunner } from './index.js'

describe('@gullabs/claude-cli package surface', () => {
  it('claudeCliAdapter is a function', () => {
    expect(typeof claudeCliAdapter).toBe('function')
  })

  it('buildClaudeCliRunner is a function', () => {
    expect(typeof buildClaudeCliRunner).toBe('function')
  })

  it('claudeCliRegistry.resolve returns a descriptor for a known model id', () => {
    const descriptor = claudeCliRegistry.resolve(
      'claude-cli',
      'claude-haiku-4-5-20251001',
    )
    expect(descriptor).toBeDefined()
    expect(descriptor?.provider).toBe('claude-cli')
  })
})
