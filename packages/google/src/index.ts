/**
 * @gullabs/google — Gemini provider adapter over @google/genai.
 *
 * @example
 * ```ts
 * import { geminiAdapter } from '@gullabs/google'
 * import { createClient, geminiPricingSource, envAuth } from '@gullabs/core'
 *
 * const client = createClient({
 *   adapters: [geminiAdapter()],
 *   auth: envAuth(),
 *   pricing: geminiPricingSource(),
 * })
 * ```
 *
 * @module
 */

export { geminiAdapter } from './adapter.js'
export type { GeminiAdapterOptions } from './adapter.js'
export type { GeminiClientLike } from './client.js'
export { buildGoogleClient } from './client.js'
export { zodToGeminiSchema } from './schema.js'
export type { GeminiSchema } from './schema.js'
export type { GoogleFileHandle, GoogleFileStoreOptions, GeminiFilesClientLike } from './file-store.js'
export { GoogleFileStore } from './file-store.js'
export type {
  GoogleCacheHandle,
  CacheKey,
  GoogleCacheStoreOptions,
  GeminiCachesClientLike,
} from './cache-store.js'
export { GoogleCacheStore } from './cache-store.js'
