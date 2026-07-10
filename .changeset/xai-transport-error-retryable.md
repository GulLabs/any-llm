---
'@gullabs/xai': patch
---

Fix a live-observed correctness defect: transport-level connection failures (the `openai` SDK's `APIConnectionError` / `APIConnectionTimeoutError`, thrown as `"Connection error."` when the request never reaches xAI's servers, plus Node/undici errno signatures like `ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`, `EAI_AGAIN`, `EPIPE`, `socket hang up`, and `fetch failed`) previously fell through `classifyXaiError`'s generic HTTP-status classification to `kind: 'unknown', retryable: false`. Temporal treats `retryable: false` as fatal, so a transient network blip was killing module-audit and stage-6 runs outright instead of being retried (observed live 2026-07-10, redline e2e runs `f6eca8f9` and `51f64c2f`).

These are now reclassified `kind: 'server', retryable: true` — the same "provider fault, not caller fault, safe to retry" bucket this adapter already uses elsewhere for provider-side failures with no HTTP status. Detection matches the OpenAI SDK's error class by constructor name (avoiding a runtime import of `openai` outside `client.ts`), falls back to message/errno pattern matching, and also inspects a wrapped `.cause`. All prior classifications (auth, rate-limit, bad-request, timeout, content-filter) are unchanged.
