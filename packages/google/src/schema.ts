/**
 * zodToGeminiSchema — best-effort Zod-to-Gemini Schema converter.
 *
 * Supports common shapes: object, string, number (int detection), boolean,
 * array, enum, optional, nullable, default, literal.
 *
 * Returns `undefined` for unsupported shapes — the caller emits a Warning and
 * falls back to plain JSON output without a responseSchema.  The engine always
 * Zod-validates output regardless; this is only a best-effort model hint.
 *
 * @module
 */

import {
  ZodObject,
  ZodString,
  ZodNumber,
  ZodBoolean,
  ZodArray,
  ZodEnum,
  ZodOptional,
  ZodNullable,
  ZodDefault,
  ZodLiteral,
  type ZodTypeAny,
} from 'zod'

import type { GeminiSchema } from './client.js'

// Re-export for consumers.
export type { GeminiSchema }

// ---------------------------------------------------------------------------
// Optionality helper
// ---------------------------------------------------------------------------

/**
 * Returns `true` if the field's wrapper chain contains `ZodOptional` or
 * `ZodDefault` — meaning the field is **not** required in the Gemini schema.
 *
 * Recursively unwraps `ZodNullable` so that combinations such as
 * `z.string().optional().nullable()` and `z.string().nullable().optional()`
 * are both correctly detected as optional.
 *
 * Design note: `ZodNullable` alone does NOT make a field optional (the field
 * is still required, it just also accepts `null`).  Only `ZodOptional` or
 * `ZodDefault` anywhere in the chain makes it non-required.
 *
 * @param schema - The Zod field type (direct value from `ZodObject.shape`).
 */
function isOptionalField(schema: ZodTypeAny): boolean {
  if (schema instanceof ZodOptional || schema instanceof ZodDefault) return true
  if (schema instanceof ZodNullable) {
    const unwrapped = schema.unwrap() as unknown as ZodTypeAny
    return isOptionalField(unwrapped)
  }
  return false
}

/**
 * Convert a Zod schema to a Gemini Schema object.
 *
 * @param schema - Any Zod type.
 * @returns A GeminiSchema on success; `undefined` for unsupported shapes.
 */
export function zodToGeminiSchema(schema: ZodTypeAny): GeminiSchema | undefined {
  return convertSchema(schema, false)
}

function convertSchema(schema: ZodTypeAny, nullable: boolean): GeminiSchema | undefined {
  const desc: string | undefined =
    typeof schema.description === 'string' ? schema.description : undefined

  // ---- ZodOptional → unwrap, mark non-required at parent level ----
  if (schema instanceof ZodOptional) {
    const unwrapped = schema.unwrap() as unknown as ZodTypeAny
    return convertSchema(unwrapped, nullable)
  }

  // ---- ZodNullable → unwrap, set nullable:true ----
  if (schema instanceof ZodNullable) {
    const unwrapped = schema.unwrap() as unknown as ZodTypeAny
    return convertSchema(unwrapped, true)
  }

  // ---- ZodDefault → unwrap inner type ----
  if (schema instanceof ZodDefault) {
    // Access via _def.innerType (the internal storage field).
    const innerType = (schema._def as unknown as { innerType: ZodTypeAny }).innerType
    return convertSchema(innerType, nullable)
  }

  // ---- ZodObject ----
  if (schema instanceof ZodObject) {
    const shape = schema.shape as Record<string, ZodTypeAny>
    const properties: Record<string, GeminiSchema> = {}
    const required: string[] = []

    for (const [key, fieldType] of Object.entries(shape)) {
      const fieldSchema = convertSchema(fieldType, false)
      if (fieldSchema === undefined) return undefined
      properties[key] = fieldSchema
      // A field is required unless it (or any wrapper in its chain) is
      // ZodOptional or ZodDefault — detected by isOptionalField() above.
      if (!isOptionalField(fieldType)) {
        required.push(key)
      }
    }

    const result: GeminiSchema = {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
      ...(desc !== undefined ? { description: desc } : {}),
      ...(nullable ? { nullable: true } : {}),
    }
    return result
  }

  // ---- ZodString ----
  if (schema instanceof ZodString) {
    return {
      type: 'string',
      ...(desc !== undefined ? { description: desc } : {}),
      ...(nullable ? { nullable: true } : {}),
    }
  }

  // ---- ZodNumber — detect integer refinement ----
  if (schema instanceof ZodNumber) {
    const checks = (schema._def as { checks?: Array<{ kind: string }> }).checks ?? []
    const isInt = checks.some((c) => c.kind === 'int')
    return {
      type: isInt ? 'integer' : 'number',
      ...(desc !== undefined ? { description: desc } : {}),
      ...(nullable ? { nullable: true } : {}),
    }
  }

  // ---- ZodBoolean ----
  if (schema instanceof ZodBoolean) {
    return {
      type: 'boolean',
      ...(desc !== undefined ? { description: desc } : {}),
      ...(nullable ? { nullable: true } : {}),
    }
  }

  // ---- ZodArray ----
  if (schema instanceof ZodArray) {
    const element = schema.element as unknown as ZodTypeAny
    const items = convertSchema(element, false)
    if (items === undefined) return undefined
    return {
      type: 'array',
      items,
      ...(desc !== undefined ? { description: desc } : {}),
      ...(nullable ? { nullable: true } : {}),
    }
  }

  // ---- ZodEnum (string enum) ----
  if (schema instanceof ZodEnum) {
    return {
      type: 'string',
      enum: schema.options as string[],
      ...(desc !== undefined ? { description: desc } : {}),
      ...(nullable ? { nullable: true } : {}),
    }
  }

  // ---- ZodLiteral ----
  if (schema instanceof ZodLiteral) {
    const val: unknown = schema.value
    if (typeof val === 'string') {
      return {
        type: 'string',
        enum: [val],
        ...(desc !== undefined ? { description: desc } : {}),
        ...(nullable ? { nullable: true } : {}),
      }
    }
    if (typeof val === 'number') {
      return {
        type: 'number',
        ...(desc !== undefined ? { description: desc } : {}),
        ...(nullable ? { nullable: true } : {}),
      }
    }
    if (typeof val === 'boolean') {
      return {
        type: 'boolean',
        ...(desc !== undefined ? { description: desc } : {}),
        ...(nullable ? { nullable: true } : {}),
      }
    }
    // Non-string/number/boolean literal — unsupported.
    return undefined
  }

  // Unsupported Zod shape — caller emits Warning.
  return undefined
}
