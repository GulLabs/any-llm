# @gullabs/google

Gemini provider adapter for any-llm. A thin mapping layer over `@google/genai` that converts `ResolvedRequest` → Gemini SDK params and maps the response back to `AdapterResult`. Never persists, never computes cost, never loops — pure request/response.

## Install

```bash
pnpm add @gullabs/google @gullabs/core @google/genai
```

**Peer dependency:** `@google/genai ^1 || ^2`

## Key exports

| Export                       | What it is                                                                    |
| ---------------------------- | ----------------------------------------------------------------------------- |
| `geminiAdapter(opts?)`       | Creates the `ProviderAdapter` for Gemini                                      |
| `GeminiAdapterOptions`       | `{ client?: GeminiClientLike }` — inject a pre-built or fake client           |
| `GeminiClientLike`           | Structural interface the adapter depends on (satisfied by real SDK and fakes) |
| `buildGoogleClient(auth)`    | Builds the real `@google/genai` client from `AuthMaterial`                    |
| `isGeminiCapacityError(err)` | Detects Gemini Flex shared-capacity errors for built-in fallback              |

## Quick example

```ts
import { geminiAdapter } from '@gullabs/google'
import { createClient, geminiPricingSource } from '@gullabs/core'

const client = createClient({
  adapters: [geminiAdapter()],
  pricing: geminiPricingSource(),
})

// Auth is required per call — the library never reads environment variables.
const result = await client.generate(
  {
    model: 'gemini-2.5-flash',
    messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hello' }] }],
  },
  { auth: { apiKey: 'YOUR_GEMINI_API_KEY' } },
)
```

## What it maps

- `serviceTier: 'flex'` → Gemini Flex service tier when the model descriptor supports it
- `reasoning.includeThoughts` → `thinkingConfig.includeThoughts`; thought parts become `reasoningText`
- `reasoning.effort` → `thinkingBudget` (gemini-2.5) or `thinkingLevel` (gemini-3.x) with a warning when lossy
- `output.jsonSchema` → `responseMimeType: 'application/json'` + verbatim `responseSchema` when native structured output is enabled; the engine returns parsed output and `outputParsed` without validating shape
- `providerOptions.google.*` → forwarded verbatim to the SDK config, including Gemini `safetySettings`
- Usage: `promptTokenCount`→`inputTokens`, `candidatesTokenCount`+`thoughtsTokenCount`→`outputTokens` (GROSS)
- Errors: `401/403`→`invalid_auth`, `429`→`rate_limited`, `5xx`→`server`, timeouts, safety blocks

## Gemma 4

The default registry includes two API-verified Gemma 4 models: `gemma-4-31b-it`
and `gemma-4-26b-a4b-it`. Both route through this adapter and support:

- **Native structured output** — `responseMimeType` + verbatim `responseSchema` are sent
  automatically when `output.jsonSchema` is set.
- **Grounding** — `tools:[{googleSearch:{}}]` via `providerOptions.google`.
- **Vision** — `inline-media` and `file-uri` multimodal message parts.
- **Thinking** — `reasoning.effort` maps to `thinkingLevel` (`reasoningApi: 'level'`).
  Gemma 4 thinking is binary: only `effort: 'none'` (MINIMAL) and `effort: 'high'`
  (HIGH) are accepted. Passing `effort: 'low'` or `effort: 'medium'` is rejected at
  validation time with a `bad_request` error because the model only supports MINIMAL
  and HIGH `thinkingLevel` values. Note: `thinkingBudget` is **not** supported
  (rejected by the API with HTTP 400).
- **Tunable sampling** — `temperature`, `topP`, `topK` are accepted.

This follows the library-wide **reject, don't map** rule: unsupported or incorrect input throws a
typed `bad_request` `LlmError` at validation time rather than being silently clamped or coerced
into something the model happens to accept.

Gemma 4 models do **not** support Gemini Flex service tier (`serviceTiers` is absent from their
descriptors) and are unpriced (`cost.microUsd` will be `null`).

## Learn more

- [Monorepo root README](../../README.md) — full architecture, auth model, and package overview
- [`docs/grounded-structured.md`](../../docs/grounded-structured.md) — the recommended two-call Gemini grounding → structured-output recipe
- [`docs/multi-runtime.md`](../../docs/multi-runtime.md) — web route + Temporal worker integration pattern, auth, metadata, and retry ownership
- [`@gullabs/core` README](../core/README.md) — engine, ports, and the `LlmError` contract
