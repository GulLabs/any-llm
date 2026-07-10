/**
 * `googleProvider` — {@link ProviderPlugin} factory for @gullabs/google.
 *
 * Bundles the Gemini adapter, the built-in Gemini + Gemma model descriptors,
 * and the Gemini pricing source into a single plugin for
 * {@link composeProviders}.
 *
 * @module
 */

import type { ProviderPlugin } from '@gullabs/core'
import {
  geminiModelDescriptors,
  gemmaModelDescriptors,
  geminiPricingSource,
} from '@gullabs/core'

import { geminiAdapter } from './adapter.js'
import type { GeminiAdapterOptions } from './adapter.js'

/**
 * Create a {@link ProviderPlugin} for the Gemini provider.
 *
 * @param opts - Forwarded to {@link geminiAdapter}.
 * @returns A plugin bundling the Gemini adapter, Gemini + Gemma model
 *   descriptors, and the built-in Gemini pricing source.
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
export function googleProvider(opts?: GeminiAdapterOptions): ProviderPlugin {
  return {
    adapter: geminiAdapter(opts),
    modelDescriptors: [...geminiModelDescriptors, ...gemmaModelDescriptors],
    pricingSource: geminiPricingSource(),
  }
}
