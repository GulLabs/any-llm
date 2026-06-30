# Architecture — any-llm (`@gullabs/core`)

This document is the canonical engineering overview of the library. For a record of individual
design decisions, see [`DECISIONS.md`](../DECISIONS.md). For deep supplementary design notes,
see [`DESIGN.md`](../DESIGN.md).

---

## 1. Problem and Goals

Every project that calls an LLM solves the same set of problems: authenticate to a provider,
send a request, normalize the response shape, validate structured output, compute cost, persist
an audit record, and handle failures consistently. Doing this ad hoc per project means duplicating
retry logic, creating inconsistent error handling, and accumulating billing blind spots.

This library provides a single call primitive that handles all of the above consistently across
providers. It is explicitly not a framework, not an agent loop, and not a gateway. It loads
in-process and owns exactly one thing: the contract and orchestration of a single LLM call.

Design constraints that drove the architecture:

- The library owns no database, no logger, no telemetry client, no pricing service. Host projects
  inject these.
- Provider SDKs (`@google/genai`, `@anthropic-ai/sdk`, `openai`) are peer dependencies and are
  never imported by the core engine.
- A broken observability dependency must not fail an LLM call (fail-open on side effects).
- A working result from the provider must always reach the caller.
- Adding a new provider adapter must not require changes to the engine.

---

## 2. Hexagonal Design — Ports and Adapters

The core engine sits at the center. Everything it touches is an interface defined in `ports.ts`.
Concrete implementations live outside the engine, in separate packages or in host applications.

### Ports

| Port              | Who implements                                        | Notes                                                                          |
| ----------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------ |
| `ProviderAdapter` | `@gullabs/google`, future provider packages           | Translates `ResolvedRequest` ↔ raw SDK. Never validates, costs, or persists.   |
| `UsageSink`       | Host app, `@gullabs/drizzle`                          | Receives completed `LlmCallRecord`. Called fail-open.                          |
| `PricingSource`   | `@gullabs/core` (built-in Gemini snapshot), or custom | Returns `Cost` for a model + usage. Called fail-open.                          |
| `AuthProvider`    | Host app                                              | Returns `AuthMaterial` (`{ apiKey }` or Vertex WIF) per provider at call time. |
| `RateLimiter`     | Host app or companion package                         | Pre-send backpressure. `acquire` is fail-closed. Default is a no-op.           |
| `Telemetry`       | Host app (Sentry / PostHog / OTel hook)               | Optional; all callbacks are optional. Called fail-open.                        |
| `Logger`          | Host app                                              | Structured logger (`info`, `warn`, `error`). Defaults to no-op.                |
| `Clock`           | `@gullabs/testing` (`FakeClock`) or default           | `Date.now()` abstraction for deterministic latency in tests.                   |
| `IdGenerator`     | `@gullabs/testing` (`FakeIds`) or default             | `crypto.randomUUID()` abstraction for deterministic records in tests.          |

### Component Diagram

```
  Host application
  ─────────────────────────────────────────────────────────────
  client.generate(LlmRequest)
  client.runStructured(CallSite, vars, opts)
         │
         ▼
  ┌────────────────────────────────────────────────────────┐
  │                  Core Engine                           │
  │  createClient(ClientConfig): Client                    │
  │                                                        │
  │  • Config resolution (deep-merge, serviceTier default) │
  │  • callId assignment + telemetry.onStart               │
  │  • Middleware chain composition (reduceRight)          │
  │  • Per-attempt: route → auth → acquire → adapter.run   │
  │    → normalizeUsage → safeParse → price → buildRecord  │
  │    → sink.record → LlmResult                           │
  │  • Epilogue: telemetry.onSuccess / onError             │
  └────┬──────┬───────┬──────┬──────┬──────┬──────┬───────┘
       │      │       │      │      │      │      │
  ProviderAdapter  UsageSink  PricingSource  AuthProvider
       │      │       │      │      │      │      │
  RateLimiter  Telemetry  Logger  Clock  IdGenerator
       │
       ▼
  @gullabs/google (geminiAdapter)
    └── @google/genai SDK
```

The engine never imports `@gullabs/google` or any provider SDK. The adapter packages import the
engine's port interfaces but nothing internal.

---

## 3. Request Pipeline

Both `generate()` and `runStructured()` execute the same pipeline. `runStructured` adds template
interpolation and config-layer merging before handing off to the shared core.

### Phase 1 — Prologue (once per logical call)

1. **Config resolution.** `generate`: merges `libDefaults → request.config`. `runStructured`:
   merges `libDefaults → callSite.config → opts.config`. Merge is deep for `reasoning` and
   `providerOptions` objects (per-key override without dropping siblings); last-write-wins for
   scalars and arrays. `serviceTier` defaults to `'flex'` when unset.

2. **Template rendering** (`runStructured` only). `{{var}}` placeholders in `system` and
   `userTemplate` are replaced in a single, non-recursive pass. Values are substituted verbatim
   (no re-scanning) to prevent template injection. Missing variables are left as the literal
   `{{var}}` placeholder so the absence is visible.

3. **callId assignment.** One UUID per logical call, stable across all retry attempts. Emitted
   in `llm.call.start` log and forwarded to `telemetry.onStart`.

4. **ModelDescriptor resolution.** The registry resolves the model string (exact-ID, then
   longest-prefix). The resolved descriptor is attached to `ResolvedRequest` for the adapter's
   use (`reasoningApi` variant, capability flags).

5. **Middleware chain construction.** `config.middleware` (outermost-first) is folded right-to-left
   around `runAttempt` using `reduceRight`. The resulting `Handler` is a single function that
   captures the full chain.

### Phase 2 — Middleware Chain (Chain-of-Responsibility)

Each `Middleware` receives `(req, ctx, next)` where `next` is the rest of the chain down to
`runAttempt`. Middleware calling `next` once is a passthrough; calling it multiple times
implements retry patterns.

`retryMiddleware` (first-party, opt-in) sits outermost. On a retryable error it computes a
backoff delay and calls `next` again. Each `next` call generates a fresh `attemptId` in the
sink — retries are visible as separate records sharing a `callId`.

### Phase 3 — Per-Attempt Handler (`runAttempt`)

Each invocation generates a fresh `attemptId`. Steps:

1. **Config validation.** When `req.modelDescriptor.validateConfig` is set, the engine runs the
   Standard Schema v1 validator against a projection of the resolved config (`temperature`, `topP`,
   `topK`, `maxOutputTokens`, `stopSequences`, `reasoning`, `serviceTier`). Failure throws
   `LlmError('bad_request', retryable: false)` before any network I/O.

2. **Route.** `routeFn(model, adapters)` selects the `ProviderAdapter`. With a single adapter,
   it is used unconditionally. With multiple adapters, the default router reads `adapter.id`
   against the derived provider (from registry, then slash convention). A custom `route` function
   can override entirely.

3. **Auth.** `auth.credentials(provider)` returns `AuthMaterial` — `{ apiKey }` or
   `{ vertex: { project, location } }`.

4. **Cancellation scaffolding.** Two independent `Promise<never>` rejection promises are built:
   one fires when the caller's `AbortSignal` fires, one fires after `timeoutMs`. The timeout
   promise rejects **before** calling `AbortController.abort()` on the combined signal — this
   ordering guarantees `kind: 'timeout'` wins the `Promise.race` even against a synchronously
   aborting adapter.

5. **Rate-limiter acquire.** `rateLimiter.acquire("${provider}:${model}", signal)` is raced
   against the cancellation promises. On rejection (caller abort, timeout, or limiter error),
   the call fails. On resolution, a `Release` function is returned; it is called on every exit
   path (success and error).

6. **Adapter invocation.** `adapter.run(resolvedReq, adapterCtx)` is raced against the
   cancellation promises. The adapter receives the merged abort signal (caller + timeout).

7. **Usage normalization.** `normalizeUsage(adapterResult.usage)` enforces the GROSS token
   convention: clamps `cachedInputTokens ≤ inputTokens` and `thinkingTokens ≤ outputTokens`;
   replaces non-finite numbers with `0`; emits `Warning` entries for each violation. This
   runs once; the same normalized `Usage` object is used for cost, the result, and the record.

8. **Structured output parsing.** When `req.outputJsonSchema` is set, the adapter JSON-parses
   provider text into `rawStructured` when possible. The engine returns `output` and
   `outputParsed`; it never validates shape. Callers own validation, retry, and acceptance policy.

9. **Cost computation.** `pricing.price(pricingKey, usage, serviceTier)` is called inside a
   try/catch. Failure appends an `'other'` warning and logs `llm.call.cost.failed`; the call
   succeeds without a `cost` field (fail-open).

10. **Record assembly.** `buildRecord` assembles an `LlmCallRecord` from all collected fields.
    This is a pure function with no I/O. Token hot fields (`inputTokens`, `outputTokens`, etc.)
    are promoted to typed columns; open maps (`tokenDetails`, `rawUsage`, `providerMetadata`,
    `warnings`, `generationConfig`) are stored as JSONB-compatible `JsonValue`.

11. **Sink write.** `sink.record(record)` is called inside a try/catch. Failure logs
    `llm.call.sink.failed` and is swallowed (fail-open). A record is written on both the success
    path and the error path (postmortem record with whatever usage was known).

12. **Return `LlmResult`.** The result carries `usage`, `cost` (including derived `cost.usd`),
    `text`, `output` (schema-validated), `reasoningText`, `latencyMs`, `warnings`,
    `providerMetadata`, and provider metadata fields.

### Phase 4 — Epilogue (once per logical call)

After the middleware chain settles (whether the first attempt succeeded or the retry middleware
exhausted), the engine fires `telemetry.onSuccess` or `telemetry.onError` (both fail-open) and
logs `llm.call.success` or `llm.call.error` with the total call latency. These fire exactly once
regardless of how many attempts the retry middleware made.

---

## 4. Error Model

All failures from `generate()` and `runStructured()` are `LlmError` instances. Callers can
narrow by `kind` or read `retryable` without parsing message strings.

### Error Kinds

| `kind`           | HTTP     | `retryable` | Description                                               |
| ---------------- | -------- | ----------- | --------------------------------------------------------- |
| `invalid_auth`   | 401, 403 | No          | Wrong or missing credentials.                             |
| `rate_limited`   | 429      | Yes         | Provider quota exceeded; `retryAfterMs` may be set.       |
| `server`         | 5xx      | Yes         | Transient provider error.                                 |
| `timeout`        | 408      | Yes         | Request exceeded `timeoutMs` or network timeout.          |
| `aborted`        | —        | No          | Caller cancelled via `AbortSignal`. Never retried.        |
| `bad_request`    | 400, 422 | No          | Malformed request; retrying without change will not help. |
| `content_filter` | —        | No          | Provider refused output for safety reasons.               |
| `unknown`        | other    | No          | Uncategorised; inspect `cause` for details.               |

### Classification

`classifyError(e: unknown): LlmError` is the single conversion point. Detection order:

1. Already an `LlmError` — returned as-is.
2. `Error.name === 'AbortError'` → `aborted`.
3. `Error.name === 'TimeoutError'` or message matches `/timeout|timed? out/i` → `timeout`.
4. Any object with a recognizable `status`, `code`, or `response.status` numeric property →
   routed through `classifyHttpStatus`, with `retryAfterMs` extracted from `Retry-After` /
   `x-ratelimit-reset` headers.
5. Anything else → `unknown`.

Adapters call `classifyError` in their catch block and re-throw the result tagged with `provider`.

---

## 5. Retry Design

`retryMiddleware` is a first-party `Middleware` implementation. Key properties:

**callId stability.** The `callId` is assigned before the middleware chain runs and is forwarded
through `EngineCtx` unchanged. Every attempt shares the same `callId`. Each attempt's `runAttempt`
invocation generates a fresh `attemptId`, so retry attempts appear as separate records in the sink
linked by `callId`.

**Backoff.** Two modes:

- `retryAfterMs` present on the error (from a 429): the sleep duration is
  `min(retryAfterMs, maxDelayMs)`.
- No hint: exponential backoff with full jitter —
  `rand() * min(maxDelayMs, baseDelayMs * 2^(attempt-1))`.

Full jitter (multiply by a uniform random in `[0, 1)`) is preferred over capped exponential
because it prevents retry storms when many callers fail simultaneously.

**Abort during sleep.** The backoff sleep (`abortableSleep`) races the timer against
`ctx.signal`. If the caller aborts during a backoff window, the sleep rejects immediately with
`LlmError('aborted')`.

**Terminal conditions.** `kind === 'aborted'` is always terminal — even a custom `shouldRetry`
returning true for `aborted` is overridden. Exhausting `maxAttempts` rethrows the last error.

**Per-attempt timeout.** Each call to `next()` (each attempt) builds its own independent
cancellation race with a fresh timeout window. The timeout clock resets between attempts; the
retry delay is not counted against the per-attempt timeout.

---

## 6. Multimodal Message Parts

`Message.parts` is an array of the `Part` discriminated union:

| `kind`           | Type              | Notes                                                                  |
| ---------------- | ----------------- | ---------------------------------------------------------------------- |
| `'text'`         | `TextPart`        | Plain text string.                                                     |
| `'inline-media'` | `InlineMediaPart` | Base64-encoded bytes; `mimeType` required. No `data:…;base64,` prefix. |
| `'file-uri'`     | `FileUriPart`     | Provider-hosted file reference; `uri` and `mimeType` required.         |

All three parts accept an optional `mediaResolution?: 'low' | 'medium' | 'high'` hint for
image/video detail level. The Gemini adapter maps this to `PartMediaResolutionLevel`
(`MEDIA_RESOLUTION_LOW` / `…_MEDIUM` / `…_HIGH`) and throws `LlmError('bad_request')`
when a model cannot honour the hint.

`isTextPart`, `isInlineMediaPart`, and `isFileUriPart` type guards are exported from
`@gullabs/core` for exhaustive narrowing.

The adapter maps `file-uri` parts to Gemini `fileData` parts (`{ fileUri, mimeType }`); no binary
payload is sent with the request — the provider dereferences the URI server-side.

---

## 7. Registry as Config Schema Layer

`ModelDescriptor` carries two optional schema fields in addition to capability flags:

- **`configJsonSchema`** — a plain JSON Schema object (typed as `JsonValue`). Clients can
  retrieve this to build form fields for a model's generation config without hard-coding per-model
  knowledge. No schema library required to consume it.
- **`validateConfig`** — a Standard Schema v1 validator. The engine runs this before auth and
  rate-limiter acquire, against a **projection** of the resolved config: `temperature`, `topP`,
  `topK`, `maxOutputTokens`, `stopSequences`, `reasoning`, `serviceTier`. Execution-spine fields
  (`timeoutMs`, `providerOptions`) are excluded from the projection.

When the validator returns issues, the engine throws `LlmError('bad_request', retryable: false)`
with all issue messages joined. The error fires before any network I/O.

For Gemini models, `makeGeminiConfigSchema` and `makeGeminiConfigValidator` factory functions
produce per-family schemas parameterized by `{ sampling: 'tunable' | 'fixed' }`. Gemini 3.x
models have `sampling: 'fixed'`; passing `temperature`, `topP`, or `topK` to them fails
validation with per-field paths before the request leaves the process.

---

## 8. Resource Helpers (Google)

The core engine is stateless and reference-only with respect to provider-hosted resources. Two
helper classes in `@gullabs/google` handle the stateful upload and cache lifecycle:

### `GoogleFileStore`

Wraps the Gemini Files API. Not part of the engine; not imported by `@gullabs/core`.

- `upload(source, mimeType, opts?)` — uploads bytes (`Uint8Array` or `Blob`) and polls until
  the file reaches `ACTIVE` state (default poll interval: 3 s; default timeout: 120 s). Returns a
  `GoogleFileHandle` with `name`, `uri`, `mimeType`, and optional `expiresAt`.
- The returned `handle.uri` maps directly to `FileUriPart.uri`; no conversion needed.
- `delete(handle)` and `deleteAll(handles)` are fail-open: errors go to an injectable
  `onDeleteError` callback and are not rethrown.
- The underlying SDK client is lazily constructed and memoised per store instance.
- Provider auto-deletes files approximately 48 hours after upload regardless of explicit deletion.

### `GoogleCacheStore`

Wraps the Gemini Context Cache API. Reuse is **process-scoped** — the in-memory handle map does
not survive restarts.

- `getOrCreate(key, factory)` — returns a live `GoogleCacheHandle`, creating one if the map
  is empty or the stored handle has expired (accounting for a configurable `expirySkewSeconds`
  buffer, default 30 s). Optional `coalesce: true` serialises concurrent creates for the same key.
- `refreshIfExpiringSoon(handle, opts?)` — extends the TTL if expiry is within
  `thresholdSeconds` (default 300). Fail-open: returns the original handle unchanged if the
  update call throws.
- `delete(handle)` — removes from the local map and deletes from the provider. Fail-open.
- `GoogleCacheHandle.cacheName` is passed to the adapter as
  `providerOptions.google.cachedContent`; the adapter forwards it verbatim via the
  `providerOptions.google` merge.

---

## 9. Registry and Model Routing

### `ModelDescriptor`

Each descriptor carries:

- `id` — the base model string (used as exact-match key and prefix).
- `provider` — matches the `ProviderAdapter.id` used for routing.
- `pricingFamily` — the key into the pricing table (e.g., `"gemini-2.5-pro"` for
  `"gemini-2.5-pro-001"`).
- `capabilities.reasoningApi` — `'budget'` (Gemini 2.5 series, `thinkingBudget`) or
  `'level'` (Gemini 3.x series, `thinkingLevel`).
- `capabilities.sampling` — `'tunable'` (Gemini 2.5 series) or `'fixed'` (Gemini 3.x series).
- `capabilities.caching` — `{ explicit: boolean; minTokens: number }`.
- `capabilities.grounding` — whether the model supports Google Search grounding.
- `capabilities.nativeStructuredOutput` — whether the adapter may send provider-native
  `responseMimeType` / `responseSchema` hints for `output.jsonSchema`.
- `capabilities.vision` / `capabilities.audioInput` — declarative multimodal support flags.
- `capabilities.serviceTiers` — provider service tiers safe to send to the SDK for this model.

### Resolution Order

`ModelRegistry.resolve(model)`:

1. Exact match on `descriptor.id` — O(1) hash lookup.
2. Longest-prefix match — linear scan; first candidate with `model.startsWith(id)` and longest
   `id` wins.
3. `undefined` — no descriptor found.

When `undefined`, the engine derives the provider by the `provider/model` slash convention, then
falls back to `'unknown'`. With a single adapter configured, routing succeeds regardless;
with multiple adapters, an unknown provider throws `LlmError('bad_request')`.

### Default Registry

`defaultGeminiRegistry` is pre-populated from `geminiModelDescriptors` and
`gemmaModelDescriptors` in `registry.ts`. It covers current Gemini 2.5/3.x model families plus
two API-verified Gemma 4 models: `gemma-4-31b-it` and `gemma-4-26b-a4b-it`. Hosts supply
`ClientConfig.modelRegistry` to extend or replace it.

---

## 10. Extensibility

### Adding a Provider Adapter

Implement `ProviderAdapter` from `@gullabs/core`:

```ts
import type {
  ProviderAdapter,
  ResolvedRequest,
  AdapterCtx,
  AdapterResult,
} from '@gullabs/core'
import { classifyError } from '@gullabs/core'

const myAdapter: ProviderAdapter = {
  id: 'myprovider',
  async run(req: ResolvedRequest, ctx: AdapterCtx): Promise<AdapterResult> {
    try {
      // Map req → SDK call. Forward ctx.signal, ctx.auth.
      // Return AdapterResult with usage, text, rawStructured, warnings.
    } catch (rawErr) {
      const classified = classifyError(rawErr)
      throw new LlmError(classified.message, {
        ...classified,
        provider: 'myprovider',
        cause: rawErr,
      })
    }
  },
}
```

Register model descriptors with a custom `ModelRegistry`:

```ts
import { createModelRegistry } from '@gullabs/core'

const registry = createModelRegistry([
  { id: 'my-model-v1', provider: 'myprovider', pricingFamily: 'my-model-v1' },
])

const client = createClient({ adapters: [myAdapter], modelRegistry: registry, ... })
```

### Adding a Sink

Implement `UsageSink`:

```ts
import type { UsageSink, LlmCallRecord } from '@gullabs/core'

const mySink: UsageSink = {
  async record(r: LlmCallRecord): Promise<void> {
    await db.insert(llmCalls).values({ ... }).onConflictDoNothing()
  },
}
```

`record` should be idempotent on `attemptId`. The engine guarantees exactly one `record` call per
attempt; the retry middleware may produce multiple attempts with different `attemptId`s for the
same `callId`.

### Adding Middleware

Implement `Middleware`:

```ts
import type { Middleware } from '@gullabs/core'

const tracingMiddleware: Middleware = {
  id: 'tracing',
  async intercept(req, ctx, next) {
    const span = tracer.startSpan('llm.call', { callId: ctx.callId })
    try {
      const result = await next(req, ctx)
      span.finish({ status: 'ok' })
      return result
    } catch (err) {
      span.finish({ status: 'error' })
      throw err
    }
  },
}

const client = createClient({ middleware: [tracingMiddleware, retryMiddleware()], ... })
```

Middleware IDs must be unique across the array. `createClient` throws `LlmError('bad_request')`
on duplicates.

---

## 11. Grounding and Transport Timeout (Gemini)

### Grounding

Google Search grounding is requested via `providerOptions.google`:

```ts
config: {
  providerOptions: {
    google: {
      tools: [{ googleSearch: {} }]
    }
  }
}
```

The `providerOptions.google` object is merged into `GenerateContentConfig` last, after all
typed-field mapping. After the merge the adapter checks whether any entry in `config.tools`
contains a `googleSearch` or `googleSearchRetrieval` key. If so and `req.outputJsonSchema` is also
set, the adapter throws `LlmError('bad_request', retryable: false)` — grounding and structured
output are mutually exclusive at the Gemini API level.

When grounding is active, `candidate.groundingMetadata` from the response is captured into
`result.providerMetadata['groundingMetadata']` as `JsonValue`. `promptFeedback`, when present, is
captured alongside it under `result.providerMetadata['promptFeedback']`. Both are persisted in the
`LlmCallRecord` via the existing `providerMetadata` JSONB lane.

### Transport Timeout

The `@google/genai` SDK defaults its HTTP transport timeout to ~60 seconds. The adapter sets
`config.httpOptions.timeout` on every request:

| Condition                                    | Transport timeout set                                  |
| -------------------------------------------- | ------------------------------------------------------ |
| `providerOptions.google.httpOptions` present | Caller value wins (spread over any computed value)     |
| `timeoutMs` is set                           | `timeoutMs + 5 000 ms` (`TRANSPORT_TIMEOUT_BUFFER_MS`) |
| `serviceTier === 'flex'`, no `timeoutMs`     | `FLEX_DEFAULT_TIMEOUT_MS` (900 000 ms)                 |
| `serviceTier === 'standard'`, no `timeoutMs` | No forced timeout; SDK default applies                 |

The 5 000 ms buffer ensures the engine's `AbortSignal` fires before the SDK transport timer so
the error is classified as `LlmError('timeout')` rather than a raw SDK error.
`FLEX_DEFAULT_TIMEOUT_MS` and `TRANSPORT_TIMEOUT_BUFFER_MS` are exported constants from
`@gullabs/google`.

---

## 12. Not in v1 / Deliberate Scope Boundaries

These capabilities have designed seams in the type system but are not implemented in v1. They are
not deferred because of time pressure; they are excluded because the one-call, Gemini-only
foundation needs to be solid before the surface expands.

**Streaming.** `generate` and `runStructured` return complete responses. The `Middleware` and
`ProviderAdapter` interfaces are designed to accommodate a future `stream()` path without a
breaking change to the engine.

**Additional providers.** The `ProviderAdapter` port and routing infrastructure are in place for
Anthropic, OpenAI, and others. v1 ships the Google adapter for Gemini and Gemma. Multi-adapter setups work today
with the custom `route` option; the default router handles the single-adapter case.

**Function calling / tool use.** `LlmRequest` does not yet carry a `tools` field. The `Part`
union's `kind` discriminant is reserved for future `tool-call` and `tool-result` variants.

**Provider-fallback middleware.** The middleware contract allows calling `next` with a modified
`ResolvedRequest` pointing to a different model. A fallback middleware (retry on `server` with
a different provider) is implementable today; no first-party implementation ships in v1.

**Distributed rate limiting.** The `RateLimiter` port is in place. v1 ships only a no-op default.
A companion package wrapping Upstash or Redis would satisfy the port without any engine changes.
