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

import { version } from '../package.json'

/** Library version, sourced from package.json at build time. */
export const ANY_LLM_VERSION: string = version
