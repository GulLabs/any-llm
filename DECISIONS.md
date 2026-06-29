# Architecture Decision Records — any-llm

Each entry records a decision made during design or implementation, why it was made, and what it
costs. The canonical overview of what these decisions produced is in
[`docs/architecture.md`](./docs/architecture.md).

---

## ADR-001: Ports & Adapters (Hexagonal) Architecture

**Status:** Accepted

**Context:**
The library needs to support multiple LLM providers without coupling the core engine to any
provider SDK. Provider SDKs (`@google/genai`, `@anthropic-ai/sdk`, `openai`) have different
API shapes, authentication schemes, and versioning cadences. Embedding SDK calls directly in the
engine would make every cross-cutting concern (retry, cost, telemetry, validation) repeat or
diverge per provider.

**Decision:**
The core engine depends only on typed interfaces (`ports.ts`). Every pluggable dependency —
provider communication (`ProviderAdapter`), persistence (`UsageSink`), pricing (`PricingSource`),
credentials (`AuthProvider`), backpressure (`RateLimiter`), observability (`Telemetry`, `Logger`),
and time/identity sources (`Clock`, `IdGenerator`) — is expressed as a port. Concrete
implementations live in separate packages (`@gullabs/google`, `@gullabs/drizzle`, etc.) that the
engine never imports directly.

**Consequences:**
- The engine can be unit-tested with in-memory fakes without any network dependency.
- Adding a new provider requires only implementing `ProviderAdapter`; the rest of the pipeline
  (retry, cost, record, telemetry) comes for free.
- The seam between engine and provider is narrow and explicit: `ResolvedRequest` in, `AdapterResult`
  out. Adapters never validate output, compute cost, or persist anything.
- Host applications choose their own DB, logger, and telemetry client; the library brings none.

---

## ADR-002: Fail-Open Side Effects

**Status:** Accepted

**Context:**
The engine calls several side effects after the provider responds: persist a record to the sink,
compute cost via the pricing source, and emit telemetry events. Any of these can fail for reasons
unrelated to the LLM call (network partition to the sink DB, bug in a telemetry hook, pricing
snapshot missing a new model). If these failures propagate, callers lose the actual LLM result
even though the provider call succeeded.

**Decision:**
Sink writes (`UsageSink.record`), cost computation (`PricingSource.price`), and telemetry callbacks
(`Telemetry.onStart/onSuccess/onError`) are fail-open: errors are logged and swallowed. A broken
sink appends a `Warning` to the record and logs `llm.call.sink.failed`; it does not rethrow.

The rate-limiter (`RateLimiter.acquire`) is the deliberate exception: a rejection from `acquire`
propagates to the caller. The entire point of the rate-limiter port is to be able to delay or
refuse calls; swallowing its errors would make it inert.

**Consequences:**
- LLM call results always reach the caller even when observability infrastructure is degraded.
- Sink failures are visible in logs but not in the returned `LlmResult`. Callers that need
  guaranteed persistence must check the sink independently.
- The rate-limiter asymmetry is intentional and documented. Any new port that is meant to gate
  calls (not just observe them) must be treated fail-closed, not fail-open.

---

## ADR-003: Typed `LlmError` with Machine-Readable `retryable` and `retryAfterMs`

**Status:** Accepted

**Context:**
Provider SDKs throw a mix of typed error classes, plain objects with `status` fields, and
`AbortError` instances. Callers need to make programmatic decisions — retry vs surface to user,
respect a backoff hint — without parsing error message strings.

**Decision:**
Every throw from the engine or adapters is an `LlmError`. The class carries:
- `kind`: a closed union (`invalid_auth | rate_limited | server | timeout | aborted | bad_request |
  content_filter | parse_error | unknown`) that drives retry decisions and record status.
- `retryable`: a boolean derived deterministically from `kind`; callers and retry middleware read
  this flag rather than switching on `kind` themselves.
- `retryAfterMs`: populated from the provider's `Retry-After` header when a 429 carries one.

`classifyError` converts arbitrary thrown values (SDK error classes, plain objects with a `status`
field, `AbortError`, `TimeoutError`, strings) into `LlmError` with a single, testable code path.
Adapters call `classifyError` in their catch block and re-throw the result tagged with `provider`.

**Consequences:**
- The retry middleware reads `err.retryable` and `err.retryAfterMs` without any knowledge of
  provider-specific error shapes.
- The record's `errorKind` and `status` fields are derived from the same classification, keeping
  persisted data consistent with what callers observe.
- Adding a new error kind is a breaking change to the `LlmErrorKind` union, which is intentional:
  it forces consumers to handle the new case explicitly.

---

## ADR-004: GROSS Token Accounting Convention

**Status:** Accepted

**Context:**
LLM providers report token usage inconsistently. Anthropic's `input_tokens` excludes cache hits;
Gemini's `promptTokenCount` includes them. Thinking tokens are sometimes reported separately from
output tokens. Cost math that adds subsets to totals produces double-counting; math that subtracts
them produces under-counting when the subset is absent.

**Decision:**
The `Usage` type uses a GROSS convention throughout:
- `inputTokens` is the total billed input, **including** cached tokens.
- `outputTokens` is the total billed output, **including** thinking tokens.
- `cachedInputTokens` and `thinkingTokens` are subsets of their respective totals, not additive.

This is enforced at two points: the Gemini adapter explicitly computes
`outputTokens = candidatesTokenCount + thoughtsTokenCount` (not the provider's `totalTokenCount`),
and `sanitizeUsage` in `record.ts` clamps any subset that exceeds its parent to the parent value,
emitting a `Warning`.

**Consequences:**
- Cost math is: `(inputTokens - cachedInputTokens) × inputRate + cachedInputTokens × cachedRate +
  outputTokens × outputRate`. This formula is correct regardless of whether any subset is absent.
- Adapters for future providers must document how their raw fields map to GROSS fields.
- `Usage.raw` preserves the provider's original usage object verbatim so cost can be recalculated
  from scratch if the convention mapping is later found to be wrong.

---

## ADR-005: Pricing as a Pinned Snapshot with a Pluggable `PricingSource` Port

**Status:** Accepted

**Context:**
Pricing data changes when providers update their rate cards. Fetching pricing at call time couples
the library to provider pricing APIs and introduces latency. Embedding pricing in the engine as a
constant couples cost accuracy to library release cadence.

**Decision:**
Pricing is expressed as a `PricingSource` port with a `version` string and a `price()` method.
The library ships a built-in `geminiPricingSource()` that holds a dated, named snapshot
(`gemini-2026-06-27`). The snapshot version is frozen into every `Cost` record at write time so
historical records can identify which rate card was used.

Hosts can supply a custom `PricingSource` to override rates (e.g. committed-use discounts) without
forking the library. The `pricingFamily` field on `ModelDescriptor` allows model variants
(`gemini-2.5-pro-001`) to resolve to the base pricing entry (`gemini-2.5-pro`) without
enumerating every version string in the pricing table.

**Consequences:**
- Pricing snapshots go stale when providers update rates. The `pricingVersion` on each record
  makes it straightforward to identify records that need backfill when a snapshot is updated.
- `Cost.microUsd` is `null` when the model is not in the pricing table. The tokens are still
  recorded, enabling cost backfill once the model is priced. This is a deliberate trade-off:
  silence (a missing `cost` field) would make unpriced calls invisible.
- Separating the pricing snapshot from the adapter means price corrections never require an
  adapter release.

---

## ADR-006: `ModelDescriptor` Registry with Exact-ID and Longest-Prefix Resolution

**Status:** Accepted

**Context:**
A model string like `gemini-2.5-pro-001` must route to the `google` adapter, resolve to the
`gemini-2.5-pro` pricing entry, and inform the adapter which `thinkingConfig` API variant to use
(`thinkingBudget` for 2.5 series, `thinkingLevel` for 3.x series). Encoding this knowledge as
string-prefix heuristics in the engine or adapter scatters it and produces bugs when new model
strings arrive.

**Decision:**
`ModelDescriptor` centralizes all per-model metadata: `provider`, `pricingFamily`, and capability
flags (`reasoning`, `structuredOutput`, `reasoningApi`). The registry (`createModelRegistry`)
resolves a model string with exact-ID match first, then longest-prefix match. The `defaultGeminiRegistry`
pre-populates descriptors for all known Gemini models.

The engine attaches the resolved `ModelDescriptor` to `ResolvedRequest`, so adapters can branch on
`req.modelDescriptor?.capabilities?.reasoningApi` without re-deriving it from the model string.
Hosts supply a custom registry via `ClientConfig.modelRegistry` to add new models or override
provider mappings without a library release.

**Consequences:**
- Model-specific logic in the adapter is data-driven (a switch on `reasoningApi`) rather than
  string-matching (fragile against new version suffixes).
- An unknown model is still routable when only one adapter is configured; it falls back to that
  adapter with a missing descriptor. With multiple adapters, an unknown model throws
  `LlmError('bad_request')` at call time rather than silently routing wrong.
- The registry is immutable after construction. Hosts that need to add models at runtime must pass
  a pre-built custom registry to `createClient`.

---

## ADR-007: Opt-In Middleware Chain; Retry as First-Party Middleware

**Status:** Accepted

**Context:**
Cross-cutting behaviors like retry, circuit-breaking, and request logging need to wrap the
per-attempt call. Baking retry directly into the engine creates coupling between retry policy and
the call pipeline; it also makes it impossible to place non-retry middleware outside or inside
the retry loop.

**Decision:**
`ClientConfig.middleware` accepts an ordered list of `Middleware` objects. The engine folds them
right-to-left (outermost-first ordering) around `runAttempt`, producing a `Handler` chain. Each
middleware receives `(req, ctx, next)` and calls `next` zero or more times: zero short-circuits,
once is a passthrough, multiple times is retry.

`retryMiddleware` is shipped as a first-party implementation of this interface. It reads
`err.retryable` and `err.retryAfterMs`, applies exponential backoff with full jitter, and never
retries `kind === 'aborted'`. It is not registered by default; callers opt in explicitly:
`middleware: [retryMiddleware({ maxAttempts: 3 })]`.

Each invocation of `next()` (i.e., each attempt) generates a fresh `attemptId` and sinks exactly
one record. The `callId` is stable across all attempts of a logical call.

**Consequences:**
- Retry policy is configurable without patching the engine: `maxAttempts`, `baseDelayMs`,
  `maxDelayMs`, and a custom `shouldRetry` predicate are all overridable.
- The middleware contract is simple enough that hosts can implement circuit-breakers, request
  tracing, or provider-fallback as middleware without forking the library.
- Middleware `id` uniqueness is validated at `createClient` construction to catch misconfiguration
  early.
- The retry sleep is abortable: if the caller fires the abort signal during a backoff window, the
  sleep rejects immediately with `LlmError('aborted')`.

---

## ADR-008: Rate-Limiter Ownership — Provider Enforces, Library Survives, App Owns Policy

**Status:** Accepted

**Context:**
LLM providers enforce rate limits per model and per API key. The library needs to expose a hook
for pre-send backpressure without owning any distributed state (Redis, token bucket counters)
itself. A library-owned distributed rate limiter would couple the library to a specific
infrastructure dependency.

**Decision:**
The `RateLimiter` port exposes `acquire(key, signal): Promise<Release>`. The engine calls
`acquire("${provider}:${model}")` before every adapter invocation. The port is fail-closed (not
fail-open): a rejection from `acquire` propagates to the caller.

The key format encodes both provider and model because quotas are per-model. The `Release`
function, called on every exit path (success and error), signals the end of the rate-limited
window so slot-tracking implementations can free the slot.

The library ships a `NOOP_RATE_LIMITER` as the default. Distributed implementations (Upstash
token bucket, Redis sliding window) are external packages that implement the port. Applications
running inside Temporal use Temporal's own task-queue rate limiting; the engine's rate-limiter
port is a no-op in that context.

**Consequences:**
- No Redis, Upstash, or any other infrastructure dependency in the library itself.
- The app (or a companion package) owns rate-limit policy: per-key vs global, distributed vs
  in-process, token bucket vs sliding window.
- Concurrency-slot accuracy depends on adapters honoring `ctx.signal`: if an adapter ignores the
  abort signal, the `Release` fires before the underlying HTTP request finishes, and the slot
  count under-represents actual in-flight requests.

---

## ADR-009: Zod for v1 Structured Output Validation

**Status:** Accepted

**Context:**
Provider APIs return structured JSON output as raw strings or parsed objects. The library needs to
validate that raw output conforms to the caller-supplied schema before returning it. Multiple
schema libraries exist (Zod, Valibot, ArkType, Standard Schema); choosing one affects the public
API surface and dependency footprint.

**Decision:**
v1 uses Zod directly. `LlmRequest.output.schema` is typed as `ZodType`; the engine calls
`schema.safeParse(adapterResult.rawStructured)` and throws `LlmError('parse_error')` on failure.
`runStructured`'s return type is parameterized on `ZodType` and infers `_output` so callers get
typed results without casting.

The Gemini adapter uses `zodToGeminiSchema` to convert the Zod schema to a Gemini `responseSchema`
object at the API level; this instructs the model to return conformant JSON rather than relying
solely on prompt engineering.

**Consequences:**
- `zod` becomes a peer dependency that consumers must install. This is preferable to bundling Zod
  (which would duplicate it for hosts that already depend on Zod).
- The public surface is coupled to Zod's major version. Migrating to Standard Schema as the
  public contract type (for validator-agnosticism) is a non-breaking additive change planned
  for a future version, at which point `ZodType` would be accepted as a Standard Schema
  implementation rather than a first-class type parameter.
- `parse_error` is terminal: the library does not retry structured output validation failures.
  A model consistently returning non-conformant JSON is a prompt or schema problem, not a
  transient failure.

---

## ADR-010: Model-Bound, Schema-Described Config

**Status:** Accepted

**Context:**
Different Gemini model families have different acceptable generation parameters. Gemini 3.x models
fix sampling; passing `temperature`, `topP`, or `topK` to them causes a provider-side error
(`bad_request`). The error is confusing to surface at the SDK level. Meanwhile, host UIs and config
editors need a machine-readable description of which knobs a model accepts, so they can build form
fields without hard-coding per-model knowledge in application code.

**Decision:**
Each `ModelDescriptor` carries two optional schema fields:

- `configJsonSchema` — a plain JSON Schema object (typed as `JsonValue` so no schema library is
  required to consume it). Used for UX form generation.
- `validateConfig` — a hand-written Standard Schema v1 validator the engine runs before dispatch.

The engine validates a **projection** of the resolved config: generation knobs only
(`temperature`, `topP`, `topK`, `maxOutputTokens`, `stopSequences`, `reasoning`, `serviceTier`).
Execution-spine fields (`timeoutMs`, `providerOptions`) are excluded from the projection so
validation failures are about what the model can do, not how the engine calls it. A projection
with issues throws `LlmError('bad_request', retryable: false)` before auth or rate-limiter acquire.

`makeGeminiConfigSchema` and `makeGeminiConfigValidator` are factory functions parameterized by
`{ sampling: 'tunable' | 'fixed' }`. `'fixed'` produces a validator that rejects `temperature`,
`topP`, and `topK` with per-field issue paths; all issues are collected before returning so callers
see every violation at once.

**Rejected alternatives:**
- *Per-model TypeScript types* — would leak model-specific types into the public API surface and
  require callers to import and narrow types manually. Compile-time safety does not help when
  the model is a runtime string from a database.
- *One generic superset type* — a single config type that accepts all parameters for all models
  cannot express per-model constraints; the only enforcement would be at the provider, which
  produces an opaque error after auth and network roundtrip.

**Consequences:**
- Config validation fires before auth, rate-limiter, and adapter — the fastest possible rejection
  for a misconfigured call.
- The `configJsonSchema` field can be serialized to JSON and returned to clients as part of a
  model-capabilities API response; no schema library required on the client.
- Hosts that add custom model descriptors can supply their own validators by implementing the
  Standard Schema v1 interface.
- Extending the validated field set is non-breaking: new fields added to the projection simply
  become subject to validation for any descriptor that chooses to check them.

---

## ADR-011: Reference-Only Core for Stateful Resources; Optional Provider Helpers

**Status:** Accepted

**Context:**
Gemini's Files API and Context Cache API require stateful, long-lived client objects: upload a
file once, receive a `uri`; create a cached-content resource once, receive a `cacheName`; reuse
both across many requests. The core engine's call pipeline is stateless and per-attempt; it has
no ownership model for provider-hosted resources.

**Decision:**
The core engine and `@gullabs/core` types remain stateless and reference-only. `FileUriPart` and
the `providerOptions.google.cachedContent` field are reference types — they carry a URI or a
resource name, respectively. The engine passes them to the adapter verbatim; it has no upload or
cache lifecycle.

Stateful resource management lives in `@gullabs/google` as opt-in helper classes:
- `GoogleFileStore` — wraps the Gemini Files API. `upload(bytes, mimeType)` uploads and polls
  until `ACTIVE`, returning a `GoogleFileHandle` whose `uri` field can be used directly in a
  `FileUriPart`. `delete` / `deleteAll` are fail-open (errors go to `onDeleteError`, not rethrown).
  The SDK client is memoised per store instance (lazy, built at most once).
- `GoogleCacheStore` — wraps the Gemini Context Cache API. `getOrCreate(key, factory)` returns a
  live `GoogleCacheHandle`, creating one if the in-process map is empty or the entry has expired
  (with a configurable skew buffer). Reuse is **process-scoped** — the map lives in memory and
  does not survive restarts. `refreshIfExpiringSoon` extends the TTL fail-open. `delete` is
  fail-open. Optional `coalesce: true` serialises concurrent creates for the same key.

**Considered and rejected:** a generic `ResourceManager` port in `@gullabs/core` that the engine
would call to resolve URIs or inject cached content. Rejected for three reasons:
1. Upload-once-reuse-N means resource identity is process-scoped or database-backed — there is no
   single correct abstraction the library should own.
2. Entangling the engine with resource lifecycle would require a new port, new injection point in
   `ClientConfig`, and a new failure mode to classify; the per-call pipeline becomes more complex
   with no benefit to the common case.
3. Resources are not cross-provider: Gemini file URIs are useless to an Anthropic adapter. A
   shared port would be a fake abstraction that collapses to a no-op for every provider except
   the one that introduced it.

**Consequences:**
- Callers that do not need Files or Context Caching import neither class; the helpers are
  additional exports from `@gullabs/google`, not engine dependencies.
- The `GoogleFileHandle.uri` field maps directly to `FileUriPart.uri`; no conversion step needed.
- The `GoogleCacheHandle.cacheName` is passed as `providerOptions.google.cachedContent`; the
  Gemini adapter forwards it verbatim via the `providerOptions.google` merge.
- The helpers have injectable clients and clocks so tests run without network or real SDK.

---

## ADR-012: Flex Transport Timeout via Per-Request `httpOptions`

**Status:** Accepted

**Context:**
The `@google/genai` SDK defaults its HTTP transport timeout to ~60 seconds. Gemini Flex-tier calls
can legitimately run for up to 15 minutes. Without an explicit transport timeout, the SDK would
cancel a long Flex call before the engine's `AbortSignal`-based deadline fires. Additionally, when
callers set `timeoutMs`, the engine arms an `AbortSignal` at exactly that value. If the SDK
transport timer fired at the same millisecond, the raw SDK error would arrive instead of the
engine's clean `LlmError('timeout')`.

**Decision:**
The Gemini adapter sets `config.httpOptions.timeout` on every request according to this precedence
(highest first):

1. **Caller-supplied `providerOptions.google.httpOptions`** — wins unconditionally; caller values
   are spread over any computed value. This is the standard `providerOptions` escape-hatch.
2. **`timeoutMs` is set** — transport timeout = `timeoutMs + TRANSPORT_TIMEOUT_BUFFER_MS`
   (currently 5 000 ms). This ensures the engine's `AbortSignal` always fires before the SDK
   transport timer.
3. **`serviceTier === 'flex'`, no `timeoutMs`** — transport timeout = `FLEX_DEFAULT_TIMEOUT_MS`
   (currently 900 000 ms, 15 minutes). No buffer is applied because there is no engine `AbortSignal`
   deadline in this case.
4. **`serviceTier === 'standard'`, no `timeoutMs`** — no forced timeout; the SDK default applies.

The computed `httpOptions` is built from the computed base and then the caller's value is spread on
top, so extra keys in a caller-supplied `httpOptions` object are preserved alongside any fields the
adapter sets.

**Deliberately not built:** automatic Flex → Standard fallback when a Flex call times out. Such a
fallback is a disguised retry that crosses tier boundaries without the caller's awareness. Retry
and fallback logic belongs in the middleware chain where it is explicit and auditable.

**Consequences:**
- Long Flex calls complete without being killed by the SDK transport layer.
- When `timeoutMs` is set, the engine's `AbortSignal` is always the hard ceiling; the SDK transport
  timer cannot preempt it.
- `FLEX_DEFAULT_TIMEOUT_MS` and `TRANSPORT_TIMEOUT_BUFFER_MS` are exported constants so callers
  can reason about the values they're building on.
- Callers that need a different transport timeout set it via `providerOptions.google.httpOptions`
  and their value wins.

---

## ADR-013: Grounding via `providerOptions` Passthrough; Hard Guard Against Grounding + Schema

**Status:** Accepted

**Context:**
Google Search grounding is a Gemini capability that attaches live search results to the model's
response. It is requested by including `{ googleSearch: {} }` in the Gemini `tools` array.
Grounding is not a cross-provider concept and the library does not model it in `GenConfig`. A
first-class `grounding` field on `GenConfig` would need to be mapped — or noop-ed — for every
adapter, which is the wrong trade-off for a provider-specific feature. Grounding and structured
output (`responseSchema`) are mutually exclusive at the Gemini API level.

**Decision:**
Grounding is requested entirely via `providerOptions.google`:

```ts
config: {
  providerOptions: {
    google: { tools: [{ googleSearch: {} }] },
  },
}
```

The `providerOptions.google` object is merged into the Gemini `GenerateContentConfig` last
(after all typed-field mapping), so `tools` reaches the SDK verbatim.

The adapter inspects the merged config after the merge and enforces a hard guard: if
`tools` contains any entry with a `googleSearch` or `googleSearchRetrieval` key AND
`req.outputSchema` is set, the adapter throws `LlmError('bad_request', retryable: false)` with a
clear message. This catches the incompatibility at the library boundary rather than as a cryptic
provider error.

When grounding is active, the adapter captures `candidate.groundingMetadata` from the response
and includes it in `result.providerMetadata` alongside any `promptFeedback`. The host reads
grounding attribution from `result.providerMetadata['groundingMetadata']` as `JsonValue`; the
library does not model the grounding metadata structure as a typed field.

**Consequences:**
- Grounding support requires no new typed fields on `GenConfig` or `LlmRequest`; it uses the
  existing `providerOptions` passthrough.
- The `bad_request` guard surfaces the mutual-exclusion constraint at call time with a human-
  readable message, not as a provider API error.
- Grounding metadata is preserved in `result.providerMetadata` and persisted in the `LlmCallRecord`
  via the existing `providerMetadata` JSONB lane — no schema migration required.
- Adding first-class typed grounding support later is additive and non-breaking.

---

## ADR-014: `Cost.usd` as a Derived, Display-Only Convenience Field

**Status:** Accepted

**Context:**
`Cost.microUsd` is the canonical cost value — an integer count of micro-USD (1 USD = 1 000 000 µUSD)
computed at call time and frozen into every persisted record. Callers frequently need to display
cost in whole USD for UI labels and log lines. Dividing by `1_000_000` at every call site is
mechanical and error-prone (integer vs float rounding).

**Decision:**
`Cost.usd` is a computed field equal to `microUsd / 1_000_000` (or `null` when `microUsd` is
`null`). It is set alongside `microUsd` when `computeCost` builds the `Cost` object. It is
**display-only**: it is not persisted to the `LlmCallRecord`, and it should not be used for
financial calculations or aggregation. Micro-USD is canonical and is the only value written to the
sink.

**Consequences:**
- `result.cost?.usd` is available for immediate display without division at the call site.
- Aggregations (summing cost across records) must use `microUsd` from the persisted record to avoid
  floating-point accumulation error.
- The field is `null` when `microUsd` is `null` (unpriced model), consistent with the null
  semantics already documented on `Cost.microUsd`.
