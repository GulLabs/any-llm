---
'@gullabs/any-llm': patch
'@gullabs/claude-cli': patch
'@gullabs/codex-cli': patch
'@gullabs/core': patch
'@gullabs/drizzle': patch
'@gullabs/google': patch
'@gullabs/quota': patch
'@gullabs/testing': patch
'@gullabs/xai': patch
---

Point `repository.url`, `homepage`, and `bugs` at the canonical GitHub org path
`gul-labs/any-llm`. The org was renamed from `GulLabs`; the old path still
redirects in a browser, but npm provenance matches `repository.url` literally
against the attestation's `sourceRepositoryURI`, so a redirect does not satisfy
it and the next provenance publish would have failed the same way the earlier
lowercase-casing incident did.

The npm scope `@gullabs` is a separate namespace and is unchanged.
