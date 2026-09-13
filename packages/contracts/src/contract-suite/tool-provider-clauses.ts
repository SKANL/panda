import { validateRegistryEntry } from '../registry.ts'
import { describeThrown, failWith, pass } from './clause.ts'
import type { Clause } from './clause.ts'
import type { ToolProvider } from '../providers.ts'

export const TOOL_PROVIDER_SUITE = 'tool-provider'

export const TOOL_PROVIDER_CLAUSES: readonly Clause<ToolProvider>[] = [
  {
    name: 'source-id-is-non-empty',
    check: async (provider) => typeof provider.sourceId === 'string' && provider.sourceId.trim() !== ''
      ? pass()
      : failWith('sourceId must be a non-empty string'),
  },
  {
    name: 'exposes-list',
    check: async (provider) => typeof provider.list === 'function'
      ? pass()
      : failWith('provider exposes no list() method'),
  },
  {
    name: 'list-returns-array',
    check: async (provider) => {
      try {
        const result = await provider.list()
        return Array.isArray(result) ? pass() : failWith('list() must return an array or a promise of an array')
      } catch (error) {
        return failWith(`list() rejected: ${describeThrown(error)}`)
      }
    },
  },
  {
    name: 'contributes-only-valid-mcp-servers',
    check: async (provider) => {
      let entries: readonly unknown[]
      try {
        const result = await provider.list()
        if (!Array.isArray(result)) return failWith('list() must return an array or a promise of an array')
        entries = result
      } catch (error) {
        return failWith(`list() rejected: ${describeThrown(error)}`)
      }
      for (const entry of entries) {
        try {
          const valid = validateRegistryEntry(entry)
          if (valid.type !== 'mcp-server') return failWith(`entry '${valid.id}' is not an mcp-server`)
        } catch (error) {
          return failWith(`list() returned an invalid registry entry: ${describeThrown(error)}`)
        }
      }
      return pass()
    },
  },
]
