/**
 * xAI-specific provider options for `@gullabs/xai`.
 *
 * Importing anything from this module (including this type-only re-export)
 * pulls in the `declare module '@gullabs/core'` augmentation below, which
 * adds the `xai` key to `ProviderOptionsMap`. `packages/xai/src/index.ts`
 * re-exports these types unconditionally so the augmentation always loads
 * when anything is imported from `@gullabs/xai`.
 *
 * @module
 */

export type XaiProviderOptions = {
  /** xAI conversation-routing cache key — maps to Responses API `prompt_cache_key`. */
  promptCacheKey?: string
}

declare module '@gullabs/core' {
  interface ProviderOptionsMap {
    xai?: XaiProviderOptions
  }
}
