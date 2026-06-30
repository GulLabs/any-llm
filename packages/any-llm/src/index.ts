/**
 * @gullabs/any-llm — batteries-included public entrypoint.
 *
 * This package is the default client install path. It re-exports the core
 * engine and Gemini adapter while depending on the Gemini SDK and Zod for a
 * one-package setup.
 *
 * @module
 */

export * from '@gullabs/core'
export * from '@gullabs/google'
export { z } from 'zod'
export type { ZodType, ZodTypeAny } from 'zod'

/** Library version — kept in sync with `package.json`. */
export const ANY_LLM_VERSION = '0.1.0'
