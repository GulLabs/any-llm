# any-llm — v1 Build Spec (the thing we implement)

> `DESIGN.md` is the explored north-star (multi-provider, streaming, tools, OSS contracts).
> **THIS** file is the lean, buildable contract for v1. When they disagree, SPEC wins for v1.
> Principle: **design the seams, build the slice.** We implement only the four goals below;
> the seams exist so future features drop in without a rewrite.

## v1 goals (the entire scope)

1. Call **Google-hosted models** through `@google/genai` (Gemini with Flex where supported; Gemma
   without Gemini-only Flex assumptions).
2. **Record token usage** (input / output / cached / **thinking**).
3. Capture **thinking** — thinking _token usage_ always; the provider-returned _thought-summary
   text_ when `reasoning.includeThoughts` is set — plus **postmortems** (per-call diagnostics on
   success and failure).
4. **Track cost** (public Gemini pricing → micro-USD, frozen per record).

Everything else from DESIGN.md is OUT of v1 (no other provider adapters, no streaming, no tools).
Seams are present; machinery is intentionally small.

## Non-negotiable invariants

- **Neither engine nor adapters validate output.** The engine forwards `output.jsonSchema` to the
  provider as a generation hint, JSON.parses the response, and surfaces `output: unknown` +
  `outputParsed: boolean`. The caller owns all validation, retry, and acceptance policy.
- **GROSS token convention:** `cachedInputTokens` is a SUBSET of `inputTokens`;
  `thinkingTokens` is a SUBSET of `outputTokens`. Cost math must not double-count.
- **Cost is frozen at write time:** integer micro-USD + `pricingVersion` on every record.
- **Side effects fail-open; the call fails-closed.** A broken sink/telemetry/cost never fails
  the LLM call; a broken call throws a typed `LlmError`.
- **No real network in tests.** The Gemini SDK is mocked; we stress the surface, not Google.

---

## Packages (pnpm workspace monorepo — the seam for optional deps)

```
packages/
  core/      @gullabs/core      # types, ports, engine, callsite, cost, errors, record  (no provider deps)
  google/    @gullabs/google    # GeminiAdapter over @google/genai  (peerDep @google/genai)
  drizzle/   @gullabs/drizzle   # reference llm_calls schema + drizzleUsageSink  (peerDep drizzle-orm)
  testing/   @gullabs/testing   # FakeClock, FakeIds, RecordingSink, fakeGemini, scenario fixtures
```

Tooling: TypeScript (strict, `exactOptionalPropertyTypes`), **vitest**, **tsup** (ESM+CJS+d.ts),
Node ≥20. Provider SDKs are **peerDependencies** (a host that only uses Gemini never pulls others).

> Naming note (decide before publish): "any-llm" collides with mozilla-ai/any-llm on npm; the
> `@gullabs/*` scope is a working placeholder. Not a blocker for local build.

---

## Core types (`@gullabs/core`)

```ts
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [k: string]: JsonValue }

// ---- request ----
export interface LlmRequest {
  model: string // routing key; v1 only resolves gemini-* (seam: provider map)
  system?: string
  messages: Message[] // v1: text parts only (seam: image/file/audio parts later)
  output?: { jsonSchema: JsonValue } // forward-only hint; adapter forwards it, engine never validates
  config?: GenConfig
  metadata?: CallMetadata // host anchors: tenantId, runId, callSiteId, traceId…
}
export type Message = { role: 'user' | 'assistant'; parts: TextPart[] }
export type TextPart = { kind: 'text'; text: string } // union kept open for future part kinds

// ---- config (typed common knobs + quarantined raw passthrough) ----
export interface GenConfig {
  temperature?: number
  topP?: number
  topK?: number
  maxOutputTokens?: number
  stopSequences?: string[]
  reasoning?: ReasoningIntent // best-effort intent; adapter maps + may warn (not a guarantee)
  serviceTier?: 'flex' | 'standard' // v1 default 'flex'
  timeoutMs?: number
  providerOptions?: Record<string, JsonValue> // forwarded verbatim to the raw SDK; logged when used
}
export interface ReasoningIntent {
  effort?: 'none' | 'low' | 'medium' | 'high' // gemini-2.5 → thinkingBudget; gemini-3 → thinkingLevel
  budgetTokens?: number
  includeThoughts?: boolean
}

// ---- result ----
export interface LlmResult {
  output?: unknown // present iff request had output.jsonSchema and JSON.parse succeeded; ALWAYS unknown, never validated
  outputParsed?: boolean // present iff output.jsonSchema was requested; true iff JSON.parse succeeded (NOT validated)
  text?: string
  reasoningText?: string // provider thought-summary, present iff includeThoughts requested
  usage: Usage
  cost?: Cost // null model-unpriced; tokens still captured
  model: string
  modelVersion?: string
  finishReason?: FinishReason
  responseId?: string
  servedServiceTier?: string // service tier actually served by the provider
  latencyMs: number
  queueDelayMs?: number // time spent waiting in RateLimiter.acquire before provider dispatch
  warnings: Warning[] // never silently drop a setting
  providerMetadata?: JsonValue // raw provider metadata (grounding/safety/etc.)
}
export type FinishReason = 'stop' | 'length' | 'content_filter' | 'other'
export type Warning = { type: 'other'; message: string }

// ---- usage: typed core + open map + raw (forward-compat without migration) ----
export interface Usage {
  inputTokens: number // GROSS (includes cached)
  outputTokens: number // GROSS (includes thinking)
  cachedInputTokens?: number // SUBSET of inputTokens
  thinkingTokens?: number // SUBSET of outputTokens
  totalTokens?: number
  details: Record<string, number> // open token-type map; new types land here, costable
  raw: JsonValue // provider's entire usage object, verbatim
}

// ---- cost: frozen, micro-USD, per-type breakdown ----
export interface Cost {
  microUsd: number | null
  pricingVersion: string
  confidence: 'exact' | 'estimated' // 'estimated' if any priced field had to be inferred
  details: { input: number; cached: number; output: number } // microUsd; MUST sum to microUsd.
  // NOTE: thinking tokens are inside outputTokens and billed at the output rate — NO separate
  // 'thinking' cost lane (that would break sum(details) === microUsd). thinkingTokens is usage-only.
}
```

### Errors (`errors.ts`)

```ts
export type LlmErrorKind =
  | 'invalid_auth'
  | 'rate_limited'
  | 'server'
  | 'timeout'
  | 'aborted'
  | 'bad_request'
  | 'content_filter'
  | 'unknown'
export class LlmError extends Error {
  kind: LlmErrorKind
  retryable: boolean
  httpStatus?: number
  retryAfterMs?: number
  provider?: string
  cause?: unknown
}
// adapters classify raw SDK errors → LlmError; engine surfaces it.
```

---

## Ports (`@gullabs/core` — host/companion implements)

```ts
export interface ProviderAdapter {
  id: string // 'google'
  // returns RAW result; engine JSON.parses it, computes cost, persists. Nobody validates it —
  // the caller owns validation.
  run(req: ResolvedRequest, ctx: AdapterCtx): Promise<AdapterResult>
}
export interface ResolvedRequest {
  // engine-built: defaults merged, prompts rendered
  model: string
  system?: string
  messages: Message[]
  outputJsonSchema?: JsonValue // adapter uses it to set provider responseSchema only
  config: Required<Pick<GenConfig, 'serviceTier'>> & GenConfig
  signal?: AbortSignal
}
export interface AdapterCtx {
  auth: AuthMaterial
  signal?: AbortSignal
  logger: Logger
}
export interface AdapterResult {
  rawStructured?: unknown // engine JSON.parses this into LlmResult.output (unknown); never validated
  servedServiceTier?: string // service tier actually served by the provider
  text?: string
  reasoningText?: string // thought summary if includeThoughts requested
  usage: Usage
  model: string
  modelVersion?: string
  finishReason?: FinishReason
  responseId?: string
  warnings: Warning[]
  providerMetadata?: JsonValue
}

export interface UsageSink {
  record(r: LlmCallRecord): Promise<void>
} // host writes to its own DB
export interface PricingSource {
  version: string
  price(model: string, usage: Usage, tier?: string): Cost
  hasModel(model: string): boolean
  listModels(): readonly string[]
}
export type AuthMaterial = { apiKey: string }
export interface Clock {
  now(): number
}
export interface IdGenerator {
  callId(): string
  attemptId(): string
}
export interface Logger {
  info(o: object, m: string): void
  warn(o: object, m: string): void
  error(o: object, m: string): void
}
export interface Telemetry {
  // optional; host wires Sentry/PostHog/OTel
  onStart?(e: object): unknown
  onSuccess?(e: object, span?: unknown): void
  onError?(e: object, span?: unknown): void
}
```

Seams deferred (designed, NOT in v1): `Redactor`, `BlobStore`, `ConfigSource`, `FileStore`,
streaming `stream()`. They can be added without changing the above.

---

## Engine pipeline (`engine.ts`) — written once

```
runStructured(callSite, vars?, opts?)  /  generate(request)
  1. resolve config   (lib defaults → call-site defaults → per-call opts; deep-merge; serviceTier='flex' default)
  2. render prompts   (non-recursive interpolation; var values are NOT re-interpolated — anti-injection)
  3. ids              callId + attemptId
  4. telemetry.onStart + log 'llm.call.start'
  5. resolve adapter  (model→provider map; v1: gemini-* → google adapter; unknown → LlmError 'bad_request')
  6. require per-call auth material ({ apiKey })
  7. rateLimiter.acquire("${provider}:${model}")  [queueDelayMs measured separately]
  8. adapter.run(resolved, ctx)   with timeout + AbortSignal
  9. normalize usage  (GROSS convention enforced; details map + raw populated by adapter)
 10. parse structured output  (JSON.parse result → output + outputParsed; caller validates)
 11. pricing.price()  → Cost (micro-USD, frozen)   [fail-open → cost absent on pricing error]
 12. build LlmCallRecord  + sink.record()           [fail-open: swallow+log sink errors]
 13. telemetry.onSuccess + log 'llm.call.success'
 14. return LlmResult
  (any throw → classify → telemetry.onError + log 'llm.call.error' + record status + rethrow LlmError)
```

Canonical log events (identical across hosts): `llm.call.start` / `.success` / `.error`.

### Config resolution & call sites (`callsite.ts`)

```ts
defineCallSite({ id, model, schema, system, userTemplate, config }) // model is a plain string (one-line swap)
// resolution: libDefaults → callSite.config → opts.config  (deep-merge; per-call wins)
// v1 keeps this runtime-validated (no compile-time ConfigFor<M> — that machinery was cut).
```

---

## Cost model (`cost.ts`) — Gemini, correct by construction

```
billableInput  = inputTokens - (cachedInputTokens ?? 0)      // GROSS→net
output+thinking = outputTokens                                // thinking already inside outputTokens
microUsd = round( billableInput   * inputRate(model, inputTokens)     // inputRate honors >200k tier
                + (cachedInputTokens ?? 0) * cachedRate(model)
                + outputTokens     * outputRate(model) )
details = { input, cached, output }   // thinking billed at output rate (folded into output)
```

- Pricing table is a frozen snapshot with a `pricingVersion` string (e.g. `gemini-2026-06-27`).
- Long-context tier: Gemini Pro charges a premium above 200k input tokens — `inputRate` selects by
  total `inputTokens`. (Flash-lite is flat; encode per-model.)
- Unknown model → `cost = { microUsd: null, … }`; tokens + raw still recorded for later backfill.
- v1 is **text-only**, so no per-modality input pricing is needed (the DESIGN regression is avoided).

---

## Persisted record (`record.ts`) + reference schema (`@gullabs/drizzle`)

```ts
export interface LlmCallRecord {
  recordSchemaVersion: 1
  callId: string
  attemptId: string
  attemptNumber: number // 1-based ordinal within the logical call (1 = first attempt, 2 = first retry, …)
  callSiteId?: string
  externalId?: string // caller-owned correlation id for host ledgers
  provider: string
  model: string
  modelVersion?: string
  responseId?: string
  serviceTier?: string
  servedServiceTier?: string // service tier actually served by the provider
  // status is a coarse outcome category: 'timeout' | 'aborted' | 'content_filter' map
  // 1:1 from LlmErrorKind, but 'invalid_auth' | 'rate_limited' | 'server' | 'bad_request'
  // | 'unknown' all collapse to 'api_error' here — the exact failure kind is preserved
  // separately in `errorKind` below, so postmortems don't lose it:
  status: 'ok' | 'api_error' | 'timeout' | 'aborted' | 'content_filter'
  finishReason?: FinishReason
  outputParsed?: boolean // whether JSON.parse succeeded for a structured-output request
  latencyMs: number
  queueDelayMs?: number
  // usage (typed hot fields)
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
  thinkingTokens?: number
  totalTokens?: number
  // cost (frozen)
  costMicroUsd?: number | null
  pricingVersion?: string
  // forward-compat lanes (jsonb)
  tokenDetails: JsonValue
  rawUsage: JsonValue
  providerMetadata?: JsonValue
  warnings?: JsonValue
  generationConfig: JsonValue // what we actually sent (transport keys stripped)
  // thinking capture (goal 3): summary text when includeThoughts was requested
  reasoningText?: string // truncated to a cap; null when not requested/returned
  // postmortem
  errorKind?: LlmErrorKind
  errorMessage?: string // truncated; diagnostics on failure
  metadata: JsonValue // host anchors
  createdAt: string // Clock-stamped
}
```

`@gullabs/drizzle` ships the matching `pgTable('llm_calls', …)` (typed columns + jsonb lanes) and
`drizzleUsageSink(db, table)`. Idempotency: insert `onConflictDoNothing` on `attemptId`.
Core imports no ORM; a host with a different store implements `UsageSink` directly.

---

## Google adapter (`@gullabs/google`)

- `geminiAdapter(): ProviderAdapter` over `@google/genai` (peerDep), API-key auth only (`{ apiKey }`
  passed per call; no Vertex support in v1 — see DESIGN.md).
- Maps: `serviceTier:'flex'` → Gemini Flex only when the model descriptor supports it; `reasoning`
  → `thinkingConfig` (budget for 2.5, level for 3.x); throws `LlmError('bad_request')` when the mapping cannot be applied;
  `output.jsonSchema` → `responseSchema` (`responseMimeType:'application/json'`) only when native
  structured output is enabled; `providerOptions.google.*` forwarded verbatim.
- Routes Gemini 2.5/3.x and two API-verified Gemma 4 models (`gemma-4-31b-it`,
  `gemma-4-26b-a4b-it`). Both Gemma 4 descriptors support multimodal parts, native structured
  output, grounding, and thinking (thinkingLevel). They do not support Gemini Flex or pricing.
- Usage: read `usageMetadata` → `promptTokenCount`→inputTokens, `candidatesTokenCount`→outputTokens,
  `cachedContentTokenCount`→cachedInputTokens, `thoughtsTokenCount`→thinkingTokens; copy whole object
  to `usage.raw`; populate `details`. Enforce GROSS convention.
- Errors: classify 401/403→invalid_auth, 429→rate_limited(+retryAfter), 5xx→server, timeout→timeout,
  400→bad_request, safety→content_filter.
- **Never executes tools, never loops, never persists.** Pure request⇄response mapping.

---

## Testing strategy (`@gullabs/testing` + per-package suites) — NO real Gemini calls

- **Fakes:** `FakeClock`, `FakeIds`, `RecordingSink` (captures records), `fakeGemini` (a stub
  `@google/genai` client returning scripted responses incl. usageMetadata with thoughtsTokenCount).
- **Unit:** cost math (GROSS/net, >200k tier, cached discount, unknown-model→null); error
  classification; config resolution/merge; usage normalization; record building; JSON parse→outputParsed.
- **The highest-risk test (codex-mandated, no network):** drive the engine with a fake adapter
  result of `inputTokens=250_000, cachedInputTokens=100_000, outputTokens=5_000, thinkingTokens=2_000`
  and assert in ONE test: gross/subset invariant preserved; `>200k` tier chosen on gross input;
  only 150_000 input billed at input rate; 100_000 at cached rate; 5_000 output billed once;
  thinkingTokens persisted but adds ZERO cost; `sum(cost.details)===cost.microUsd`; and the persisted
  record's cost === returned `LlmResult.cost` exactly.
- **Adapter contract tests:** drive `geminiAdapter` against `fakeGemini` scripted scenarios:
  flex tier set, thinking captured, structured output, each error kind, warnings emitted.
- **Engine integration (fakes):** end-to-end `generate()` → one record in `RecordingSink` with correct
  usage+cost+postmortem; success and every failure path.
- **Surface stress (no network):** property/fuzz the public surface — malformed usageMetadata, missing
  fields, huge token counts, cached>input (must clamp/warn not crash), timeouts/abort, schema mismatch,
  providerOptions passthrough, fail-open sink errors. Assert invariants hold and nothing throws except
  typed `LlmError`.
- Gate: typecheck + lint + vitest must pass; coverage on core ≥ the agreed bar.

---

## Build milestones (deliverables) — order validated by codex sign-off (testing pulled forward)

M0 scaffold · **M1** core types+errors+record · **M2** testing fakes (FakeClock/Ids/RecordingSink/
fakeGemini) · **M3** cost+pricing · **M4** engine+callsite · **M5** google adapter · **M6** drizzle
sink + surface-stress/fuzz · **M7** docs+example. Each code milestone: code + tests +
`/codex:adversarial-review` sign-off before the next.

### Codex sign-off (gpt-5.4, 2026-06-27) — addressed

Blocking issues fixed in this spec: (1) thinking _capture_ now explicit — usage always + thought
text when `includeThoughts` (`reasoningText` on result/adapter/record); (2) `Cost.details` is
`{input,cached,output}` and MUST sum to `microUsd` (thinking billed inside output, no separate lane);
(3) record `status` aligned to failure modes (+`content_filter`,`aborted`); (4) `responseId` persisted.
Pricing math verified against Google's live Gemini pricing page. Highest-risk bug to test:
double-counting cached/thinking tokens (see the explicit 250k/100k/5k/2k assertion in §Testing).
