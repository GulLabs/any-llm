/**
 * Google-specific provider options for `@gullabs/google`.
 *
 * Importing anything from this module (including this type-only re-export)
 * pulls in the `declare module '@gullabs/core'` augmentation below, which
 * adds the `google` key to `ProviderOptionsMap`. `packages/google/src/index.ts`
 * re-exports these types unconditionally so the augmentation always loads
 * when anything is imported from `@gullabs/google`.
 *
 * @module
 */

export type GoogleSafetySetting = {
  category: string
  threshold: string
}

export type GoogleSearchTool = {
  googleSearch: Record<string, never>
}

export type GoogleProviderOptions = {
  /** Google cached content resource name. */
  cachedContent?: string
  /** Allowlisted Google safety settings. */
  safetySettings?: GoogleSafetySetting[]
  /** Exact Google tool declarations admitted by the selected model schema. */
  tools?: GoogleSearchTool[]
  /** Allowlisted Google transport options. */
  httpOptions?: {
    /** Per-request Google transport timeout in milliseconds. */
    timeout?: number
  }
}

declare module '@gullabs/core' {
  interface ProviderOptionsMap {
    google?: GoogleProviderOptions
  }
}
