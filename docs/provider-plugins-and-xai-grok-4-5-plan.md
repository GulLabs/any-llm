# Implementation Plan: Provider-Plugin Architecture + xAI Grok 4.5 Provider

Status: APPROVED — codex adversarial review, 3 rounds
(final: VERDICT APPROVED, codex session 019f4937-2cd9-7d03-b970-15a83aed8446).
Every implementation commit additionally requires individual codex signoff (§4).
Branch: `feat/provider-plugin-architecture`.
Date: 2026-07-09

## 0. Goals

1. Fix the design gaps that force core edits when onboarding a provider: after this
   plan, a new provider ships as one self-contained package (adapter + model
   descriptors + strict per-model Zod config schemas + pricing source + typed
   provider options) and registers at `createClient` with zero `@gullabs/core`
   changes.
2. Onboard xAI as the first provider built on that shape: `@gullabs/xai` with
   `grok-4.5` on xAI's Responses API.

Both phases are breaking. Per the P0 rule there are no shims, aliases, or
compatibility re-exports: old surfaces are deleted outright.

## 1. Verified research inputs (2026-07-09)

### 1.1 Grok 4.5 (released 2026-07-08, docs.x.ai)

- Model id `grok-4.5`; aliases `grok-4.5-latest`, `grok-build-latest`. No mini/fast
  variants, no dated snapshot. Context 500k tokens; text + image input → text.
  Max output tokens undocumented (~30k per press, unofficial).
- Pricing (µUSD/M, standard): input $2.00, cached input $0.50, output $6.00.
  Reasoning tokens billed as output. A >200k long-context tier ($4/$1/$12) is
  reported by third-party trackers only — **must be verified with a live API call
  before it is added to the pricing table** (§5.4).
- Reasoning: always-on reasoning model; Responses API `reasoning: { effort }` with
  `low | high | none` documented per endpoint — `none` is documented for
  grok-4.3+; whether grok-4.5 accepts it must be live-verified (§5.4). Default
  effort `high`. Usage exposes `reasoning_tokens`.
  `presence_penalty`, `frequency_penalty`, `stop` are rejected by xAI on
  reasoning models.
- Structured output: native `response_format: json_schema` (constraint caps:
  string length ≤ 2048, array items ≤ 256, properties ≤ 64; empty enum/anyOf →
  400).
- Tool calling: native + parallel. Server-side agentic tools (`web_search`,
  `x_search`, `code_interpreter`, file/collections search, remote MCP) are
  Responses-API-only and billed per invocation (e.g. web_search $5/1k) — out of
  scope for v1 (§5.5).
- Vision: jpg/png, ≤ 20 MiB/image, unlimited count, base64 data URL or public URL.
- Caching: automatic; `prompt_cache_key` (Responses body) or `x-grok-conv-id`
  header (equivalent) strongly recommended for reliable cache routing.
- API: base `https://api.x.ai/v1`, `Authorization: Bearer`. Endpoints:
  `/v1/responses` (primary, recommended), `/v1/chat/completions` (documented as
  legacy), `/v1/messages` (Anthropic-compatible migration shim). Rate limits:
  150 RPS / 50M TPM default. Regions us-east-1/us-west-2; no EU at launch.
- No first-party TypeScript SDK. xAI's quickstart recommends the `openai` npm
  package with a base-URL override (or Vercel AI SDK, which does not support
  advanced server-side tools).

### 1.2 SDK decision: `openai` as peerDependency

Verified against openai-node (v6.x) README and xAI docs:

- Request side is non-validating: xAI-only body params pass through as-is (and
  `reasoning`, `prompt_cache_key` are in OpenAI's own types already).
- Per-request custom headers supported via `RequestOptions`.
- Response side never strips unknown fields: xAI usage extensions
  (`reasoning_tokens`, `cached_tokens`, `num_server_side_tools_used`, citations)
  survive; the adapter layers its own xAI-typed interfaces over the SDK types.
- Retries/timeouts disableable (`maxRetries: 0`, own `AbortSignal`) — no conflict
  with the engine owning retry/timeout (adapter contract, DESIGN.md P3).
- Error classes expose `.status`, `.headers` (retry-after), raw `.error` body —
  maps onto `classifyHttpStatus`/`LlmError` trivially.
- `client.responses` works against api.x.ai and is xAI's recommended TS path.
- Zero runtime dependencies; majors rare (v6 since 2025-09); pinned as `^6` peer.

Decision: `openai@^6` as peerDependency of `@gullabs/xai`; Responses API
(`client.responses.create`); `maxRetries: 0`; adapter passes the engine's
attempt signal. Raw fetch rejected (would re-implement SSE parsing — the
highest-defect-density part — for zero benefit). Anthropic-compat endpoint
rejected (migration shim; lags features; we have no Anthropic-SDK code to reuse).

## 2. Phase 1 — Provider-plugin architecture (core refactor)

Design authority: this plan supersedes the current layout; new ADR-023 records it.
Precedent: `packages/claude-cli` / `packages/codex-cli` already prove
self-contained descriptors work with zero core edits (claude-cli
`src/models.ts:1-11`).

### 2.1 `ProviderOptionsMap` via module augmentation

- `packages/core/src/types.ts` (~187): delete the closed
  `type ProviderOptions = { google?: GoogleProviderOptions }`. Replace with:

  ```ts
  export interface ProviderOptionsMap {}
  export type ProviderOptions = ProviderOptionsMap
  ```

- `GoogleProviderOptions` moves to `packages/google`, which augments:

  ```ts
  declare module '@gullabs/core' {
    interface ProviderOptionsMap {
      google?: GoogleProviderOptions
    }
  }
  ```

- Runtime enforcement is unchanged and remains solely the per-model strict Zod
  schemas (ADR-010) — the closed TS type never provided runtime safety.
- **Entrypoint-loading rule** (augmentation only takes effect if the declaring
  module is loaded into the program): the `declare module '@gullabs/core'`
  augmentation lives in a module that `packages/google/src/index.ts` imports
  unconditionally (the module also exports `GoogleProviderOptions`, so it is a
  real import, not a bare side-effect). Root typecheck and vitest resolve
  `@gullabs/*` to each package's `src/index.ts` (tsconfig.json:5,
  vitest.config.ts:9), and published consumers resolve to `dist` types whose
  entry d.ts re-exports the same module — both paths therefore load the
  augmentation whenever anything is imported from `@gullabs/google`.
- Type tests (compile-time, in `packages/google`): importing ONLY from the
  `@gullabs/google` entrypoint (never a deep path), assert
  `providerOptions.google` infers as `GoogleProviderOptions` at a `generate()`
  call site, and that an unknown provider key is an excess-property error.
  A post-build check (`tsc` against the packed `dist` d.ts or attw) verifies the
  published-artifact path in CI before release. Documented limitation: a
  consumer importing only `@gullabs/core` sees an empty `ProviderOptionsMap` —
  correct by design (no provider loaded, no options).

### 2.2 `ProviderPlugin` + `composeProviders`

New `packages/core/src/plugin.ts`:

```ts
export interface ProviderPlugin {
  adapter: ProviderAdapter
  modelDescriptors: ModelDescriptor[]
  pricingSource?: PricingSource
}

export function composeProviders(
  plugins: ProviderPlugin[],
): Pick<ClientConfig, 'adapters' | 'modelRegistry' | 'pricingSources'>
```

- Pure composition over existing injection; `createClient` invariants
  (duplicate adapter id, descriptor.provider ↔ adapter.id, strictPricing) are
  unchanged and still fire.
- `composeProviders` throws `LlmError('bad_request')`-style config errors on
  duplicate plugin adapter ids (fail at composition, earliest point).
- Each provider package exports one factory: `googleProvider(opts?)`,
  `claudeCliProvider()`, `codexCliProvider()`, later `xaiProvider(opts?)`.
- Host usage: `createClient({ ...composeProviders([googleProvider()]), ... })`.

### 2.3 De-Google `serviceTier`; move `flexFallback` into `providerOptions.google`

Gemini-only billing concepts leaked into shared `GenConfig` (types.ts:205-218)
and — worse — into a generic engine guard (engine.ts:641-646) that runs for every
provider. Requested-vs-served tier is also an observability contract: it flows
into call records (engine.ts:702 → record.ts:54) and the Drizzle `serviceTier`
column (packages/drizzle/src/schema.ts:23), which must keep working.

- **`GenConfig.serviceTier` STAYS, retyped as an opaque provider-defined
  `string`** (was the Google literal union `'flex' | 'standard'`). Semantics:
  "provider-defined service/billing tier vocabulary; admitted values are
  constrained by each model's strict config schema" — Gemini schemas admit
  `'flex' | 'standard'`; models without tiers simply never admit the key
  (strict schemas reject it). This keeps the requested-tier path through
  costing (engine.ts ~1262 `servedServiceTier ?? config.serviceTier`), records,
  and Drizzle completely unchanged and provider-agnostic. No
  `requestedServiceTier` echo on `AdapterResult` (a request field does not
  belong in a response port).
- **`GenConfig.flexFallback` is DELETED from core** and moves to
  `providerOptions.google.flexFallback` (pure Google capacity-retry behavior,
  ADR-013 precedent).
- Delete the engine-level flexFallback-requires-flex guard (engine.ts:641-646)
  — redundant: the Gemini per-model schema unions enforce it precisely, now
  inside the `providerOptions.google` block.
- Gemini model-config schemas: the flex/standard union branching keys on the
  top-level `serviceTier` as today, with `flexFallback` relocated under
  `providerOptions.google` in the flex branch only.
- Google adapter and `flex-fallback.ts` retry logic read `flexFallback` from
  `providerOptions.google`. `PricingSource.price(model, usage, tier)` keeps
  tier opaque (already does). `TIER_FACTOR` moves to google (§2.4).
- Record/persistence surfaces (`LlmCallRecord.serviceTier`, drizzle column):
  type widens from the Google literal union to `string` where narrowed;
  otherwise untouched.
- **Companion seams that also encode the Google vocabulary widen in the same
  commit** (they are the tier feature's other half):
  - `ModelDescriptor.capabilities.serviceTiers?: ('flex' | 'standard')[]`
    (registry.ts:47) widens to `readonly string[]` — provider-defined
    vocabulary, declared per descriptor.
  - Retry tier pinning (retry.ts): `revalidatePinnedServiceTier` drops its
    hardcoded `tier !== 'flex' && tier !== 'standard'` literal check and
    becomes fully descriptor-driven — a served tier is pinnable iff it appears
    in `modelDescriptor.capabilities.serviceTiers`; `pinnedServiceTier` widens
    from the literal union to `string | undefined` (retry.ts:243). Semantics
    for Google are unchanged (its descriptors list exactly
    `['flex', 'standard']`).
  - Tests: retry pinning exercised with a non-Google tier vocabulary (fake
    descriptor with e.g. `['priority', 'default']`) to prove the seam is
    genuinely provider-neutral, plus the existing Google pinning cases.

### 2.4 Move ALL Google-named surface out of core into `packages/google`

Complete export inventory leaving `@gullabs/core` (target: zero provider
knowledge in core — grep for `Google|Gemini|Gemma|GEMINI|flex` in
`packages/core/src` must come back clean, doc examples aside):

- Types (currently types.ts / index.ts): `GoogleProviderOptions`,
  `GoogleSafetySetting`, `GoogleSearchTool`, and any other `Google*`-named type
  → `packages/google/src/types.ts` (with the ProviderOptionsMap augmentation,
  §2.1).
- `packages/core/src/model-config/*` (per-model Gemini/Gemma schema files) →
  `packages/google/src/model-config/` (generic helpers `toConfigJsonSchema`,
  `zodToStandardSchema` stay in core).
- `geminiModelDescriptors`, `gemmaModelDescriptors`, `defaultGeminiRegistry` out
  of `packages/core/src/registry.ts` → `packages/google`. Core registry.ts keeps
  only `ModelDescriptor`, `ModelRegistry`, `createModelRegistry`,
  `assertDescriptorSchemaArtifacts`.
- `GEMINI_PRICING` + `TIER_FACTOR` (pricing.ts) and `geminiPricingSource`
  (cost.ts) → `packages/google`. Core keeps `computeCost` (already pure and
  parameterized) and the `PricingSource` port.
- `ClientConfig.modelRegistry` becomes required (no default registry in core).
- Gemini-specific tests move with the code (registry fixtures, config-validation
  cases, pricing tests). Core keeps generic-machinery tests only.
- Dependency direction: google → core only. No cycles.
- Single-audit-view cost: mitigated — the facade (and any host) can enumerate
  all models via the composed registry; `composeProviders` output exposes the
  merged `modelRegistry`.

Named downstream fallout (fixed in the SAME commit, see §4 sequencing):

- `packages/any-llm` (currently a pure re-export barrel of core + google):
  keeps `export * from '@gullabs/core'` + `export * from '@gullabs/google'` —
  so its consumers still see `googleProvider`, `geminiPricingSource`, etc.; the
  moved symbols change _home package_, not facade availability. Its
  `index.surface.test.ts` is updated to lock the new surface incl.
  `composeProviders`/`googleProvider`. Facade one-liner documented as
  `createClient({ ...composeProviders([googleProvider()]), ... })` — no new
  `createDefaultClient` wrapper (rejected as needless indirection).
- `packages/core/README.md`, `packages/any-llm/README.md`, and
  `packages/any-llm/skills/any-llm/SKILL.md` all hardcode
  `defaultGeminiRegistry`/`geminiPricingSource`/direct `createClient` wiring —
  every snippet is rewritten to the plugin composition in the same commit.
- `packages/core/src/index.ts` surface test and `packages/google`'s
  `index.surface.test.ts` updated for removed/added exports.
- `packages/quota`, `packages/drizzle`, `packages/testing`: audit for imports of
  moved symbols (`makeFakeGemini` in testing references google shapes; drizzle's
  `serviceTier` column widens per §2.3) and fix in the same commit.

### 2.5 Shared onboarding-invariant helper

- Extract `packages/core/src/registry.test.ts` (~163-228) logic into
  `packages/testing/src/registry-invariants.ts`:

  ```ts
  export function assertRegistryInvariants(opts: {
    descriptors: ModelDescriptor[]
    expectedModelIds: readonly string[]
    pricingSource?: PricingSource
    explicitlyUnpriced?: ReadonlySet<string>
    adapterFixtureModelIds: readonly string[]
    negativeContractFixtureModelIds: readonly string[]
  }): void
  ```

- Enforces per provider package: three schema artifacts present and consistent
  (`configJsonSchema === toConfigJsonSchema(configSchema)`), model-id list
  pinned, every model priced or explicitly unpriced, every model has positive
  and negative adapter contract fixtures.
- Wired into `packages/google` (moved registry tests), `claude-cli`,
  `codex-cli`; later `xai`.

### 2.6 Docs, ADR, hygiene

- ADR-023 in DECISIONS.md: "Provider packages as self-contained plugins" —
  decision, drivers (zero core edits per provider; core ships zero provider
  knowledge; CLI packages as precedent), all breaking consequences.
- Update DESIGN.md (package scope, planned seams, config sections) and
  docs/architecture.md wherever they describe core-owned Gemini schemas/pricing
  or `GenConfig.serviceTier`.
- Changeset covering all bumped packages (repo is 0.x — follow existing
  changeset conventions for breaking bumps; inspect prior `feat!` changesets).
- `no-ambient-auth` source scan unchanged in Phase 1 (no new package).

### 2.7 Phase 1 breaking-change inventory

1. `ProviderOptions` closed type removed → `ProviderOptionsMap` augmentation.
2. `GenConfig.serviceTier` widens from `'flex' | 'standard'` to opaque `string`
   (record/drizzle narrowings widen accordingly);
   `ModelDescriptor.capabilities.serviceTiers` widens to `readonly string[]`;
   retry tier pinning becomes descriptor-driven (no tier literals in core);
   `GenConfig.flexFallback` removed (now `providerOptions.google.flexFallback`).
3. Engine flexFallback guard removed.
4. Core no longer exports ANY Google-named symbol: `GoogleProviderOptions`,
   `GoogleSafetySetting`, `GoogleSearchTool`, Gemini/Gemma descriptors and
   model-config schemas, `GEMINI_PRICING`, `TIER_FACTOR`, `geminiPricingSource`,
   `defaultGeminiRegistry` (all move to `@gullabs/google`; still reachable via
   the `@gullabs/any-llm` facade).
5. `ClientConfig.modelRegistry` required.
6. New core exports: `ProviderPlugin`, `composeProviders`, `ProviderOptionsMap`.

## 3. Phase 2 — `@gullabs/xai` with grok-4.5

Mirrors `packages/google`, built on the Phase 1 plugin shape. Nothing lands in
core.

### 3.1 Package skeleton

- `packages/xai/package.json`: `dependencies: { '@gullabs/core': 'workspace:*' }`,
  `peerDependencies: { openai: '^6' }`, tsup dual CJS/ESM build, same scripts as
  google.
- `src/client.ts`: `XaiClientLike` structural interface over the openai SDK
  Responses surface (only what the adapter uses — enables fakes);
  `buildXaiClient(auth)` = `new OpenAI({ apiKey, baseURL: 'https://api.x.ai/v1', maxRetries: 0 })`
  (only file importing `openai`); `requireApiKey(auth)` narrowing `AuthMaterial`
  (reuses `ApiKeyAuth`; no union change).
- `src/adapter.ts`: `xaiAdapter(opts?): ProviderAdapter`, `id: 'xai'`.
- `src/models.ts` + `src/model-config/grok-4-5.ts`: descriptors + strict schema.
- `src/pricing.ts`: `XAI_PRICING` + `xaiPricingSource()` (provider-scoped; does
  not reuse Gemini's).
- `src/provider.ts`: `xaiProvider(): ProviderPlugin`.
- `src/types.ts`: `XaiProviderOptions` + `declare module '@gullabs/core'`
  augmentation.
- `src/index.ts` + `index.surface.test.ts` locking the public surface.

### 3.2 Adapter mapping (ResolvedRequest → Responses API)

- Messages/system → Responses `input` items + `instructions` (system).
- `Part` mapping: text passes through. `InlineMediaPart` images (jpg/png,
  ≤ 20 MiB) → `input_image` base64 data URL. `FileUriPart` is a
  provider-hosted file reference (e.g. a Gemini Files URI — types.ts:69) and is
  NOT portable to xAI: only explicit public `http`/`https` URLs are admitted as
  `input_image` URLs; any other scheme or provider-scoped URI → `bad_request`.
  Non-image media, oversize images, wrong mime → `bad_request` (reject, don't
  map).
- Structured output: `outputJsonSchema` → `text.format`/`response_format`
  json_schema (exact field per live openai-node types); JSON-parse into
  `rawStructured`; engine still never validates shape (ADR-009).
- Reasoning: `ReasoningIntent.effort` → `reasoning: { effort }` per the model's
  `admittedReasoningEfforts`. `budgetTokens` → `bad_request` (level-style model).
  `includeThoughts` → request reasoning summaries if the API supports it;
  captured into `reasoningText` when present.
- `providerOptions.xai.promptCacheKey` → `prompt_cache_key`.
- Statelessness: `store: false` on every request (our design is stateless; no
  30-day server-side conversation storage). `previous_response_id` unsupported →
  not exposed.
- Sampling: `temperature`/`topP` admitted per schema; penalties/stop never
  admitted (schema rejects — matches xAI hard rejection).
- Usage mapping (GROSS, ADR-004): `input_tokens` (incl. cached),
  `output_tokens` (incl. reasoning); `cachedInputTokens` from
  `input_tokens_details.cached_tokens`; `thinkingTokens` from
  `output_tokens_details.reasoning_tokens`; full raw payload into `Usage.raw`;
  xAI extras (`num_sources_used`, server-side tool counts, `cost_in_usd_ticks`
  if present) into `Usage.details`/`providerMetadata` — captured, not billed.
- Errors: one try/catch around client build + call; openai-node `APIError`
  status/headers (retry-after) → `classifyHttpStatus`/`classifyError`; rethrown
  as `LlmError` tagged `provider: 'xai'`. Mid-generation content-filter/refusal
  finish states → `content_filter`.
- Timeouts: engine-provided `attemptTimeoutMs`/signal only; SDK timeout
  effectively disabled.

### 3.3 Model descriptor `grok-4.5`

```
provider: 'xai', model: 'grok-4.5', pricingFamily: 'grok-4.5'
capabilities: {
  reasoning: true, reasoningApi: 'level',
  admittedReasoningEfforts: pending live check (§5.4): ['low','high'] or incl. 'none',
  structuredOutput: true, nativeStructuredOutput: true,
  vision: true, audioInput: false,
  sampling: 'tunable',
  caching: { explicit: false, minTokens: 0 },  // automatic caching — exact shape
                                               // may need a capabilities tweak;
                                               // decide at implementation, keep
                                               // it in the xai package
  grounding: false,                            // server-side tools deferred
}
```

Strict Zod schema (`z.strictObject`): `temperature`, `topP`, `maxOutputTokens`,
`reasoning` effort enum, `providerOptions.xai.promptCacheKey?: string`. No
penalties, no stop, no serviceTier. `.meta()` titles/descriptions/examples like
the Gemini schemas. Aliases (`grok-4.5-latest`, `grok-build-latest`) are NOT
registered — one canonical id, "reject don't map" (callers use `grok-4.5`).

### 3.4 Pricing

`XAI_PRICING['grok-4.5'] = { inputPerM: 2_000_000, cachedPerM: 500_000,
outputPerM: 6_000_000 }` (µUSD/M convention as core). No tiers (`TIER_FACTOR` is
Google-owned; xAI source prices standard only). `gt200k` long-context lane added
ONLY after live verification (§5.4); until then omitted and documented.
`xaiPricingSource()` versioned with snapshot date.

### 3.5 Explicitly deferred (documented in ADR/plan, not built)

- Server-side agentic tools (web_search/x_search/code_interpreter/MCP) and their
  per-invocation billing — no `Cost` lane exists; usage captured raw for
  backfill. Revisit with the function-calling seam.
- `/v1/chat/completions` (legacy) and `/v1/messages` (Anthropic shim).
- Batch API (grok-4.5 not eligible at launch), image generation models,
  stateful conversations (`store`, `previous_response_id`), streaming (core has
  no streaming seam yet).

### 3.6 Wiring & tests

- vitest alias `@gullabs/xai` → source index; tsconfig references; workspace.
- Add `packages/xai/src` to the `no-ambient-auth` source scan.
- `makeFakeXai` in `@gullabs/testing` (structural fake of `XaiClientLike`),
  mirroring `makeFakeGemini`.
- Tests: adapter unit tests (mapping matrix incl. every reject path), negative
  contract fixtures, adapter-stress parity with google where applicable,
  `assertRegistryInvariants` wiring, surface test, pricing tests
  (cached-token math, unpriced-model null path).
- Coverage must hold global gates (93/91/96/93).
- Changeset; README for the package following google/claude-cli style.

## 4. Process & quality gates (A++ bar)

1. **Plan signoff**: codex adversarial review of this document. No
   implementation until VERDICT is approval.
2. **Commit discipline**: work lands as a sequence of small, logically scoped
   commits on `feat/provider-plugin-architecture` (Phase 1) and a follow-up
   branch/PR for Phase 2. **Every commit gets a codex adversarial review
   (read-only, `git show <sha>`) and must receive signoff before the next commit
   builds on it.** Findings are fixed in place (amend/fixup) until codex
   approves.
3. **Per-commit local gate**: `pnpm quality` (build, eslint, tsc typecheck,
   vitest with coverage thresholds) green before a commit is even submitted for
   codex review. `pnpm typecheck` runs explicitly — vitest does not check types.
4. **Implementation delegation**: all code/doc edits by sonnet subagents with
   file-scoped prompts derived from this plan; the orchestrator reviews diffs,
   runs gates, and drives codex reviews.
5. **Live verification** (§5.4) before pricing/effort decisions are frozen.
6. Final: full-branch codex signoff + PR; CI (gitleaks, audit, quality) green;
   PR references ADR-023 and this plan.

### Planned Phase 1 commit sequence (each codex-signed)

1. `feat!: ProviderOptionsMap module augmentation; google owns its options type`
2. `feat: ProviderPlugin + composeProviders composition helper`
3. `feat!: provider-neutral service tiers (opaque serviceTier, string[] serviceTiers, descriptor-driven retry pinning); flexFallback into providerOptions.google; drop engine guard`
4. `feat!: move all Google model configs, descriptors, pricing, types into @gullabs/google`
   — includes IN THE SAME COMMIT: the any-llm facade surface decision + updated
   `index.surface.test.ts` (any-llm, core, google), and rewrites of
   `packages/core/README.md`, `packages/any-llm/README.md`,
   `packages/any-llm/skills/any-llm/SKILL.md` to the plugin composition, so the
   commit is independently green with no stale public guidance.
5. `feat: shared assertRegistryInvariants in @gullabs/testing; wire all providers`
6. `docs: ADR-023 provider-plugin architecture; DESIGN/architecture updates; changeset`

### Planned Phase 2 commit sequence (each codex-signed)

1. `feat: @gullabs/xai package skeleton, client port, provider options augmentation`
2. `feat: xai adapter — Responses API mapping, errors, usage`
3. `feat: grok-4.5 descriptor, strict config schema, pricing source`
4. `feat: xaiProvider plugin, testing fakes, registry invariants, fixtures`
5. `docs: xai provider docs, README, changeset`

## 5. Risks & open items

1. **Module augmentation resolution** across build/vitest-alias contexts —
   mitigated by explicit type-level tests (§2.1); if augmentation proves
   unreliable, fallback is a core-owned open-but-typed pattern decided with
   codex at review time (not silently).
2. **Coverage displacement**: moving Gemini tests out of core changes package
   coverage distribution; global thresholds still apply — watch for core
   dropping below gates once its largest test surface moves; add generic-machinery
   tests if needed.
3. **openai-node minor churn** (~weekly minors): pin behavior with an
   integration-shaped fixture test against recorded response payloads; `^6`
   range.
4. **Live verifications required (need XAI_API_KEY)**: (a) >200k long-context
   pricing tier exists? (b) `reasoning.effort: 'none'` accepted on grok-4.5?
   (c) exact Responses structured-output field shape; (d) usage field names for
   cached/reasoning tokens; (e) max output tokens. Runs as a scratchpad script;
   results recorded in the plan/ADR before the corresponding commit.
5. **EU unavailability** and region routing: no code impact (host concern);
   documented in package README.
6. **Hallucination-rate regression on grok-4.5** (AA report): not a library
   concern; noted for consumers in README.
