# any-llm

[![CI](https://github.com/GulLabs/any-llm/actions/workflows/ci.yml/badge.svg)](https://github.com/GulLabs/any-llm/actions/workflows/ci.yml)

An in-process TypeScript library that standardises LLM calls with first-class observability. v1 delivers four things: **Gemini Flex** calls, **token usage capture** (input / output / cached / thinking), **thinking text capture** and per-call postmortems, and **micro-USD cost tracking** frozen into every persisted record. The design is a thin adapter over raw provider SDKs — no agent loop, no framework, no magic.

## Install

```bash
pnpm add @gullabs/core @gullabs/google
# optional companions:
pnpm add @gullabs/drizzle    # Drizzle ORM sink for Postgres
pnpm add @gullabs/testing    # test fakes (dev only)
```

> Provider SDKs are peer-dependencies. For Gemini: `pnpm add @google/genai`

## Quickstart

The four v1 goals in ~25 lines:

```ts
import { z } from 'zod'
import { createClient, geminiPricingSource, defineCallSite } from '@gullabs/core'
import { geminiAdapter } from '@gullabs/google'
import { drizzleUsageSink, llmCalls } from '@gullabs/drizzle'

// 1. Wire up the client — no auth here; the library never reads credentials
const client = createClient({
  adapters: [geminiAdapter()],
  pricing: geminiPricingSource(),
  sink: drizzleUsageSink(db, llmCalls),
})

// 2. Define a typed, reusable call site
const ReviewSchema = z.object({ rating: z.number().int().min(1).max(5), summary: z.string() })

const codeReview = defineCallSite({
  id: 'code-review',
  model: 'gemini-2.5-flash',
  schema: ReviewSchema,
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
const result = await client.runStructured(codeReview, { auth, vars: { diff: myDiff } })

// All four goals satisfied:
console.log(result.output)          // { rating: 4, summary: '...' }  — Zod-validated
console.log(result.usage)           // { inputTokens, outputTokens, cachedInputTokens, thinkingTokens }
console.log(result.cost?.microUsd)  // integer micro-USD, frozen at call time
console.log(result.reasoningText)   // thought summary from the model
// The record has already been persisted to llm_calls via the Drizzle sink.
```

See [`examples/basic.ts`](./examples/basic.ts) for a **fully runnable** version (no network required — uses test fakes). Run it with `pnpm example`.

## Auth

The library never reads credentials from the environment or any ambient source. There is no `envAuth()`,
no `AuthProvider` port, and no client-level `auth` on `createClient`. The caller passes `auth` on
every call:

```ts
client.generate(request, { auth: { apiKey } })
client.runStructured(callSite, { auth: { apiKey }, vars: { ... } })
```

`auth` is required. `AuthMaterial` is `{ apiKey: string }`. Where the key comes from is entirely
your concern — read it from an environment variable, a secret vault, a database, or per-user input:

```ts
// For an 18-call loop, build auth once and pass it each time:
const auth = { apiKey: process.env.MY_APP_GEMINI_KEY! }
for (const item of items) {
  results.push(await client.runStructured(callSite, { auth, vars: { item } }))
}
```

The key is redacted from any persisted records or logs.

Vertex AI: see [Roadmap](./ROADMAP.md).

## Architecture

Every call — whether `generate()` or `runStructured()` — goes through the pipeline below. Model-config validation (`validateModelConfig`) runs pre-dispatch inside `runAttempt`, before routing or auth:

```
generate() / runStructured()
  → resolveConfig()               [libDefaults → callSite → opts; deep-merge]
  → validateModelConfig()         [Standard Schema pre-dispatch check; terminal on failure]
  → route(model, adapters)        → ProviderAdapter
  → opts.auth                     → AuthMaterial  [required per-call; never read from env]
  → rateLimiter.acquire("provider:model")    [pre-send pacing; propagates on reject]
  → adapter.run(resolved, ctx)    ← provider SDK (anti-corruption layer)
  → normalizeUsage()              [enforce GROSS token convention]
  → Standard Schema validate(rawStructured)  [structured output validation; terminal on failure]
  → pricing.price()               [micro-USD cost; fail-open]
  → buildRecord() → sink.record() [persist call record; fail-open]
  → LlmResult
```

The design is **Ports & Adapters (hexagonal)**: the core engine depends only on port interfaces (`ProviderAdapter`, `UsageSink`, `PricingSource`, `RateLimiter`). All concrete implementations live in separate packages — the engine never imports a provider SDK. Side effects (`sink.record`, `pricing.price`, `telemetry`) are **fail-open**: a broken sink cannot fail an LLM call. The rate-limiter is the one deliberate exception — `acquire` rejection propagates so backpressure is actually enforced.

## Packages

| Package | Description |
|---|---|
| [`@gullabs/core`](./packages/core) | Types, ports, engine (`createClient`, `generate`, `runStructured`), cost computation, record builder. No provider dependencies. |
| [`@gullabs/google`](./packages/google) | Gemini adapter over `@google/genai`. Maps Flex tier, thinking config, multimodal parts, structured output, and error classification. Optional `GoogleFileStore` and `GoogleCacheStore` helpers for Gemini Files API and Context Cache API. |
| [`@gullabs/drizzle`](./packages/drizzle) | Reference Postgres schema (`llm_calls` table) and `drizzleUsageSink` — a `UsageSink` port implementation for Drizzle ORM. |
| [`@gullabs/testing`](./packages/testing) | Test fakes: `FakeClock`, `FakeIds`, `RecordingSink`, `makeFakeGemini`, `fakeGeminiResponse`, `fakeAuth`. No network in tests. |

## Multimodal parts

`Message.parts` accepts a mix of `TextPart`, `InlineMediaPart`, and `FileUriPart`:

```ts
// Inline image (base64, no data: prefix)
const result = await client.generate({
  model: 'gemini-2.5-flash',
  messages: [{
    role: 'user',
    parts: [
      { kind: 'text', text: 'What is in this image?' },
      {
        kind: 'inline-media',
        mimeType: 'image/png',
        data: Buffer.from(pngBytes).toString('base64'),
        mediaResolution: 'high',   // optional; adapter maps to PartMediaResolutionLevel
      },
    ],
  }],
})

// File already uploaded to Gemini Files API
const result2 = await client.generate({
  model: 'gemini-2.5-flash',
  messages: [{
    role: 'user',
    parts: [
      { kind: 'text', text: 'Summarise this video.' },
      {
        kind: 'file-uri',
        uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc123',
        mimeType: 'video/mp4',
      },
    ],
  }],
})
```

## Files API (`GoogleFileStore`)

Upload bytes once, reuse the URI across many calls. The provider auto-deletes files after ~48 h.

```ts
import { GoogleFileStore } from '@gullabs/google'

const auth = { apiKey: process.env.GEMINI_API_KEY! }
const store = new GoogleFileStore({ auth })

// Upload and wait for ACTIVE (polls until ready, default timeout 120 s)
const handle = await store.upload(pdfBytes, 'application/pdf', { displayName: 'report.pdf' })

// handle.uri → FileUriPart.uri
const result = await client.generate({
  model: 'gemini-2.5-pro',
  messages: [{
    role: 'user',
    parts: [
      { kind: 'text', text: 'Extract the key figures from this document.' },
      { kind: 'file-uri', uri: handle.uri, mimeType: 'application/pdf' },
    ],
  }],
})

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

// Pass the cache name via providerOptions; the adapter forwards it verbatim
const result = await client.generate({
  model: 'gemini-2.5-pro',
  messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Summarise section 3.' }] }],
  config: {
    providerOptions: {
      google: { cachedContent: cacheHandle.cacheName },
    },
  },
})

// Extend the TTL if it is expiring within 5 minutes (default threshold)
const refreshed = await cacheStore.refreshIfExpiringSoon(cacheHandle)
```

## Flex long-timeout calls

Flex-tier calls can run for up to 25 minutes. The adapter sets `httpOptions.timeout` to
`FLEX_DEFAULT_TIMEOUT_MS` (1 500 000 ms) automatically for all Flex calls. To set an explicit
per-call deadline on top of that:

```ts
const result = await client.generate({
  model: 'gemini-2.5-pro',
  messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Write a very long essay.' }] }],
  config: {
    serviceTier: 'flex',
    timeoutMs: 600_000,  // 10 min engine deadline; SDK transport timeout = 605 000 ms
  },
})
```

**Verified field syntax for Flex:** set `serviceTier: 'flex'` in `config` (not in
`providerOptions.google`) and set `timeoutMs` in ms in `config` for the engine deadline. The
adapter automatically sets `httpOptions.timeout` to `timeoutMs + 5 000 ms` as a transport-layer
buffer. **Vertex AI caveat:** on Vertex, the `serviceTier` body field is silently ignored (SDK bug
#1468); the adapter works around this by injecting `X-Vertex-AI-LLM-Request-Type` and
`X-Vertex-AI-LLM-Shared-Request-Type` headers on the Vertex Flex path.

## Cost

`result.cost?.usd` is a display convenience (= `microUsd / 1_000_000`). For financial
calculations and aggregation, use `microUsd` from the persisted record.

```ts
const result = await client.generate({ model: 'gemini-2.5-flash', messages })
if (result.cost) {
  console.log(`$${result.cost.usd?.toFixed(6)}`)   // display
  console.log(result.cost.microUsd)                  // canonical integer, stored in the sink
}
```

## providerOptions escape hatch

`config.providerOptions` is an **unvalidated passthrough**. Values are forwarded verbatim to the
raw provider SDK; the engine does not validate, log, or audit them.

```ts
// Example: inject a cached-content resource name for the Gemini adapter
const result = await client.generate({
  model: 'gemini-2.5-pro',
  messages: [...],
  config: {
    providerOptions: {
      google: { cachedContent: cacheHandle.cacheName },
    },
  },
})
```

There is no guarantee that any key inside `providerOptions` will be honoured — it depends entirely
on what the underlying provider adapter does with it. Use sparingly and document any reliance on
specific keys in application code.

## Overall timeout semantics (`timeoutMs`)

`config.timeoutMs` sets an **overall wall-clock ceiling** for the logical call, including all
retry attempts and back-off sleep periods, when the retry middleware is installed.

```ts
const client = createClient({
  adapters: [geminiAdapter()],
  pricing: geminiPricingSource(),
  middleware: [retryMiddleware({ maxAttempts: 3 })],
})

const result = await client.generate({
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

## What v1 does NOT do yet

These are **designed seams** — the ports exist, the machinery is not built yet:

- **Multiple providers** — only Gemini (`gemini-*`) is wired. The `ProviderAdapter` port and router are in place for others.
- **Streaming** — `generate` / `runStructured` return a full response. A `stream()` seam is in the design but unimplemented.
- **Tool use** — no function-calling machinery. The `Part` union's `kind` discriminant is reserved for future `tool-call` and `tool-result` variants.
- **Vertex AI** — removed; depended on ambient ADC. See [Roadmap](./ROADMAP.md).

## Reference

- [`SPEC.md`](./SPEC.md) — v1 build contract (goals, invariants, type definitions, engine pipeline)
- [`DECISIONS.md`](./DECISIONS.md) — autonomous decision log and parked questions
