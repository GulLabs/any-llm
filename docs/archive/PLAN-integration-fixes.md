# Integration Fixes Plan — `@gullabs/any-llm` v1.x

> **Archived.** This is a historical planning/execution record from internal development, kept for
> project history. It is not maintained documentation and may not reflect the current state of the
> library — see the [root README](../../README.md) and [docs/](../) for current, maintained docs.

> **Status:** Codex signoff: APPROVE (finalized greenfield decisions, 2026-06-30) — F3 provider->core->retry served-tier contract verified against retry.ts/engine.ts; all owner decisions encoded; no open items. Execution handoff added and Claude signoff: APPROVE (2026-06-30).
> Owner signoff: COMPLETE (2026-06-30)

---

## Summary

This document captures three targeted changes to `@gullabs/any-llm` that surfaced during the
first real integration: wiring a host Temporal-driven pipeline to the library. That host
stores response schemas as hot-editable JSON in its database (no code deploy cycle), passes
`attemptId` as a correlation FK into its own context table, and runs Gemini Flex calls that need
an automatic fallback to standard-tier on capacity pressure. None of these three patterns fit the
library's current surface cleanly.

**This is a GREENFIELD library with ZERO clients. Backward compatibility is a non-concern. The
goal is the cleanest, most minimal design.** All three changes are breaking by prior-round
standards; every recommendation that was hedged on backward compatibility is now superseded by the
owner's final decisions recorded in §Owner decisions below.

The library has already adopted a strict-input / fail-closed-call / fail-open-side-effects
philosophy, codified in SPEC.md's non-negotiable invariants: the call fails-closed on bad inputs
(bad*request before any network I/O); a broken sink, telemetry hook, or cost computation never
fails the LLM call; and every attempt — success or failure — writes a postmortem record. These
invariants are correct and must not be loosened by any of the three changes below. The changes
extend what the library \_observes* (F1), what it _correlates_ (F2), and how it _falls back_ (F3)
without touching the fail-closed / fail-open boundary.

The guiding principle: **the library is STRICT about what it CONTROLS (the request it builds —
it owns the provider contract) and NEUTRAL about what it OBSERVES (the response — only the caller
knows the business rules).** F1 operationalises this fully: in-library output validation is
removed entirely; the lib forwards a JSON Schema hint to the provider and surfaces the parsed
result; the caller owns all validation, retry, and acceptance policy.

---

## Already aligned (do not re-do)

The following behaviours are already correct in uncommitted work. Implementers must not
re-implement or second-guess them.

- **Config validation throws `bad_request` before network I/O.**
  `makeGeminiConfigValidator` in `packages/core/src/registry.ts:219-289` produces a Standard
  Schema v1 validator. The engine runs it at `packages/core/src/engine.ts:1014-1026` against a
  projection of the resolved config (`temperature`, `topP`, `topK`, `maxOutputTokens`,
  `stopSequences`, `reasoning`, `serviceTier`), throwing `LlmError('bad_request', retryable:
false)` on any issue. All issue messages are joined before throwing, so all violations surface
  in one round-trip.

- **`Warning` union simplified to `{ type: 'other' }`.** `packages/core/src/types.ts:259-263`
  has exactly one Warning variant. Engine, adapter, and tests already use it. No further warning
  types are pending.

- **Adapter throws (not warns) on four bad reasoning configurations.** In
  `packages/google/src/adapter.ts`, the adapter throws `LlmError('bad_request')` for:
  both `effort` and `budgetTokens` set simultaneously (lines 305-310); `budgetTokens` on a
  `thinkingLevel`-API model (lines 327-331); `temperature`/`topP`/`topK` on a `sampling: 'fixed'`
  model injected via `providerOptions.google` (lines 411-429); no `reasoningApi` on a model that
  cannot reason (lines 360-364). These are correct fail-closed behaviours — do not soften them to
  warnings.

- **Cost is integer micro-USD; unknown model → `null` + continue (fail-open).** The pricing layer
  already returns `{ microUsd: null }` for unpriced models rather than throwing. Cost computation
  failure appends an `'other'` warning and logs `llm.call.cost.failed`; the call succeeds without
  a `cost` field (engine.ts fail-open try/catch around `pricing.price`, ~lines 1113-1130).

- **Capability flags on `ModelDescriptor`: `nativeStructuredOutput`, `vision`, `audioInput`,
  `serviceTiers`, plus per-model `serviceTier` gating and Gemma-4 routing.** All present in
  `packages/core/src/registry.ts:38-95`. The adapter enforces `serviceTier` gating at
  `packages/google/src/adapter.ts:274-296`. Gemma-4 descriptors (`gemma-4-31b-it`,
  `gemma-4-26b-a4b-it`) are registered and API-verified.

- **GROSS token convention and double-counting prevention.** Specified in SPEC.md (line 24:
  "`cachedInputTokens` is a SUBSET of `inputTokens`; `thinkingTokens` is a SUBSET of
  `outputTokens`"). Enforced by `normalizeUsage` / `sanitizeUsage` in
  `packages/core/src/record.ts`. Covered by existing cost tests.

- **Fail-open sink on both success and error paths.** `recordToSink` is called at
  `packages/core/src/engine.ts:1159` (success) and at line 1220 (error path catch block). Both
  wrap the sink call in a try/catch that logs `llm.call.sink.failed` and swallows the error.

- **Result returns `callId` and `attemptId`.** `packages/core/src/types.ts:393` — both fields
  are non-optional on `LlmResult` (`callId` at line 393, `attemptId` at line 400). The engine stamps them at
  `packages/core/src/engine.ts:1162-1164` from the same IDs that land in the persisted record.

---

## Execution handoff

This section is the implementation control plane. The detailed F1/F2/F3 sections below remain
the source of truth for design decisions, but subagents should execute from the bounded packets
here so file ownership, dependencies, and acceptance criteria stay clear.

### Execution rules for subagents

- **Do not re-litigate owner decisions.** The seven decisions in §Owner decisions are final.
  Report only implementation blockers, source drift, or test failures.
- **Keep phases ordered.** F1 changes public request/result types that F2/F3 also touch. F2
  restructures the ledger identity and drizzle table shape that F3 extends with served-tier
  recording. Do not implement F3 before F1 and F2 have landed or been merged into the working
  branch.
- **No live network in tests.** Use `FakeAdapter`, `SignalAwareFakeAdapter`, `RecordingSink`,
  `FakeIds`, `FakeClock`, and Gemini fakes from `packages/testing/src/`.
- **No provider-call dedup.** `idempotencyKey` is ledger idempotency only. Any preflight DB
  read or provider idempotency mechanism is out of scope.
- **No in-library output validation.** If implementation leaves any path that validates output
  shape or throws `parse_error` for shape mismatch, the phase is not complete.
- **Preserve fail-open side effects.** Sink, telemetry, and cost failures must not fail the LLM
  call. Bad input/config still fails closed before network I/O.
- **Prefer narrow commits by phase.** Each phase should compile and pass its focused tests before
  the next phase starts. If agents work concurrently, they must use separate worktrees and merge
  through the phase order below.

### Phase 0 — Baseline seam check

**Owner:** one reviewer/agent before implementation starts.

**Objective:** verify that line-level anchors and current code assumptions in this plan still
match the working tree. This phase should not implement F1/F2/F3.

**Likely files to inspect:**

- `packages/core/src/types.ts`
- `packages/core/src/engine.ts`
- `packages/core/src/retry.ts`
- `packages/core/src/record.ts`
- `packages/core/src/ports.ts`
- `packages/google/src/adapter.ts`
- `packages/google/src/client.ts`
- `packages/drizzle/src/schema.ts`
- `packages/drizzle/src/sink.ts`
- `packages/testing/src/*`
- `README.md`, `SPEC.md`, `docs/architecture.md`

**Required checks:**

- Confirm `LlmRequest.output` is still the existing schema-based shape before F1.
- Confirm engine output validation still lives in the block targeted by F1.
- Confirm Gemini output schema conversion still uses `zodToGeminiSchema` before deletion.
- Confirm `attemptId` is generated inside `runAttempt` and drizzle still has a separate `uuid id`.
- Confirm `retryMiddleware` rebuilds `currentReq` from the original request each attempt.
- Confirm test fakes named in this plan exist and can cover the new scenarios without network.

**Deliverable:** short note in the implementation PR or agent handoff saying either
`BASELINE OK` or listing exact drift items that require plan adjustment before coding.

### Phase 1 — F1 output simplification

**Owner:** core/google type and adapter agent.

**Objective:** remove all in-library output validation and replace the output API with a single
forward-only JSON Schema hint.

**Files likely touched:**

- `packages/core/src/types.ts`
- `packages/core/src/engine.ts`
- `packages/core/src/callsite.ts`
- `packages/core/src/index.ts`
- `packages/core/src/record.ts`
- `packages/core/src/*.test.ts`
- `packages/google/src/adapter.ts`
- `packages/google/src/*.test.ts`
- `packages/core/package.json`
- `packages/google/package.json`
- any package lockfile touched by dependency cleanup

**Concrete tasks:**

1. Replace `LlmRequest<S>` / `LlmResult<T>` output generics with plain `LlmRequest` /
   `LlmResult`.
2. Replace `output?: { schema: S }` and any two-mode output union with
   `output?: { jsonSchema: JsonValue }`.
3. Replace `ResolvedRequest.outputSchema` with `outputJsonSchema: JsonValue | undefined`,
   including the input-to-resolved mapping at `packages/core/src/engine.ts:935`
   (`request.output?.schema` -> `request.output?.jsonSchema`).
4. Delete engine output validation; JSON.parse success becomes `output` +
   `outputParsed: true`, malformed/empty JSON becomes `outputParsed: false`, and neither path
   throws `parse_error`.
5. Keep `generate()` and `runStructured()` as separate entry points; strip validation from both.
6. Add `callSiteId?: string` to `LlmRequest` and thread it through the `generate()` path.
7. Replace `CallSite.schema` with `CallSite.jsonSchema`; keep template interpolation and
   call-site config bundling.
8. In Gemini, replace the output gate with `structuredOutputRequested =
req.outputJsonSchema !== undefined`; use it for response mime/schema, grounding guard, and
   JSON parse.
9. Delete output `zodToGeminiSchema` usage and remove `InferOutput` from the public export.
10. Drop runtime `zod` dependencies from packages only after confirming there are no remaining
    imports in that package.

**Focused acceptance tests:**

- Valid JSON with `output.jsonSchema` returns `output` and `outputParsed: true`.
- Shape-mismatching but valid JSON does not throw and still returns `outputParsed: true`.
- Malformed, empty, or truncated structured output returns `outputParsed: false` and preserves
  `finishReason`.
- Plain text calls omit `outputParsed` on result and record.
- Gemini receives `responseSchema === inputJsonSchema` without conversion.
- Grounding plus `output.jsonSchema` throws `bad_request` before network I/O.
- `generate({ callSiteId })` records the caller-supplied `callSiteId`.
- `runStructured` still interpolates templates and records `callSite.id`.

**Phase gate:** focused F1 tests pass, and `rg "outputSchema|InferOutput|parse_error|zodToGeminiSchema"`
has no surviving output-validation path except historical docs/review notes in this file.

### Phase 2 — F2 correlation and ledger identity

**Owner:** core/drizzle record agent.

**Objective:** make `attemptId` the durable identity, add caller correlation fields, and provide
ledger-only idempotency.

**Files likely touched:**

- `packages/core/src/types.ts`
- `packages/core/src/engine.ts`
- `packages/core/src/record.ts`
- `packages/core/src/*.test.ts`
- `packages/drizzle/src/schema.ts`
- `packages/drizzle/src/sink.ts`
- `packages/drizzle/src/*.test.ts`
- `packages/testing/src/*` if a small helper is needed for deterministic duplicate tests

**Concrete tasks:**

1. Add `idempotencyKey?: string` to `LlmRequest`.
2. Add `externalId?: string` to `LlmRequest`, `BuildRecordInput`, and `LlmCallRecord`.
3. Use `request.idempotencyKey ?? ids.attemptId()` at the `runAttempt` attempt-id call site.
4. Thread `externalId` into success and error records.
5. Change `llm_calls` schema so `attempt_id text` is the primary key.
6. Remove the redundant `uuid id` column and redundant unique index on `attempt_id`.
7. Add a normal `callId` index and an `external_id` index.
8. Ensure drizzle sink conflict handling remains ledger-idempotent on `attempt_id`.
9. Do **not** add `served_service_tier` in this phase. The F2 drizzle code block below includes
   it as a forward reference because the final schema needs the column; Phase 3 owns that edit.

**Focused acceptance tests:**

- `idempotencyKey` becomes result `attemptId` and record `attemptId`.
- Without `idempotencyKey`, generated `attemptId` behavior is unchanged.
- `externalId` round-trips to `LlmCallRecord` and drizzle column.
- Missing `externalId` writes `null`/undefined as appropriate.
- Two sink writes with the same `attemptId` produce one ledger row.
- Two calls with the same `idempotencyKey` still call the provider twice; only the ledger row is
  deduped.

**Phase gate:** focused F2 tests pass, drizzle schema exports compile, and there is no remaining
schema-owned `uuid id` identity for `llm_calls`.

### Phase 3 — F3 flex fallback, served tier, and retry threading

**Owner:** strongest core/google runtime agent.

**Objective:** implement provider-builtin Gemini flex-to-standard fallback with correct effective
tier recording, pricing, and retry carry-forward.

**Files likely touched:**

- `packages/core/src/types.ts`
- `packages/core/src/errors.ts`
- `packages/core/src/ports.ts`
- `packages/core/src/engine.ts`
- `packages/core/src/retry.ts`
- `packages/core/src/record.ts`
- `packages/core/src/*.test.ts`
- `packages/google/src/adapter.ts`
- `packages/google/src/client.ts`
- `packages/google/src/flex-fallback.ts` (new)
- `packages/google/src/*.test.ts`
- `packages/drizzle/src/schema.ts`
- `packages/testing/src/*` if fake scripting needs a narrow extension

**Concrete tasks:**

1. Add `servedServiceTier?: string` to `LlmResult`, `LlmCallRecord`, and drizzle
   `served_service_tier`.
2. Add `effectiveConfig?: Partial<ResolvedConfig>` or equivalent served-tier channel to
   `AdapterResult`.
3. Add `servedServiceTier?: string` to `LlmError` and `LlmErrorOptions`.
4. In engine success path, compute cost and records from the adapter-reported effective tier,
   not only the outer resolved config.
5. In engine error path, record `err.servedServiceTier` when present.
6. Implement `packages/google/src/flex-fallback.ts` with `isGeminiCapacityError`.
7. Implement one-shot provider-builtin fallback: flex capacity error to standard, default ON,
   opt-out through config.
8. Ensure 503 always falls back; 429 falls back only for shared-capacity wording, never
   quota/billing exhaustion.
9. Add `STANDARD_DEFAULT_TIMEOUT_MS = 300_000` and apply it for standard tier with both
   transport timeout and `AbortController`.
10. Fix `retryMiddleware` with a loop-carried pinned service tier so retries after fallback stay
    standard.

**Focused acceptance tests:**

- Flex 503 capacity error falls back to one standard attempt without caller wiring.
- `flexFallback: false` propagates the original 503 with no standard attempt.
- Capacity-flavored 429 falls back; quota/billing 429 does not.
- Flex success does not fall back.
- Fallback success returns and records `servedServiceTier: 'standard'`.
- Fallback failure records the effective served tier on the error record.
- Pricing uses standard-tier rates after fallback.
- Required sequence test passes:
  `flex(capacity-fail) -> standard -> [retry] -> standard`, with no later flex attempt.
- Standard tier with no `timeoutMs` gets `STANDARD_DEFAULT_TIMEOUT_MS` through both SDK timeout
  and `AbortController`.

**Phase gate:** focused F3 tests pass and the sequence test fails if the old retry behavior
(`currentReq` rebuilt from original request without a pinned tier) is restored.

### Phase 4 — Documentation and public surface cleanup

**Owner:** docs/API cleanup agent after Phases 1-3 merge.

**Objective:** make public docs match the implemented behavior and remove stale API claims.

**Files likely touched:**

- `README.md`
- `SPEC.md`
- `docs/architecture.md`
- package READMEs if they mention output validation, `schema`, parse errors, drizzle identity,
  or flex fallback behavior
- package manifests if dependency cleanup remains after implementation

**Concrete tasks:**

1. Update output docs to describe `output.jsonSchema`, `output: unknown`, `outputParsed`, and
   caller-owned validation.
2. Remove or rewrite examples that use `output.schema`, `InferOutput`, or in-library parse
   errors.
3. Document `externalId`, `idempotencyKey`, `attemptId` as the FK/PK target, and ledger-only
   idempotency.
4. Document provider-builtin Gemini flex fallback, opt-out config, `servedServiceTier`, and
   standard timeout.
5. Fix the architecture timeout table: flex is 1,500,000 ms and standard is 300,000 ms.
6. Ensure docs do not imply provider-call dedup or middleware-based flex fallback.

**Focused acceptance checks:**

- `rg "output\\.schema|InferOutput|parse_error|flexFallbackMiddleware|uuid\\('id'\\)|900,000"`
  only returns historical notes in this plan or intentional changelog text.
- README examples compile conceptually against the new public API.
- SPEC invariants match the implemented fail-closed/fail-open boundary.

**Phase gate:** docs and package manifests reflect the final implementation; no stale public API
claims remain.

### Phase 5 — Integration quality gate and review

**Owner:** final integrator/reviewer.

**Objective:** verify the merged implementation behaves as one coherent release, not as three
local patches.

**Commands:**

```bash
pnpm -r build
pnpm typecheck
pnpm test
pnpm quality
```

**Final review checklist:**

- Public API is internally consistent: no generics remain only for removed output validation.
- `outputParsed: false` is a success signal, not a thrown error.
- `attemptId` is the only ledger identity and remains returned on success and failure records.
- `idempotencyKey` dedups ledger inserts only; duplicate provider calls remain expected.
- `servedServiceTier` is set from effective provider behavior, not requested config.
- Retry after fallback stays standard.
- Sink, telemetry, and cost failures are still fail-open.
- Bad config/input still fails before network I/O.

**Done condition:** all gates pass, Claude or human code review has no blocker findings, and the
PR/commit message lists the F1/F2/F3 behavior changes explicitly.

---

## Change F1 — Output: single forward-only mode; caller owns all validation

### Decision

**REMOVE in-library output validation entirely. There is ONE output mode.**

`LlmRequest.output?: { jsonSchema: JsonValue }`. The lib forwards it to Gemini as
`responseSchema` (generation hint, keeps provider-side enforcement), JSON.parses the response,
sets `result.output: unknown` + `result.outputParsed: boolean`, and NEVER validates, NEVER throws
`parse_error`. The caller owns all output validation, retry, and acceptance policy.

### What to delete

The following are **removed entirely** — they must not survive into the implementation:

- The two-mode discriminated union (`{schema}|{jsonSchema}`) and the `OutputSpec` union type with
  `never` discriminants.
- The Zod `output.schema` validate-in-lib path everywhere it appears.
- The engine validation block at `packages/core/src/engine.ts:1093-1110` (the
  `if (req.outputSchema !== undefined) { validate → throw or set output }` block). Delete it; do
  not replace it with a no-op.
- `zodToGeminiSchema` usage for output at `packages/google/src/adapter.ts:381-388`. The Zod
  conversion path is gone. The adapter sets `responseSchema` directly from `req.outputJsonSchema`.
- The `StandardSchema-output` requirement: `output.schema` accepting only `StandardSchemaV1` is
  gone; the input is plain `JsonValue` with no vendor check.
- The `outputSchema` field on `ResolvedRequest` and anywhere it is threaded through. Replace with
  `outputJsonSchema: JsonValue | undefined`.

**Zod dependency drop:** `packages/core/src/registry.ts` config validators are hand-rolled
StandardSchema — confirmed by grep (zero Zod/zod imports in registry.ts). Removing the output
validation path is therefore sufficient to let the core package drop `zod` as a runtime
dependency. Confirm by checking the full `packages/core` import graph before removing the dep.
`zodToGeminiSchema` in `packages/google` was used ONLY for OUTPUT schema conversion
(`adapter.ts:381-388`) — it was never used for reasoning schema conversion. Since output
validation is removed entirely, `zodToGeminiSchema` (and its call site at `adapter.ts:381-388`)
is **DELETED entirely**. There is **no** reasoning-schema conversion path. Drop `zod` from
`packages/google` once this deletion is confirmed clean.

**Public surface cleanup — drop `InferOutput` from `packages/core/src/index.ts`:** With
`LlmResult` no longer generic and output typed as `unknown`, the `StandardSchemaV1.InferOutput`
wrapper exported at `index.ts:15` has no consumers and must be removed:

```ts
// packages/core/src/index.ts — DELETE line 14-15:
//   /** Infer the output type of a Standard Schema. */
//   export type InferOutput<S extends StandardSchemaV1> = StandardSchemaV1.InferOutput<S>
```

The `StandardSchemaV1` type itself (line 13: `export type { StandardSchemaV1 }`) stays — it is
still used for config-validation validators in the registry (`makeGeminiConfigValidator` returns
a `StandardSchemaV1` validator). Only the OUTPUT-surface `InferOutput` re-export is dropped.

### `LlmRequest.output` (new — single mode)

```ts
// packages/core/src/types.ts — replace the output field on LlmRequest
// Current (types.ts:240): output?: { schema: S }
// Replacement:

export interface LlmRequest {
  // ... existing fields ...
  /**
   * Optional structured output hint.
   * The lib forwards jsonSchema to the provider as responseSchema (generation hint),
   * JSON.parses the response, and sets result.output: unknown + result.outputParsed: boolean.
   * The lib NEVER validates and NEVER throws parse_error.
   * The caller owns all output validation, retry, and acceptance policy.
   */
  output?: { jsonSchema: JsonValue }

  /**
   * Optional call-site identifier for observability grouping.
   * When set, persisted as callSiteId on the record so ledger queries
   * can group calls by their logical origin even when going through generate().
   * the host assembles its own prompts and uses generate() — this field lets
   * it get callSiteId observability without going through runStructured.
   */
  callSiteId?: string
  // ...
}
```

`LlmRequest` loses the `<S extends StandardSchemaV1>` generic entirely — there is nothing to
infer. `LlmRequest` is now a plain (non-generic) interface.

### `LlmResult` (simplified)

```ts
// packages/core/src/types.ts — LlmResult (no longer generic)

export interface LlmResult {
  // ... existing fields ...
  /**
   * The JSON.parsed response body when output.jsonSchema was set.
   * Always typed unknown — the caller validates.
   */
  output?: unknown
  /**
   * Whether JSON.parse of the model's text response succeeded.
   * Present when output.jsonSchema was set; absent on plain-text calls.
   * status remains 'ok' — the call succeeded; output policy is the caller's.
   */
  outputParsed?: boolean
}
```

`LlmResult<T>` loses its generic parameter. The single overload on `generate()` returns
`Promise<LlmResult>`. Simplify all overloads accordingly — no more `StandardSchemaV1.InferOutput<S>` anywhere.

### `generate()` entry point — add `callSiteId` pass-through

`generate()` currently passes `callSiteId=undefined` at `engine.ts:1345`. The `callSiteId` field
on `LlmRequest` (added above) fixes this: the engine reads `request.callSiteId` at the generate
path and threads it through to the record exactly as `runStructured` does.

**Current `engine.ts:1345`:**

```ts
return runPipeline<S>(
  request,
  resolvedConfig,
  undefined, // ← callSiteId always undefined on generate() path
  runtimeOpts?.signal,
  callAuth,
)
```

**Fix:** read `request.callSiteId` and pass it instead of hardcoded `undefined`:

```ts
return runPipeline(
  request,
  resolvedConfig,
  request.callSiteId, // ← caller-supplied callSiteId for observability
  runtimeOpts?.signal,
  callAuth,
)
```

### `CallSite` and `runStructured` — strip validation, keep everything else

`CallSite` currently carries `schema?: S` (StandardSchemaV1) at `callsite.ts:52`. Replace with
`jsonSchema?: JsonValue` (forward-only hint).

```ts
// packages/core/src/callsite.ts — update CallSite interface
// Current (callsite.ts:52): schema?: S
// Replacement:

export interface CallSite {
  id: string
  model: string
  /**
   * Optional JSON Schema forwarded verbatim to the provider as a generation hint.
   * No in-library validation. The caller owns acceptance policy.
   */
  jsonSchema?: JsonValue
  system?: string
  userTemplate?: string
  config?: GenConfig
}
```

`CallSite` loses its `<S>` generic. `defineCallSite` becomes a plain identity function with no
type parameter.

**`runStructured` earns its place via:**

- Template interpolation (`{{var}}` expansion) at `engine.ts:1380-1386`.
- Call-site config bundling (`callSite.config` merging).
- `callSiteId` propagation (passes `callSite.id` as `callSiteId` to the record).

`runStructured` does NOT validate. It renders templates, bundles config, sets `callSiteId`, and
calls the same `runPipeline` as `generate()` — with `output.jsonSchema` from the call site if
set.

**Do NOT collapse `generate()` and `runStructured()` into one method.** Both entry points remain;
the distinction is template-rendering + call-site bundling (runStructured) vs. caller-assembled
prompts (generate).

### Adapter — `structuredOutputRequested` gate (simplified)

The adapter's `outputSchemaRequested` gate at `packages/google/src/adapter.ts:370-391` becomes
simply:

```ts
// packages/google/src/adapter.ts — replace the outputSchemaRequested block
// Current: let outputSchemaRequested = false; if (req.outputSchema !== undefined) { … zodToGeminiSchema … }
// Replacement:

const structuredOutputRequested = req.outputJsonSchema !== undefined

if (structuredOutputRequested) {
  const nativeStructuredOutput =
    req.modelDescriptor?.capabilities?.nativeStructuredOutput !== false
  if (nativeStructuredOutput) {
    config.responseMimeType = 'application/json'
    config.responseSchema = req.outputJsonSchema // verbatim — no conversion
  }
}
```

No `zodToGeminiSchema` call. No vendor check. Gemini accepts JSON Schema/OpenAPI-subset objects
verbatim as `responseSchema`; the host already does this in its current production pipeline.

Use `structuredOutputRequested` for:

1. Setting `responseMimeType` / `responseSchema` (above).
2. The grounding-conflict guard (adapter.ts:447 — see below).
3. The JSON.parse step (adapter.ts:645): replace `outputSchemaRequested` with `structuredOutputRequested`.

**Grounding conflict guard:**

```ts
// packages/google/src/adapter.ts:447 — keep the guard, update the condition
if (groundingRequested && structuredOutputRequested) {
  throw new LlmError(
    'Grounding (googleSearch) cannot be combined with structured output ' +
      '(output.jsonSchema) on Gemini; choose one.',
    { kind: 'bad_request', retryable: false },
  )
}
```

### Engine step 8 (replace the validation block)

```ts
// engine.ts — replace lines 1093-1110 (the entire validation block)
// DELETE: if (req.outputSchema !== undefined) { validate → throw or set output }
// REPLACE WITH:

// Step 8: JSON.parse structured output — caller owns validation.
let output: unknown
let outputParsed: boolean | undefined
if (req.outputJsonSchema !== undefined) {
  if (adapterResult.rawStructured !== undefined) {
    output = adapterResult.rawStructured
    outputParsed = true
  } else {
    output = undefined
    outputParsed = false
  }
}
// No parse_error thrown. finishReason is always surfaced — caller detects truncation.
```

### `outputParsed` on `LlmCallRecord` and drizzle

```ts
// packages/core/src/record.ts — add to LlmCallRecord and BuildRecordInput
outputParsed?: boolean   // present only when output.jsonSchema mode was used

// packages/drizzle/src/schema.ts — add alongside other nullable boolean columns
outputParsed: boolean('output_parsed'),
```

> **Import note:** `packages/drizzle/src/schema.ts` currently imports only `integer`, `jsonb`,
> `pgTable`, `text`, `timestamp`, `uniqueIndex`, and `uuid` from `drizzle-orm/pg-core`. `boolean`
> is **not** currently imported. Adding `outputParsed: boolean('output_parsed')` requires adding
> `boolean` to that import list.

`status` remains `'ok'` when `outputParsed: false`. The call succeeded; output policy is the
caller's.

### SPEC.md invariant reframe

Replace the current invariant (line 23):

> "Engine validates output; adapters never do."

With:

> "Neither engine nor adapters validate output. The engine forwards output.jsonSchema to the
> provider as a generation hint, JSON.parses the response, and surfaces output: unknown +
> outputParsed: boolean. The caller owns all validation, retry, and acceptance policy."

Update SPEC.md, README.md (add an "Output" section), and `docs/architecture.md` §3 Phase 3
step 8 to reflect the single forward-only mode.

### Test plan

| Scenario                                                             | Expected                                                                              |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `output.jsonSchema` set, valid JSON response                         | `output` set to parsed value, `outputParsed: true`, no throw                          |
| `output.jsonSchema` set, shape-mismatching but valid JSON            | `output` set, `outputParsed: true`, NO throw, NO `parse_error`                        |
| `output.jsonSchema` set, malformed / empty JSON                      | `output: undefined`, `outputParsed: false`, no throw, `finishReason` surfaced         |
| `output.jsonSchema` set, truncated (`finishReason: 'length'`)        | `outputParsed: false`, no throw                                                       |
| `output.jsonSchema` set, responseSchema forwarded verbatim to Gemini | Gemini mock receives `responseSchema === inputJsonSchema`                             |
| `outputParsed: false` persisted in `LlmCallRecord`                   | `RecordingSink` captures `outputParsed: false`; `status` remains `'ok'`               |
| Grounding + `output.jsonSchema` set                                  | `bad_request` thrown before network I/O                                               |
| `output` absent (plain-text call)                                    | `outputParsed` absent on result and record                                            |
| `generate()` with `callSiteId` set                                   | Record `callSiteId` matches; same grouping as runStructured                           |
| `runStructured` — template interpolation still works                 | `{{var}}` variables expanded; `callSiteId` from callSite.id on record                 |
| `runStructured` with `callSite.jsonSchema` set                       | Forwarded to adapter as `responseSchema` verbatim; same path as generate() jsonSchema |

All tests use `FakeAdapter` or `makeFakeGemini` / `fakeGeminiResponse` from `@gullabs/testing` —
no live network.

---

## Change F2 — First-class correlation: `externalId` + `attemptId` as primary key

### Decision

**`attemptId` IS the primary key. Drop the redundant `uuid id`.**
**`idempotencyKey` is BUILT NOW (not phased).**

### Schema: `attemptId` as PK

```ts
// packages/drizzle/src/schema.ts — REMOVE line 14:
//   id: uuid('id').primaryKey().defaultRandom(),
// REPLACE the table definition opening with attemptId as PK:

export const llmCalls = pgTable(
  'llm_calls',
  {
    attemptId: text('attempt_id').primaryKey(), // ← PK; also the returned FK target
    recordSchemaVersion: integer('record_schema_version').notNull(),
    callId: text('call_id').notNull(),
    // ... rest unchanged ...
  },
  // remove the uniqueIndex on attemptId (now the PK index covers it)
  (table) => [index('llm_calls_call_id_idx').on(table.callId)],
)
```

`attemptId` is the returned key, the FK target, and the idempotency key — one identity column.
The `uniqueIndex('llm_calls_attempt_id_idx')` is dropped (PK covers it). Add an ordinary index on
`callId` instead so call-level queries remain fast.

Greenfield: no migration churn to avoid.

### `idempotencyKey` on `LlmRequest`

```ts
// packages/core/src/types.ts — add to LlmRequest

export interface LlmRequest {
  // ... existing fields ...
  /**
   * Optional caller-supplied idempotency key.
   * When set, the engine uses this value as `attemptId` instead of generating one
   * (replacing the `ids.attemptId()` CALL at engine.ts:967, inside `runAttempt`).
   * The drizzle PK on attemptId makes the LEDGER idempotent under Temporal activity
   * retry: a second attempt with the same key produces no duplicate persisted row.
   *
   * NOTE: this does NOT prevent a duplicate provider call — the provider call happens
   * before the sink insert. Preventing duplicate provider calls requires a preflight
   * dedup or provider-level idempotency — explicitly out of scope (ledger idempotency
   * only; Temporal owns activity idempotency upstream).
   *
   * Pattern: mint the key in the Temporal activity, thread it into the request,
   * and write the caller's own context row keyed by the same value — giving deterministic
   * correlation on BOTH success and failure paths, with no post-hoc attemptId race.
   */
  idempotencyKey?: string
}
```

When `idempotencyKey` is set, the engine substitutes it at `engine.ts:967` — the
`ids.attemptId()` CALL inside `runAttempt` (not `DEFAULT_IDS` at lines 273-276, which is the
generator definition, not the call site). No other engine behaviour changes.

### `externalId` on `LlmRequest`

```ts
// packages/core/src/types.ts — add to LlmRequest

export interface LlmRequest {
  // ... existing fields ...
  /**
   * Caller-supplied text handle for this call.
   * Examples: a job UUID, a composite like "stage-03:job:abc123:run:xyz".
   * Not interpreted by the library; persisted as a first-class indexed column
   * so ledger queries filter without JSONB expression indexes.
   * Optional — null when absent.
   */
  externalId?: string
}
```

`externalId` is threaded through the engine into `BuildRecordInput`, `LlmCallRecord`, and
the drizzle schema as a new indexed text column `external_id text` (nullable, non-unique —
a single job produces multiple calls).

### Drizzle schema additions

```ts
// packages/drizzle/src/schema.ts — add after callSiteId column
externalId: text('external_id'),
servedServiceTier: text('served_service_tier'),  // from F3 — see below

// in the table indexes array:
index('llm_calls_external_id_idx').on(table.externalId),
```

Keep `metadata` jsonb — unchanged.

### the host integration pattern (for documentation)

the host's custom `UsageSink` writes in a single Postgres transaction:

1. The lib's `LlmCallRecord` via `drizzleUsageSink` into `llm_calls`.
2. the host's own `llm_call_context` row (FK: `attempt_id → llm_calls.attempt_id`).

The transaction is fail-open at the outer sink boundary (engine wraps sink in try/catch at
`engine.ts:1158-1159`).

`externalId` is the denormalized convenience for ledger-only queries. The typed FK join for
richer pipeline-run queries goes through `llm_call_context.attempt_id → llm_calls.attempt_id`.

### Test plan

| Scenario                                           | Expected                                                                                                                                                                                                             |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `externalId` set on request                        | Round-trips through engine → record → drizzle column                                                                                                                                                                 |
| `externalId` absent                                | `LlmCallRecord.externalId` is `undefined`, drizzle writes `null`                                                                                                                                                     |
| `attemptId` returned in result                     | Matches `LlmCallRecord.attemptId` in `RecordingSink`                                                                                                                                                                 |
| `attemptId` PK constraint                          | Two calls with same `attemptId` → second insert is no-op (PK conflict); no duplicate row                                                                                                                             |
| `idempotencyKey` set on request                    | Engine uses `idempotencyKey` as `attemptId`; result `attemptId` matches; record `attemptId` matches                                                                                                                  |
| `idempotencyKey` ledger dedup under activity retry | Two calls with same `idempotencyKey` → second DB insert is no-op (PK conflict); result returned on both attempts; provider is called TWICE (ledger-idempotent, not call-idempotent — provider dedup is out of scope) |

---

## Change F3 — Flex → standard fallback: provider-builtin default-ON + retry threading fix

### Decision

**The Gemini provider performs flex → standard fallback automatically (default ON, opt-out).
It is NOT a user-wired middleware. The `flexFallbackMiddleware` helper is NOT shipped.**
**Post-fallback retries stay standard — the retry threading bug is FIXED (Decision 7).**

### Problem

There is no automatic flex → standard fallback on 503/capacity errors. Additionally,
`STANDARD_DEFAULT_TIMEOUT_MS` is needed as a standard-tier transport default. Finally,
`retryMiddleware` at `packages/core/src/retry.ts:239` rebuilds each retry from the ORIGINAL
request (`currentReq = { ...req, attemptNumber: attempt }`), so any tier mutation from a
fallback is discarded on the next outer retry — causing repeated flex→standard→flex cycling.

### Fallback design (provider-builtin)

The Gemini provider (`@gullabs/google`) performs a ONE-SHOT standard-tier attempt automatically
when a flex-tier call hits a capacity error:

- **503** always triggers fallback (UNAVAILABLE is always a capacity signal).
- **429** triggers fallback ONLY when the error message indicates shared-capacity overload (e.g.
  "no capacity available", "overloaded"), NOT quota/billing exhaustion. The `isGeminiCapacityError`
  predicate (see below) encodes this distinction.

Default: ON. Single opt-out: `config.flexFallback: false` (or equivalent field on `GenConfig`)
for the rare "fail rather than pay standard" case.

Because fallback is provider-builtin, zero wiring is required by the caller.

**`isGeminiCapacityError` predicate (in `@gullabs/google`):**

```ts
// packages/google/src/flex-fallback.ts (new file)

export function isGeminiCapacityError(err: LlmError): boolean {
  // 'rate_limited' is the correct LlmErrorKind for 429 responses.
  if (err.kind !== 'server' && err.kind !== 'rate_limited') return false
  if (err.httpStatus === 503) return true
  if (err.httpStatus === 429) {
    const msg = (err.message ?? '').toLowerCase()
    const isCapacity =
      msg.includes('no capacity') ||
      msg.includes('overloaded') ||
      (msg.includes('resource exhausted') &&
        !msg.includes('quota') &&
        !msg.includes('billing'))
    return isCapacity
  }
  return false
}
```

⚠️ A blind 429 fallback turns quota exhaustion into MORE paid standard-tier traffic — a cost and
abuse hazard. This predicate MUST distinguish capacity overload from quota/billing errors. It
belongs in `@gullabs/google`, NOT in core.

### Served tier recording + retry threading — blocking data contract

This is the **blocking design contract** for F3. The exact field names are implementation detail;
the CHANNEL (adapter effectiveConfig → core record/cost; typed error tier; retry carry-forward)
is mandatory and must not be omitted or hand-waved.

`runAttempt` currently prices and builds records from the OUTER `resolvedConfig`, not the
per-attempt effective config after any fallback mutation. The engine.ts cost call at **line 1119**
passes `resolvedConfig.serviceTier`; `buildSuccessRecord` at **line 1141** receives `resolvedConfig`
as its config argument (line 1148); `buildErrorRecord` at **line 1204** likewise receives
`resolvedConfig` (line 1211). A provider-internal flex→standard downgrade is therefore
mis-recorded and mis-priced unless the adapter explicitly communicates the effective tier.

#### Part 1 — Adapter → Core (success path): `AdapterResult.effectiveConfig`

The Gemini adapter, after any internal flex→standard fallback, MUST return the EFFECTIVE config
it actually used. Add `effectiveConfig` (or at minimum `servedServiceTier`) to `AdapterResult`:

```ts
// packages/core/src/ports.ts — add to AdapterResult
effectiveConfig?: Partial<ResolvedConfig>  // overrides from provider-internal fallback
// OR, at minimum:
servedServiceTier?: string                 // tier actually served, post-fallback
```

Core MUST build the success record AND compute cost from `adapterResult.effectiveConfig` (NOT
`resolvedConfig`). Specifically:

- **`engine.ts:1119`** — replace `resolvedConfig.serviceTier` in the `pricing.price(...)` call
  with the adapter-reported effective tier (e.g.
  `adapterResult.effectiveConfig?.serviceTier ?? resolvedConfig.serviceTier`).
- **`engine.ts:1148`** — replace `resolvedConfig` in the `buildSuccessRecord(...)` call with a
  merged config that applies adapter-reported overrides (e.g.
  `{ ...resolvedConfig, ...adapterResult.effectiveConfig }`).

#### Part 2 — Adapter → Core (error path): typed `LlmError.servedServiceTier`

When the fallback itself fails (e.g. flex→standard, standard also errors), the thrown `LlmError`
MUST carry the effective served tier so the error record also reflects the tier that was actually
used after fallback:

```ts
// packages/core/src/errors.ts — add to LlmError (and LlmErrorOptions)
servedServiceTier?: string  // tier actually attempted, post-fallback
```

- **`engine.ts:1211`** — `buildErrorRecord` currently receives `resolvedConfig`. After the fix,
  core reads `err.servedServiceTier` (if present) and passes it through to the error record,
  overriding `resolvedConfig.serviceTier`. The effective tier is recorded on every postmortem
  row, success or failure.

#### Part 3 — Core / retry tier-pinning: carry-forward in `retryMiddleware`

`retryMiddleware` at `packages/core/src/retry.ts:239` rebuilds each retry from the original
request: `let currentReq: ResolvedRequest = { ...req, attemptNumber: attempt }`. This resets
`currentReq.config.serviceTier` back to the original `flex` on every iteration. Any mutation of
`currentReq.config.serviceTier` inside the catch block is therefore silently discarded when the
next iteration re-initialises `currentReq` from `req` — causing repeated flex→standard→flex
cycling regardless of the mutation.

**Fix:** use a loop-carried variable declared OUTSIDE the retry loop. At the top of each
iteration, merge the pinned tier when constructing `currentReq`. Update the pin after each
attempt by reading the served tier from the result or error:

```ts
// packages/core/src/retry.ts — declare OUTSIDE the for(;;) loop:
let pinnedServiceTier: 'flex' | 'standard' | undefined = undefined

// Inside the loop, replace the existing currentReq initialisation at retry.ts:239:
let currentReq: ResolvedRequest = {
  ...req,
  attemptNumber: attempt,
  config: {
    ...req.config,
    ...(pinnedServiceTier !== undefined ? { serviceTier: pinnedServiceTier } : {}),
  },
}

// After a successful return — update the pin before returning (so the variable is
// available if the calling code ever re-enters; mainly documents the success channel):
//   if (result.servedServiceTier !== undefined)
//     pinnedServiceTier = result.servedServiceTier as 'flex' | 'standard'

// In the catch block, after classifying the error — update the pin:
if (err.servedServiceTier !== undefined) {
  pinnedServiceTier = err.servedServiceTier as 'flex' | 'standard'
}
```

The concrete data channel is:

- On success: `result.servedServiceTier` read and stored into `pinnedServiceTier` before returning.
- On error: `err.servedServiceTier` read and stored into `pinnedServiceTier` inside the catch block.

Crucially, the pin is applied when CONSTRUCTING `currentReq` at the top of the next iteration —
not by mutating an already-built `currentReq`. This guarantees the correct merge order and means
the fix survives the existing `currentReq = { ...currentReq, attemptTimeoutMs: remaining }` shrink
that follows (both branches rebuild from a fresh spread, so the pinned tier is already baked into
`req.config` before any timeout shrink is layered on).

Once the engine executes a provider-internal flex→standard fallback, `pinnedServiceTier` is set to
`'standard'`; every subsequent iteration constructs `currentReq` with `serviceTier: 'standard'` and
the flex→standard→flex cycle is broken. The FIRST attempt still starts at the originally-requested
tier because `pinnedServiceTier` is `undefined` before any attempt runs, so the spread no-ops.

**`servedServiceTier` field on result and record:**

```ts
// packages/core/src/types.ts — add to LlmResult
servedServiceTier?: string  // tier actually used; differs from requested when fallback fired

// packages/core/src/record.ts — add to LlmCallRecord
servedServiceTier?: string

// packages/drizzle/src/schema.ts — add column (see F2 drizzle section)
servedServiceTier: text('served_service_tier'),
```

`servedServiceTier` is set from `adapterResult.effectiveConfig` inside `runAttempt` and
propagated to the record, result, and retry carry-forward. It differs from the top-level
`resolvedConfig.serviceTier` only when the fallback fired.

**Required test asserting the correct tier sequence and pricing:**

```
flex (capacity-fail) → standard (one-shot fallback) → [retry] → standard (NOT back to flex)
```

The test MUST assert:

1. `RecordingSink` does NOT see a flex attempt after the first fallback has fired.
2. The recorded/priced `servedServiceTier` on each attempt row matches the tier actually served
   (flex→capacity-fail row has `servedServiceTier:'flex'`; standard row has `servedServiceTier:'standard'`).
3. `pricing.price(...)` is called with `'standard'` rates on the post-fallback attempt(s).

Use `SignalAwareFakeAdapter` scripted to: attempt 1 = flex 503 capacity error; fallback =
standard success or retryable standard error; attempt 2 = standard (asserted).

### Timeout constants

```ts
// packages/google/src/client.ts — add alongside FLEX_DEFAULT_TIMEOUT_MS

/** Default transport timeout for standard-tier Gemini calls (ms). Applied when
 * serviceTier === 'standard' and no timeoutMs is set. */
export const STANDARD_DEFAULT_TIMEOUT_MS = 300_000 // 5 minutes

/** (existing) Default transport timeout for flex-tier calls (ms). 25 minutes. */
export const FLEX_DEFAULT_TIMEOUT_MS = 1_500_000
```

Update the transport timeout table at `packages/google/src/adapter.ts:519-540` to apply
`STANDARD_DEFAULT_TIMEOUT_MS` when `serviceTier === 'standard'` and `genConfig.timeoutMs` is
`undefined`.

**`STANDARD_DEFAULT_TIMEOUT_MS` must be backed by `AbortController`** (same belt-and-suspenders
pattern already present for flex at `adapter.ts:479-499`). `httpOptions.timeout` alone can be a
no-op on some SDK versions. Extend the existing belt-and-suspenders block:

```ts
// packages/google/src/adapter.ts — extend the existing AbortController block

if (config.serviceTier === 'flex' && genConfig.timeoutMs === undefined) {
  // existing flex belt-and-suspenders (unchanged)
  …
} else if (config.serviceTier === 'standard' && genConfig.timeoutMs === undefined) {
  const stdController = new AbortController()
  const timeoutReason = new DOMException(
    `Standard timeout: call exceeded ${STANDARD_DEFAULT_TIMEOUT_MS}ms client-side ceiling`,
    'TimeoutError',
  )
  _standardTimeoutHandle = setTimeout(
    () => stdController.abort(timeoutReason),
    STANDARD_DEFAULT_TIMEOUT_MS,
  )
  config.abortSignal = ctx.signal !== undefined
    ? AbortSignal.any([stdController.signal, ctx.signal])
    : stdController.signal
}
```

### Test plan

| Scenario                                                        | Expected                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Flex 503 capacity error → provider-builtin fallback ON          | One flex attempt (fails), one standard attempt (succeeds); `servedServiceTier:'standard'` on result and record; no user wiring required                                                                                                                                        |
| Flex 503 with `config.flexFallback: false`                      | No fallback; 503 propagates as error                                                                                                                                                                                                                                           |
| Flex 429 — capacity overload message                            | `isGeminiCapacityError` returns `true`; fallback fires; `servedServiceTier:'standard'`                                                                                                                                                                                         |
| Flex 429 — quota/billing exhaustion message                     | `isGeminiCapacityError` returns `false`; no fallback; error propagates; no standard-tier traffic                                                                                                                                                                               |
| Tier sequence after fallback + retry (Decision 7 fix)           | flex(capacity-fail) → standard → [retry] → standard; RecordingSink does NOT see a flex attempt after first fallback; `pinnedServiceTier` persists across iterations (test MUST fail under the old "mutate currentReq in catch" approach, which resets the tier each iteration) |
| Flex success                                                    | No fallback; one record; `servedServiceTier:'flex'`                                                                                                                                                                                                                            |
| Fallback: `servedServiceTier` on record reflects effective tier | `RecordingSink` record for standard attempt has `servedServiceTier:'standard'`, NOT `'flex'`; pricing uses standard-tier rates                                                                                                                                                 |
| Standard tier, no `timeoutMs`                                   | `STANDARD_DEFAULT_TIMEOUT_MS` applied via both `httpOptions.timeout` AND `AbortController`; `SignalAwareFakeAdapter` detects abort signal                                                                                                                                      |
| Standard tier, explicit `timeoutMs`                             | `timeoutMs + TRANSPORT_TIMEOUT_BUFFER_MS` applied (existing behaviour unchanged)                                                                                                                                                                                               |
| Flex tier, no `timeoutMs`                                       | `FLEX_DEFAULT_TIMEOUT_MS` applied via existing belt-and-suspenders (existing behaviour unchanged)                                                                                                                                                                              |

All tests use `SignalAwareFakeAdapter` or `FakeAdapter` from `@gullabs/testing` — no live network.

---

## Documentation updates

| Document               | Change                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SPEC.md`              | Reframe the output invariant: neither engine nor adapters validate; lib is forward-only. Add notes on `outputParsed: false` as a durable signal (status:'ok' preserved), `idempotencyKey` ledger-only semantics, and provider-builtin flex fallback.                                                                                                                       |
| `README.md`            | Add "Output" section: single `output.jsonSchema` mode (forward-only, caller validates), `outputParsed` flag, `finishReason` for truncation detection. Add "Correlation" section: `externalId`, `idempotencyKey`, `attemptId` as PK/FK target, custom sink pattern. Add "Flex tier" section: provider-builtin fallback, `servedServiceTier`, standard-tier default timeout. |
| `docs/architecture.md` | Update §3 Phase 3 step 8: single forward-only output mode, `structuredOutputRequested` gate, `outputParsed` durable signal. Add note in §2 Ports table that `UsageSink` may write in-transaction with a caller-owned context table correlated by `attemptId`. Note `externalId`, `servedServiceTier`, and `outputParsed` drizzle columns.                                  |
| `docs/architecture.md` | Fix the transport timeout table at `architecture.md:511`: `FLEX_DEFAULT_TIMEOUT_MS` is 1,500,000 ms (not 900,000 ms). Add `STANDARD_DEFAULT_TIMEOUT_MS` (300,000 ms) as the standard-tier default when `timeoutMs` is absent. Note both constants are backed by `AbortController` belt-and-suspenders.                                                                     |

---

## Out of scope / non-goals

- **No in-library output validation.** The caller owns validation, retry, and acceptance policy
  for all LLM output. The lib forwards `output.jsonSchema` to the provider and surfaces parsed
  JSON; that is all.
- **No provider-call dedup.** `idempotencyKey` provides ledger idempotency (no duplicate DB row
  via the PK conflict / `onConflictDoNothing`). Preventing duplicate provider calls requires a
  preflight dedup or provider-level idempotency — out of scope. Temporal owns activity
  idempotency upstream.
- **No Anthropic/OpenAI adapters in this pass.** Gemini-only; the `ProviderAdapter` seam is in
  place for future providers.
- **No removal of strict config validation.** The registry validators at
  `packages/core/src/registry.ts:219-289` are correct and must stay.
- **No agent loop or framework features.** The library is a single-call primitive.
- **No streaming.** The design seam is present; streaming is out of v1 scope.

---

## Owner decisions (finalized 2026-06-30)

All seven open questions are resolved. No remaining open items.

1. **Remove in-library output validation entirely (single forward-only output mode).**
   `LlmRequest.output?: { jsonSchema: JsonValue }`. The lib forwards the schema to Gemini as a
   generation hint, JSON.parses the response, and sets `result.output: unknown` +
   `result.outputParsed: boolean`. Never validates, never throws `parse_error`. Caller owns all
   output validation, retry, and acceptance policy. Both `generate()` and `runStructured()` are
   KEPT — but validation is stripped from BOTH. `runStructured` earns its place via template
   interpolation, call-site config bundling, and `callSiteId` propagation.

2. **`attemptId` is the primary key; drop the redundant `uuid id`.**
   `packages/drizzle/src/schema.ts:14` — remove `uuid('id').primaryKey().defaultRandom()`. Make
   `attemptId` (text) the PK. It is the returned key, FK target, and idempotency key — one
   identity column. Greenfield: no migration churn.

3. **Flex→standard fallback is DEFAULT-ON provider-builtin behavior in `@gullabs/google`.**
   Not a user-wired middleware. Not a core flag. The Gemini provider performs a one-shot
   standard-tier attempt automatically on capacity errors (503 always; 429 only when the error
   indicates shared-capacity overload via `isGeminiCapacityError`, never quota/billing). Default
   ON; single opt-out config. `flexFallbackMiddleware` helper is NOT shipped.

4. **`idempotencyKey` is BUILT NOW (not phased).**
   Caller-supplied optional `idempotencyKey?: string` on `LlmRequest` becomes `attemptId`,
   replacing the `ids.attemptId()` CALL at `engine.ts:967` (inside `runAttempt`). Provides
   ledger idempotency (no duplicate DB row); does NOT prevent duplicate provider calls (that is
   out of scope — Temporal owns activity idempotency upstream).

5. **`externalId` is the column name.**
   Matches the pattern used in most payment and audit APIs (Stripe, Postgres foreign tables).
   Persisted as `external_id text` indexed column on `llm_calls`.

6. **`STANDARD_DEFAULT_TIMEOUT_MS` backed by `AbortController` (true hard ceiling).**
   Same belt-and-suspenders pattern as the existing flex path at `adapter.ts:479-499`. Not
   `httpOptions.timeout` alone (which can be a no-op on some SDK versions).

7. **Fix retry threading in `retryMiddleware` (no longer out of scope).**
   `retry.ts:239` rebuilds each retry from the ORIGINAL request, causing flex→standard→flex
   cycling. Fix: thread the post-fallback effective request/tier forward so once a logical call
   has fallen back to standard, subsequent retries stay standard. Required test asserts tier
   sequence: flex(capacity-fail)→standard→[retry]→standard.

---

## Test & quality gate

Run the full gate before considering any change complete:

```bash
pnpm -r build          # build all packages (shared → dependents)
pnpm typecheck         # tsc --noEmit across all packages
pnpm test              # vitest (packages/core, packages/google, packages/drizzle, packages/testing)
pnpm quality           # typecheck + lint + test combined (CI gate)
```

Test fakes available in `packages/testing/src/` — use these; no live network in any test:

| Fake                                                          | Use for                                                            |
| ------------------------------------------------------------- | ------------------------------------------------------------------ |
| `FakeClock`                                                   | Deterministic latency assertions                                   |
| `FakeIds`                                                     | Deterministic `callId`/`attemptId` in record assertions            |
| `RecordingSink`                                               | Capture `LlmCallRecord`s for assertion without a DB                |
| `makeFakeGemini` / `fakeGeminiResponse` / `fakeGeminiBlocked` | Script Gemini SDK responses                                        |
| `FakeAdapter`                                                 | Engine integration tests without the Google adapter                |
| `SignalAwareFakeAdapter`                                      | Cancellation / timeout tests (adapter cooperates with AbortSignal) |

The live-probe script `scripts/probe-capabilities.mjs` is available for capability verification
against the real Gemini API when a new model is being registered, but must not be used in
automated tests.

New tests for F1, F2, F3 (including Decision 7 retry-threading) must run in the `vitest` suite
with no network access.

---

## Signoff

**Codex signoff: APPROVE (finalized greenfield decisions, 2026-06-30) — F3 provider->core->retry served-tier contract verified against retry.ts/engine.ts; all owner decisions encoded; no open items.**
**Owner signoff: COMPLETE (2026-06-30)**
**Claude signoff: APPROVE (2026-06-30) — execution handoff is detailed enough for subagents; three non-blocking tightening items applied.**

---

## Codex review round 1 — fix map

Changes applied in this revision in response to the Codex adversarial review. Each bullet maps a
must-fix to the section changed and cites the re-verified file:line anchor.

- **F3 — Served-tier recording is false in current code** (§ Change F3 Design, "Served tier
  recording" block): removed the false "records naturally" sentence; added explicit required
  code-change items at `engine.ts:1119` (pricing uses `resolvedConfig.serviceTier`, must use
  effective per-attempt tier), `engine.ts:1148` and `engine.ts:1211` (`buildSuccessRecord` /
  `buildErrorRecord` receive `resolvedConfig`), and `engine.ts:643` (`buildSuccessRecord` writes
  `resolvedConfig.serviceTier`). Added authoritative `servedServiceTier` field on `LlmResult`,
  `LlmCallRecord`, and drizzle column `served_service_tier`. _Re-verified:_ `engine.ts:643`
  (`serviceTier: resolvedConfig.serviceTier`) and `engine.ts:1119`
  (`pricing.price(…, resolvedConfig.serviceTier)`).

- **F3 — Trigger cannot be "503 only"** (§ Change F3 Design, "Fallback trigger" block): replaced
  the "intercepts on `httpStatus === 503`" text with a provider-specific `isGeminiCapacityError`
  predicate in `@gullabs/google` that fires on 503 always and on 429 only when the
  message indicates shared-capacity overload, not quota/billing exhaustion. Added explicit warning
  that blind 429 fallback turns quota exhaustion into more paid standard-tier traffic. Noted that
  this predicate is provider-specific and belongs in `@gullabs/google`, not core.

- **F3 — Middleware composition discussion removed** (§ Change F3 Design, superseded): the
  previous round's middleware composition example and discussion of `flexFallbackMiddleware`
  ordering has been removed entirely. The finalized design does NOT ship a
  `flexFallbackMiddleware` helper — fallback is provider-builtin (default ON, opt-out config).
  No middleware wiring is required by the caller, so no composition example is needed and no
  ordering hazard exists. References to `flexFallbackMiddleware` anywhere in the plan are stale
  and must not be re-introduced.

- **F3 — Standard timeout may be a no-op** (§ Change F3 Design, "Standard timeout" block): added
  requirement that `STANDARD_DEFAULT_TIMEOUT_MS` must be backed by a client-side `AbortController`
  belt-and-suspenders (same pattern as the existing flex path at `adapter.ts:479-499`), not
  `httpOptions.timeout` alone.

- **F1 — Adapter parse gate must include `outputJsonSchema`** (§ Change F1 Design, "Adapter
  changes required" block): corrected the false "no adapter change needed" claim; added required
  `structuredOutputRequested` shared gate covering `req.outputJsonSchema` for mime type, grounding
  guard, and JSON parse at `adapter.ts:645`.

- **F1 — Grounding conflict guard must reject `outputJsonSchema` too** (§ Change F1 Design,
  "Grounding conflict guard" block): updated `adapter.ts:447` condition to use
  `structuredOutputRequested` so both modes are rejected with grounding.

- **F2 — Idempotency promoted to Phase 1** (§ Change F2 Design, "`idempotencyKey`" block):
  replaced the deferred Phase-2 note with Phase 1 inclusion; explained that `externalId` does not
  dedup Temporal activity retries, only `idempotencyKey` (which becomes `attemptId`) does, using
  the PK conflict / `onConflictDoNothing` at `sink.ts:61`.

- **Line-claim corrections** (§ Already aligned and § Change F1/F2 Problem):
  - `LlmRequest.output` corrected to `types.ts:240` (was `types.ts:239-244`).
  - `LlmResult.callId/attemptId` corrected to `types.ts:393` / `:400`.
  - `architecture.md:511` / `client.ts:27` FLEX timeout discrepancy (900,000 vs 1,500,000 ms)
    preserved as a doc-fix item in the Documentation updates table.

## Owner decision round — fix map (2026-06-30)

Changes applied in this revision to encode the owner's final decisions. Backward-compat hedges
removed; greenfield clean design applied.

- **F1 — Remove Zod validate-in-lib entirely** (§ Change F1): rewrote the entire section.
  Removed two-mode discriminated union, `OutputSpec`, Zod `output.schema` path, engine validation
  block at `engine.ts:1093-1110`, `zodToGeminiSchema` for output at `adapter.ts:381-388`. Single
  `output?: { jsonSchema: JsonValue }` mode. `LlmRequest` and `LlmResult` lose generics. Both
  `generate()` and `runStructured()` kept — validation stripped from both. Added `callSiteId?:
string` to `LlmRequest` so generate() callers get observability grouping; generate() currently
  passes hardcoded `undefined` at `engine.ts:1345`. Noted Zod dependency drop opportunity.
  _Verified:_ `types.ts:240` (`output?: { schema: S }`); `engine.ts:1093-1110` (validation
  block to delete); `adapter.ts:381-388` (`zodToGeminiSchema` for output, to delete);
  `callsite.ts:52` (`schema?: S`, to replace with `jsonSchema?: JsonValue`).

- **F2 — `attemptId` as PK; drop `uuid id`** (§ Change F2): rewrote schema section. Removed
  `uuid('id').primaryKey()` at `schema.ts:14`; made `attemptId` the PK. Removed the now-redundant
  `uniqueIndex('llm_calls_attempt_id_idx')`. Added plain index on `callId`.
  _Verified:_ `schema.ts:14` (`id: uuid('id').primaryKey().defaultRandom()`); `engine.ts:967`
  (`const attemptId = ids.attemptId()` — the actual call site inside `runAttempt`; `DEFAULT_IDS`
  at lines 273-276 is the generator definition, not the call site); `retry.ts:239`
  (`let currentReq: ResolvedRequest = { ...req, attemptNumber: attempt }`).

- **F3 — Provider-builtin fallback; drop `flexFallbackMiddleware`** (§ Change F3): rewrote the
  fallback design. Removed middleware-composition discussion, `flexFallbackMiddleware` helper,
  ordering hazard notes, and naive-composition documentation test. Provider performs one-shot
  standard fallback internally (default ON, opt-out config). Kept `isGeminiCapacityError`,
  `servedServiceTier`, effective-tier fix, and `STANDARD_DEFAULT_TIMEOUT_MS` AbortController
  requirement.

- **Decision 7 — Fix retry threading (in-scope)** (§ Change F3 Decision 7): replaced the "out of
  scope" note with an in-scope fix requirement. `retry.ts:239` rebuilds retries from original
  request; fix threads the post-fallback effective tier forward. Added required tier-sequence test
  asserting flex(capacity-fail)→standard→[retry]→standard.
  _Verified:_ `retry.ts:239` (`currentReq = { ...req, attemptNumber: attempt }`).

- **Open questions → Owner decisions** (§ Owner decisions): converted section; all 7 recorded
  with final decisions; no remaining open items.

- **Summary, Non-goals, Status** updated: removed "additive/backwards-compatible" framing;
  noted greenfield zero-clients; added non-goals for no in-library output validation and no
  provider-call dedup.
