/**
 * Package-surface importability tests for @gullabs/any-llm.
 *
 * Proves that the batteries-included package exposes the default client path:
 * core engine exports and Gemini adapter exports.
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import { version as pkgVersion } from '../package.json'
import {
  ANY_LLM_VERSION,
  createClient,
  geminiAdapter,
  geminiPricingSource,
} from './index.js'

describe('@gullabs/any-llm package surface', () => {
  it('exports the core client factory', () => {
    expect(typeof createClient).toBe('function')
  })

  it('exports the Gemini adapter and pricing source', () => {
    expect(typeof geminiAdapter).toBe('function')
    expect(typeof geminiPricingSource).toBe('function')
  })

  it('ANY_LLM_VERSION matches package.json version', () => {
    expect(ANY_LLM_VERSION).toBe(pkgVersion)
  })
})
