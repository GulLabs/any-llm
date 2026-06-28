/**
 * Call-site definition for @gullabs/core.
 *
 * A {@link CallSite} is a reusable, named prompt template with an associated
 * model and optional Zod schema for structured output.  It is the unit of
 * observability: every call made through a call site records a `callSiteId`
 * so usage can be grouped by prompt template in dashboards and audits.
 *
 * @module
 */

import type { ZodType } from 'zod'
import type { GenConfig } from './types.js'

// ---------------------------------------------------------------------------
// CallSite type
// ---------------------------------------------------------------------------

/**
 * A reusable prompt template that bundles model, schema, and gen-config.
 *
 * @typeParam S - Zod schema type for structured output.  Defaults to `ZodType`
 *   (unstructured — no Zod validation, `output` will be `undefined`).
 *
 * @example
 * ```ts
 * const summarise = defineCallSite({
 *   id: 'summarise-article',
 *   model: 'gemini-2.5-pro',
 *   system: 'You are a concise summariser.',
 *   userTemplate: 'Summarise this article in 3 sentences:\n\n{{article}}',
 *   config: { temperature: 0.3 },
 * })
 * ```
 */
export interface CallSite<S extends ZodType = ZodType> {
  /**
   * Stable identifier for this call site.
   * Persisted as `callSiteId` on every record for grouping/attribution.
   */
  id: string
  /**
   * Model to use for this call site.
   * A plain string — change it here to reroute the entire call site.
   */
  model: string
  /**
   * Zod schema for structured output.
   * When present, the engine validates `rawStructured` from the adapter and
   * exposes the typed result as `LlmResult.output`.
   */
  schema?: S
  /**
   * System instruction template.
   * Supports `{{var}}` interpolation (non-recursive; missing vars are left
   * as the literal `{{var}}` placeholder).
   */
  system?: string
  /**
   * User message template.
   * Supports `{{var}}` interpolation (non-recursive; missing vars are left
   * as the literal `{{var}}` placeholder).
   */
  userTemplate?: string
  /**
   * Generation config defaults for this call site.
   * Merged over library-level defaults; per-call `opts.config` wins over this.
   */
  config?: GenConfig
}

// ---------------------------------------------------------------------------
// defineCallSite
// ---------------------------------------------------------------------------

/**
 * Defines a typed call site — a reusable prompt template bound to a model.
 *
 * This is a pure identity function: it returns the options object unchanged but
 * branded with the correct TypeScript type so the `S` type parameter is
 * propagated to `runStructured`.
 *
 * @param opts - Call site definition.
 * @returns The same object, typed as {@link CallSite}.
 *
 * @example
 * ```ts
 * import { defineCallSite } from '@gullabs/core'
 * import { z } from 'zod'
 *
 * const classify = defineCallSite({
 *   id: 'classify-sentiment',
 *   model: 'gemini-2.5-flash',
 *   schema: z.object({ sentiment: z.enum(['positive', 'negative', 'neutral']) }),
 *   userTemplate: 'Classify the sentiment of: {{text}}',
 * })
 * ```
 */
export function defineCallSite<S extends ZodType>(opts: CallSite<S>): CallSite<S> {
  return opts
}
