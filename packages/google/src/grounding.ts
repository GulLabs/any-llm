/**
 * normalizeGroundingCitations — shape Gemini's raw groundingMetadata.groundingChunks
 * into a clean, deduplicated citation list.
 *
 * This is a caller-owned, optional post-processing convenience helper — NOT
 * request validation. It NEVER throws: any missing/malformed input yields `[]`.
 *
 * @module
 */

import type { Citation } from '@gullabs/core'

/**
 * Derive a human-readable source name for a hostname, stripping a leading
 * `www.` label (e.g. `www.example.com` → `example.com`).
 */
function hostnameFrom(url: URL): string {
  return url.hostname.startsWith('www.') ? url.hostname.slice(4) : url.hostname
}

/**
 * Shape a single grounding chunk into a `Citation`, or `undefined` if the
 * chunk is malformed (missing/invalid `web.uri`, or a `web.uri` that isn't
 * a well-formed http(s) URL with a hostname).
 *
 * Real SDK shape (`@google/genai` `GroundingChunk.web`): `{ uri, title, domain }`,
 * which in practice is always an http(s) URL. This helper only ever produces
 * http(s) citations — any other scheme (`javascript:`, `mailto:`, `data:`,
 * `file:`, etc.) is treated as a malformed chunk and skipped, since callers
 * may render `Citation.url` as a clickable link.
 *
 * `title`, when present, is the human-readable page title and is preferred
 * over the hostname as `sourceName`; the hostname (parsed from `uri`) is the
 * robust fallback when `title` is absent.
 */
function toCitation(chunk: unknown): Citation | undefined {
  if (chunk === null || typeof chunk !== 'object') return undefined

  const web = (chunk as Record<string, unknown>)['web']
  if (web === null || typeof web !== 'object') return undefined

  const uri = (web as Record<string, unknown>)['uri']
  if (typeof uri !== 'string' || uri.length === 0) return undefined

  let parsed: URL
  try {
    parsed = new URL(uri)
  } catch {
    return undefined
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
  if (parsed.hostname === '') return undefined

  const title = (web as Record<string, unknown>)['title']
  const hasTitle = typeof title === 'string' && title.length > 0
  const sourceName = hasTitle ? title : hostnameFrom(parsed)

  return {
    url: uri,
    ...(hasTitle ? { title } : {}),
    sourceName,
  }
}

/**
 * Shape Gemini's raw `groundingMetadata.groundingChunks` into a clean,
 * deduplicated citation list (deduplicated by URL, first-seen order).
 *
 * Accepts `unknown` since `groundingMetadata` arrives as raw JSON on
 * `providerMetadata` (see `docs/grounded-structured.md`). Never throws —
 * any missing/malformed top-level shape returns `[]`; a malformed individual
 * chunk is skipped rather than failing the whole array.
 */
export function normalizeGroundingCitations(groundingMetadata: unknown): Citation[] {
  if (groundingMetadata === null || typeof groundingMetadata !== 'object') return []

  const chunks = (groundingMetadata as Record<string, unknown>)['groundingChunks']
  if (!Array.isArray(chunks)) return []

  const seen = new Set<string>()
  const citations: Citation[] = []

  for (const chunk of chunks) {
    const citation = toCitation(chunk)
    if (citation === undefined) continue
    if (seen.has(citation.url)) continue
    seen.add(citation.url)
    citations.push(citation)
  }

  return citations
}
