/**
 * Tests for input-contracts commit C1: D1 (strict template interpolation),
 * D2 (`CallSite.inputSchema`), and their interaction with D6 (`issues`).
 *
 * D6's own normalization/drift-pinning tests live in errors.test.ts (unit
 * level) and engine.test.ts (config-validation integration level).
 *
 * @module
 */

import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { createClient, createModelRegistry, defineCallSite, LlmError } from './index.js'
import type { AdapterResult, Usage } from './index.js'
import type { StandardSchemaV1 } from './standard-schema.js'
import { FakeAdapter, FakeClock, FakeIds, RecordingSink } from '@gullabs/testing'
import { zodToStandardSchema } from './model-config/index.js'
import { makePermissiveTestDescriptor } from './test-model-descriptor.js'
import { makeTestPricingSource } from './test-pricing-source.js'

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const GOOD_USAGE: Usage = {
  inputTokens: 50,
  outputTokens: 10,
  details: {},
  raw: null,
}

function successResult(overrides?: Partial<AdapterResult>): AdapterResult {
  return {
    text: 'result text',
    usage: GOOD_USAGE,
    model: 'gemini-2.5-flash',
    warnings: [],
    ...overrides,
  }
}

const TEST_AUTH = { apiKey: 'test-key' }
const PRICING = makeTestPricingSource(
  {
    'gemini-2.5-flash': { inputPerM: 300_000, cachedPerM: 30_000, outputPerM: 2_500_000 },
  },
  { standard: 1 },
  'test-pricing-1',
)
const TEST_REGISTRY = createModelRegistry([
  makePermissiveTestDescriptor({ model: 'gemini-2.5-flash', provider: 'google' }),
])

function makeClient(adapter: FakeAdapter, sink?: RecordingSink) {
  return createClient({
    adapters: [adapter],
    pricingSources: { google: PRICING },
    modelRegistry: TEST_REGISTRY,
    sink: sink ?? new RecordingSink(),
    clock: new FakeClock(),
    ids: new FakeIds(),
  })
}

// ---------------------------------------------------------------------------
// D1 — strict template interpolation
// ---------------------------------------------------------------------------

describe('D1 — strict template interpolation', () => {
  it('unresolved placeholder in userTemplate throws bad_request, not retryable, with issues', async () => {
    const adapter = new FakeAdapter('google', successResult())
    const client = makeClient(adapter)
    const cs = defineCallSite({
      id: 'cs-user',
      provider: 'google',
      model: 'gemini-2.5-flash',
      userTemplate: 'Hello {{name}}',
    })

    await expect(client.runStructured(cs, {}, { auth: TEST_AUTH })).rejects.toMatchObject(
      {
        kind: 'bad_request',
        retryable: false,
        issues: [{ path: 'name' }],
      },
    )
    expect(adapter.calls).toHaveLength(0)
  })

  it('unresolved placeholder in system template throws bad_request with issues', async () => {
    const adapter = new FakeAdapter('google', successResult())
    const client = makeClient(adapter)
    const cs = defineCallSite({
      id: 'cs-system',
      provider: 'google',
      model: 'gemini-2.5-flash',
      system: 'You serve {{tenant}}.',
      userTemplate: 'Hi',
    })

    await expect(client.runStructured(cs, {}, { auth: TEST_AUTH })).rejects.toMatchObject(
      {
        kind: 'bad_request',
        retryable: false,
        issues: [{ path: 'tenant' }],
      },
    )
    expect(adapter.calls).toHaveLength(0)
  })

  it('unresolved placeholders in both templates: violations from both surface in one error', async () => {
    const adapter = new FakeAdapter('google', successResult())
    const client = makeClient(adapter)
    const cs = defineCallSite({
      id: 'cs-both',
      provider: 'google',
      model: 'gemini-2.5-flash',
      system: 'System for {{tenant}}.',
      userTemplate: 'Hello {{name}}',
    })

    const err = await client.runStructured(cs, {}, { auth: TEST_AUTH }).catch((e) => e)
    expect(err).toBeInstanceOf(LlmError)
    expect(err.kind).toBe('bad_request')
    expect(err.retryable).toBe(false)
    const paths = (err.issues as Array<{ path: string }>).map((i) => i.path).sort()
    expect(paths).toEqual(['name', 'tenant'])
    expect(adapter.calls).toHaveLength(0)
  })

  it('null value for a placeholder is a violation', async () => {
    const adapter = new FakeAdapter('google', successResult())
    const client = makeClient(adapter)
    const cs = defineCallSite({
      id: 'cs-null',
      provider: 'google',
      model: 'gemini-2.5-flash',
      userTemplate: 'Hello {{name}}',
    })

    await expect(
      client.runStructured(cs, { name: null as unknown as string }, { auth: TEST_AUTH }),
    ).rejects.toMatchObject({
      kind: 'bad_request',
      retryable: false,
      issues: [{ path: 'name' }],
    })
    expect(adapter.calls).toHaveLength(0)
  })

  it('undefined value for a placeholder is a violation', async () => {
    const adapter = new FakeAdapter('google', successResult())
    const client = makeClient(adapter)
    const cs = defineCallSite({
      id: 'cs-undefined',
      provider: 'google',
      model: 'gemini-2.5-flash',
      userTemplate: 'Hello {{name}}',
    })

    await expect(
      client.runStructured(
        cs,
        { name: undefined as unknown as string },
        { auth: TEST_AUTH },
      ),
    ).rejects.toMatchObject({
      kind: 'bad_request',
      retryable: false,
      issues: [{ path: 'name' }],
    })
    expect(adapter.calls).toHaveLength(0)
  })

  it('non-string value (number) is a violation — never coerced', async () => {
    const adapter = new FakeAdapter('google', successResult())
    const client = makeClient(adapter)
    const cs = defineCallSite({
      id: 'cs-number',
      provider: 'google',
      model: 'gemini-2.5-flash',
      userTemplate: 'Age: {{age}}',
    })

    await expect(
      client.runStructured(cs, { age: 30 as unknown as string }, { auth: TEST_AUTH }),
    ).rejects.toMatchObject({
      kind: 'bad_request',
      retryable: false,
      issues: [{ path: 'age' }],
    })
    expect(adapter.calls).toHaveLength(0)
  })

  it('non-string value (object) is a violation — never coerced', async () => {
    const adapter = new FakeAdapter('google', successResult())
    const client = makeClient(adapter)
    const cs = defineCallSite({
      id: 'cs-object',
      provider: 'google',
      model: 'gemini-2.5-flash',
      userTemplate: 'Data: {{data}}',
    })

    await expect(
      client.runStructured(
        cs,
        { data: { nested: true } as unknown as string },
        { auth: TEST_AUTH },
      ),
    ).rejects.toMatchObject({
      kind: 'bad_request',
      retryable: false,
      issues: [{ path: 'data' }],
    })
    expect(adapter.calls).toHaveLength(0)
  })

  it('multiple violations are all reported in one error (not just the first)', async () => {
    const adapter = new FakeAdapter('google', successResult())
    const client = makeClient(adapter)
    const cs = defineCallSite({
      id: 'cs-multi',
      provider: 'google',
      model: 'gemini-2.5-flash',
      userTemplate: 'Hello {{first}} {{second}} {{third}}',
    })

    const err = await client
      .runStructured(cs, { second: 42 as unknown as string }, { auth: TEST_AUTH })
      .catch((e) => e)
    expect(err).toBeInstanceOf(LlmError)
    const paths = (err.issues as Array<{ path: string }>).map((i) => i.path).sort()
    expect(paths).toEqual(['first', 'second', 'third'])
    expect(err.message).toContain('{{first}}')
    expect(err.message).toContain('{{second}}')
    expect(err.message).toContain('{{third}}')
    expect(adapter.calls).toHaveLength(0)
  })

  it('unused extra vars are allowed (shared context bag across call sites)', async () => {
    const adapter = new FakeAdapter('google', successResult())
    const client = makeClient(adapter)
    const cs = defineCallSite({
      id: 'cs-extra',
      provider: 'google',
      model: 'gemini-2.5-flash',
      userTemplate: 'Hello {{name}}',
    })

    await client.runStructured(
      cs,
      { name: 'Ada', unusedInThisTemplate: 'whatever' },
      { auth: TEST_AUTH },
    )

    expect(adapter.calls).toHaveLength(1)
    const part = adapter.calls[0]!.messages[0]?.parts[0] as { text: string }
    expect(part.text).toBe('Hello Ada')
  })

  it('a call site with no templates is unchanged by D1', async () => {
    const adapter = new FakeAdapter('google', successResult())
    const client = makeClient(adapter)
    const cs = defineCallSite({
      id: 'cs-no-template',
      provider: 'google',
      model: 'gemini-2.5-flash',
    })

    await client.runStructured(cs, { auth: TEST_AUTH })
    expect(adapter.calls).toHaveLength(1)
    const part = adapter.calls[0]!.messages[0]?.parts[0] as { text: string }
    expect(part.text).toBe('')
  })

  it('a template with no {{ is unchanged by D1', async () => {
    const adapter = new FakeAdapter('google', successResult())
    const client = makeClient(adapter)
    const cs = defineCallSite({
      id: 'cs-plain',
      provider: 'google',
      model: 'gemini-2.5-flash',
      userTemplate: 'Plain text, no placeholders here.',
    })

    await client.runStructured(cs, { auth: TEST_AUTH })
    expect(adapter.calls).toHaveLength(1)
    const part = adapter.calls[0]!.messages[0]?.parts[0] as { text: string }
    expect(part.text).toBe('Plain text, no placeholders here.')
  })
})

// ---------------------------------------------------------------------------
// D2 — CallSite.inputSchema
// ---------------------------------------------------------------------------

describe('D2 — CallSite.inputSchema', () => {
  const VarsSchema = z.object({
    name: z.string().min(1),
    age: z.string(),
  })

  it('valid vars pass through to the adapter', async () => {
    const adapter = new FakeAdapter('google', successResult())
    const client = makeClient(adapter)
    const cs = defineCallSite({
      id: 'cs-valid',
      provider: 'google',
      model: 'gemini-2.5-flash',
      userTemplate: 'Hello {{name}}, age {{age}}',
      inputSchema: zodToStandardSchema(VarsSchema),
    })

    await client.runStructured(cs, { name: 'Ada', age: '30' }, { auth: TEST_AUTH })
    expect(adapter.calls).toHaveLength(1)
  })

  it('invalid vars throw bad_request with every failing path in issues', async () => {
    const adapter = new FakeAdapter('google', successResult())
    const client = makeClient(adapter)
    const cs = defineCallSite({
      id: 'cs-invalid',
      provider: 'google',
      model: 'gemini-2.5-flash',
      userTemplate: 'Hello {{name}}, age {{age}}',
      inputSchema: zodToStandardSchema(VarsSchema),
    })

    const err = await client
      .runStructured(cs, { name: '', age: '30' }, { auth: TEST_AUTH })
      .catch((e) => e)

    expect(err).toBeInstanceOf(LlmError)
    expect(err.kind).toBe('bad_request')
    expect(err.retryable).toBe(false)
    expect((err.issues as Array<{ path: string }>).map((i) => i.path)).toEqual(['name'])
    expect(adapter.calls).toHaveLength(0)
  })

  it('async validators are supported', async () => {
    const asyncSchema: StandardSchemaV1<Record<string, string>> = {
      '~standard': {
        version: 1,
        vendor: 'test-async',
        async validate(value: unknown) {
          await new Promise((resolve) => setTimeout(resolve, 0))
          const v = value as Record<string, string>
          if (v['name'] === undefined) {
            return { issues: [{ message: 'name is required', path: ['name'] }] }
          }
          return { value: v }
        },
      },
    }

    const adapter = new FakeAdapter('google', successResult())
    const client = makeClient(adapter)
    const cs = defineCallSite({
      id: 'cs-async',
      provider: 'google',
      model: 'gemini-2.5-flash',
      userTemplate: 'Hi',
      inputSchema: asyncSchema,
    })

    await expect(client.runStructured(cs, {}, { auth: TEST_AUTH })).rejects.toMatchObject(
      { kind: 'bad_request', retryable: false, issues: [{ path: 'name' }] },
    )
    expect(adapter.calls).toHaveLength(0)

    await client.runStructured(cs, { name: 'Ada' }, { auth: TEST_AUTH })
    expect(adapter.calls).toHaveLength(1)
  })

  it('D2 runs before D1: a field missing from BOTH the schema and the template surfaces as the schema error', async () => {
    const adapter = new FakeAdapter('google', successResult())
    const client = makeClient(adapter)
    const cs = defineCallSite({
      id: 'cs-ordering',
      provider: 'google',
      model: 'gemini-2.5-flash',
      userTemplate: 'Hello {{name}}',
      inputSchema: zodToStandardSchema(z.object({ name: z.string().min(1) })),
    })

    // 'name' is both required by the schema AND referenced by the template.
    // Omitting it entirely must surface as the schema's own error (D2),
    // never as a D1 unresolved-placeholder violation.
    const err = await client.runStructured(cs, {}, { auth: TEST_AUTH }).catch((e) => e)
    expect(err).toBeInstanceOf(LlmError)
    expect(err.issues[0].path).toBe('name')
    // Distinguish the D2 message shape ("vars.<path>") from the D1 shape
    // ("has unresolved template placeholder(s)").
    expect(err.message).toContain('vars.name')
    expect(err.message).not.toContain('unresolved template placeholder')
    expect(adapter.calls).toHaveLength(0)
  })

  it('schema validator is invoked exactly once (no double validation)', async () => {
    const validate = vi.fn((value: unknown) => ({
      value: value as Record<string, string>,
    }))
    const schema: StandardSchemaV1<Record<string, string>> = {
      '~standard': { version: 1, vendor: 'test-count', validate },
    }

    const adapter = new FakeAdapter('google', successResult())
    const client = makeClient(adapter)
    const cs = defineCallSite({
      id: 'cs-once',
      provider: 'google',
      model: 'gemini-2.5-flash',
      userTemplate: 'Hi {{name}}',
      inputSchema: schema,
    })

    await client.runStructured(cs, { name: 'Ada' }, { auth: TEST_AUTH })
    expect(validate).toHaveBeenCalledTimes(1)
  })

  it('two-arg overload (vars defaulted to {}) still runs D2: schema issues surface', async () => {
    const adapter = new FakeAdapter('google', successResult())
    const client = makeClient(adapter)
    const cs = defineCallSite({
      id: 'cs-two-arg',
      provider: 'google',
      model: 'gemini-2.5-flash',
      userTemplate: 'Hello {{name}}',
      inputSchema: zodToStandardSchema(z.object({ name: z.string().min(1) })),
    })

    // No vars argument: runStructured defaults vars to {} — the inputSchema
    // must still be enforced on that defaulted bag, and its violation must be
    // the schema's own error (D2 message shape), not a D1 placeholder error.
    const err = await client.runStructured(cs, { auth: TEST_AUTH }).catch((e) => e)
    expect(err).toBeInstanceOf(LlmError)
    expect(err.kind).toBe('bad_request')
    expect(err.retryable).toBe(false)
    expect((err.issues as Array<{ path: string }>).map((i) => i.path)).toEqual(['name'])
    expect(err.message).toContain('vars.name')
    expect(err.message).not.toContain('unresolved template placeholder')
    expect(adapter.calls).toHaveLength(0)
  })

  it('inputSchema absent → no D2 validation performed (unchanged behavior)', async () => {
    const adapter = new FakeAdapter('google', successResult())
    const client = makeClient(adapter)
    const cs = defineCallSite({
      id: 'cs-none',
      provider: 'google',
      model: 'gemini-2.5-flash',
      userTemplate: 'Hi {{name}}',
    })

    await client.runStructured(cs, { name: 'Ada' }, { auth: TEST_AUTH })
    expect(adapter.calls).toHaveLength(1)
  })
})
