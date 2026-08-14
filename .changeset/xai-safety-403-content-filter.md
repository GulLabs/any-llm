---
'@gullabs/xai': patch
'@gullabs/any-llm': patch
---

Classify xAI safety-check HTTP 403 (`Content violates usage guidelines` / `SAFETY_CHECK_TYPE_*`) as `content_filter` instead of `invalid_auth`. HTTP status is a hint; adapters overlay from the structured body only. A bare 403 stays `invalid_auth`. Packaged skill documents the default-vs-overlay rule.
