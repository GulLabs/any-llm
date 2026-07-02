# Grounded -> Structured on Gemini

Gemini grounding and native structured output are mutually exclusive in one request. The Google
adapter enforces that directly: if `providerOptions.google.tools` requests `googleSearch` or
`googleSearchRetrieval` and the same request also sets `output.jsonSchema`, the library throws
`bad_request`.

The recommended pattern is two calls:

1. grounded research;
2. structured synthesis.

Both attempts flow through the normal sink and keep separate ledger rows.

## Why there is no `runGroundedStructured()`

The library intentionally does not ship a one-off client method here yet. Hosts have different
requirements for prompt framing, validation, citation retention, and how they join the two attempts
back into their own workflow tables. The stable first step is a documented recipe with normal
`generate()` / `runStructured()` calls.

## Call 1: grounded research

```ts
const operationId = 'op-2026-01-research'

const research = await client.generate(
  {
    model: 'gemini-2.5-pro',
    system: 'Research the topic and quote only grounded findings.',
    messages: [
      {
        role: 'user',
        parts: [{ kind: 'text', text: `Research: ${topic}` }],
      },
    ],
    callSiteId: 'grounded-research',
    metadata: {
      operationId,
      workflowId,
      reportId,
      phase: 'research',
    },
    config: {
      serviceTier: 'flex',
      providerOptions: {
        google: {
          tools: [{ googleSearch: {} }],
        },
      },
    },
  },
  { auth },
)
```

Important outputs from the first call:

- `research.text` — grounded prose you can pass into synthesis;
- `research.providerMetadata?.groundingMetadata` — Gemini grounding payload;
- `research.providerMetadata?.promptFeedback` — prompt-level provider feedback;
- `research.attemptId` — the correlation key for the ledger sidecar pattern: use it as the
  foreign key if you keep a host-owned sidecar row for this attempt (see `docs/ledger.md`).

## Small application-local normalizer

The provider metadata lane is intentionally raw JSON. A small app-local helper keeps the rest of
your workflow code from probing nested provider fields ad hoc:

```ts
type GroundingArtifacts = {
  groundingMetadata?: unknown
  promptFeedback?: unknown
}

function extractGroundingArtifacts(providerMetadata: unknown): GroundingArtifacts {
  if (providerMetadata === null || typeof providerMetadata !== 'object') {
    return {}
  }

  const meta = providerMetadata as Record<string, unknown>
  return {
    ...(meta['groundingMetadata'] !== undefined
      ? { groundingMetadata: meta['groundingMetadata'] }
      : {}),
    ...(meta['promptFeedback'] !== undefined
      ? { promptFeedback: meta['promptFeedback'] }
      : {}),
  }
}
```

Once you have `groundingMetadata`, `@gullabs/google` ships `normalizeGroundingCitations()` so you
don't need a bespoke dedup-by-URI helper: it shapes `groundingMetadata.groundingChunks` into a
clean, deduplicated `Citation[]` (`{ url, sourceName }`), preferring each chunk's title and falling
back to the URL's hostname, and never throws on missing/malformed input.

```ts
import { normalizeGroundingCitations } from '@gullabs/google'

const citations = normalizeGroundingCitations(grounding.groundingMetadata)
```

## Call 2: structured synthesis

```ts
const grounding = extractGroundingArtifacts(research.providerMetadata)

const structured = await client.generate(
  {
    model: 'gemini-2.5-flash',
    system: 'Convert grounded research into a structured summary.',
    messages: [
      {
        role: 'user',
        parts: [
          {
            kind: 'text',
            text: [
              'Grounded research:',
              research.text ?? '',
              '',
              'Citation context:',
              JSON.stringify(grounding),
            ].join('\n'),
          },
        ],
      },
    ],
    output: {
      jsonSchema: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
          citationsUsed: { type: 'array', items: { type: 'string' } },
        },
        required: ['summary', 'confidence', 'citationsUsed'],
      },
    },
    callSiteId: 'grounded-summary',
    metadata: {
      operationId,
      workflowId,
      reportId,
      phase: 'synthesis',
      groundedAttemptId: research.attemptId,
    },
  },
  {
    auth,
  },
)
```

`structured.output` is JSON-parsed when the model produced valid JSON. The library does not
validate the shape; callers still own schema validation and retry policy.

## Persistence pattern

Recommended persistence flow:

1. let `drizzleUsageSink()` write both `llm_calls` rows normally;
2. keep a host sidecar row for workflow-specific context if you need typed joins;
3. store the relationship between the two attempts in host-owned fields such as
   `groundedAttemptId` or `synthesisAttemptId`.

That produces a durable audit trail without adding special-purpose library APIs.

## What to correlate on

- Use `metadata.operationId` as the canonical link between grounded-research and structured-synthesis.
- `externalId` can still carry one caller-owned convenience id for filtering (for example,
  `reportId`), and a sidecar table is still the right place for typed joins.
- Use `operationId` consistently for this operation; do not define a separate correlation key.

This convention is shared with the multi-runtime example in `docs/multi-runtime.md` so both workflow
chains and runtime boundaries reuse the same relationship field.
