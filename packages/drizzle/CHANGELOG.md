# @gullabs/drizzle

## 0.5.2

### Patch Changes

- Updated dependencies [2ab1ea6]
  - @gullabs/core@0.12.0

## 0.5.1

### Patch Changes

- Updated dependencies [d46fd27]
  - @gullabs/core@0.11.0

## 0.5.0

### Minor Changes

- aa858bf: Fix `llm_calls.raw_usage jsonb NOT NULL` silently dropping every error and pre-attempt-refusal row from the ledger. The core engine's `EMPTY_USAGE` sentinel sets `Usage.raw = null` on every record path where no provider usage payload ever existed — a per-attempt error (`api_error` / `timeout` / `aborted` / `content_filter`) and the ADR-025 `attemptNumber: 0` synthetic pre-attempt refusal record both hit this. `buildRecord` copies `usage.raw` verbatim into `LlmCallRecord.rawUsage`, so every such record carried `rawUsage: null` into the sink. Because `raw_usage` was `NOT NULL`, the INSERT was rejected at the DB boundary — and because `UsageSink.record` is fail-open by design (ADR-002), that rejection was logged and swallowed, so the row never appeared in the ledger at all. Any consumer relying on the ledger for error/refusal visibility was silently missing that data.

  `raw_usage` is now nullable (ADR-027). `null` means "no provider usage payload existed for this row" — it is not backfilled with a `{}` sentinel, since that would fabricate a payload the provider never returned. `token_details`, `generation_config`, and `metadata` were audited against the same engine record paths and are always populated (never null) on every code path, so their `.notNull()` constraints are unchanged; the schema now documents this invariant per-column.

  **Consumers with an existing `llm_calls` table must run:**

  ```sql
  ALTER TABLE llm_calls ALTER COLUMN raw_usage DROP NOT NULL;
  ```

## 0.4.0

### Minor Changes

- a3f74be: Add per-key attribution (ADR-026): `ApiKeyAuth` gains an optional `keyId?: string` — an opaque, caller-supplied label (e.g. `'gemini-paid'`, `'grok-team-A'`) for the API key actually used, never the secret itself. The engine resolves `keyId` from the auth material used for the dispatch attempt that produced the recorded outcome — after any retries, fallbacks, or profile translation — so attribution stays correct even when the engine switches auth material between attempts.

  Key attribution belongs in any-llm rather than client code: the engine is the only component that authoritatively knows which auth material was used at dispatch time. Threading that identity through client-side call sites separately is the pattern that produced a real production bug (calls under one provider billed to the wrong client-side key label because the client's own attribution tracking drifted from what the engine actually dispatched with).

  `keyId`, when provided, is validated per the library's reject-don't-map convention: must be a non-empty string, and must not equal `apiKey` (rejecting the case where a caller passes the secret itself as the label) — both raise a `bad_request` `LlmError`. The resolved `keyId` is carried through `buildRecord` into a new `authKeyId` field on `LlmCallRecord`, persisted to a nullable `auth_key_id` column on `llm_calls` (`@gullabs/drizzle`), and is exempt from the record's secret-redaction pass since it's a label by design. `CliSessionAuth` is unaffected — CLI-session providers have no key identity, so `keyId` is out of scope there.

### Patch Changes

- Updated dependencies [a3f74be]
  - @gullabs/core@0.10.0

## 0.3.8

### Patch Changes

- Updated dependencies [20453fc]
  - @gullabs/core@0.9.0

## 0.3.7

### Patch Changes

- 0b44a5e: Provider-plugin architecture: `@gullabs/core` becomes provider-agnostic (zero Google/Gemini/Gemma knowledge), provider packages own their model configs, pricing, and options types, and wiring goes through a new `composeProviders()` seam. New `@gullabs/xai` package adds a Grok provider (breaking, pre-1.0).

  **Breaking changes:**

  - `ProviderOptions` is removed as a closed type. It is replaced by an extensible `ProviderOptionsMap` interface; provider packages declare their own options via module augmentation (`declare module '@gullabs/core' { interface ProviderOptionsMap { google?: GoogleProviderOptions } }`).
  - `GenConfig.serviceTier` widens from Google's literal union `'flex' | 'standard'` to an opaque provider-defined `string`; `ModelDescriptor.capabilities.serviceTiers` widens to `readonly string[]`. Retry tier pinning (`revalidatePinnedServiceTier`) is now descriptor-driven instead of hardcoding Google's tier vocabulary.
  - `GenConfig.flexFallback` is removed from core. It now lives under `providerOptions.google.flexFallback`, admitted only by the flex branch of each Gemini model's config schema.
  - `@gullabs/core` no longer exports any Google/Gemini/Gemma-named symbol: `GoogleProviderOptions`, `GoogleSafetySetting`, `GoogleSearchTool`, the Gemini/Gemma model descriptors and config schemas, `GEMINI_PRICING`, `TIER_FACTOR`, `geminiPricingSource`, and `defaultGeminiRegistry` all move to `@gullabs/google`. They remain available from `@gullabs/any-llm`, which re-exports both `@gullabs/core` and `@gullabs/google`.
  - `ClientConfig.modelRegistry` is now required — there is no default registry. Build one via `composeProviders()`.
  - `GeminiClientLike.countTokens` is now a required method on the structural client interface. Anyone building a custom fake against this interface (including via `@gullabs/testing`) must implement it.

  **New features:**

  - New `@gullabs/xai` package: an xAI Grok provider adapter (`xaiProvider()`) with `grok-4.5` on the Responses API — reasoning (`low`/`high` effort), native structured output, vision, automatic caching via `promptCacheKey`, and live-verified pricing including the >200k long-context tier.
  - New `ProviderPlugin` interface and `composeProviders()` helper in `@gullabs/core` — the standard way to wire one or more provider packages into `createClient`: `createClient({ ...composeProviders([googleProvider(), xaiProvider()]) })`.
  - New `Client.countTokens()` — dry-run token counting with no generation and no billing, implemented for Google via `@google/genai`'s `models.countTokens`.
  - `GoogleCacheStore` gains an optional token-count preflight gate before cache creation.
  - New `geminiContentToMessages()` migration utility in `@gullabs/google` for converting hand-authored `@google/genai` prompts into any-llm's normalized message shape.
  - New `assertRegistryInvariants()` shared test helper in `@gullabs/testing` for provider-package model-onboarding tests (schema-artifact completeness, JSON-schema staleness, pinned model-id lists, pricing coverage, fixture-list membership).
  - New `claudeCliProvider()` / `codexCliProvider()` plugin factories for the existing dev-only CLI provider packages, so they compose the same way as API-backed providers.

  **Migration notes:**

  Wire providers through `composeProviders()` instead of constructing `adapters`/`modelRegistry`/`pricingSources` by hand:

  ```ts
  import { createClient, composeProviders } from '@gullabs/core'
  import { googleProvider } from '@gullabs/google'

  const client = createClient({
    ...composeProviders([googleProvider()]),
  })
  ```

  Flex-fallback configuration moves to `providerOptions.google.flexFallback` on the request.

- Updated dependencies [0b44a5e]
  - @gullabs/core@0.8.0

## 0.3.6

### Patch Changes

- ba21620: Provider-qualified model identity — explicit `(provider, model)` everywhere (breaking, pre-1.0).

  - `LlmRequest`, `CallSite`, and `ResolvedRequest` now require a top-level `provider: string`; `model` stays the bare provider-native string forwarded verbatim to SDKs/CLIs. Bare requests without a provider, unregistered `(provider, model)` pairs, and slash-style `'provider/model'` strings are rejected with `bad_request`.
  - `ModelRegistry` is keyed by `(provider, model)`: `resolve(provider, model)`, `ModelDescriptor.id` renamed to `model`, duplicate exact pairs throw, the same bare model may exist under multiple providers with different config schemas, and prefix matching never crosses providers.
  - Routing is always by `req.provider`: the single-adapter bypass is removed, custom `route(provider, model, adapters)` results are checked against `adapter.id === req.provider`, and `createClient` verifies every registry descriptor's provider has a matching adapter.
  - Pricing composes per provider: `ClientConfig.pricing` is replaced by `pricingSources: Record<provider, PricingSource>`; the port shape is unchanged and `geminiPricingSource()` is the google-scoped source. A provider without a source yields an unpriced result with a warning.
  - Telemetry events carry `provider`; quota's `providerQuotaMiddleware` reads `req.provider` from the request (the `provider` option is removed).

- Updated dependencies [ba21620]
  - @gullabs/core@0.7.0

## 0.3.5

### Patch Changes

- Updated dependencies [e3da339]
  - @gullabs/core@0.6.0

## 0.3.4

### Patch Changes

- Updated dependencies [b39ceac]
  - @gullabs/core@0.5.0

## 0.3.3

### Patch Changes

- Updated dependencies [78b7636]
  - @gullabs/core@0.4.3

## 0.3.2

### Patch Changes

- c1aa7ad: Open-source documentation pass: rewrote the root README and all package READMEs for
  accuracy and consistency, fixed stale content in DESIGN.md/SPEC.md/docs/architecture.md
  left over from the forward-only structured-output migration, restructured the root
  CHANGELOG.md to point at each package's own changelog, archived internal planning docs
  into `docs/archive/`, and scrubbed a private host name from a `@gullabs/core` source
  comment (no behavior change).

  `@gullabs/any-llm` also ships a new Agent Skill at `skills/any-llm/SKILL.md` teaching AI
  coding assistants (e.g. Claude Code) how to use this library correctly — per-call auth,
  the forward-only structured-output contract, error handling, and common mistakes.

- Updated dependencies [c1aa7ad]
  - @gullabs/core@0.4.2

## 0.3.1

### Patch Changes

- Updated dependencies [dab0792]
  - @gullabs/core@0.4.1

## 0.3.0

### Minor Changes

- Implement the adoption backlog: add core reasoning resolution exports, pricing-source introspection
  and construction-time strict pricing, unpriced-cost warnings, queue-delay attribution on results and
  records, Drizzle `queue_delay_ms`, hardened quota deny/defer decisions, service-tier re-validation
  after Google provider-options merge, and deterministic testing support for rate-limiter wait time.

  Docs now cover ledger sidecar transaction composition, `metadata.operationId` correlation for
  grounded-to-structured workflows, multi-runtime retry caveats, and caller-owned structured-output
  validation.

### Patch Changes

- Updated dependencies
  - @gullabs/core@0.4.0

## 0.2.0

### Minor Changes

- ea4b941: Implement the integration-fixes API cleanup across structured output, ledger identity, Gemini Flex fallback, and API-verified Gemma 4 routing.

  Breaking API changes:

  - Replace Standard Schema/Zod output validation with forward-only `output.jsonSchema`. The library forwards the JSON Schema hint to providers, JSON-parses native structured output, surfaces `outputParsed`, and leaves business validation to callers.
  - Remove `InferOutput`, generic `LlmRequest`/`LlmResult` output typing, `output.schema`, `parse_error`, and `zodToGeminiSchema`.
  - Make `attemptId` the durable ledger identity. The drizzle schema now uses `attempt_id` as the primary key, removes the redundant UUID `id`, and adds `external_id`, `served_service_tier`, and `output_parsed`.
  - Add `idempotencyKey` and `externalId` request correlation fields. `idempotencyKey` is ledger idempotency only; provider calls are not deduplicated.
  - Add provider-builtin Gemini Flex fallback to standard tier on capacity pressure, with `servedServiceTier` returned and persisted so cost/retry logic uses the tier actually served.

  Gemini/Gemma routing changes:

  - Add API-verified Gemma 4 routing (`gemma-4-31b-it`, `gemma-4-26b-a4b-it`) with thinking(level), grounding, native structured output, and vision.
  - Add `nativeStructuredOutput`, `serviceTiers`, `vision`, and `audioInput` capability flags with per-model service-tier gating.

  Only two Gemma 4 model IDs are confirmed callable via the live Google Gemini API. All previously listed IDs (e2b, e4b, 12b variants, google/ aliases) return HTTP 404 and are removed. Both verified models support native structured output (responseMimeType + responseSchema), grounding, vision, and thinkingLevel reasoning. thinkingBudget is rejected by the API with HTTP 400 and is not used.

  Gemma 4 reasoning effort is now constrained to `none`/`high` only (`low`/`medium` are rejected at validation time with a `bad_request` error). This reflects live API behaviour: the models only accept MINIMAL and HIGH `thinkingLevel` values; LOW and MEDIUM return HTTP 400.

  gemini-3.1-pro-preview now rejects effort: 'none' at validation time; the model has no MINIMAL thinking level (thinkingLevel MINIMAL returns HTTP 400).

### Patch Changes

- Updated dependencies [ea4b941]
  - @gullabs/core@0.3.0

## 0.1.1

### Patch Changes

- Updated dependencies [8f1bf61]
  - @gullabs/core@0.2.0
