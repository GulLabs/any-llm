# any-llm

[![CI](https://github.com/gullabs/any-llm/actions/workflows/ci.yml/badge.svg)](https://github.com/gullabs/any-llm/actions/workflows/ci.yml)

An in-process TypeScript library that standardises LLM calls with first-class observability. v1 delivers four things: **Gemini Flex** calls, **token usage capture** (input / output / cached / thinking), **thinking text capture** and per-call postmortems, and **micro-USD cost tracking** frozen into every persisted record. The design is a thin adapter over raw provider SDKs — no agent loop, no framework, no magic.

## Install

```bash
pnpm add @gullabs/any-llm
```

The default package includes the core engine, Gemini adapter, and `@google/genai`.
Use the modular packages only when you want explicit dependency control:

```bash
pnpm add @gullabs/core @gullabs/google @google/genai
# optional companions:
pnpm add @gullabs/drizzle    # Drizzle ORM sink for Postgres
pnpm add @gullabs/testing    # test fakes (dev only)
```

### Multi-provider (Gemini + xAI Grok)

Install each provider package and its peer SDK. Auth stays host-injected on every call (and on file stores).

```bash
pnpm add @gullabs/core @gullabs/google @gullabs/xai @google/genai openai
# peers: @google/genai for Gemini; openai ^6 || ^7 for xAI Responses (baseURL api.x.ai)
```

```ts
import { createClient, composeProviders } from '@gullabs/core'
import { googleProvider, GoogleFileStore } from '@gullabs/google'
import { xaiProvider, XaiFileStore } from '@gullabs/xai'

const client = createClient({
  ...composeProviders([googleProvider(), xaiProvider()]),
})

// Generate — explicit provider + model; pass auth every call
await client.generate(
  { provider: 'xai', model: 'grok-4.6', messages: [...] },
  { auth: { apiKey: xaiKey } },
)

// Files are outside generate — construct stores with the same host auth
const xaiFiles = new XaiFileStore({ auth: { apiKey: xaiKey } })
const geminiFiles = new GoogleFileStore({ auth: { apiKey: geminiKey } })
```

See [`packages/xai/README.md`](./packages/xai/README.md) for `XaiFileStore` / `FileRefPart` and fail-closed delete; [`packages/testing`](./packages/testing/README.md) for `FakeXaiFileStore` / `makeFakeXai`.

## Quickstart

The four v1 goals in ~25 lines:

```ts
import {
  createClient,
  composeProviders,
  defineCallSite,
  googleProvider,
} from '@gullabs/any-llm'

// 1. Wire up the client — no auth here; the library never reads credentials
const client = createClient({
  ...composeProviders([googleProvider()]),
})

// 2. Define a reusable call site with a structured output schema
const codeReview = defineCallSite({
  id: 'code-review',
  provider: 'google',
  model: 'gemini-2.5-flash',
  jsonSchema: {
    type: 'object',
    properties: {
      rating: { type: 'number' },
      summary: { type: 'string' },
    },
    required: ['rating', 'summary'],
  },
  system: 'You are a senior code reviewer.',
  userTemplate: 'Review this diff:\n\n{{diff}}',
  config: {
    reasoning: { includeThoughts: true, effort: 'medium' },
    serviceTier: 'flex',
  },
})

// 3. Your application owns the key — bring it from wherever makes sense
const auth = { apiKey: process.env.MY_APP_GEMINI_KEY! }

// 4. Run it — pass auth on every call
const result = await client.runStructured(codeReview, { diff: myDiff }, { auth })

// All four goals satisfied:
console.log(result.output) // JSON-parsed unknown; caller validates
console.log(result.outputParsed) // true when JSON.parse succeeded
console.log(result.usage) // { inputTokens, outputTokens, cachedInputTokens, thinkingTokens }
console.log(result.cost?.microUsd) // integer micro-USD, frozen at call time
console.log(result.reasoningText) // thought summary from the model
```

To persist records to Postgres, install `@gullabs/drizzle` and pass
`sink: drizzleUsageSink(db, llmCalls)` when creating the client.

See [`examples/basic.ts`](./examples/basic.ts) for a **fully runnable** version (no network required — uses test fakes). Run it with `pnpm example`.

## Auth

The library never reads credentials from the environment or any ambient source. There is no `envAuth()`,
no `AuthProvider` port, and no client-level `auth` on `createClient`. The caller passes `auth` on
every call:

```ts
client.generate(request, { auth: { apiKey } })
client.runStructured(callSite, { auth: { apiKey } }) // no template vars
client.runStructured(callSite, { ...vars }, { auth: { apiKey } }) // with template vars
```

`auth` is required. `AuthMaterial` is `{ apiKey: string, keyId?: string }`. Where the key comes from
is entirely your concern — read it from an environment variable, a secret vault, a database, or
per-user input. `keyId` is an optional opaque label (e.g. `'gemini-paid'`) for per-key attribution:
it is persisted verbatim to `LlmCallRecord.authKeyId`, never redacted, and must never be the secret
itself (see ADR-026).

```ts
// For an 18-call loop, build auth once and pass it each time:
const auth = { apiKey: process.env.MY_APP_GEMINI_KEY! }
for (const item of items) {
  results.push(await client.runStructured(callSite, { item }, { auth }))
}
```

The key is redacted from any persisted records or logs.

Vertex AI: see [Roadmap](./ROADMAP.md).

## Strict model config

Strict model config is descriptor-owned. The runtime boundary is
`descriptor.configSchema`, and the UI/form boundary is
`descriptor.configJsonSchema` derived from that same schema.

```ts
import { defaultGeminiRegistry } from '@gullabs/google'

const descriptor = defaultGeminiRegistry.resolve('google', 'gemini-3.5-flash')
if (!descriptor) throw new Error('unknown model')

// 1. Build forms from the descriptor's derived JSON Schema.
const formSchema = descriptor.configJsonSchema

// 2. Parse persisted config through the exact runtime schema before dispatch.
const parsedConfig = descriptor.configSchema.parse({
  reasoning: { effort: 'medium', includeThoughts: true },
  serviceTier: 'flex',
})

await client.generate(
  {
    provider: descriptor.provider,
    model: descriptor.model,
    messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Summarize this PR.' }] }],
    config: parsedConfig,
  },
  { auth },
)
```

Use this boundary consistently:

- `reasoning.budgetTokens` is a Gemini 2.5 budget-API setting. Gemini 3 and
  Gemma built-ins should use `reasoning.effort`.
- `gemini-3.1-pro-preview` does not admit `effort: 'none'`; remove that value
  instead of expecting the library to repair it.
- Omit `serviceTier` to use provider-default request behavior. Opt into `flex`
  explicitly.
- Google documents `priority`, but the library still rejects it until pricing,
  served-tier recording, and tests exist for that lane.
- `LlmRequest.output.jsonSchema` is an output-format hint. It is not the same
  contract as `descriptor.configJsonSchema`.

## Input contracts

Symmetric to output validation, the library also validates request _inputs_ before
dispatch. Template placeholders (`{{var}}` in `system`/`userTemplate`) are strict by
default — an unresolved, `null`, or non-string value throws `bad_request` before any
request is built. Two opt-in `StandardSchemaV1` contracts add business-field validation:
`callSite.inputSchema` (`runStructured`) and `request.inputContract` (`generate()`).
`createClient({ requireInputContract: true })` makes either contract mandatory
fleet-wide. See ADR-025 in `DECISIONS.md` and the `@gullabs/any-llm` skill doc for the
full contract, including ledger semantics for refused calls.

## Architecture

Every call — whether `generate()` or `runStructured()` — goes through the pipeline below. Model-config validation (`validateModelConfig`) runs pre-dispatch inside `runAttempt`, before routing or auth:

```
generate() / runStructured()
  → resolveConfig()               [libDefaults → callSite → opts; deep-merge]
  → validateModelConfig()         [Standard Schema pre-dispatch check; terminal on failure]
  → route(provider, model, adapters) → ProviderAdapter
  → opts.auth                     → AuthMaterial  [required per-call; never read from env]
  → rateLimiter.acquire("provider:model")    [pre-send pacing; propagates on reject]
  → adapter.run(resolved, ctx)    ← provider SDK (anti-corruption layer)
  → normalizeUsage()              [enforce GROSS token convention]
  → JSON.parse structured output      [sets outputParsed; caller validates]
  → pricing.price()               [micro-USD cost; fail-open]
  → buildRecord() → sink.record() [persist call record; fail-open]
  → LlmResult
```

The design is **Ports & Adapters (hexagonal)**: the core engine depends only on port interfaces (`ProviderAdapter`, `UsageSink`, `PricingSource`, `RateLimiter`). All concrete implementations live in separate packages — the engine never imports a provider SDK. Side effects (`sink.record`, `pricing.price`, `telemetry`) are **fail-open**: a broken sink cannot fail an LLM call. The rate-limiter is the one deliberate exception — `acquire` rejection propagates so backpressure is actually enforced.

## Packages

| Package                                  | Description                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@gullabs/any-llm`](./packages/any-llm) | Default batteries-included package: re-exports core + Gemini adapter and installs `@google/genai` for one-package setup.                                                                                                                                                                                                                                            |
| [`@gullabs/core`](./packages/core)       | Types, ports, engine (`createClient`, `generate`, `runStructured`), cost computation, record builder. No provider dependencies.                                                                                                                                                                                                                                     |
| [`@gullabs/google`](./packages/google)   | Google adapter over `@google/genai`. Maps Gemini Flex tier, thinking config, multimodal parts, structured output, Gemma 4 routing, and error classification. Ships `isGeminiCapacityError` (Flex capacity-error detection) and `normalizeGroundingCitations`. Optional `GoogleFileStore` and `GoogleCacheStore` helpers for Gemini Files API and Context Cache API. |
| [`@gullabs/xai`](./packages/xai)         | xAI Grok adapter over the `openai` SDK's Responses API. `grok-4.5` / `grok-4.6` with level-effort reasoning (`xhigh` + `serviceTier: 'priority'` on 4.6), native structured output (`text.format`), vision, and automatic caching (`promptCacheKey`).                                                                                                               |
| [`@gullabs/drizzle`](./packages/drizzle) | Reference Postgres schema (`llm_calls` table) and `drizzleUsageSink` — a `UsageSink` port implementation for Drizzle ORM.                                                                                                                                                                                                                                           |
| [`@gullabs/testing`](./packages/testing) | Test fakes: `FakeClock`, `FakeIds`, `RecordingSink`, `FakeAdapter`, `makeFakeGemini`, `fakeGeminiResponse`. No network in tests.                                                                                                                                                                                                                                    |

## Multimodal parts

`Message.parts` accepts a mix of `TextPart`, `InlineMediaPart`, and `FileUriPart`:

```ts
// Inline image (base64, no data: prefix)
const result = await client.generate(
  {
    provider: 'google',
    model: 'gemini-2.5-flash',
    messages: [
      {
        role: 'user',
        parts: [
          { kind: 'text', text: 'What is in this image?' },
          {
            kind: 'inline-media',
            mimeType: 'image/png',
            data: Buffer.from(pngBytes).toString('base64'),
            mediaResolution: 'high', // optional; adapter maps to PartMediaResolutionLevel
          },
        ],
      },
    ],
  },
  { auth: { apiKey: process.env.GEMINI_API_KEY! } },
)

// File already uploaded to Gemini Files API
const result2 = await client.generate(
  {
    provider: 'google',
    model: 'gemini-2.5-flash',
    messages: [
      {
        role: 'user',
        parts: [
          { kind: 'text', text: 'Summarise this video.' },
          {
            kind: 'file-uri',
            uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc123',
            mimeType: 'video/mp4',
          },
        ],
      },
    ],
  },
  { auth: { apiKey: process.env.GEMINI_API_KEY! } },
)
```

Gemma 4 models use the same message shape. Built-in routing covers two
API-verified Gemma 4 models: `gemma-4-31b-it` and `gemma-4-26b-a4b-it`:

```ts
const qa = await client.generate(
  {
    provider: 'google',
    model: 'gemma-4-26b-a4b-it',
    messages: [
      {
        role: 'user',
        parts: [
          {
            kind: 'text',
            text: 'Does this rendered page pass visual QA?',
          },
          {
            kind: 'inline-media',
            mimeType: 'image/png',
            data: Buffer.from(screenshotPng).toString('base64'),
            mediaResolution: 'high',
          },
        ],
      },
    ],
    output: {
      jsonSchema: {
        type: 'object',
        properties: {
          pass: { type: 'boolean' },
          notes: { type: 'string' },
        },
        required: ['pass', 'notes'],
      },
    },
  },
  { auth: { apiKey: process.env.GEMINI_API_KEY! } },
)
```

Both Gemma 4 models support native structured output (`responseMimeType` +
`responseSchema`), grounding (`tools:[{googleSearch:{}}]`), vision input, and
thinking via `thinkingLevel`. They remain intentionally unpriced, and the
strict contract does not admit any `serviceTier` for them until Google provides
matching public evidence or fresh live verification.

Gemma 4 thinking is binary: use `reasoning: { effort: 'none' }` (MINIMAL, thinking off)
or `{ effort: 'high' }` (HIGH, thinking on). Passing `effort: 'low'` or `effort: 'medium'`
is rejected with a `bad_request` error because the model only accepts MINIMAL and HIGH
`thinkingLevel` values.

## Files API (`GoogleFileStore`)

Upload bytes once, reuse the URI across many calls. The provider auto-deletes files after ~48 h.

```ts
import { GoogleFileStore } from '@gullabs/google'

const auth = { apiKey: process.env.GEMINI_API_KEY! }
const store = new GoogleFileStore({ auth })

// Upload and wait for ACTIVE (polls until ready, default timeout 120 s)
const handle = await store.upload(pdfBytes, 'application/pdf', {
  displayName: 'report.pdf',
})

// handle.uri → FileUriPart.uri
const result = await client.generate(
  {
    provider: 'google',
    model: 'gemini-2.5-pro',
    messages: [
      {
        role: 'user',
        parts: [
          { kind: 'text', text: 'Extract the key figures from this document.' },
          { kind: 'file-uri', uri: handle.uri, mimeType: 'application/pdf' },
        ],
      },
    ],
  },
  { auth },
)

// Delete when done (fail-open — errors go to onDeleteError, not rethrown)
await store.delete(handle)
```

## Context caching (`GoogleCacheStore`)

```ts
import { GoogleCacheStore } from '@gullabs/google'

const auth = { apiKey: process.env.GEMINI_API_KEY! }
const cacheStore = new GoogleCacheStore({ auth })

// getOrCreate returns a live handle; creates at most once per process lifetime
const cacheHandle = await cacheStore.getOrCreate(
  { model: 'gemini-2.5-pro', stableKey: 'system-docs-v3' },
  async () => ({
    ttlSeconds: 3600,
    contents: [/* large content to cache */],
    systemInstruction: 'You are a helpful assistant with access to the following docs.',
  }),
)

// Pass the cache name through the allowlisted Google provider-options lane
const result = await client.generate(
  {
    provider: 'google',
    model: 'gemini-2.5-pro',
    messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Summarise section 3.' }] }],
    config: {
      providerOptions: {
        google: { cachedContent: cacheHandle.cacheName },
      },
    },
  },
  { auth },
)

// Extend the TTL if it is expiring within 5 minutes (default threshold)
const refreshed = await cacheStore.refreshIfExpiringSoon(cacheHandle)
```

## Flex long-timeout calls

Flex-tier calls can run for up to 25 minutes. Flex is now explicit: if you omit
`serviceTier`, the provider uses standard. Set `serviceTier: 'flex'` only for
the calls that should actually take the Flex latency/cost trade-off.

When a Flex call has no explicit `timeoutMs`, the adapter sets
`httpOptions.timeout` to `FLEX_DEFAULT_TIMEOUT_MS` (1 500 000 ms)
automatically. To set an explicit per-call deadline on top of that:

```ts
const result = await client.generate(
  {
    provider: 'google',
    model: 'gemini-2.5-pro',
    messages: [
      {
        role: 'user',
        parts: [{ kind: 'text', text: 'Write a very long essay.' }],
      },
    ],
    config: {
      serviceTier: 'flex',
      timeoutMs: 600_000, // 10 min engine deadline; SDK transport timeout = 605 000 ms
    },
  },
  { auth: { apiKey: process.env.GEMINI_API_KEY! } },
)
```

**Verified field syntax for Flex:** set `serviceTier: 'flex'` in `config`, and
set `timeoutMs` in ms in `config` for the engine deadline. The adapter
automatically sets `httpOptions.timeout` to `timeoutMs + 5 000 ms` as a
transport-layer buffer. If `serviceTier` is omitted, requests stay on provider
standard. `priority` remains rejected even though Google documents it, because
the library has not shipped the schema, pricing, served-tier recording, and
test coverage needed for that contract.

If a Flex call fails with a shared-capacity error (as opposed to quota/billing exhaustion),
`isGeminiCapacityError(error)` (exported from `@gullabs/google`) tells you whether it is safe to
retry the same request on the `standard` tier:

```ts
import { isGeminiCapacityError } from '@gullabs/google'
import { LlmError } from '@gullabs/core'

try {
  return await client.generate(request, { auth })
} catch (e) {
  if (e instanceof LlmError && isGeminiCapacityError(e)) {
    return await client.generate(
      { ...request, config: { ...request.config, serviceTier: 'standard' } },
      { auth },
    )
  }
  throw e
}
```

## Cost

`result.cost?.usd` is a display convenience (= `microUsd / 1_000_000`). For financial
calculations and aggregation, use `microUsd` from the persisted record.

```ts
const result = await client.generate(
  { provider: 'google', model: 'gemini-2.5-flash', messages },
  { auth: { apiKey: process.env.GEMINI_API_KEY! } },
)
if (result.cost) {
  console.log(`$${result.cost.usd?.toFixed(6)}`) // display
  console.log(result.cost.microUsd) // canonical integer, stored in the sink
}
```

## Typed provider extensions

`config.providerOptions.google` is a typed extension lane owned by the selected
descriptor schema. Use it for provider-specific fields the descriptor admits,
such as cached content handles, safety settings, or exact tool declarations.
Do not treat it as an override lane for descriptor-owned fields like
`serviceTier`, sampling, reasoning, or response schema.

```ts
import { defaultGeminiRegistry } from '@gullabs/google'

const descriptor = defaultGeminiRegistry.resolve('google', 'gemini-2.5-pro')
if (!descriptor) throw new Error('unknown model')

// Parse the exact provider extension shape through the descriptor schema.
const config = descriptor.configSchema.parse({
  providerOptions: {
    google: { cachedContent: cacheHandle.cacheName },
  },
})

const result = await client.generate(
  {
    provider: descriptor.provider,
    model: descriptor.model,
    messages: [...],
    config,
  },
  { auth: { apiKey: process.env.GEMINI_API_KEY! } },
)
```

Gemini-specific settings that are not first-class generic fields use the same
lane when the descriptor admits them:

```ts
await client.generate(
  {
    provider: 'google',
    model: 'gemini-2.5-flash',
    messages: [...],
    config: {
      providerOptions: {
        google: {
          safetySettings: [
            {
              category: 'HARM_CATEGORY_HATE_SPEECH',
              threshold: 'BLOCK_MEDIUM_AND_ABOVE',
            },
          ],
        },
      },
    },
  },
  { auth: { apiKey: process.env.GEMINI_API_KEY! } },
)
```

Unsupported provider keys should fail at the schema boundary instead of being
silently forwarded or merged on top of validated config.

## Overall timeout semantics (`timeoutMs`)

`config.timeoutMs` sets an **overall wall-clock ceiling** for the logical call, including all
retry attempts and back-off sleep periods, when the retry middleware is installed.

```ts
const client = createClient({
  ...composeProviders([googleProvider()]),
  middleware: [retryMiddleware({ maxAttempts: 3 })],
})

const result = await client.generate({
  provider: 'google',
  model: 'gemini-2.5-flash',
  messages: [...],
  config: {
    timeoutMs: 30_000,
  },
}, { auth: { apiKey: process.env.MY_APP_GEMINI_KEY! } })
```

The retry middleware enforces this ceiling by:

- Refusing to start a new attempt when the remaining budget is ≤ 0 (throws `LlmError('timeout')`).
- Passing the shrinking remaining budget as the per-attempt `timeoutMs` so each attempt's internal
  `AbortSignal` deadline shrinks with elapsed time.
- Clamping the back-off sleep to the remaining budget so the sleep never overshoots the deadline.

Without the retry middleware, `timeoutMs` applies only to the single attempt (the engine arms an
`AbortSignal` at that value for the adapter).

## Logging & Observability

### Logger

Inject a structured logger via `ClientConfig.logger`. The `Logger` port uses an object-first
signature (`(o, m)`) compatible with pino, bunyan, and similar libraries:

```ts
import pino from 'pino'
const logger = pino()

const client = createClient({
  ...composeProviders([googleProvider()]),
  sink: drizzleUsageSink(db, llmCalls),
  logger, // inject your logger here
})
```

Four levels are supported: `debug`, `info`, `warn`, `error`. The engine emits structured events at
these levels:

| Event                    | Level   | When                                                                                     |
| ------------------------ | ------- | ---------------------------------------------------------------------------------------- |
| `llm.call.start`         | `info`  | Before the middleware chain runs                                                         |
| `llm.call.attempt.start` | `debug` | Before each adapter invocation                                                           |
| `llm.call.retry`         | `debug` | After a retryable failure; includes `attemptNumber`, `delayMs`, `errorKind`, `retryable` |
| `llm.call.success`       | `info`  | After a successful call                                                                  |
| `llm.call.error`         | `error` | After all retries are exhausted                                                          |
| `llm.call.cost.failed`   | `warn`  | When cost computation throws (fail-open)                                                 |
| `llm.call.sink.success`  | `debug` | After the sink write succeeds                                                            |
| `llm.call.sink.failed`   | `error` | After a sink write fails (fail-open; message is redacted)                                |

**Fail-open**: host logger exceptions are caught and swallowed by `makeSafeLogger` — a misbehaving
logger can never break or mask an LLM call result.

### Telemetry (OTel / Sentry / PostHog seam)

Inject a `Telemetry` hook via `ClientConfig.telemetry`. All methods are optional; implement only
what you need. Events fire once per logical call (not per retry attempt):

```ts
const client = createClient({
  // …
  telemetry: {
    onStart(e) {
      // e: { callId, provider, model, callSiteId?, metadata }
      return myTracer.startSpan('llm.call', { attributes: { model: e.model } })
    },
    onSuccess(e, span) {
      // e: { callId, attemptId, provider, model, latencyMs, usage, cost?, metadata }
      span?.setStatus({ code: SpanStatusCode.OK })
      span?.end()
    },
    onError(e, span) {
      // e: { callId, attemptId?, provider, model, latencyMs, errorKind, retryable, metadata }
      span?.setStatus({ code: SpanStatusCode.ERROR })
      span?.end()
    },
  },
})
```

Telemetry hook failures are swallowed (fail-open) and emit a `debug` breadcrumb
(`llm.telemetry.hook.failed`) so they never mask the real LLM result or error.

### UsageSink and LlmCallRecord

Every call attempt produces an `LlmCallRecord` that is persisted via `UsageSink`. Key traceability
fields:

| Field                          | Description                                                          |
| ------------------------------ | -------------------------------------------------------------------- |
| `callId`                       | Stable identifier shared across all retry attempts of a logical call |
| `attemptId`                    | Unique per-attempt idempotency key and ledger primary key            |
| `attemptNumber`                | 1-based ordinal (1 = first attempt, 2 = first retry, …)              |
| `externalId`                   | Optional caller-owned correlation id                                 |
| `servedServiceTier`            | Service tier actually served by the provider                         |
| `latencyMs`                    | Wall-clock time from dispatch to response for this attempt           |
| `inputTokens` / `outputTokens` | GROSS token counts (cached and thinking are subsets)                 |
| `costMicroUsd`                 | Frozen micro-USD cost; `null` if model is unpriced                   |
| `errorKind`                    | Classified error kind (absent on success)                            |
| `status`                       | `ok`, `api_error`, `timeout`, `aborted`, or `content_filter`         |
| `metadata`                     | Host-supplied `CallMetadata` — persisted verbatim                    |

Records are per-attempt and correlated by `callId`. The `@gullabs/drizzle` sink is idempotent on
`attemptId`.

When you pass `idempotencyKey`, attempt 1 uses that exact value as `attemptId`. If library-side
`retryMiddleware` performs an in-process retry, later attempts are suffixed (`key:2`, `key:3`, ...)
so each attempt can keep its own durable row; correlate the final outcome from `result.attemptId`
or `LlmError.attemptId`. Temporal-owned activity retries that call the library fresh each time keep
the pre-minted key on attempt 1 and rely on the sink's `attemptId` conflict handling for ledger
idempotency. This is ledger idempotency only; provider calls are not deduplicated.

### Secret redaction

`redactSecrets` is applied automatically before persistence:

- `errorMessage` in the persisted record (API keys / Bearer tokens in provider error URLs).
- The `providerOptions` lane of `generationConfig` when present.

Standard generation knobs (`temperature`, `topP`, etc.) are NOT scanned. Host-supplied `metadata`
is stored **verbatim** — do not put secrets there.

`redactSecrets` is also exported from `@gullabs/core` for use in application log lines.

---

## What v1 does NOT do yet

These are **designed seams** — the ports exist, the machinery is not built yet:

- **Multiple providers** — Gemini (`gemini-*`, `gemma-*`) and xAI (`grok-*`) are wired. The `ProviderAdapter` port and router are in place for others.
- **Streaming** — `generate` / `runStructured` return a full response. A `stream()` seam is in the design but unimplemented.
- **Tool use** — no function-calling machinery. The `Part` union's `kind` discriminant is reserved for future `tool-call` and `tool-result` variants.
- **Vertex AI** — removed; depended on ambient ADC. See [Roadmap](./ROADMAP.md).

## Documentation

### Design & architecture

- [`SPEC.md`](./SPEC.md) — v1 build contract (goals, invariants, type definitions, engine pipeline)
- [`docs/architecture.md`](./docs/architecture.md) — canonical engineering deep-dive
- [`DESIGN.md`](./DESIGN.md) — supplementary design notes: deeper rationale and forward-compatibility decisions
- [`DECISIONS.md`](./DECISIONS.md) — architecture decision log (ADRs) and parked questions

### Using the library

- [`docs/multi-runtime.md`](./docs/multi-runtime.md) — web route + Temporal worker integration pattern, auth, metadata, and retry ownership
- [`docs/grounded-structured.md`](./docs/grounded-structured.md) — the recommended two-call Gemini grounding -> structured-output recipe
- [`docs/structured-output-validation.md`](./docs/structured-output-validation.md) — validating `result.output` after `outputParsed` with a Standard-Schema-compatible helper
- [`docs/ledger.md`](./docs/ledger.md) — canonical `llm_calls` guidance, sidecar-table pattern, and query examples

### Contributing / operating

- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — dev setup, test/lint/build commands, and contribution principles
- [`RELEASING.md`](./RELEASING.md) — Changesets-based versioning and npm publish workflow
- [`SECURITY.md`](./SECURITY.md) — reporting security issues and the library's credential-handling posture
- [`ROADMAP.md`](./ROADMAP.md) — deferred/designed seams (multiple providers, streaming, tool use, Vertex AI)
- [`CHANGELOG.md`](./CHANGELOG.md) — per-package release history

## License

[Apache-2.0](./LICENSE)
