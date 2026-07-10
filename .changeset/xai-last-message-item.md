---
'@gullabs/xai': patch
---

Fix a live-observed correctness defect: when the xAI Responses API returns multiple `type: 'message'` output items in one response (observed live: strict `json_schema` mode, `grok-4.5`, reasoning effort `high`, two complete JSON documents in two separate message items), the adapter previously concatenated `output_text` across ALL message items, producing corrupted, invalid-JSON text (`...}\n}{\n"..."`). This broke a downstream consumer's parse gate and killed a Temporal audit run.

The adapter now takes only the LAST `type: 'message'` output item's `output_text` parts as the result text, matching the Responses API convention that the final message item is the response and earlier ones are superseded. Joining multiple `output_text` parts *within* a single message item is unchanged (that is legitimate segmentation, not duplication), and `reasoningText` assembly from `type: 'reasoning'` items is unaffected. When more than one message item is present, a `warnings` entry now names the dropped item count.
