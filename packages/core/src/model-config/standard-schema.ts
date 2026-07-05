import type { z } from 'zod'

import type { StandardSchemaV1 } from '../standard-schema.js'

export function zodToStandardSchema<Schema extends z.ZodType>(
  schema: Schema,
  vendor = 'gullabs-zod4',
): StandardSchemaV1<z.input<Schema>, z.output<Schema>> {
  return {
    '~standard': {
      vendor,
      version: 1,
      validate(value: unknown) {
        const result = schema.safeParse(value)
        if (result.success) {
          return { value: result.data }
        }

        return {
          issues: result.error.issues.map((issue) => ({
            message: issue.message,
            ...(issue.path.length > 0 ? { path: issue.path } : {}),
          })),
        }
      },
    },
  }
}
