---
'@gullabs/drizzle': minor
---

Fix `llm_calls.raw_usage jsonb NOT NULL` silently dropping every error and pre-attempt-refusal row from the ledger. The core engine's `EMPTY_USAGE` sentinel sets `Usage.raw = null` on every record path where no provider usage payload ever existed — a per-attempt error (`api_error` / `timeout` / `aborted` / `content_filter`) and the ADR-025 `attemptNumber: 0` synthetic pre-attempt refusal record both hit this. `buildRecord` copies `usage.raw` verbatim into `LlmCallRecord.rawUsage`, so every such record carried `rawUsage: null` into the sink. Because `raw_usage` was `NOT NULL`, the INSERT was rejected at the DB boundary — and because `UsageSink.record` is fail-open by design (ADR-002), that rejection was logged and swallowed, so the row never appeared in the ledger at all. Any consumer relying on the ledger for error/refusal visibility was silently missing that data.

`raw_usage` is now nullable (ADR-027). `null` means "no provider usage payload existed for this row" — it is not backfilled with a `{}` sentinel, since that would fabricate a payload the provider never returned. `token_details`, `generation_config`, and `metadata` were audited against the same engine record paths and are always populated (never null) on every code path, so their `.notNull()` constraints are unchanged; the schema now documents this invariant per-column.

**Consumers with an existing `llm_calls` table must run:**

```sql
ALTER TABLE llm_calls ALTER COLUMN raw_usage DROP NOT NULL;
```
