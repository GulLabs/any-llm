---
'@gullabs/xai': patch
---

Docs + fixture + test only — zero adapter behavior change. Codifies the 2026-07-09 live-verified finding that xAI's `strict: true` on `text.format` json_schema performs no OpenAI-style compile-time schema validation (missing `additionalProperties: false`, optional properties, `format`/other keywords, `anyOf`, `$defs`/`$ref`, and nullable unions were all accepted with HTTP 200 across 13 live probes). Adds a fixture (`10-non-strict-schema-accepted.json`) and a fixture-backed test proving this adapter forwards schemas to xAI verbatim, and documents in the README that OpenAI-strict schema rewriting is unnecessary for xai as of that verification date.
