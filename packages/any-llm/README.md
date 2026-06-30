# @gullabs/any-llm

The default, batteries-included any-llm client package.

## Install

```bash
pnpm add @gullabs/any-llm
```

This installs the core engine, Gemini adapter, `@google/genai`, and `zod`.

## Usage

```ts
import { createClient, defineCallSite, geminiAdapter, geminiPricingSource, z } from '@gullabs/any-llm'

const client = createClient({
  adapters: [geminiAdapter()],
  pricing: geminiPricingSource(),
})

const Summary = z.object({
  title: z.string(),
  bullets: z.array(z.string()),
})

const summarize = defineCallSite({
  id: 'summarize',
  model: 'gemini-2.5-flash',
  schema: Summary,
  userTemplate: 'Summarize this:\n\n{{text}}',
})

const result = await client.runStructured(
  summarize,
  { text: documentText },
  { auth: { apiKey: process.env.GEMINI_API_KEY! } },
)
```

Use `@gullabs/core` and `@gullabs/google` directly only when you want modular dependency control.
