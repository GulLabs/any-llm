# @gullabs/core

The provider-agnostic heart of any-llm. Contains all types, port interfaces, the engine pipeline, call-site definitions, cost computation, and the persisted record builder. Has no provider dependencies — only `zod` as a peer.

## Key exports

| Export | What it is |
|---|---|
| `createClient(config)` | Wires ports into a `{ generate, runStructured }` client |
| `defineCallSite(opts)` | Defines a typed, reusable prompt template bound to a model |
| `geminiPricingSource()` | Returns a `PricingSource` backed by the built-in Gemini pricing snapshot |
| `LlmError` | Typed error class — always thrown on call failure |
| `buildRecord(input)` | Assembles an `LlmCallRecord` from engine state (used internally) |

Port interfaces you implement: `ProviderAdapter`, `UsageSink`, `PricingSource`, `Clock`, `IdGenerator`, `Logger`, `Telemetry`.

## Quick example

```ts
import { createClient, geminiPricingSource, defineCallSite } from '@gullabs/core'
import { z } from 'zod'

const client = createClient({
  adapters: [myAdapter],
  pricing: geminiPricingSource(),
  sink: mySink,
})

const callSite = defineCallSite({
  id: 'summarise',
  model: 'gemini-2.5-flash',
  schema: z.object({ summary: z.string() }),
  userTemplate: 'Summarise: {{text}}',
  config: { reasoning: { includeThoughts: true } },
})

// Auth is required per call — never read from the environment.
const result = await client.runStructured(callSite, { text: 'hello world' }, {
  auth: { apiKey: 'YOUR_KEY' },
})
// result.output   — Zod-validated
// result.usage    — { inputTokens, outputTokens, thinkingTokens, cachedInputTokens }
// result.cost     — { microUsd, pricingVersion, details: { input, cached, output } }
// result.reasoningText — thought summary if includeThoughts was set
```

## Token convention

**GROSS**: `cachedInputTokens` is a subset of `inputTokens`; `thinkingTokens` is a subset of `outputTokens`. Cost math never double-counts. See `SPEC.md` for the full invariant.
