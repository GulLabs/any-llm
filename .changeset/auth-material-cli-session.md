---
'@gullabs/core': minor
'@gullabs/google': patch
---

Extend `AuthMaterial` from `{ apiKey: string }` to a union of `ApiKeyAuth` (`{ apiKey: string }`) and the new `CliSessionAuth` (`{ cliSession: true }`), an explicit opt-in credential shape for the dev-only CLI provider packages (`@gullabs/claude-cli`, `@gullabs/codex-cli`). `requireAuth()` now accepts either variant. This is a shape-only extension — existing `{ apiKey }` call sites keep compiling unchanged.

`@gullabs/google` narrows to `ApiKeyAuth` via a new `requireApiKey(auth)` helper and throws `invalid_auth` when `apiKey` is missing; the Google adapter, cache store, and file store never accept `CliSessionAuth`.
