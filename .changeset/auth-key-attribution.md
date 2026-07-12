---
'@gullabs/core': minor
'@gullabs/drizzle': minor
---

Add per-key attribution (ADR-026): `ApiKeyAuth` gains an optional `keyId?: string` — an opaque, caller-supplied label (e.g. `'gemini-paid'`, `'grok-team-A'`) for the API key actually used, never the secret itself. The engine resolves `keyId` from the auth material used for the dispatch attempt that produced the recorded outcome — after any retries, fallbacks, or profile translation — so attribution stays correct even when the engine switches auth material between attempts.

Key attribution belongs in any-llm rather than client code: the engine is the only component that authoritatively knows which auth material was used at dispatch time. Threading that identity through client-side call sites separately is the pattern that produced a real production bug (calls under one provider billed to the wrong client-side key label because the client's own attribution tracking drifted from what the engine actually dispatched with).

`keyId`, when provided, is validated per the library's reject-don't-map convention: must be a non-empty string, and must not equal `apiKey` (rejecting the case where a caller passes the secret itself as the label) — both raise a `bad_request` `LlmError`. The resolved `keyId` is carried through `buildRecord` into a new `authKeyId` field on `LlmCallRecord`, persisted to a nullable `auth_key_id` column on `llm_calls` (`@gullabs/drizzle`), and is exempt from the record's secret-redaction pass since it's a label by design. `CliSessionAuth` is unaffected — CLI-session providers have no key identity, so `keyId` is out of scope there.
