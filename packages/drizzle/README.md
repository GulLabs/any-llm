# @anyllm/drizzle

Reference Postgres schema and `UsageSink` implementation for any-llm using Drizzle ORM. Provides the `llm_calls` table definition and a ready-to-use sink that persists `LlmCallRecord` objects to your database.

**Peer dependency:** `drizzle-orm >=0.36.0`

## Key exports

| Export | What it is |
|---|---|
| `llmCalls` | Drizzle `pgTable('llm_calls', ...)` — the reference schema |
| `drizzleUsageSink(db, table?)` | Returns a `UsageSink` that writes records via `INSERT ... ON CONFLICT DO NOTHING` (idempotent on `attemptId`) |
| `InsertableDb` | Type of the `db` argument accepted by `drizzleUsageSink` |

## Quick example

```ts
import { drizzle } from 'drizzle-orm/node-postgres'
import { llmCalls, drizzleUsageSink } from '@anyllm/drizzle'
import { createClient, geminiPricingSource } from '@anyllm/core'
import { geminiAdapter } from '@anyllm/google'
import pg from 'pg'

const db = drizzle(new pg.Pool({ connectionString: process.env.DATABASE_URL }))

const client = createClient({
  adapters: [geminiAdapter()],
  auth: myAuth,
  pricing: geminiPricingSource(),
  sink: drizzleUsageSink(db, llmCalls),
})
```

## Schema

The `llm_calls` table mirrors `LlmCallRecord` from `@anyllm/core`: typed columns for the hot fields (`inputTokens`, `outputTokens`, `thinkingTokens`, `costMicroUsd`, etc.) and `jsonb` columns for forward-compatible lanes (`tokenDetails`, `rawUsage`, `providerMetadata`, `warnings`, `generationConfig`, `metadata`). Use the Drizzle schema directly, or implement `UsageSink` yourself to write to any store.

## Sink fail-open guarantee

The engine swallows all sink errors — a broken database write never fails the LLM call. Errors are logged via the engine's `Logger` at level `error` with event name `llm.call.sink.failed`.
