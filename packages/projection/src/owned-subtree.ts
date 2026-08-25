import {
  PandaError,
  PANDA_ERROR_CODES,
  PROJECTION_GRAMMAR_VERSION,
  UNPROJECTABLE_ENTRY_IDS,
} from '@panda/contracts'
import type {
  ProjectionOwnedMcpServer,
  ProjectionOwnedSkill,
  ProjectionOwnedSubtree,
  ProjectionOwnedTool,
  RegistryEntriesByKind,
  RegistryEntry,
} from '@panda/contracts'

// Deterministic rendering of registry entries into the owned subtree:
// entry ids become section keys in stable lexicographic order and every
// grammar section is present (explicitly empty when no entry matches), so the
// serialization of a given registry state never varies run to run.
//
// Which registry kinds a given target does NOT project (profiles have no
// Claude settings surface in grammar v1) is target knowledge: targets report
// those through their outcome's skippedEntryIds.

function byId(a: RegistryEntry, b: RegistryEntry): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function assertProjectableId(kind: string, id: string): void {
  // Defense in depth: the canonical envelope already rejects these ids on every
  // registration path, so reaching here means a hand-edited or corrupted store.
  if (UNPROJECTABLE_ENTRY_IDS.has(id)) {
    throw new PandaError(
      PANDA_ERROR_CODES.registryInvalidEntry,
      `registry ${kind} entry '${id}' cannot be used as a projected key`,
    )
  }
}

/**
 * Defense in depth: the Registry already rejects duplicate type+id pairs, but
 * a corrupted or hand-edited store must never silently collapse two entries
 * into one projected key — it fails coded instead.
 */
function renderSection<T>(
  kind: string,
  entries: readonly RegistryEntry[],
  toLeaf: (entry: RegistryEntry) => T,
): Record<string, T> {
  const sorted = [...entries].sort(byId)
  const section: Record<string, T> = {}
  let previousId: string | undefined
  for (const entry of sorted) {
    assertProjectableId(kind, entry.id)
    if (previousId === entry.id) {
      throw new PandaError(
        PANDA_ERROR_CODES.registryContention,
        `duplicate registry ${kind} entries '${entry.id}': two entries with the same id cannot both be projected`,
      )
    }
    section[entry.id] = toLeaf(entry)
    previousId = entry.id
  }
  return section
}

export function renderOwnedSubtree(entries: RegistryEntriesByKind): ProjectionOwnedSubtree {
  return {
    version: PROJECTION_GRAMMAR_VERSION,
    tools: renderSection<ProjectionOwnedTool>('tool', entries.tool, (entry) =>
      entry.command === undefined ? {} : { command: entry.command },
    ),
    mcpServers: renderSection<ProjectionOwnedMcpServer>(
      'mcp-server',
      entries['mcp-server'],
      (entry) => ({
        ...(entry.command === undefined ? {} : { command: entry.command }),
        ...(entry.args === undefined ? {} : { args: [...entry.args] }),
      }),
    ),
    skills: renderSection<ProjectionOwnedSkill>('skill', entries.skill, (entry) =>
      entry.entryPath === undefined ? {} : { entryPath: entry.entryPath },
    ),
  }
}
