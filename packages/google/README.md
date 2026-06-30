# @gullabs/google

Gemini provider adapter for any-llm. A thin mapping layer over `@google/genai` that converts `ResolvedRequest` → Gemini SDK params and maps the response back to `AdapterResult`. Never persists, never computes cost, never loops — pure request/response.

**Peer dependency:** `@google/genai ^1 || ^2`

## Key exports

| Export                      | What it is                                                                    |
| --------------------------- | ----------------------------------------------------------------------------- |
| `geminiAdapter(opts?)`      | Creates the `ProviderAdapter` for Gemini                                      |
| `GeminiAdapterOptions`      | `{ client?: GeminiClientLike }` — inject a pre-built or fake client           |
| `GeminiClientLike`          | Structural interface the adapter depends on (satisfied by real SDK and fakes) |
| `buildGoogleClient(auth)`   | Builds the real `@google/genai` client from `AuthMaterial`                    |
| `zodToGeminiSchema(schema)` | Converts a Zod schema to a Gemini `responseSchema` object                     |

## Quick example

```ts
import { geminiAdapter } from '@gullabs/google'
import { createClient, geminiPricingSource } from '@gullabs/core'

const client = createClient({
  adapters: [geminiAdapter()],
  pricing: geminiPricingSource(),
})

// Auth is required on every call — the library never reads environment variables.
const result = await client.generate(
  {
    model: 'gemini-2.5-flash',
    messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hello' }] }],
  },
  { auth: { apiKey: 'YOUR_GEMINI_API_KEY' } },
)
```

## What it maps

- `serviceTier: 'flex'` → Gemini Flex service tier (default)
- `reasoning.includeThoughts` → `thinkingConfig.includeThoughts`; thought parts become `reasoningText`
- `reasoning.effort` → `thinkingBudget` (gemini-2.5) or `thinkingLevel` (gemini-3.x) with a warning when lossy
- `output.schema` → `responseMimeType: 'application/json'` + `responseSchema` (Zod-converted)
- `providerOptions.google.*` → forwarded verbatim to the SDK config
- Usage: `promptTokenCount`→`inputTokens`, `candidatesTokenCount`+`thoughtsTokenCount`→`outputTokens` (GROSS)
- Errors: `401/403`→`invalid_auth`, `429`→`rate_limited`, `5xx`→`server`, timeouts, safety blocks
