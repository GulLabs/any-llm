import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { zodToStandardSchema } from './standard-schema.js'

describe('zodToStandardSchema', () => {
  it('adapts Zod safeParse to StandardSchema v1', () => {
    const schema = z
      .strictObject({
        tier: z.literal('gold'),
      })
      .meta({ title: 'TierOnly', description: 'Gold-tier-only test schema.' })

    const validator = zodToStandardSchema(schema)
    const success = validator['~standard'].validate({ tier: 'gold' })
    const failure = validator['~standard'].validate({ tier: 'silver' })

    expect('value' in success && success.value).toEqual({ tier: 'gold' })
    expect('issues' in failure).toBe(true)
  })

  it('defaults the vendor tag and allows overriding it', () => {
    const schema = z.strictObject({}).meta({ title: 'Empty', description: 'Empty.' })

    expect(zodToStandardSchema(schema)['~standard'].vendor).toBe('gullabs-zod4')
    expect(zodToStandardSchema(schema, 'custom-vendor')['~standard'].vendor).toBe(
      'custom-vendor',
    )
  })

  it('reports issue paths for nested validation failures', () => {
    const schema = z
      .strictObject({ nested: z.strictObject({ value: z.number() }) })
      .meta({ title: 'Nested', description: 'Nested test schema.' })

    const validator = zodToStandardSchema(schema)
    const result = validator['~standard'].validate({ nested: { value: 'not-a-number' } })

    expect('issues' in result).toBe(true)
    if ('issues' in result) {
      expect(result.issues?.[0]?.path).toEqual(['nested', 'value'])
    }
  })
})
