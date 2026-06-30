/**
 * Real-database-boundary integration test for drizzleUsageSink.
 *
 * Uses PGlite (in-memory WASM Postgres) so the suite runs offline in CI with
 * no Docker or external service dependencies.
 *
 * Covers audit findings TEST-002 / DB-001:
 *   a) INSERT shape — all mapped values (hot columns + JSONB lanes) round-trip.
 *   b) attemptId idempotency — recording the same attemptId twice yields 1 row.
 *   c) timestamp + JSONB mapping — timestamps and JSONB objects round-trip correctly.
 */

import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { drizzleUsageSink, type InsertableDb } from './sink.js'
import { llmCalls } from './schema.js'
import type { LlmCallRecord, JsonValue } from '@gullabs/core'

// ---------------------------------------------------------------------------
// DDL derived precisely from packages/drizzle/src/schema.ts
// ---------------------------------------------------------------------------
// Column-by-column derivation from schema.ts:
//   record_schema_version: integer NOT NULL
//   call_id:             text NOT NULL
//   attempt_id:          text PRIMARY KEY
//   call_site_id:        text (nullable)
//   external_id:         text (nullable)
//   provider:            text NOT NULL
//   model:               text NOT NULL
//   model_version:       text (nullable)
//   response_id:         text (nullable)
//   service_tier:        text (nullable)
//   served_service_tier: text (nullable)
//   status:              text NOT NULL
//   finish_reason:       text (nullable)
//   output_parsed:       boolean (nullable)
//   latency_ms:          integer (nullable)
//   input_tokens:        integer (nullable)
//   output_tokens:       integer (nullable)
//   cached_input_tokens: integer (nullable)
//   thinking_tokens:     integer (nullable)
//   total_tokens:        integer (nullable)
//   cost_micro_usd:      integer (nullable)
//   pricing_version:     text (nullable)
//   token_details:       jsonb NOT NULL
//   raw_usage:           jsonb NOT NULL
//   provider_metadata:   jsonb (nullable)
//   warnings:            jsonb (nullable)
//   generation_config:   jsonb NOT NULL
//   reasoning_text:      text (nullable)
//   error_kind:          text (nullable)
//   error_message:       text (nullable)
//   attempt_number:      integer NOT NULL
//   metadata:            jsonb NOT NULL
//   created_at:          timestamptz DEFAULT now()
// ---------------------------------------------------------------------------
const CREATE_TABLE_SQL = /* sql */ `
  CREATE TABLE IF NOT EXISTS llm_calls (
    record_schema_version INTEGER      NOT NULL,
    call_id               TEXT         NOT NULL,
    attempt_id            TEXT         PRIMARY KEY,
    call_site_id          TEXT,
    external_id           TEXT,
    provider              TEXT         NOT NULL,
    model                 TEXT         NOT NULL,
    model_version         TEXT,
    response_id           TEXT,
    service_tier          TEXT,
    served_service_tier   TEXT,
    status                TEXT         NOT NULL,
    finish_reason         TEXT,
    output_parsed         BOOLEAN,
    latency_ms            INTEGER,
    input_tokens          INTEGER,
    output_tokens         INTEGER,
    cached_input_tokens   INTEGER,
    thinking_tokens       INTEGER,
    total_tokens          INTEGER,
    cost_micro_usd        INTEGER,
    pricing_version       TEXT,
    token_details         JSONB        NOT NULL,
    raw_usage             JSONB        NOT NULL,
    provider_metadata     JSONB,
    warnings              JSONB,
    generation_config     JSONB        NOT NULL,
    reasoning_text        TEXT,
    error_kind            TEXT,
    error_message         TEXT,
    attempt_number        INTEGER      NOT NULL,
    metadata              JSONB        NOT NULL,
    created_at            TIMESTAMPTZ  DEFAULT now()
  );

  CREATE INDEX IF NOT EXISTS llm_calls_call_id_idx ON llm_calls (call_id);
  CREATE INDEX IF NOT EXISTS llm_calls_external_id_idx ON llm_calls (external_id);
`

// ---------------------------------------------------------------------------
// Test fixture helpers
// ---------------------------------------------------------------------------

function makeRecord(overrides: Partial<LlmCallRecord> = {}): LlmCallRecord {
  return {
    recordSchemaVersion: 1,
    callId: 'call_integration_1',
    attemptId: 'attempt_integration_1',
    attemptNumber: 1,
    callSiteId: 'site_integration',
    provider: 'google',
    model: 'gemini-2.5-pro',
    modelVersion: 'gemini-2.5-pro-001',
    responseId: 'resp_int_456',
    serviceTier: 'flex',
    servedServiceTier: 'standard',
    status: 'ok',
    finishReason: 'stop',
    outputParsed: true,
    latencyMs: 250,
    inputTokens: 200,
    outputTokens: 40,
    cachedInputTokens: 20,
    thinkingTokens: 5,
    totalTokens: 240,
    costMicroUsd: 789,
    pricingVersion: 'gemini-2026-06-29',
    tokenDetails: { input: 200, output: 40 } satisfies JsonValue,
    rawUsage: {
      promptTokenCount: 200,
      candidatesTokenCount: 40,
    } satisfies JsonValue,
    providerMetadata: {
      safetyRatings: [
        { category: 'HARM_CATEGORY_HATE_SPEECH', probability: 'NEGLIGIBLE' },
      ],
    } satisfies JsonValue,
    warnings: [{ type: 'other', message: 'test warning' }] satisfies JsonValue,
    generationConfig: { temperature: 0.7, topP: 0.9 } satisfies JsonValue,
    reasoningText: 'integration thought summary',
    metadata: { tenantId: 'tenant_int', runId: 'run_42' } satisfies JsonValue,
    createdAt: '2026-06-29T12:00:00.000Z',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Per-test in-memory DB setup
// ---------------------------------------------------------------------------

type PgliteDb = ReturnType<typeof drizzle>

async function createTestDb(): Promise<PgliteDb> {
  const pglite = new PGlite()
  await pglite.exec(CREATE_TABLE_SQL)
  return drizzle({ client: pglite })
}

/**
 * Cast a PgliteDatabase to InsertableDb for use with drizzleUsageSink.
 *
 * The real drizzle-orm pglite driver satisfies InsertableDb at runtime.
 * TypeScript rejects the direct assignment due to contra-variance on the
 * widened `target: unknown` parameter in InsertableDb (which was widened to
 * keep the interface easily mockable). The cast is safe: sink.ts only ever
 * passes `table.attemptId` (an IndexColumn) as the target.
 */
function asInsertableDb(db: PgliteDb): InsertableDb {
  return db as unknown as InsertableDb
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('drizzleUsageSink — real PGlite integration', () => {
  // (a) INSERT shape: all mapped values persist and round-trip correctly.
  it('inserts a record and all column values round-trip correctly', async () => {
    const db = await createTestDb()
    const sink = drizzleUsageSink(asInsertableDb(db))
    const record = makeRecord()

    await sink.record(record)

    const rows = await db.select().from(llmCalls)
    expect(rows).toHaveLength(1)

    const row = rows[0]!

    // Identity
    expect(row.recordSchemaVersion).toBe(1)
    expect(row.callId).toBe('call_integration_1')
    expect(row.attemptId).toBe('attempt_integration_1')
    expect(row.callSiteId).toBe('site_integration')

    // Routing
    expect(row.provider).toBe('google')
    expect(row.model).toBe('gemini-2.5-pro')
    expect(row.modelVersion).toBe('gemini-2.5-pro-001')
    expect(row.responseId).toBe('resp_int_456')
    expect(row.serviceTier).toBe('flex')
    expect(row.servedServiceTier).toBe('standard')

    // Outcome
    expect(row.status).toBe('ok')
    expect(row.finishReason).toBe('stop')
    expect(row.outputParsed).toBe(true)
    expect(row.latencyMs).toBe(250)

    // Token hot fields
    expect(row.inputTokens).toBe(200)
    expect(row.outputTokens).toBe(40)
    expect(row.cachedInputTokens).toBe(20)
    expect(row.thinkingTokens).toBe(5)
    expect(row.totalTokens).toBe(240)

    // Cost
    expect(row.costMicroUsd).toBe(789)
    expect(row.pricingVersion).toBe('gemini-2026-06-29')

    // JSONB lanes — verify deep equality (real DB deserialization)
    expect(row.tokenDetails).toEqual({ input: 200, output: 40 })
    expect(row.rawUsage).toEqual({
      promptTokenCount: 200,
      candidatesTokenCount: 40,
    })
    expect(row.providerMetadata).toEqual({
      safetyRatings: [
        { category: 'HARM_CATEGORY_HATE_SPEECH', probability: 'NEGLIGIBLE' },
      ],
    })
    expect(row.warnings).toEqual([{ type: 'other', message: 'test warning' }])
    expect(row.generationConfig).toEqual({ temperature: 0.7, topP: 0.9 })

    // Text fields
    expect(row.reasoningText).toBe('integration thought summary')
    expect(row.errorKind).toBeNull()
    expect(row.errorMessage).toBeNull()

    // attemptNumber round-trips through the real DB.
    expect(row.attemptNumber).toBe(1)

    // Host metadata JSONB
    expect(row.metadata).toEqual({ tenantId: 'tenant_int', runId: 'run_42' })

    // attemptId is the ledger primary key.
    expect(row.attemptId).toBe('attempt_integration_1')
  })

  // (b) attemptId idempotency: two records with the same attemptId → exactly one row.
  it('deduplicate on attemptId: recording the same attemptId twice yields exactly one row', async () => {
    const db = await createTestDb()
    const sink = drizzleUsageSink(asInsertableDb(db))
    const record = makeRecord({ attemptId: 'idempotent_attempt' })

    // First insert
    await sink.record(record)
    // Second insert with same attemptId — should be silently ignored
    await sink.record(record)

    const rows = await db
      .select()
      .from(llmCalls)
      .where(eq(llmCalls.attemptId, 'idempotent_attempt'))
    expect(rows).toHaveLength(1)
  })

  // (b cont.) Second insert with different data on same attemptId must not overwrite.
  it('onConflictDoNothing preserves the first row on duplicate attemptId', async () => {
    const db = await createTestDb()
    const sink = drizzleUsageSink(asInsertableDb(db))

    const first = makeRecord({
      attemptId: 'dup_attempt',
      status: 'ok',
      latencyMs: 100,
    })
    const second = makeRecord({
      attemptId: 'dup_attempt',
      status: 'api_error',
      latencyMs: 999,
    })

    await sink.record(first)
    await sink.record(second)

    const rows = await db
      .select()
      .from(llmCalls)
      .where(eq(llmCalls.attemptId, 'dup_attempt'))
    expect(rows).toHaveLength(1)
    // The first row must be preserved, not the second.
    expect(rows[0]!.status).toBe('ok')
    expect(rows[0]!.latencyMs).toBe(100)
  })

  // (c) Timestamp + JSONB mapping: timestamps persist and round-trip correctly.
  it('persists createdAt as a proper timestamp and JSONB columns round-trip nested objects', async () => {
    const db = await createTestDb()
    const sink = drizzleUsageSink(asInsertableDb(db))

    const complexJsonb: JsonValue = {
      nested: { a: 1, b: [true, null, 'str'] },
      arr: [{ x: 42 }],
    }
    const record = makeRecord({
      attemptId: 'ts_test_attempt',
      createdAt: '2026-06-29T12:00:00.000Z',
      generationConfig: complexJsonb,
      tokenDetails: complexJsonb,
      rawUsage: complexJsonb,
    })

    await sink.record(record)

    const rows = await db
      .select()
      .from(llmCalls)
      .where(eq(llmCalls.attemptId, 'ts_test_attempt'))
    expect(rows).toHaveLength(1)
    const row = rows[0]!

    // Timestamp: createdAt must be a Date object matching the ISO string.
    expect(row.createdAt).toBeInstanceOf(Date)
    expect(row.createdAt!.toISOString()).toBe('2026-06-29T12:00:00.000Z')

    // Nested JSONB round-trip
    expect(row.generationConfig).toEqual(complexJsonb)
    expect(row.tokenDetails).toEqual(complexJsonb)
    expect(row.rawUsage).toEqual(complexJsonb)
  })

  // (a cont.) api_error postmortem fields map correctly at the DB boundary.
  it('persists error fields for api_error status', async () => {
    const db = await createTestDb()
    const sink = drizzleUsageSink(asInsertableDb(db))
    const record = makeRecord({
      attemptId: 'error_attempt',
      status: 'api_error',
      errorKind: 'server',
      errorMessage: 'upstream 503',
    })

    await sink.record(record)

    const rows = await db
      .select()
      .from(llmCalls)
      .where(eq(llmCalls.attemptId, 'error_attempt'))
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.status).toBe('api_error')
    expect(row.errorKind).toBe('server')
    expect(row.errorMessage).toBe('upstream 503')
  })

  // Multiple distinct records are all persisted (no cross-contamination).
  it('persists multiple distinct records correctly', async () => {
    const db = await createTestDb()
    const sink = drizzleUsageSink(asInsertableDb(db))

    await sink.record(
      makeRecord({
        attemptId: 'multi_1',
        callId: 'call_multi_1',
        latencyMs: 111,
      }),
    )
    await sink.record(
      makeRecord({
        attemptId: 'multi_2',
        callId: 'call_multi_2',
        latencyMs: 222,
      }),
    )
    await sink.record(
      makeRecord({
        attemptId: 'multi_3',
        callId: 'call_multi_3',
        latencyMs: 333,
      }),
    )

    const rows = await db.select().from(llmCalls)
    expect(rows).toHaveLength(3)

    const latencies = rows.map((r) => r.latencyMs).sort()
    expect(latencies).toEqual([111, 222, 333])
  })
})
