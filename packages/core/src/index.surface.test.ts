/**
 * Package-surface importability tests for @gullabs/core.
 *
 * Proves that config-schema factory functions are reachable from the
 * package root index — catching export/re-export mismatches at test time
 * rather than at consumer build time.
 *
 * @module
 */

import { describe, it, expect } from 'vitest'
import { makeGeminiConfigSchema, makeGeminiConfigValidator } from './index.js'

describe('@gullabs/core package surface: config-schema factories', () => {
  it('makeGeminiConfigSchema is exported and is a function', () => {
    expect(typeof makeGeminiConfigSchema).toBe('function')
  })

  it('makeGeminiConfigValidator is exported and is a function', () => {
    expect(typeof makeGeminiConfigValidator).toBe('function')
  })
})
