/**
 * `codexCliProvider` — {@link ProviderPlugin} factory for @gullabs/codex-cli.
 *
 * Bundles the dev-only Codex CLI adapter with its model descriptors. This
 * provider is unpriced by design (dev-only CLI, $0 API spend) — the returned
 * plugin has no `pricingSource`.
 *
 * @module
 */

import type { ProviderPlugin } from '@gullabs/core'

import { codexCliAdapter } from './adapter.js'
import type { CodexCliAdapterOptions } from './adapter.js'
import { codexCliModelDescriptors } from './models.js'

/**
 * Create a {@link ProviderPlugin} for the dev-only OpenAI Codex CLI provider.
 *
 * Unpriced by design: the returned plugin omits `pricingSource` entirely.
 *
 * @param opts - Forwarded to {@link codexCliAdapter}.
 * @returns A plugin bundling the Codex CLI adapter and its model descriptors.
 *
 * @example
 * ```ts
 * import { createClient, composeProviders } from '@gullabs/core'
 * import { codexCliProvider } from '@gullabs/codex-cli'
 *
 * const client = createClient({
 *   ...composeProviders([codexCliProvider()]),
 * })
 * ```
 */
export function codexCliProvider(opts?: CodexCliAdapterOptions): ProviderPlugin {
  return {
    adapter: codexCliAdapter(opts),
    modelDescriptors: codexCliModelDescriptors,
  }
}
