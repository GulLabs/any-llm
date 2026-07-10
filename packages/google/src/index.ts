/**
 * @gullabs/google — Gemini provider adapter over @google/genai.
 *
 * @example
 * ```ts
 * import { geminiAdapter } from '@gullabs/google'
 * import { createClient, geminiPricingSource } from '@gullabs/core'
 *
 * const client = createClient({
 *   adapters: [geminiAdapter()],
 *   pricingSources: { google: geminiPricingSource() },
 * })
 *
 * const result = await client.generate(
 *   { provider: 'google', model: 'gemini-2.5-pro', messages: [...] },
 *   { auth: { apiKey: process.env.GEMINI_API_KEY! } },
 * )
 * ```
 *
 * @module
 */

export type {
  GoogleSafetySetting,
  GoogleSearchTool,
  GoogleProviderOptions,
} from './types.js'
export { geminiAdapter } from './adapter.js'
export type { GeminiAdapterOptions } from './adapter.js'
export { googleProvider } from './provider.js'
export type { GeminiClientLike } from './client.js'
export {
  buildGoogleClient,
  requireApiKey,
  FLEX_DEFAULT_TIMEOUT_MS,
  STANDARD_DEFAULT_TIMEOUT_MS,
  TRANSPORT_TIMEOUT_BUFFER_MS,
} from './client.js'
export { isGeminiCapacityError } from './flex-fallback.js'
export type {
  GoogleFileHandle,
  GoogleFileStoreOptions,
  GeminiFilesClientLike,
} from './file-store.js'
export { GoogleFileStore } from './file-store.js'
export type {
  GoogleCacheHandle,
  CacheKey,
  GoogleCacheStoreOptions,
  GeminiCachesClientLike,
} from './cache-store.js'
export { GoogleCacheStore } from './cache-store.js'
export { normalizeGroundingCitations } from './grounding.js'
export type { Citation } from './grounding.js'
