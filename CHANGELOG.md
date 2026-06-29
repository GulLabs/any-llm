# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
This project does not use semantic versioning yet — it will adopt semver on first public release.

---

## [Unreleased] / 0.1.0 — 2026-06-29

### Breaking

**`@gullabs/core`**
- `Message.parts` is now `Part[]` where `Part = TextPart | InlineMediaPart | FileUriPart`. Any
  code that typed `parts` as `TextPart[]` must be updated. Existing messages with only text parts
  are structurally compatible; the `kind: 'text'` field was already required by `TextPart`.

### Added

**`@gullabs/core`**
- `InlineMediaPart` (`kind: 'inline-media'`) — inline base64 binary media with `mimeType` and
  optional `mediaResolution` hint (`'low' | 'medium' | 'high'`).
- `FileUriPart` (`kind: 'file-uri'`) — provider-hosted file reference with `uri`, `mimeType`,
  and optional `mediaResolution` hint.
- `Part` union type (`TextPart | InlineMediaPart | FileUriPart`).
- `isTextPart`, `isInlineMediaPart`, `isFileUriPart` type-guard functions.
- `ModelDescriptor.capabilities.sampling` — `'tunable'` | `'fixed'`.
- `ModelDescriptor.capabilities.caching` — `{ explicit: boolean; minTokens: number }`.
- `ModelDescriptor.capabilities.grounding` — boolean.
- `ModelDescriptor.configJsonSchema` — plain JSON Schema object for UX form generation.
- `ModelDescriptor.validateConfig` — Standard Schema v1 validator; engine runs before dispatch.
- `makeGeminiConfigSchema(opts)` — factory for per-family Gemini config JSON Schema.
- `makeGeminiConfigValidator(opts)` — factory for per-family Gemini config Standard Schema v1
  validator; `sampling: 'fixed'` rejects `temperature`, `topP`, `topK` with per-field paths.
- Config validation step in `runAttempt` — validates a projection of the resolved config
  (excluding `timeoutMs`, `providerOptions`) before auth and rate-limiter acquire.
- `Cost.usd` — derived convenience field; `= microUsd / 1_000_000`. Display-only; not persisted.
- Gemini model descriptors extended to 7 entries: gemini-2.5-pro, gemini-2.5-flash,
  gemini-2.5-flash-lite, gemini-3.5-flash, gemini-3.1-flash-lite, gemini-3.1-pro-preview,
  gemini-3-flash-preview.

**`@gullabs/google`**
- `GoogleFileStore` — `upload(source, mimeType, opts?)` uploads bytes (`Uint8Array` | `Blob`)
  and polls until `ACTIVE` (default interval 3 s, default timeout 120 s). `delete(handle)` and
  `deleteAll(handles)` are fail-open.
- `GoogleFileHandle` — `{ name, uri, mimeType, expiresAt? }` returned by `upload`.
- `GoogleCacheStore` — `getOrCreate(key, factory)`, `create(input)`,
  `refreshIfExpiringSoon(handle, opts?)`, `delete(handle)`. Process-scoped; not shared across
  restarts. Optional `coalesce: true` serialises concurrent creates for the same key.
- `GoogleCacheHandle` — `{ cacheName, expiresAt, model }` returned by cache operations.
- `CacheKey` — `{ model, stableKey }` used by `getOrCreate`.
- Multimodal part mapping in adapter: `inline-media` → Gemini `inlineData`, `file-uri` → Gemini
  `fileData`, `mediaResolution` → `PartMediaResolutionLevel` enum.
- Grounding metadata capture: `candidate.groundingMetadata` captured into
  `result.providerMetadata['groundingMetadata']`; `promptFeedback` captured alongside it.
- Grounding + schema conflict guard: adapter throws `LlmError('bad_request')` when
  `googleSearch` tool and `output.schema` are both set.
- `FLEX_DEFAULT_TIMEOUT_MS` (900 000) and `TRANSPORT_TIMEOUT_BUFFER_MS` (5 000) exported from
  `@gullabs/google`.
- Automatic `httpOptions.timeout` on every request: `FLEX_DEFAULT_TIMEOUT_MS` for Flex calls
  without `timeoutMs`; `timeoutMs + TRANSPORT_TIMEOUT_BUFFER_MS` when `timeoutMs` is set.
  Caller-supplied `providerOptions.google.httpOptions` wins over any computed value.

---

## [Unreleased] / 0.0.0 — 2026-06-27

Initial v1 implementation. Scope: four goals, no more — see `SPEC.md`.

### Added

**`@gullabs/core`**
- `createClient` engine: 12-step pipeline (config resolution → adapter → normalize → validate → cost → record → result)
- `defineCallSite` — typed, reusable prompt template with `{{var}}` interpolation (anti-injection: values are not re-scanned)
- `geminiPricingSource` — `PricingSource` implementation backed by the built-in Gemini pricing snapshot (`gemini-2026-06-28`)
- `computeCost` — pure cost function; GROSS token convention enforced; `sum(details) === microUsd` guaranteed by construction
- Gemini pricing snapshot: 2.5 Pro (tiered >200k), 2.5 Flash, 2.5 Flash-Lite, 3.0 Flash, 3.0 Flash-Lite
- `buildRecord` — assembles `LlmCallRecord` from engine state; frozen cost, `pricingVersion`, and `reasoningText` included
- `normalizeUsage` — enforces GROSS convention; clamps cached > input with a warning instead of throwing
- `LlmError` with `kind`, `retryable`, `httpStatus`, `retryAfterMs`, `provider`, `cause`
- `classifyHttpStatus` / `classifyError` — HTTP status and raw SDK error → `LlmError` classification
- Port interfaces: `ProviderAdapter`, `UsageSink`, `PricingSource`, `AuthProvider`, `Clock`, `IdGenerator`, `Logger`, `Telemetry`
- Full TypeScript types: `LlmRequest`, `LlmResult`, `Usage`, `Cost`, `LlmCallRecord`, `GenConfig`, `ReasoningIntent`, and more

**`@gullabs/google`**
- `geminiAdapter` — `ProviderAdapter` over `@google/genai` (API-key + Vertex auth via `buildGoogleClient`)
- Gemini Flex service tier (`serviceTier: 'flex'` default)
- Thinking capture: `thoughtsTokenCount` → `thinkingTokens` in usage; thought parts → `reasoningText`
- `reasoning.effort` → `thinkingBudget` (gemini-2.5) or `thinkingLevel` (gemini-3.x); lossy mapping emits a `reasoning-mapping` warning
- Structured output: Zod schema → `responseSchema` + `responseMimeType: 'application/json'` via `zodToGeminiSchema`
- Error classification: `401/403` → `invalid_auth`, `429` → `rate_limited` (+ `retryAfterMs`), `5xx` → `server`, safety → `content_filter`

**`@gullabs/drizzle`**
- `llmCalls` — reference Drizzle `pgTable` schema for `LlmCallRecord`; typed columns + `jsonb` forward-compat lanes
- `drizzleUsageSink` — `UsageSink` implementation; idempotent on `attemptId` via `INSERT ... ON CONFLICT DO NOTHING`

**`@gullabs/testing`**
- `FakeClock` — deterministic `Clock` with `advance` / `set`
- `FakeIds` — sequential `IdGenerator` (`call_1`, `attempt_1`, …)
- `RecordingSink` — in-memory `UsageSink`; `failOnRecord` option for fail-open tests
- `makeFakeGemini` / `fakeGeminiResponse` / `fakeGeminiBlocked` — scriptable fake Gemini client (no `@google/genai` import)
- `FakeAdapter` — scriptable `ProviderAdapter` at the port level (bypasses SDK entirely)
- `SignalAwareFakeAdapter` — cooperative abort-signal adapter for timeout/cancellation tests
- `fakeAuth` — `AuthProvider` that resolves to a fixed `AuthMaterial`

**Tooling & repo**
- pnpm workspace monorepo; ESM + CJS + `.d.ts` output via `tsup`
- Strict TypeScript: `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`
- vitest test suite: cost math, error classification, config resolution, usage normalization, adapter contract tests, engine integration, surface-stress / fuzz tests
- `examples/basic.ts` — fully runnable network-free example (`pnpm example`)
- Apache-2.0 license

[Unreleased]: https://github.com/atifgul/any-llm/compare/HEAD...HEAD
