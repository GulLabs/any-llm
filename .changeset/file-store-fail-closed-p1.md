---
'@gullabs/xai': minor
'@gullabs/google': minor
'@gullabs/testing': minor
---

File-store fail-closed delete + xAI Files host ergonomics.

- `XaiFileStore` / `GoogleFileStore`: `delete(id, { failClosed?: boolean, signal? })` — default fail-open; opt-in throw on non-not-found failures; empty id always `bad_request`; 404 success both modes.
- `@gullabs/testing`: `FakeXaiFileStore` in-memory store with TTL clock and fail-closed delete.
- Docs: multi-provider install (core + google + xai + peers); attachment_search counters visible on `usage.details` / `usage.raw`.
