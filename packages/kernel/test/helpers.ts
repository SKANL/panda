import type { StandardSchemaV1Like } from '../src'

export const passthroughSchema: StandardSchemaV1Like = {
  '~standard': {
    version: 1,
    validate: (value) => ({ value }),
  },
}

export function manifest(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: 'plugin-a',
    version: '1.0.0',
    provides: [],
    consumes: [],
    configSchema: passthroughSchema,
    ...overrides,
  }
}
