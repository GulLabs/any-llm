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
content_filter | unknown`) that drives retry decisions and record status.
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
Provider APIs return structured JSON output as raw strings or parsed objects. The library should
forward provider-native JSON Schema hints without choosing the caller's validation library.

**Decision:**
v1 uses a forward-only JSON Schema hint. `LlmRequest.output.jsonSchema` is typed as `JsonValue`;
the Gemini adapter forwards it as `responseSchema` and JSON-parses the returned text when
structured output was requested. The engine returns `output: unknown` and `outputParsed`, and never
validates shape.

**Consequences:**

- The library has no runtime dependency on Zod or any other validation library.
- Callers own validation, retry, and acceptance policy for `output`.
- Malformed or empty structured output is a successful provider call with `outputParsed:false`.

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

- _Per-model TypeScript types_ — would leak model-specific types into the public API surface and
  require callers to import and narrow types manually. Compile-time safety does not help when
  the model is a runtime string from a database.
- _One generic superset type_ — a single config type that accepts all parameters for all models
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
can legitimately run for up to 25 minutes. Without an explicit transport timeout, the SDK would
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
   (currently 1 500 000 ms, 25 minutes). No buffer is applied because there is no engine `AbortSignal`
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

The `providerOptions.google` object is merged after typed-field mapping, so `tools` reaches the
SDK verbatim; transport/abort scaffolding (`abortSignal`, `httpOptions`) is applied afterward,
and caller-supplied `httpOptions` still wins.

The adapter inspects the merged config after the merge and enforces a hard guard: if
`tools` contains any entry with a `googleSearch` or `googleSearchRetrieval` key AND
`req.outputJsonSchema` is set, the adapter throws `LlmError('bad_request', retryable: false)` with a
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

---

## ADR-015: `timeoutMs` as Overall Wall-Clock Ceiling Across Retry Attempts

**Status:** Accepted

**Context:**
`GenConfig.timeoutMs` was originally documented and implemented as a per-attempt timeout: the
engine arms an `AbortSignal` at that value for each individual adapter invocation. With retry
middleware installed, a caller setting `timeoutMs: 30_000` expected a 30-second total budget for
the entire logical call (all attempts + back-off), but the actual behavior was 30 seconds _per
attempt_ — a 3-attempt retry could run for up to 90 seconds before surfacing an error. This is
confusing and makes `timeoutMs` unpredictable as a scheduling primitive in production.

**Decision:**
When the retry middleware is installed and `req.config.timeoutMs` is set, `retryMiddleware`
enforces it as an **overall wall-clock ceiling** for the logical call. Implementation:

1. `start = Date.now()` is captured once before the first attempt.
2. Before each attempt, `remaining = timeoutMs - (Date.now() - start)` is computed. If
   `remaining ≤ 0`, the middleware throws `LlmError('timeout', retryable: false)` without starting
   another attempt.
3. The shrinking remaining budget is passed as `attemptTimeoutMs` on the cloned request (an
   internal field on `ResolvedRequest` set by the retry middleware; the engine reads it to arm the
   per-attempt `AbortSignal`, leaving `config.timeoutMs` unchanged so the persisted audit record
   always reflects the caller's original value).
4. After a failed attempt, `remainingAfter` is recomputed. If `≤ 0`, the classified error from
   the attempt is rethrown immediately (no sleep; no next attempt).
5. Back-off sleep is clamped: `delayMs = Math.min(delayMs, remainingAfter)` so the sleep never
   overshoots the deadline.
6. When `timeoutMs` is **not** set (undefined), all deadline logic is skipped and behavior is
   identical to the pre-fix implementation (full backward compatibility).

The `retryMiddleware` opts object gains an optional `now?: () => number` injectable clock so the
deadline logic can be tested deterministically without real timers.

**Considered and rejected:** moving the deadline enforcement into the engine's `runPipeline`
function. Rejected because: (a) the retry loop lives in middleware, not in the engine; (b) the
engine already handles per-attempt timeouts via `buildCancellationRace`; (c) placing overall-budget
logic in the middleware keeps the engine pipeline simple and separates the two concerns cleanly.

**Consequences:**

- `timeoutMs` now means what callers expect: the total wall-clock budget for the logical call,
  not a per-attempt limit.
- Retry policies that previously relied on `timeoutMs` as a per-attempt limit must either increase
  the value or remove it. This is a behavior change (though not a type-level breaking change).
- `buildCancellationRace` in the engine continues to arm per-attempt `AbortSignal` at the
  _remaining_ budget, so each attempt's HTTP timeout also shrinks — the ceiling is respected at
  both the retry level and the transport level.

---

## ADR-016: Best-Effort Secret Redaction on Error Record Persistence

**Status:** Accepted

**Context:**
Provider SDKs sometimes include the raw request URL (which may contain an API key as a `key=`
query parameter or a signed-URL `X-Goog-Signature`) in their error messages. When these errors
are classified and persisted as `LlmCallRecord.errorMessage`, secrets from the transient error
message end up in the append-only audit log. This is a credential-hygiene risk: the log may be
readable by more operators than the running service, and secrets written to a database are harder
to rotate than secrets in memory.

**Decision:**
A `redactSecrets(text: string): string` utility is added to `@gullabs/core` and applied to
`errorMessage` at the single point where it is written into `LlmCallRecord` (inside `buildRecord`
in `record.ts`).

`redactSecrets` is a best-effort, regex-based scrubber. It covers the most common patterns:

- Google API keys (`AIza[0-9A-Za-z_\-]{20,}` → `AIza…REDACTED`)
- HTTP Bearer tokens (`Bearer\s+[A-Za-z0-9._\-]+` → `Bearer …REDACTED`)
- Sensitive URL query-parameter values for keys: `X-Goog-*`, `key`, `api_key`, `access_token`,
  `token`, `signature`, `sig` — value replaced with `REDACTED`.

The live `LlmError` thrown to the caller is **not** modified. Redaction is applied only to the
persisted copy. This preserves the full error context for the caller (who already has the secret)
while protecting the audit log from accidental exposure.

**Considered and rejected:**

- _Full DLP pipeline_: a proper DLP solution with content-type detection, entropy analysis, and
  provider-specific patterns would be more thorough but is a substantial dependency. The
  risk-vs-cost trade-off favors a simple regex scrubber for v1.
- _Redacting the live error_: callers may need the full error text for debugging (e.g. to see which
  URL failed). Redacting the thrown error would make operational debugging harder without
  meaningfully improving security (the caller already holds the secret).
- _Provider-adapter responsibility_: redaction in each adapter is fragile because adapters may not
  know which parts of SDK error messages contain secrets. Centralising in `buildRecord` ensures
  every error path — regardless of provider — goes through one redaction point.

**Consequences:**

- API keys and Bearer tokens that appear in provider error messages are scrubbed from persisted
  records; the audit log is safe to export to less-privileged storage.
- False negatives are possible: custom or future secret formats may not be caught. The JSDoc on
  `redactSecrets` makes this limitation explicit.
- False positives are unlikely given the specific patterns used, but `keyword=` or `sig=` in
  benign text would be redacted. This is acceptable for error text.
- `redactSecrets` is exported from `@gullabs/core` so host applications can apply it to their own
  log lines or error reporting integrations.

---

## ADR-017: Gemini 3.x Sampling Params Are Hard-Rejected (House Policy, Stricter Than Google)

**Status:** Accepted

**Context:**
Google's documentation for Gemini 3.x models _discourages_ the use of `temperature`, `topP`, and
`topK`, recommending `temperature=1.0` and noting that changing sampling parameters "may lead to
unexpected behavior." Google does **not** hard-reject these parameters at the API level — a
request with `temperature=0.7` on a Gemini 3.x model is accepted and processed.

**Decision:**
We deliberately choose to **hard-reject** `temperature`, `topP`, and `topK` on all Gemini 3.x
models in the registry validator (`makeGeminiConfigValidator({ sampling: 'fixed' })`). Additionally,
these fields are stripped with a warning from the `providerOptions.google` escape hatch before the
request reaches the adapter.

This is a **house-policy invariant** that is intentionally stricter than Google's advisory stance.
The `ModelDescriptor.capabilities.sampling` field encodes this as `'fixed'`, and the engine validates
the projection of `GenConfig` against the descriptor's validator before auth and rate-limiter acquire.

**Rationale:**
A single enforced sampling contract per model family is more valuable for our typed-config and UX
story than permitting a discouraged knob. The `configJsonSchema` (used for form generation) omits
these fields entirely for `fixed` models, ensuring UIs cannot expose them. Config validation fires
before any network or auth cost, so the rejection is immediate.

**Trade-off (conscious divergence from upstream):**
We will reject some requests that Google's API would accept. Host applications that have a
legitimate reason to pass non-default sampling to Gemini 3.x models cannot do so through this
library without adding a custom model descriptor with `sampling: 'tunable'`. This is an acceptable
cost: the constraint is explicit, documented, and localized to a single descriptor flag.

---

## ADR-018: Verified `@google/genai` SDK Bugs and Mitigations

**Status:** Accepted

**Context:**
Two confirmed bugs in the `@google/genai` SDK affect Gemini Flex-tier reliability and have been
verified against the SDK source and issue tracker.

**Bug #1277 — `config.httpOptions.timeout` may be a no-op for `generateContent`:**
The SDK's `httpOptions.timeout` field is documented as the transport-layer timeout, but due to a
bug in how the SDK wires the timeout into the underlying fetch/HTTP layer, the timeout may not be
enforced for `generateContent` requests. This means a Flex-tier call that stalls at the network
layer may hang indefinitely even with `httpOptions.timeout` set.

_Mitigation:_ The Gemini adapter (`@gullabs/google`) arms a client-side `AbortSignal` to enforce
the effective timeout. For Flex calls without an explicit `timeoutMs`, the signal is set at
`FLEX_DEFAULT_TIMEOUT_MS` (1 500 000 ms, 25 min). When `timeoutMs` is set, the remaining budget from the
retry middleware is the signal deadline. The `AbortSignal` is passed as `config.abortSignal` so the
SDK will honour it regardless of whether `httpOptions.timeout` fires.

**Bug #1468 — On Vertex, `serviceTier` in the request body is ignored for Flex:**
When targeting Vertex AI (as opposed to the Gemini Developer API), the `serviceTier: 'flex'`
field in the generation config body is silently ignored. Flex calls on Vertex are billed at the
standard tier rate without any indication that the tier selection was not honoured.

_Mitigation:_ On the Vertex flex path, the adapter injects two HTTP headers:

- `X-Vertex-AI-LLM-Request-Type: shared`
- `X-Vertex-AI-LLM-Shared-Request-Type: flex`

These headers are the correct Vertex-native mechanism for requesting Flex tier and are honoured
by the Vertex AI backend independently of the body field.

**Consequences:**

- Flex calls will time out correctly via `AbortSignal` even if the SDK's transport timeout is
  silently dropped.
- Vertex Flex calls are billed at the Flex rate when the headers are injected correctly. Hosts
  that bypass the adapter and call Vertex directly must inject these headers themselves.
- If Google fixes either bug, the mitigations remain harmless (belt-and-suspenders).

---

## ADR-019: Per-Call API Key Only; No Env/Ambient Auth, No AuthProvider Port

**Status:** Accepted

**Context:**
Early prototypes of the library included an `AuthProvider` port — a pluggable credential resolver
with implementations like `envAuth()` (reads `GEMINI_API_KEY` from `process.env`) and a
context-aware resolver that could select credentials based on request metadata. Client-level auth
was wired as `createClient({ auth: envAuth() })`.

This design shifted secret-source logic into the library: the engine's pipeline called
`auth.credentials(provider)` before each adapter invocation, so the library was in the business
of discovering and supplying credentials. That's a concern that belongs entirely in host
application code.

A secondary problem: Vertex AI auth used Google Application Default Credentials (ADC) — ambient
discovery from environment variables (`GOOGLE_APPLICATION_CREDENTIALS`), well-known credential
files, or the GCE metadata service. ADC is fundamentally an ambient-read pattern that cannot be
made explicit without a new credential shape.

**Decision:**
Remove the `AuthProvider` port, `envAuth()`, and all client-level auth. `AuthMaterial` is
narrowed to `{ apiKey: string }`. The caller passes `{ auth: { apiKey } }` on every `generate()`
and `runStructured()` call. `auth` is required; there is no default and no fallback.

Vertex AI auth is removed entirely for this version. It will return when an explicit, non-ADC
credential shape is designed (see ROADMAP.md).

A CI source-invariant test asserts:

1. No file under `packages/core/src` or `packages/google/src` reads `process.env`.
2. Neither `AuthProvider` nor `envAuth` appears in any package entrypoint export.

**Alternatives considered:**

- _AuthProvider port + context-aware resolver + per-call override_ — the original design. Rejected
  as over-engineering for v0: it added a port, an injection point in `ClientConfig`, three
  implementations, and a resolution step in the engine pipeline, all to solve a problem that host
  application code solves trivially in one line (`const auth = { apiKey: process.env.KEY! }`).
- _Client-level auth with per-call override_ — a single `createClient({ auth })` plus optional
  per-call override. Rejected because the "optional override" path is the only path callers
  actually need; the client-level default adds implicit state and makes the engine impure relative
  to its inputs.
- _Keep envAuth for convenience_ — rejected; convenience functions that read ambient env are the
  entire class of bug this decision eliminates. Documenting "don't use envAuth in prod" is weaker
  than not shipping envAuth.

**Consequences:**

- **Breaking.** All callers must pass `auth` on every call. There is no migration path that
  preserves the old client-level auth; callers must add `{ auth: { apiKey } }` to each call site.
- Vertex AI is not supported in this version. Callers targeting Vertex must wait for the roadmap
  item or implement their own adapter.
- The engine pipeline no longer has an `AuthProvider` step. `auth.apiKey` arrives with the call
  options and is forwarded directly to the adapter.
- The no-ambient-reads guarantee is enforced by CI, not by convention. Regressions are caught
  before merge.
- `AuthMaterial` is a narrower type than before; any host code that branched on `{ vertex: ... }`
  must be updated.

---

## ADR-020: Auth Extension Seams — Keep `AuthMaterial` Bare; Defer Discriminant and Translator Consolidation

**Status:** Accepted

**Context:**
Following ADR-019's removal of the `AuthProvider` port, a follow-up panel review (architect +
YAGNI reviewer + codex signoff) examined whether `AuthMaterial` should proactively grow a `kind`
discriminant and whether the three `GoogleGenAI` client-construction sites
(`buildGoogleClient` in `adapter.ts`, `buildCachesClient` in `cache-store.ts`,
`buildFilesClient` in `file-store.ts`) should be consolidated into a shared translator.

**Decision:**
Defer both changes. `AuthMaterial` stays as `{ apiKey: string }` with no `kind` field. The three
client-construction sites remain as independent leaf constructors.

**Rationale:**

1. **Single-kind discriminant is dead metadata.** With exactly one credential kind, a `kind`
   field carries no information and taxes every caller that must now type `{ kind: 'api-key',
apiKey: '...' }` instead of `{ apiKey: '...' }`. A discriminant earns its keep only when there
   are two or more kinds to discriminate between.

2. **Adding a kind later is a trivial, safe additive change.** When a second kind exists (e.g.
   Vertex service-account material or an OAuth bearer token), the migration is ~4 files and ~20
   lines: turn `AuthMaterial` into a discriminated union, update `requireAuth()` in `engine.ts`,
   and update the three `buildXxxClient` functions. TypeScript exhaustiveness checks will surface
   every narrowing site automatically; nothing can be silently missed.

3. **Translator consolidation buys nothing now.** The three client-construction sites are leaf
   constructors that differ only in which `GoogleGenAI` sub-API they wrap (`ai.models`,
   `ai.caches`, `ai.files`). Sharing a single translator would tie unrelated packages together
   and add a cross-package import for no practical benefit.

**The real future-design concern is not the `AuthMaterial` shape.** It is the long-lived
`GoogleCacheStore` and `GoogleFileStore` instances that capture auth at construction time and
memoize a single SDK client from it. For static API keys this is correct. For short-lived
refreshable credentials (OAuth/STS tokens) this memoized client would silently hold stale
credentials for the lifetime of the store. The primary design work when refreshable creds arrive
is these two stores, not the `AuthMaterial` type or the discriminant. Both stores are annotated
with this note (see `cache-store.ts` and `file-store.ts`).

**For the engine resolver:** when refreshable credentials are needed, widen `opts.auth` to
`AuthMaterial | ((ctx) => Promise<AuthMaterial>)` and resolve in `requireAuth()` once per logical
call. Policy questions deferred to that time: per-call vs. per-attempt resolution, mid-attempt
expiry handling, and resolver-failure classification. See the JSDoc on `requireAuth()` in
`engine.ts` for the full set of open questions.

**Consequences:**

- No code change from this ADR. All changes are documentation and comments.
- The three `buildXxxClient` sites and `requireAuth()` are marked as the exact update targets for
  the future second credential kind.
- Future contributors adding a credential kind should start from this ADR and the annotated
  seams rather than searching the codebase.

---

## ADR-021: Observability — Leveled Fail-Open Logging, Per-Attempt Records, and Consumer-Owned Metrics/OTel/Traceparent

**Status:** Accepted

**Context:**
As the engine gained retry middleware and per-attempt record persistence, the observability surface
expanded to cover: structured logging at four levels, telemetry hooks for APM integration, and
richer `LlmCallRecord` fields (notably `attemptNumber` for retry correlation). Several related
capabilities were proposed during design: a first-party OTel package, W3C `traceparent`
propagation, an in-library metrics runtime, and configurable secret-redaction patterns. A decision
was needed on which of these belong in the library and which belong in the host or in companion
packages.

**Decision:**
The library ships three observability primitives:

1. **Leveled `Logger` port** (`debug` / `info` / `warn` / `error`, object-first `(o, m)` signature
   compatible with pino/bunyan). A `makeSafeLogger` wrapper catches and swallows any exception
   thrown by the host logger so a misbehaving logger can never break or mask an LLM call result
   (fail-open).

2. **`Telemetry` port** (`onStart` / `onSuccess` / `onError`, all optional) for OTel / Sentry /
   PostHog integration. Events fire once per logical call; `onStart` may return an opaque span
   handle that is forwarded to the terminal hooks. Hook failures are swallowed fail-open and emit a
   `debug` breadcrumb (`llm.telemetry.hook.failed`).

3. **Per-attempt `LlmCallRecord`** with `callId` (stable across retries), `attemptId`
   (idempotency key), `attemptNumber` (1-based ordinal), `latencyMs`, token counts, `costMicroUsd`,
   `errorKind`, and verbatim `metadata`. Records are written via `UsageSink` (fail-open). Secret
   redaction (`redactSecrets`) is applied before persistence to `errorMessage`,
   `generationConfig.providerOptions`, and `generationConfig.httpOptions.headers`. Standard
   generation knobs and host-supplied `metadata` are not scanned.

The following are **explicitly deferred as consumer concerns**:

- First-party OTel package (the `Telemetry` port is the seam; publish an integration example).
- W3C `traceparent` propagation (hosts inject headers today via `providerOptions`).
- In-library metrics runtime, `/metrics` endpoint, cache-hit gauges (derive from records +
  `Telemetry`).
- Error sampling/dedup, persisted stack traces, typed provider-error schema.
- TTFB/streaming latency (requires `stream()` pipeline).
- Rate-limiter wait-time attribution, sink-side logical-call latency.
- Configurable custom-redaction-pattern API (deferred to the `Redactor` port; see ROADMAP).

**Rationale:**
This is a library, not a service. The library's job is to provide rich, accurate data (records and
events) and stable seams (ports). Owning a metrics runtime, an OTel SDK, or an HTTP `/metrics`
endpoint would impose infrastructure dependencies on every host and duplicate concerns the host
already solves. The `Telemetry` port is deliberately OTel-shaped (start/success/error with a span
handle) so a one-file wrapper is all a host needs to bridge it to any APM system.

**Consequences:**

- Host applications get structured log events and telemetry hooks without taking on any transitive
  infrastructure dependency from the library.
- `LlmCallRecord` fields are sufficient to derive dashboards, cost aggregations, retry rates, and
  error-kind breakdowns at the sink level.
- Hosts that need `traceparent` propagation pass it today via
  `providerOptions.google.httpOptions.headers` — no library change required.
- The `metadata` field is the caller's domain anchor (tenantId, runId, traceId, etc.) and is
  stored verbatim; it must not contain secrets.
- Items listed as deferred are tracked in ROADMAP.md under "Deferred observability."
