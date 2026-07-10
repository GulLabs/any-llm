/**
 * Package-surface importability tests for @gullabs/xai.
 *
 * Proves that the commit-1 surface (client factory + auth helper) is
 * reachable from the package root index — catching export/re-export
 * mismatches at test time rather than at consumer build time. Mirrors
 * `packages/google/src/index.surface.test.ts`, adjusted for what actually
 * exists in commit 1 (no adapter/provider/pricing yet).
 *
 * @module
 */

import { describe, it, expect } from 'vitest'
import { buildXaiClient, requireApiKey } from './index.js'

describe('@gullabs/xai package surface', () => {
  it('buildXaiClient is a function reachable from the package root', () => {
    expect(typeof buildXaiClient).toBe('function')
  })

  it('requireApiKey is a function reachable from the package root', () => {
    expect(typeof requireApiKey).toBe('function')
  })
})
