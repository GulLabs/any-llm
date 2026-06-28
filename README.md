# any-llm

An in-process TypeScript library that standardises LLM calls with first-class observability. v1 delivers four things: **Gemini Flex** calls, **token usage capture** (input / output / cached / thinking), **thinking text capture** and per-call postmortems, and **micro-USD cost tracking** frozen into every persisted record. The design is a thin adapter over raw provider SDKs — no agent loop, no framework, no magic.

## Install

```
pnpm add @anyllm/core @anyllm/google
# optional companions:
pnpm add @anyllm/drizzle    # Drizzle ORM sink for Postgres
pnpm add @anyllm/testing    # test fakes (dev only)
```

> Provider SDKs are peer-dependencies. For Gemini: `pnpm add @google/genai`

## Quickstart

The four v1 goals in ~25 lines:

```ts
import { z } from 'zod'
import { createClient, geminiPricingSource, defineCallSite } from '@anyllm/core'
import { geminiAdapter } from '@anyllm/google'
import { drizzleUsageSink, llmCalls } from '@anyllm/drizzle'

// 1. Wire up the client
const client = createClient({
  adapters: [geminiAdapter()],          // Gemini Flex via @google/genai
  auth: {
    async credentials(_provider) {
      return { apiKey: process.env.GEMINI_API_KEY! }
    },
  },
  pricing: geminiPricingSource(),       // built-in Gemini pricing snapshot
  sink: drizzleUsageSink(db, llmCalls), // write every call record to your DB
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
    reasoning: { includeThoughts: true, effort: 'medium' }, // capture thinking text
    serviceTier: 'flex',
  },
})

// 3. Run it — typed result, usage, cost, and reasoning all in one shot
const result = await client.runStructured(codeReview, { diff: myDiff })

// 4. All four goals satisfied:
console.log(result.output)          // { rating: 4, summary: '...' }  — Zod-validated
console.log(result.usage)           // { inputTokens, outputTokens, cachedInputTokens, thinkingTokens }
console.log(result.cost?.microUsd)  // integer micro-USD, frozen at call time
console.log(result.reasoningText)   // thought summary from the model
// The record has already been persisted to llm_calls via the Drizzle sink.
```

See [`examples/basic.ts`](./examples/basic.ts) for a **fully runnable** version (no network required — uses test fakes). Run it with `pnpm example`.

## Packages

| Package | Description |
|---|---|
| [`@anyllm/core`](./packages/core) | Types, ports, engine (`createClient`, `generate`, `runStructured`), cost computation, record builder. No provider dependencies. |
| [`@anyllm/google`](./packages/google) | Gemini adapter over `@google/genai`. Maps Flex tier, thinking config, structured output, and error classification. |
| [`@anyllm/drizzle`](./packages/drizzle) | Reference Postgres schema (`llm_calls` table) and `drizzleUsageSink` — a `UsageSink` port implementation for Drizzle ORM. |
| [`@anyllm/testing`](./packages/testing) | Test fakes: `FakeClock`, `FakeIds`, `RecordingSink`, `makeFakeGemini`, `fakeGeminiResponse`, `fakeAuth`. No network in tests. |

## What v1 does NOT do yet

These are **designed seams** — the ports exist, the machinery is not built yet:

- **Multiple providers** — only Gemini (`gemini-*`) is wired. The `ProviderAdapter` port and router are in place for others.
- **Streaming** — `generate` / `runStructured` return a full response. A `stream()` seam is in the design but unimplemented.
- **Tool use** — no function-calling machinery. The request type is extensible.
- **Rate limiting, redaction, blob storage** — ports are named in the spec; v1 stubs are absent.
- **Other auth methods** — Vertex AI WIF path exists in `buildGoogleClient`; API-key path is the tested one.

## Reference

- [`SPEC.md`](./SPEC.md) — v1 build contract (goals, invariants, type definitions, engine pipeline)
- [`DECISIONS.md`](./DECISIONS.md) — autonomous decision log and parked questions
