/**
 * Package-surface importability tests for @gullabs/google.
 *
 * Proves that timeout constants are reachable from the package root index —
 * catching export/re-export mismatches at test time rather than at consumer
 * build time.
 *
 * @module
 */

import { describe, it, expect } from 'vitest'
import { FLEX_DEFAULT_TIMEOUT_MS, TRANSPORT_TIMEOUT_BUFFER_MS } from './index.js'

describe('@gullabs/google package surface: timeout constants', () => {
  it('FLEX_DEFAULT_TIMEOUT_MS is exported and equals 1_500_000', () => {
    expect(FLEX_DEFAULT_TIMEOUT_MS).toBe(1_500_000)
  })

  it('TRANSPORT_TIMEOUT_BUFFER_MS is exported and equals 5_000', () => {
    expect(TRANSPORT_TIMEOUT_BUFFER_MS).toBe(5_000)
  })
})
