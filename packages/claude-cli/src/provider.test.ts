/**
 * Tests for {@link claudeCliProvider}.
 *
 * @module
 */

import { describe, it, expect } from 'vitest'
import { createClient, composeProviders } from '@gullabs/core'

import { claudeCliProvider } from './provider.js'

describe('claudeCliProvider', () => {
  it('returns a plugin whose adapter id is "claude-cli"', () => {
    const plugin = claudeCliProvider()

    expect(plugin.adapter.id).toBe('claude-cli')
  })

  it('returns model descriptors all scoped to provider "claude-cli"', () => {
    const plugin = claudeCliProvider()

    expect(plugin.modelDescriptors.length).toBeGreaterThan(0)
    for (const descriptor of plugin.modelDescriptors) {
      expect(descriptor.provider).toBe('claude-cli')
    }
  })

  it('has no pricingSource (unpriced by design)', () => {
    const plugin = claudeCliProvider()

    expect(plugin.pricingSource).toBeUndefined()
    expect('pricingSource' in plugin).toBe(false)
  })

  it('constructs a working client via composeProviders', () => {
    expect(() =>
      createClient({ ...composeProviders([claudeCliProvider()]) }),
    ).not.toThrow()
  })
})
