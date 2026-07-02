import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const src = (p: string) =>
  fileURLToPath(new URL(`./packages/${p}/src/index.ts`, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@gullabs/core': src('core'),
      '@gullabs/google': src('google'),
      '@gullabs/drizzle': src('drizzle'),
      '@gullabs/quota': src('quota'),
      '@gullabs/testing': src('testing'),
    },
  },
  test: {
    include: ['packages/*/src/**/*.{test,spec}.ts'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts'],
      thresholds: {
        statements: 93,
        branches: 91,
        functions: 96,
        lines: 93,
      },
    },
  },
})
