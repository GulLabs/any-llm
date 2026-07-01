# Caller-owned structured-output validation

`@gullabs/core` intentionally treats `output.jsonSchema` as a **provider hint** and not a contract that
the engine enforces. It parses JSON when possible, sets `outputParsed`, and leaves business-level shape
validation to callers.

Use this helper after any structured-output call:

- first gate on `outputParsed` (cheap, boolean signal from the provider path)
- then validate `output` with a Standard-Schema v1 validator (`'~standard'`, same interface as
  `packages/core/src/standard-schema.ts`)

```ts
import type { StandardSchemaV1 } from '@gullabs/core'

type StructuredValidationResult<T> =
  | { ok: true; value: T }
  | {
      ok: false
      reason: 'not_parsed' | 'shape_invalid'
      issues?: readonly StandardSchemaV1.Issue[]
    }

async function validateStructuredResult<T>(
  result: { output?: unknown; outputParsed?: boolean },
  schema: StandardSchemaV1<unknown, T>,
): Promise<StructuredValidationResult<T>> {
  if (result.outputParsed !== true) {
    return { ok: false, reason: 'not_parsed' }
  }

  const parsed = await schema['~standard'].validate(result.output)

  if ('issues' in parsed) {
    return { ok: false, reason: 'shape_invalid', issues: parsed.issues }
  }

  return { ok: true, value: parsed.value }
}
```

Use any Standard-Schema implementation. This example uses two hand-rolled schemas to show portability:

```ts
const summarySchema: StandardSchemaV1 = {
  '~standard': {
    version: 1,
    vendor: 'example/summary',
    validate(value) {
      const maybe = value as Record<string, unknown>
      if (
        value !== null &&
        typeof value === 'object' &&
        typeof maybe['summary'] === 'string' &&
        typeof maybe['confidence'] === 'number'
      ) {
        return {
          value: { summary: maybe['summary'], confidence: maybe['confidence'] },
        }
      }

      return { issues: [{ message: 'summary schema mismatch' }] }
    },
    types: {
      input: { summary: '' as string, confidence: 0 as number },
      output: { summary: '' as string, confidence: 0 as number },
    },
  },
}

const citationShapeSchema: StandardSchemaV1 = {
  '~standard': {
    version: 1,
    vendor: 'example/citations',
    validate(value) {
      const maybe = value as Record<string, unknown>
      return maybe && typeof maybe === 'object' && Array.isArray(maybe['citations'])
        ? { value: { citations: maybe['citations'] } }
        : { issues: [{ message: 'citations must be an array' }] }
    },
    types: {
      input: { citations: [] as unknown[] },
      output: { citations: [] as unknown[] },
    },
  },
}
```

This pattern is the caller-owned fix for the gap documented as **"New gap: silent structured-output parse failures"**
in `docs/ADOPTION-FEEDBACK.md`.

## Example usage

```ts
const validation = await validateStructuredResult(
  result,
  result.output?.summary === undefined
    ? citationShapeSchema
    : summarySchema,
)

if (!validation.ok && validation.reason === 'not_parsed') {
  // retry, escalate, or run fallback path
} else if (!validation.ok) {
  // shape invalid but parsed; inspect validation.issues and decide retry policy
} else {
  // validation.value is typed to your chosen schema
}
```

The helper does not mutate `result`; it is pure and composable in your retry, retry-window, and audit
pipelines.
