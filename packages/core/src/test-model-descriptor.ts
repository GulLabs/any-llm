import { z } from 'zod'

import { toConfigJsonSchema, zodToStandardSchema } from './model-config/index.js'
import type { ModelDescriptor } from './registry.js'

const EmptyConfigSchema = z
  .strictObject({})
  .meta({ title: 'EmptyConfig', description: 'Test schema.', examples: [{}] })

const EmptyConfigJsonSchema = toConfigJsonSchema(EmptyConfigSchema)
const EmptyConfigValidator = zodToStandardSchema(EmptyConfigSchema)

export function makeTestDescriptor(
  overrides: Partial<ModelDescriptor> & Pick<ModelDescriptor, 'id' | 'provider'>,
): ModelDescriptor {
  const { id, provider, ...rest } = overrides

  return {
    ...rest,
    id,
    provider,
    configSchema: EmptyConfigSchema,
    configJsonSchema: EmptyConfigJsonSchema,
    validateConfig: EmptyConfigValidator,
  }
}
