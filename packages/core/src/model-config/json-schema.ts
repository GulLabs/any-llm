import { z } from 'zod'

import type { JsonValue } from '../types.js'

export function toConfigJsonSchema(schema: z.ZodType): JsonValue {
  return z.toJSONSchema(schema, { unrepresentable: 'throw' }) as JsonValue
}
