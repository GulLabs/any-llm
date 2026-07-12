---
'@gullabs/codex-cli': patch
'@gullabs/claude-cli': patch
---

Fix `totalTokens` being permanently omitted from `Usage` (and thus null in `llm_calls.total_tokens`) for every codex-cli and claude-cli call. Neither CLI's JSON output reports a total-tokens figure directly — `codex exec --json`'s `turn.completed.usage` and `claude -p --output-format json`'s result envelope `usage` object both only report `input_tokens`/`output_tokens` (plus subset fields like `cached_input_tokens`/`reasoning_output_tokens`/`cache_read_input_tokens`). `inputTokens`/`outputTokens` were already captured correctly; only the derived total was missing.

`mapUsage()` in both adapters now derives `totalTokens = inputTokens + outputTokens` (a GROSS total — subset fields like `reasoning_output_tokens`/`cached_input_tokens` are not added again) whenever a usage payload was actually present on the CLI response. When the CLI reports no usage payload at all, `totalTokens` stays `undefined` rather than being synthesized as `0`, matching how `inputTokens`/`outputTokens` already fall back only as a last resort.
