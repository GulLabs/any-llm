---
'@gullabs/core': patch
'@gullabs/google': patch
'@gullabs/any-llm': patch
---

Fix bugs found in a second round of independent Codex adversarial review, run
against the commits from the previous two releases:

- `@gullabs/core`: `resolveReasoning()` now rejects negative, non-integer, `NaN`,
  and `Infinity` `budgetTokens` with a deterministic `bad_request` `LlmError`
  instead of silently mapping them to a valid reasoning effort. The Gemini
  config JSON Schema's `reasoning.budgetTokens` property now also declares
  `minimum: 0` for defense-in-depth consistency with the same check.
- `@gullabs/google`: `normalizeGroundingCitations()` now only produces
  citations for `http:`/`https:` URLs with a non-empty hostname, skipping
  malformed/unsafe schemes (e.g. `javascript:`, `mailto:`) instead of
  including them in the returned citation list.
- `@gullabs/any-llm`: fixed the shipped skill's `Cost.microUsd` nullability
  comment (it's `number | null`, not `number | undefined`).
