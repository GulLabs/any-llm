/**
 * Package-surface importability tests for @gullabs/any-llm.
 *
 * Proves that the batteries-included package exposes the default client path:
 * core engine exports, Gemini adapter exports, and the bundled Zod helper.
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import { createClient, geminiAdapter, geminiPricingSource, z } from './index.js'

describe('@gullabs/any-llm package surface', () => {
  it('exports the core client factory', () => {
    expect(typeof createClient).toBe('function')
  })

  it('exports the Gemini adapter and pricing source', () => {
    expect(typeof geminiAdapter).toBe('function')
    expect(typeof geminiPricingSource).toBe('function')
  })

  it('exports Zod for one-package structured-output setup', () => {
    expect(typeof z.object).toBe('function')
  })
})
