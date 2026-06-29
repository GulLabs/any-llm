/**
 * Environment-variable auth provider for @gullabs/core.
 *
 * `envAuth()` is the zero-config way to wire credentials from environment
 * variables into the engine. It returns an {@link AuthProvider} that reads
 * the env var mapped to each provider at call time, so rotating secrets
 * (e.g. in long-running servers) is automatically picked up.
 *
 * @example Default map — works for Gemini out of the box:
 * ```ts
 * import { createClient, envAuth } from '@gullabs/core'
 * import { geminiAdapter } from '@gullabs/google'
 *
 * const client = createClient({
 *   adapters: [geminiAdapter()],
 *   auth: envAuth(),            // reads GEMINI_API_KEY from process.env
 * })
 * ```
 *
 * @example Custom map — for multiple providers or a non-standard env var name:
 * ```ts
 * const client = createClient({
 *   adapters: [...],
 *   auth: envAuth({ google: 'MY_GEMINI_KEY', openai: 'OPENAI_API_KEY' }),
 * })
 * ```
 *
 * @module
 */

import type { AuthProvider, AuthMaterial } from './ports.js'
import { LlmError } from './errors.js'

/** Default provider → env-var-name mapping. */
const DEFAULT_MAP: Record<string, string> = {
  google: 'GEMINI_API_KEY',
}

/**
 * Creates an {@link AuthProvider} that resolves credentials from environment
 * variables.
 *
 * @param map - Optional mapping of provider id → environment variable name.
 *   Defaults to `{ google: 'GEMINI_API_KEY' }`. Pass a custom map to add
 *   additional providers or to override the default env var name.
 *
 * @throws {@link LlmError} `kind: 'invalid_auth'` if the provider is not in the
 *   map, or if the mapped env var is unset or empty.
 *
 * // future: add vertex support — return { vertex: { project, location } }
 *   for Workload-Identity-Federation scenarios where no API key is used.
 */
export function envAuth(map?: Record<string, string>): AuthProvider {
  const resolved: Record<string, string> = map ?? DEFAULT_MAP

  return {
    async credentials(provider: string): Promise<AuthMaterial> {
      const envVar = resolved[provider]
      if (envVar === undefined) {
        throw new LlmError(
          `No env var configured for provider "${provider}"; pass envAuth({ ${provider}: 'YOUR_ENV_VAR' })`,
          { kind: 'invalid_auth', retryable: false },
        )
      }
      const value = process.env[envVar]
      if (!value) {
        throw new LlmError(
          `Auth env var "${envVar}" is not set or empty (provider: "${provider}")`,
          { kind: 'invalid_auth', retryable: false },
        )
      }
      return { apiKey: value }
    },
  }
}
