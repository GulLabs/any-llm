---
'@gullabs/core': minor
'@gullabs/any-llm': patch
---

Input contracts: strict template interpolation, opt-in `inputSchema`/`inputContract`
validation, and pre-attempt ledger rows for refused calls (ADR-025).

**Breaking changes:**

- Strict template interpolation is now the unconditional default. Every `{{var}}`
  placeholder referenced by `callSite.system`/`callSite.userTemplate` must have a
  string-typed value present in `vars`, or `runStructured` refuses the call with
  `LlmError('bad_request')` before any request is built — templates that previously
  dispatched with literal `{{placeholder}}` text left in place now fail locally instead.
  There is no opt-out and no preserved fallback.
- Pre-attempt refusals now write zero-usage `attemptNumber: 0` ledger rows. Any
  `LlmError` thrown inside `runPipeline` after `callId` allocation but before the first
  attempt runs — including `@gullabs/quota` denials, with no `@gullabs/quota` code
  changes — produces a synthetic `LlmCallRecord` (`attemptId` derived by the existing
  first-attempt idempotency rule: `request.idempotencyKey` when supplied, minted
  otherwise). Refusals that previously left no ledger row now appear as one.

**New features:**

- `CallSite.inputSchema?: StandardSchemaV1` — validates `vars` before interpolation,
  so a missing business field surfaces as the schema's own error.
- `LlmRequest.inputContract?: { schema: StandardSchemaV1; value: unknown }` — the
  equivalent opt-in contract for the `generate()` path; validated once per logical
  call, before `@gullabs/quota` and before the retry middleware.
- `createClient({ requireInputContract: true })` — fleet-wide toggle requiring every
  call to carry a contract (`inputSchema` on `runStructured`, `inputContract` on
  `generate()`).
- `LlmErrorOptions.issues` / `LlmError.issues` — structured `{ path, message }[]`
  validation failures, populated by both input-contract paths and by model-config
  validation.

See ADR-025 in `DECISIONS.md` for the full design and the row-less/ledgered boundary
table.
