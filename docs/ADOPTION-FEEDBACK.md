# Host Adoption Feedback for `any-llm`

Status: consolidated, source-checked product backlog for `@gullabs/any-llm`.

This document merges and supersedes:

- `docs/POSTBUZZ-MIGRATION-FEEDBACK.md`
- `docs/REDLINE-ADOPTION-FEEDBACK.md`

It keeps every feedback item from both host planning passes, but re-ranks the work after checking
the current implementation. Host prose is not treated as proof. The source of truth for current
library behavior is the code in this repo.

## Operating posture

There are zero external clients. Backward compatibility is not a constraint. If a clean public
contract requires breaking request types, package names, table shapes, helper signatures, or docs,
we should make the breaking change now.

Decision filters:

1. Prefer a forward-facing, clean design over incremental compatibility.
2. Keep core small, but do not hide real host adoption problems behind "host-owned" if the same
   pattern is recurring across multiple owned hosts.
3. Promote stable contracts and reusable helpers when they prevent runtime crashes, billing drift,
   or repeated migration mistakes.
4. Use companion packages and examples for infrastructure-specific integrations unless the engine
   contract itself is missing information.
5. Document temporary host workarounds as evidence, not as the final library shape.

## Host evidence

### PostBuzz

Host repo: `postbuzz-app-v2`

Adoption target: replace a custom Gemini stack with `@gullabs/any-llm`.

Relevant constraints:

- Mixed runtimes: Next routes plus Temporal worker.
- Grounded Gemini calls.
- Multimodal screenshot analysis.
- Durable usage and audit requirements.
- Provider-level quota behavior is operationally important.

Source validation:

- PostBuzz still has a local quota implementation in
  `packages/shared/src/ai/gemini-rate-limit.ts` and `gemini-rate-limits.ts`.
- That implementation uses Upstash rate limiting, `rpd === 0` as model-disabled, RPD durable
  deferral through Temporal `nextRetryDelay`, RPM `blockUntilReady`, and saturation alerts.
- PostBuzz's adoption plan validates the any-llm F1/F2/F3 contract as shipped, and originally
  identified `providerQuotaMiddleware`, `runGroundedStructured`, `createRuntimeClientFactory`, and
  `buildCallMetadata` as missing prerequisites. The provider-quota prerequisite is now shipped as
  the `@gullabs/quota` companion package; PostBuzz still needs to consume it.
- Therefore: any-llm's ledger/output/fallback primitives are shipped; PostBuzz adoption of those
  primitives is not "done" just because the host plan has checked the library contract.

### RED LINE

Host repo: `redline`

Adoption target: replace an in-house `@google/genai` wrapper with `@gullabs/any-llm`.

Relevant constraints:

- Mixed runtimes: Next.js API routes plus Temporal workers.
- Gemini-only provider usage.
- Billing-critical `llm_calls` usage ledger with matter/run/document/module anchors.
- Temporal owns retry for activities; RED LINE should not install any-llm retry middleware on those
  externally retried calls.

Source validation:

- RED LINE's current `lib/gemini/service-tier.ts` accepts `flex`, `standard`, and `priority`; maps
  `priority` to `ServiceTier.PRIORITY`; and treats `batch` defensively as not a synchronous tier.
- RED LINE's current `lib/temporal/activities/llm.activities.ts` has numeric `THINKING_BUDGET`
  values for module audits.
- RED LINE's clean-cutover plan already recognizes the zero-client posture and depends on any-llm
  F1/F2/F3 as shipped.
- RED LINE has domain ledger needs that are stronger than a generic JSON metadata column:
  `matter_id`, `audit_run_id`, `document_id`, `module_id`, artifact pointers, raw/debug payloads,
  and retention/deletion behavior.

## Current any-llm implementation validation

### Shipped and verified

- Versions match the original docs: `@gullabs/any-llm`, `@gullabs/core`, and `@gullabs/google` are
  `0.3.0`; `@gullabs/drizzle` is `0.2.0`; `@gullabs/testing` is `0.1.2`.
- Forward-only structured output is implemented. `LlmRequest.output` accepts `jsonSchema`, the
  engine forwards it as `ResolvedRequest.outputJsonSchema`, and result parsing returns `output` plus
  `outputParsed`; the library does not validate shape.
- `generate()` accepts `callSiteId`, `idempotencyKey`, and `externalId`.
- `attemptId` is generated inside `runAttempt`. Attempt 1 uses the caller's `idempotencyKey` exactly;
  in-process retry attempts suffix `:2`, `:3`, and so on.
- `@gullabs/drizzle` uses `attempt_id` as the primary key and maps `external_id`,
  `served_service_tier`, and `output_parsed`.
- `drizzleUsageSink()` inserts with `onConflictDoNothing({ target: table.attemptId })`.
- Gemini flex-to-standard fallback is implemented in the Google adapter, default-on unless
  `flexFallback: false`, and records the effective `servedServiceTier`.
- Grounding plus `output.jsonSchema` is rejected with non-retryable `bad_request` after
  `providerOptions.google.tools` are merged.
- `geminiPricingSource()` prices current Gemini 2.5 and 3.x descriptors through
  `GEMINI_PRICING` and computes using the effective served tier passed by the engine.
- `@gullabs/quota` ships provider-quota primitives: `providerQuotaMiddleware`,
  `providerQuotaRateLimiter`, `upstashQuotaStore`, typed `QuotaDecision`, and Gemini quota policy
  defaults that preserve the PostBuzz `rpd === 0` model-disabled convention.

### New gap: silent structured-output parse failures

The F1/F2/F3 merge changed structured-output failure handling. Pre-merge, an unparseable
`output.jsonSchema` response threw a typed `parse_error`. Post-merge, `packages/core/src/engine.ts`
(around lines 1100-1110) no longer throws: when `adapterResult.rawStructured` is `undefined`, the
call still returns `status: 'ok'` with `outputParsed: false`, and `output` is simply absent from the
result.

This is a real billing/product-integrity risk, not a cosmetic behavior change. Any host that alerts
only on `status` or `errorKind` will miss this failure mode entirely: the call looks fully successful,
gets billed as a successful call, and the host believes it has valid structured output when it does
not. `outputParsed` is the only signal that distinguishes a genuine structured success from a silent
shape failure, and nothing currently forces a caller to check it.

This interacts with cost computation. `packages/core/src/engine.ts` (around lines 1113-1120) prices
usage from `adapterResult.servedServiceTier ?? req.config.serviceTier` — the tier the provider
actually served, not necessarily the tier the caller requested. That tier-fallback behavior is
correct and intentional, but it means hosts reconciling billing against `llm_calls` need to watch
both signals together: `outputParsed` for shape-success truth, and `servedServiceTier` for which tier
was actually billed, neither of which is visible from `status` alone.

### Not shipped

- No `runGroundedStructured` client method.
- No grounding metadata normalization helper.
- No `createRuntimeClientFactory`.
- No `buildCallMetadata`.
- No migration helper package or codemod.
- No public `resolveReasoning` helper.
- No public API for allowed reasoning efforts apart from inspecting model descriptors and internal
  config schema/validator behavior.
- No `priority` service tier in `GenConfig` or `ModelDescriptor.capabilities.serviceTiers`.
- No pricing-source introspection such as `hasModel()` or `listPricedModels()`.
- No strict pricing mode.
- No Drizzle table factory for host extra columns.
- No rate-limiter wait-time attribution in telemetry or records.

### Already documented, but still useful feedback

- README already documents `idempotencyKey` and Temporal-style external retries: a fresh library call
  with the same key reuses attempt 1's `attemptId`, and provider calls are not deduplicated.
- ROADMAP already has caller-owned structured-output validation as a deferred item.
- ROADMAP already has rate-limiter wait-time attribution as deferred observability.

These should remain in this backlog because multiple host plans rediscovered them, but they should
not be treated as completely unrecognized gaps.

## Recommendations

### P0 - Fix before relying on multi-generation Gemini adoption

#### 1. Add portable reasoning resolution

Problem:

RED LINE has numeric thinking budgets by module. any-llm maps Gemini 2.5 through `thinkingBudget`
but rejects `reasoning.budgetTokens` for Gemini 3.x and Gemma 4 descriptors because those use
`thinkingLevel`. This is correct provider-contract enforcement, but it creates a guaranteed
non-retryable crash when a host carries a numeric budget table across model generations.

Current implementation facts:

- `ReasoningIntent` has both `effort` and `budgetTokens`.
- Registry descriptors expose `capabilities.reasoningApi` as `budget` or `level`.
- Gemini 3.x descriptors use `reasoningApi: 'level'`.
- `gemini-3.1-pro-preview` excludes `effort: 'none'`.
- Gemma 4 supports only `effort: 'none'` and `effort: 'high'`.
- The adapter throws `bad_request` when `budgetTokens` is sent to a `level` model.

Decision:

Build a public, registry-aware helper in core. Do not force every host to reimplement generation
and per-model effort mapping.

API direction:

```ts
resolveReasoning({
  model,
  budgetTokens,
  registry,
}): { budgetTokens?: number; effort?: ReasoningEffort } | undefined
```

Minimum behavior:

- For `reasoningApi: 'budget'`, pass `budgetTokens` through.
- For `reasoningApi: 'level'`, map numeric budgets into admitted effort levels.
- Consult each descriptor's actual supported efforts.
- Never emit `effort: 'none'` for `gemini-3.1-pro-preview`.
- Never emit `effort: 'low'` or `effort: 'medium'` for Gemma 4.
- Make bucketing explicit and documented, for example `0 -> none` when admitted,
  `1..4096 -> medium` when admitted, `>4096 -> high`, with model-specific fallback when a bucket is
  not admitted.

Acceptance criteria:

- A host with a numeric budget table can route across Gemini 2.5, Gemini 3.x, and Gemma 4 without
  model-generation branching in host code.
- Invalid effort output is impossible when using the helper.
- Tests cover Gemini 2.5, `gemini-3.1-flash-lite`, `gemini-3.1-pro-preview`, and both Gemma 4
  descriptors.

#### 2. Decide the `priority` service tier contract

Problem:

RED LINE's current wrapper exposes Gemini `priority`. any-llm's public `GenConfig.serviceTier` only
admits `flex | standard`, registry descriptors only admit `flex | standard`, and the adapter rejects
explicit unsupported tiers. This may be the right decision, but it is not visible enough as a design
choice.

Current implementation facts:

- `GenConfig.serviceTier?: 'flex' | 'standard'`.
- `ModelDescriptor.capabilities.serviceTiers?: ('flex' | 'standard')[]`.
- Gemini model descriptors list only `flex` and `standard`.
- `TIER_FACTOR` knows `standard`, `flex`, and `batch`; not `priority`.
- RED LINE has existing `priority` usage through `@google/genai`'s `ServiceTier.PRIORITY`.

Decision:

Make an explicit product decision now, while breaking changes are cheap.

Preferred forward-facing option:

- Add `priority` only if we verify provider availability and pricing semantics.
- Extend `GenConfig.serviceTier`, descriptor `serviceTiers`, tests, docs, and cost behavior together.
- If priority has standard pricing, encode that explicitly with `TIER_FACTOR.priority = 1` and
  document it.
- If priority pricing or availability is not verified, keep it unsupported and document the exclusion
  in `registry.ts`, README, and the service-tier docs.

Acceptance criteria:

- A host can learn the `priority` answer from public docs and types before runtime.
- Registry admitted tiers and cost semantics stay consistent.
- No provider SDK enum value is silently implied by docs but unreachable through types.

### P1 - Billing and observability integrity

#### 3. Add pricing coverage introspection and strict pricing mode

Problem:

Unpriced models return a successful `Cost` object with `microUsd: null` and no warning. That is safe
for fail-open calls, but weak for hosts treating `llm_calls` as a billing source of truth.

Current implementation facts:

- `computeCost()` returns `{ microUsd: null, confidence: 'estimated' }` when no pricing key matches.
- `geminiPricingSource()` exposes only `version` and `price()`.
- Gemma 4 descriptors are registered and callable but intentionally have no pricing family.
- README documents Gemma 4 as unpriced, but there is no programmatic startup assertion.
- Since the F1/F2/F3 merge, a malformed or unparseable structured-output response silently produces
  `status: 'ok'` with `outputParsed: false` and no separate error signal (see "New gap" above under
  "Shipped and verified"). This is the same class of problem as unpriced-model silence: a host
  relying only on `status`/`errorKind` misses it, so it belongs in the same billing/observability
  integrity fix as strict pricing mode.

Decision:

Extend the pricing contract cleanly. Backward compatibility is irrelevant, so we can change the
`PricingSource` port instead of layering awkward wrappers.

API direction:

```ts
interface PricingSource {
  version: string
  price(model: string, usage: Usage, tier?: string): Cost
  hasModel(model: string): boolean
  listModels(): readonly string[]
}
```

Add a strict mode either at client config or pricing source construction:

```ts
geminiPricingSource({ strict: true })
```

Strict behavior should fail before or during the call with a typed error or visible warning when a
configured routed model is unpriced. The default can remain fail-open if we want lightweight usage.

Acceptance criteria:

- A host can assert at boot that every model it routes to is priced.
- Calling an unpriced model can be made visible without scanning rows after the fact.
- Tests cover exact match, longest-prefix match, and unpriced Gemma 4.
- Any strict pricing / strict mode behavior validates against the _served_ tier
  (`adapterResult.servedServiceTier`) returned by the adapter, not the tier the caller originally
  requested in `GenConfig.serviceTier`.

#### 4. Define the canonical ledger extension pattern

Problem:

PostBuzz can likely consume the fixed `@gullabs/drizzle` table directly for its first migration, but
RED LINE needs typed domain anchors, artifact pointers, debug diagnostics, and deletion semantics.
The fixed Drizzle table is a good reference schema but not enough for every serious host.

Current implementation facts:

- `llmCalls` is a fixed `pgTable`.
- `drizzleUsageSink()` maps only `LlmCallRecord` fields.
- Host-specific typed columns have no table-factory or extractor hook.
- RED LINE's clean-cutover plan points toward a two-table design: canonical any-llm `llm_calls`
  plus a host-owned sidecar table correlated by `attemptId`.

Decision:

Do not rush into a generic `createLlmCallsTable({ extraColumns })` API until the two-table pattern is
documented and used. A table factory is still a valid future option, but the clean design probably is:

- any-llm owns the canonical per-attempt `llm_calls` record;
- hosts that need typed domain data create sidecar tables keyed by `attemptId`;
- optional helper packages can provide common sidecar extractors later.

Keep all original feedback:

- PostBuzz asked for canonical ledger guidance: when to use `callSiteId`, `callId`, `attemptId`,
  `externalId`, and `metadata`; how to query spend; and how to migrate old ledgers.
- RED LINE asked for extensibility so `matterId`, `auditRunId`, `documentId`, `moduleId`,
  `inputR2Key`, and debug payloads are first-class queryable data.
- Both asks are valid. The recommended first step is documentation plus an example sidecar schema.

Acceptance criteria:

- README or `docs/ledger.md` states that `llm_calls` is canonical for per-attempt LLM facts.
- It shows when to use `metadata` versus `externalId` versus a typed sidecar.
- It includes query examples: spend by day, failures by call-site, retries by model, grounded-call
  audit, and host-domain joins.
- It includes an example `llm_call_context` or host sidecar table keyed by `attemptId`.
- It states that `idempotencyKey` is ledger idempotency only; provider calls are not deduplicated.

### P2 - Host adoption velocity

#### 5. Build provider quota as a companion package

Problem:

The existing `RateLimiter` port is pre-send and low-level. It can delay or reject, but it does not
standardize durable workflow deferral, provider/model quota policy, RPD/RPM distinction, or quota
telemetry. PostBuzz already has this implemented locally.

Current implementation facts:

- Core has `RateLimiter.acquire(key, signal)`.
- The key is `"${provider}:${model}"`.
- `RateLimiter.acquire` is fail-closed; rejection fails the call.
- No distributed implementation ships today.
- No typed quota-defer metadata exists.

Decision:

Build `@gullabs/quota` or `@gullabs/rate-limiter-upstash` as a companion package, not core. It
should implement the existing `RateLimiter` port where possible and expose typed helpers for durable
schedulers where plain `acquire()` is too narrow.

API direction:

```ts
export type QuotaDecision =
  | { kind: 'allow' }
  | {
      kind: 'defer'
      retryAfterMs: number
      scope: string
      reason: 'rpm_exhausted' | 'rpd_exhausted' | 'provider_disabled'
    }

providerQuotaMiddleware({
  store: upstashQuotaStore(...),
  policy: quotaPolicyForGemini(...),
  onEvent: event => ...
})
```

Design constraints:

- Preserve PostBuzz's useful behaviors: Upstash-backed distributed state, `rpd === 0` model
  disabled, RPD durable-defer, RPM short wait, and alerting.
- Do not add Upstash or Redis dependencies to core.
- Queue/Temporal hosts must be able to convert quota defer into their scheduler retry primitive.

Acceptance criteria:

- PostBuzz can delete its local Gemini quota control without losing durable deferral.
- A non-Temporal host can still use the package as a normal pre-send limiter.
- Quota events are structured: allow, defer, backend error, provider disabled.

#### 6. Document grounded-to-structured workflows before adding a client method

Problem:

Gemini cannot combine Google Search grounding with native structured output in one call. any-llm
correctly rejects the invalid request, but hosts still need a blessed replacement pattern.

Current implementation facts:

- `providerOptions.google.tools` can carry `googleSearch` or `googleSearchRetrieval`.
- The adapter checks after provider options are merged.
- If grounding and `outputJsonSchema` are both present, it throws `bad_request`.
- Provider metadata can carry grounding/citation data, but the library has no stable normalized
  citation shape.

Decision:

Start with docs and utilities, not `client.runGroundedStructured()` in core. A full client method may
overfit one host's workflow. The clean first step is a canonical two-call recipe plus small
normalizers.

Keep all original feedback:

- PostBuzz asked for a two-step helper that records both attempts cleanly, preserves provider
  metadata, exposes citations/grounding chunks, and returns a composed result.
- The minimum viable request was docs, grounding metadata normalization utilities, and a canonical
  example.

Recommended first step:

- Add a `docs/grounded-structured.md` pattern:
  1. grounded research call with `tools: [{ googleSearch: {} }]`;
  2. extract grounded text and citation metadata;
  3. structured synthesis call with `output.jsonSchema`;
  4. persist both attempts through the normal sink;
  5. link them via caller `metadata`/`externalId`.

Acceptance criteria:

- Hosts do not invent different grounded-to-structured architectures per call-site.
- Citation/provider metadata survival is documented.
- Tests or examples verify both calls produce separate attempt records sharing host correlation.

#### 7. Ship a Temporal and multi-runtime integration example

Problem:

PostBuzz and RED LINE both have web routes plus Temporal workers. Auth, sink wiring, metadata
stamping, retry ownership, and client construction are easy to get subtly wrong.

Current implementation facts:

- Auth is per-call, not ambient.
- Telemetry events fire once per logical call.
- `retryMiddleware` is opt-in and creates multiple attempt records within one logical call.
- For externally retried Temporal activities, the correct pattern is stable `idempotencyKey` with no
  library retry middleware.

Decision:

Prefer a concrete example over a generic `createRuntimeClientFactory` in the first pass. If the
example reveals repeated boilerplate, then extract a helper.

Keep all original feedback:

- `createRuntimeClientFactory` may still be useful.
- `buildCallMetadata` may still be useful.
- A metadata convention should be documented: `tenantId`, `orgId`, `workspaceId`, `route`,
  `workflowId`, `reportId`, `jobType`, and host-specific domain anchors.
- Brownfield migration docs should acknowledge custom wrappers, legacy schemas, and result mapping.

Acceptance criteria:

- Example has separate web and worker client construction.
- Example shows per-call auth with no env read inside the library.
- Example shows Temporal-owned retry with stable `idempotencyKey`.
- Example shows when library retry middleware is appropriate and when it is not.
- Example shows typed metadata and optional sidecar persistence.

#### 8. Caller-owned structured-output validation helpers

Problem:

This is already in ROADMAP, and RED LINE gave concrete evidence even before the F1/F2/F3 merge. The
merge makes the gap larger. Pre-merge, core carried in-library Zod validation for structured output;
post-merge there is zero built-in shape safety net — only the `jsonSchema` hint forwarded to the
provider plus the `outputParsed` boolean signal (see "New gap: silent structured-output parse
failures" above). Because a malformed parse now silently reports `status: 'ok'`, the only remaining
safety net for shape-correctness — not just parse-success — is exactly this caller-owned validation
helper. Its absence is more consequential than before the merge.

Priority call: promote from P3 to P2. Per operating-posture filter 3, reusable helpers that prevent
billing drift deserve promotion, and per filter 2 both PostBuzz and RED LINE independently hit the
same missing pattern, which argues against leaving it as a low-priority nice-to-have. It does not
warrant P1/P0, though: the acute risk — a host being unaware a parse even failed — is already closed
by `outputParsed` plus the P1 #3 acceptance criteria above, and checking that boolean is a one-line
host change. What a validation helper adds beyond that is shape-correctness after a successful parse,
which is valuable and repeatedly requested but is not itself the mechanism that prevents the
worst-case silent failure, so P2 (host adoption velocity) is the right home.

Requested item:

- Optional validation helper, preferably Standard Schema compatible, so callers can apply Zod,
  bespoke validators, or manual shape checks consistently after `outputParsed === true`.

Recommended action:

- Build an optional helper package or example.
- Core must stay forward-only: it forwards JSON Schema and parses JSON; it does not own business
  acceptance policy.

### P3 - Useful but lower priority

#### 9. Brownfield migration helpers

Keep the feedback, but do not build a helper package until the examples prove repeated shape.

Requested items:

- "Replacing a custom Gemini wrapper with any-llm" guide.
- "Replacing env-owned auth with per-call auth" guide.
- "Replacing embedded usage JSON arrays with `llm_calls`" guide.
- Result mapping examples such as `toLegacyUsage(result)` and `toLegacyStructuredResult(result)`.
- Sink adapter example for hosts that currently append usage into a domain row.
- Call-site transform guide from old prompt wrappers to
  `defineCallSite({ id, model, jsonSchema, system, userTemplate, config })`.

Recommended action:

- Document these as examples and migration notes.
- Avoid committing to generic `LegacyUsageShape` APIs in public packages.

#### 10. Rate-limiter wait attribution

This is already in ROADMAP, but PostBuzz gives concrete evidence.

Requested item:

- Capture `queueDelayMs` or `rateLimitWaitMs` in telemetry and optionally in `LlmCallRecord`.

Recommended action:

- Add only after deciding whether queue wait belongs in the canonical record or telemetry only.
- This is lower priority than quota correctness.

## Consolidated build order

1. Portable reasoning resolution.
2. Explicit `priority` service-tier decision.
3. Pricing coverage introspection and strict pricing mode.
4. Ledger architecture docs with sidecar-table pattern.
5. Provider quota companion package. Done in `@gullabs/quota` 0.1.0; host consumption remains.
6. Grounded-to-structured docs and metadata utilities.
7. Temporal/multi-runtime integration example.
8. Caller-owned validation helper.
9. Brownfield migration guide and examples.
10. Rate-limiter wait attribution.

This document remains the phase-ordered backlog for these host-adoption items.

## Stale or corrected assumptions from the split docs

- "PostBuzz should consume `@gullabs/drizzle` directly" is plausible for PostBuzz, but not a
  universal answer. RED LINE needs either a sidecar table or a more extensible Drizzle story.
- "Canonical host-ledger guidance is mostly a documentation task" is true for the base any-llm
  ledger, but incomplete for hosts with typed domain anchors.
- "Idempotency guidance is absent" is now partially stale: README documents the core rule. It still
  needs an example and stronger placement in ledger docs.
- "Caller-owned validation is a new ask" is stale: ROADMAP already records it. RED LINE strengthens
  priority but does not introduce the idea; the F1/F2/F3 merge's removal of in-library validation is
  what moved it from P3 to P2 (see recommendation #8), not a new host request.
- "Rate-limiter wait attribution is new" is stale: ROADMAP already records it. PostBuzz strengthens
  priority but it is not urgent.
- "Runtime factory and buildMetadata are committed library deliverables" is too strong. They are
  valid feedback, but the cleaner first step is an example and metadata convention.

## Review checklist for the next implementation plan

- Does the plan ignore backward compatibility when a cleaner type or package contract exists?
- Does it cite current source, not only host prose?
- Does it preserve provider-call truth: `idempotencyKey` deduplicates ledger rows only, not provider
  calls?
- Does it preserve the strict/fail-open boundary: bad request inputs fail closed, sink/telemetry/cost
  side effects fail open unless a host explicitly opts into stricter pricing?
- Does it avoid putting infrastructure dependencies in core?
- Does it give worker/orchestrator hosts a durable retry story instead of in-process sleeping for
  hours?
- Does it include focused tests for every runtime contract change?
