/**
 * `claudeCliProvider` — {@link ProviderPlugin} factory for @gullabs/claude-cli.
 *
 * Bundles the dev-only Claude CLI adapter with its model descriptors. This
 * provider is unpriced by design (dev-only CLI, $0 API spend) — the returned
 * plugin has no `pricingSource`.
 *
 * @module
 */

import type { ProviderPlugin } from '@gullabs/core'

import { claudeCliAdapter } from './adapter.js'
import type { ClaudeCliAdapterOptions } from './adapter.js'
import { claudeCliModelDescriptors } from './models.js'

/**
 * Create a {@link ProviderPlugin} for the dev-only Claude Code CLI provider.
 *
 * Unpriced by design: the returned plugin omits `pricingSource` entirely.
 *
 * @param opts - Forwarded to {@link claudeCliAdapter}.
 * @returns A plugin bundling the Claude CLI adapter and its model descriptors.
 *
 * @example
 * ```ts
 * import { createClient, composeProviders } from '@gullabs/core'
 * import { claudeCliProvider } from '@gullabs/claude-cli'
 *
 * const client = createClient({
 *   ...composeProviders([claudeCliProvider()]),
 * })
 * ```
 */
export function claudeCliProvider(opts?: ClaudeCliAdapterOptions): ProviderPlugin {
  return {
    adapter: claudeCliAdapter(opts),
    modelDescriptors: claudeCliModelDescriptors,
  }
}
