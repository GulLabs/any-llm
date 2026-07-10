/**
 * Tests for {@link codexCliProvider}.
 *
 * @module
 */

import { describe, it, expect } from 'vitest'
import { createClient, composeProviders } from '@gullabs/core'

import { codexCliProvider } from './provider.js'

describe('codexCliProvider', () => {
  it('returns a plugin whose adapter id is "codex-cli"', () => {
    const plugin = codexCliProvider()

    expect(plugin.adapter.id).toBe('codex-cli')
  })

  it('returns model descriptors all scoped to provider "codex-cli"', () => {
    const plugin = codexCliProvider()

    expect(plugin.modelDescriptors.length).toBeGreaterThan(0)
    for (const descriptor of plugin.modelDescriptors) {
      expect(descriptor.provider).toBe('codex-cli')
    }
  })

  it('has no pricingSource (unpriced by design)', () => {
    const plugin = codexCliProvider()

    expect(plugin.pricingSource).toBeUndefined()
    expect('pricingSource' in plugin).toBe(false)
  })

  it('constructs a working client via composeProviders', () => {
    expect(() =>
      createClient({ ...composeProviders([codexCliProvider()]) }),
    ).not.toThrow()
  })
})
