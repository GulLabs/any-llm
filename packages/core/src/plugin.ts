/**
 * Provider plugin composition for @gullabs/core.
 *
 * A {@link ProviderPlugin} bundles everything a provider package needs to
 * contribute to a {@link ClientConfig}: its adapter, its model descriptors,
 * and (optionally) its pricing source. {@link composeProviders} merges any
 * number of plugins into the `adapters` / `modelRegistry` / `pricingSources`
 * shape `createClient` expects, so hosts never hand-assemble those three
 * fields themselves.
 *
 * @module
 */

import { LlmError } from './errors.js'
import type { PricingSource, ProviderAdapter } from './ports.js'
import type { ModelDescriptor } from './registry.js'
import { createModelRegistry } from './registry.js'
import type { ClientConfig } from './engine.js'

/**
 * Everything a single provider package contributes to a client's
 * configuration: its adapter, its model descriptors, and (optionally) its
 * pricing source.
 */
export interface ProviderPlugin {
  /** The provider's {@link ProviderAdapter} implementation. */
  adapter: ProviderAdapter
  /** Model descriptors for every model this provider supports. */
  modelDescriptors: ModelDescriptor[]
  /**
   * Pricing source for this provider, if it has one. Omit entirely for
   * unpriced providers (e.g. dev-only CLI providers) — do not set to
   * `undefined`.
   */
  pricingSource?: PricingSource
}

/**
 * Compose one or more {@link ProviderPlugin}s into the `adapters` /
 * `modelRegistry` / `pricingSources` slice of a {@link ClientConfig}.
 *
 * `adapters` preserves the input plugin order. `modelRegistry` is built from
 * the concatenation of every plugin's `modelDescriptors`. `pricingSources` is
 * keyed by each plugin's `adapter.id`, omitting the key entirely for plugins
 * without a `pricingSource` (never set to `undefined`).
 *
 * Every plugin's descriptors must be self-owned: each descriptor's `provider`
 * field must equal that plugin's own `adapter.id`. Once descriptors are
 * flattened into a single `modelRegistry`, per-plugin ownership can no longer
 * be recovered, so this is checked eagerly at composition time rather than
 * deferred to `createClient`.
 *
 * An empty plugin list composes to an empty config; `createClient` will then
 * fail its own construction-time invariants (e.g. "No adapters configured")
 * — this is intentional; `composeProviders` does not duplicate that check.
 *
 * @param plugins - The provider plugins to compose, in the order their
 *   adapters should appear.
 * @returns The `adapters`, `modelRegistry`, and `pricingSources` fields of a
 *   {@link ClientConfig}, ready to spread into `createClient`.
 * @throws {@link LlmError} — `kind: 'bad_request'` when two plugins share the
 *   same `adapter.id`. This check runs at composition time, before
 *   `createClient` would otherwise catch the same duplicate.
 * @throws {@link LlmError} — `kind: 'bad_request'` when a plugin contributes a
 *   model descriptor whose `provider` does not match that plugin's own
 *   `adapter.id`. This check also runs at composition time.
 *
 * @example
 * ```ts
 * import { createClient, composeProviders } from '@gullabs/core'
 * import { googleProvider } from '@gullabs/google'
 *
 * const client = createClient({
 *   ...composeProviders([googleProvider()]),
 * })
 * ```
 */
export function composeProviders(
  plugins: ProviderPlugin[],
): Pick<ClientConfig, 'adapters' | 'modelRegistry' | 'pricingSources'> {
  const seenIds = new Set<string>()
  for (const plugin of plugins) {
    const id = plugin.adapter.id
    if (seenIds.has(id)) {
      throw new LlmError(`Duplicate adapter id "${id}"`, {
        kind: 'bad_request',
        retryable: false,
      })
    }
    seenIds.add(id)

    for (const descriptor of plugin.modelDescriptors) {
      if (descriptor.provider !== id) {
        throw new LlmError(
          `Plugin "${id}" contributed a descriptor for model "${descriptor.model}" ` +
            `with provider "${descriptor.provider}" (expected provider "${id}")`,
          { kind: 'bad_request', retryable: false },
        )
      }
    }
  }

  const adapters = plugins.map((p) => p.adapter)
  const modelRegistry = createModelRegistry(plugins.flatMap((p) => p.modelDescriptors))

  const pricingSources: Record<string, PricingSource> = {}
  for (const plugin of plugins) {
    if (plugin.pricingSource !== undefined) {
      pricingSources[plugin.adapter.id] = plugin.pricingSource
    }
  }

  return { adapters, modelRegistry, pricingSources }
}
