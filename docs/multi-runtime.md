# Multi-Runtime Integration

This is the recommended first-pass pattern for hosts that run `any-llm` in both request/response
code and worker/orchestrator code. Keep the shared helpers in your application until real
duplication proves a library helper is warranted. That is why the repo does not currently export
`createRuntimeClientFactory()` or `buildCallMetadata()`.

## Design rules

- construct clients per runtime, not via ambient globals;
- pass auth on every call;
- let web routes decide whether library retry middleware is appropriate;
- let Temporal or another orchestrator own external retries;
- use stable `idempotencyKey` values for externally retried activities;
- persist host-specific typed context in a sidecar keyed by `attemptId` when needed.

## Application-local metadata helper

Keep a small host helper for repeatable metadata anchors:

```ts
type AnyLlmMetadata = {
  tenantId: string
  orgId?: string
  workspaceId?: string
  route?: string
  workflowId?: string
  reportId?: string
  jobType?: string
  operationId?: string
}

function buildAnyLlmMetadata(input: AnyLlmMetadata) {
  return input
}
```

That is enough for most hosts. If this shape stabilizes across multiple repos, it can graduate into
a library helper later.

Set `operationId` once for a workflow operation and reuse it on every correlated call in that flow
(including the grounded-then-structured pattern from `docs/grounded-structured.md`).

## Shared wiring

```ts
import {
  createClient,
  geminiPricingSource,
  retryMiddleware,
} from '@gullabs/any-llm'
import { geminiAdapter } from '@gullabs/google'
import { drizzleUsageSink, llmCalls } from '@gullabs/drizzle'

function baseClientConfig(db: DbLike) {
  return {
    adapters: [geminiAdapter()],
    pricing: geminiPricingSource(),
    sink: drizzleUsageSink(db, llmCalls),
  }
}
```

## Web route client

HTTP handlers often want short in-process retries for retryable provider failures:

```ts
function makeWebClient(db: DbLike) {
  return createClient({
    ...baseClientConfig(db),
    middleware: [
      retryMiddleware({
        maxAttempts: 2,
      }),
    ],
  })
}

async function handleRoute(req: Request, db: DbLike) {
  const client = makeWebClient(db)
  const auth = { apiKey: await loadRouteApiKey(req) }

  return client.generate(
    {
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Summarize this' }] }],
      callSiteId: 'http-summary',
      externalId: req.headers.get('x-request-id') ?? undefined,
      metadata: buildAnyLlmMetadata({
        tenantId: 'tenant_123',
        route: '/api/reports/summary',
        operationId: `op-${Date.now()}`,
      }),
    },
    { auth, signal: req.signal },
  )
}
```

## Temporal worker client

Externally retried activities should usually skip library retry middleware. Let the orchestrator own
retry timing and hand the library a stable `idempotencyKey` so the ledger deduplicates attempt 1
rows across activity replays/retries.

### Testing note: RecordingSink does not dedupe

`RecordingSink` (`packages/testing/src/recording-sink.ts`) pushes every record it receives and does not
implement `onConflictDoNothing` deduplication. `drizzleUsageSink` (`packages/drizzle/src/sink.ts`) only
gets dedupe via the `attempt_id` primary key. In a test, if you replay a Temporal activity with the same
`idempotencyKey`, `RecordingSink` can still accumulate multiple rows.

```ts
function makeWorkerClient(db: DbLike) {
  return createClient(baseClientConfig(db))
}

export async function runReportActivity(input: {
  workflowId: string
  reportId: string
  prompt: string
  attemptKey: string
}, db: DbLike) {
  const client = makeWorkerClient(db)
  const auth = { apiKey: await loadWorkerApiKey(input.reportId) }

  return client.generate(
    {
      model: 'gemini-2.5-pro',
      messages: [{ role: 'user', parts: [{ kind: 'text', text: input.prompt }] }],
      callSiteId: 'worker-report',
      idempotencyKey: input.attemptKey,
      externalId: input.reportId,
      metadata: buildAnyLlmMetadata({
        tenantId: 'tenant_123',
        workflowId: input.workflowId,
        reportId: input.reportId,
        jobType: 'brand-report',
        operationId: input.attemptKey,
      }),
    },
    { auth },
  )
}
```

## Retry ownership

Use library retry middleware when:

- the caller is synchronous;
- a short retry loop is cheaper than handing control back to a queue;
- multiple durable attempt rows within one logical call are desirable.

Do not use library retry middleware when:

- Temporal, a job queue, or another orchestrator already retries the unit of work;
- you need durable sleeps or calendar-time rescheduling;
- you want one externally minted `idempotencyKey` to anchor the first ledger row.

## Sidecar persistence

If your host needs typed context rows, write them after the call using `result.attemptId` or
`LlmError.attemptId`:

```ts
await db.insert(llmCallContext).values({
  attemptId: result.attemptId,
  workflowId: input.workflowId,
  reportId: input.reportId,
  jobType: 'brand-report',
})
```

That keeps `llm_calls` canonical while preserving domain-specific queryability.
