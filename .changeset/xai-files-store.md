---
"@gullabs/core": minor
"@gullabs/xai": minor
"@gullabs/google": patch
---

Add xAI Files store (`XaiFileStore`) and core `FileRefPart` for provider-hosted file ids.

- `@gullabs/core`: new `FileRefPart` (`kind: 'file-ref'`) + `isFileRefPart` guard on the `Part` union.
- `@gullabs/xai`: `XaiFileStore` (upload with TTL, get, list, idempotent delete, content); adapter maps `file-ref` → Responses `input_file.file_id`; rejects Gemini Files URIs.
- `@gullabs/google`: reject `file-ref` with clear `bad_request` (Gemini uses `FileUriPart` URIs).
