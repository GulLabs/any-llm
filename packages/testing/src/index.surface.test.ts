/**
 * Package-surface importability tests for @gullabs/testing.
 *
 * Proves that `assertRegistryInvariants` is reachable from the package root
 * index — catching export/re-export mismatches at test time rather than at
 * consumer build time.
 *
 * @module
 */

import { describe, it, expect } from 'vitest'
import { assertRegistryInvariants } from './index.js'

describe('@gullabs/testing package surface: assertRegistryInvariants', () => {
  it('is a function reachable from the package root', () => {
    expect(typeof assertRegistryInvariants).toBe('function')
  })
})
