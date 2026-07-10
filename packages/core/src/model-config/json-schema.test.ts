import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { toConfigJsonSchema } from './json-schema.js'

describe('toConfigJsonSchema', () => {
  it('derives a JSON Schema that preserves Zod metadata', () => {
    const schema = z
      .strictObject({
        temperature: z
          .number()
          .min(0)
          .max(2)
          .optional()
          .meta({
            title: 'Temperature',
            description: 'Sampling temperature.',
            examples: [0.7],
          }),
      })
      .meta({ title: 'AcmeConfig', description: 'Test schema for acme-model.' })

    const jsonSchema = toConfigJsonSchema(schema) as Record<string, unknown>
    const properties = jsonSchema['properties'] as Record<string, unknown>
    const temperature = properties['temperature'] as Record<string, unknown>

    expect(jsonSchema['title']).toBe('AcmeConfig')
    expect(jsonSchema['description']).toMatch(/acme-model/i)
    expect(temperature['title']).toBe('Temperature')
    expect(temperature['description']).toMatch(/sampling temperature/i)
    expect(temperature['examples']).toEqual([0.7])
  })

  it('marks strict objects with additionalProperties: false', () => {
    const schema = z
      .strictObject({ foo: z.string().optional() })
      .meta({ title: 'Strict', description: 'Strict test schema.' })

    const jsonSchema = toConfigJsonSchema(schema) as Record<string, unknown>

    expect(jsonSchema['additionalProperties']).toBe(false)
  })

  it('throws when JSON Schema generation encounters an unrepresentable Zod construct', () => {
    expect(() => toConfigJsonSchema(z.map(z.string(), z.string()))).toThrow()
  })
})
