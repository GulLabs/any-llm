---
'@gullabs/codex-cli': minor
---

Local preflight now enforces both live-verified OpenAI-strict `--output-schema` backend rules (`additionalProperties: false` on every object node, and `required` covering every key in `properties`), over the complete JSON-Schema draft-2020-12 subschema traversal — and a new explicit, opt-in `toOpenAiStrictOutputSchema()` helper lets callers rewrite a schema into compliance.

**Intentional observable behavior break:** schemas that violate the `required`-completeness rule (rule 2) previously dispatched to the backend and failed after a network round-trip with a provider-classified error; they now fail locally, before dispatch, with a typed `bad_request` `LlmError` naming the offending node's JSON path and the first missing key. Additionally, the widened traversal (`patternProperties`, `contains`, `if`/`then`/`else`, `dependentSchemas`, `propertyNames`, `unevaluatedProperties`/`unevaluatedItems`, `contentSchema`, schema-valued `additionalProperties`, and tuple-form `prefixItems`) means rule-1/rule-2 violations in these previously-unvisited subschema positions are now also caught locally instead of only surfacing as a provider 400 after a round-trip. Both changes convert provider 400s into earlier local rejections for schemas the backend already rejects — no schema the backend accepts becomes rejected.

**New export:** `toOpenAiStrictOutputSchema(schema)` — a pure, deep-cloning, explicit opt-in helper (never called by the adapter itself) that injects `additionalProperties: false` where absent, completes `required` for every `properties` key, and makes previously-optional properties nullable-required (`type: T` → `type: [T, 'null']`) instead of silently making them mandatory. Rejects (rather than rewrites) an explicit `additionalProperties: true`/schema-valued `additionalProperties`, and a malformed (non-string-array) `required`.

The adapter's previous internal rule-1-only preflight helper is deleted outright and replaced by `assertOpenAiStrictOutputSchema` — no compatibility alias and no legacy-named code is kept, per this repo's no-legacy-compatibility rule.
