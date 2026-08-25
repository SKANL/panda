import { PandaError } from './errors.ts'
import type { RegistryEntry, RegistryEntryType } from './registry.ts'
import { isRecord } from './validation.ts'

// Versioned, namespaced sentinel grammar (AD-9) for projection markers. A
// JSON-family target claims ownership of ONE reserved root key whose value is
// a `ProjectionOwnedSubtree`. The grammar version stamps every written
// subtree; markers declaring any other version — or not matching the declared
// shape at all — classify as Drift and are reported, never rewritten.

export const PROJECTION_GRAMMAR_VERSION = 1

export const PROJECTION_RESERVED_ROOT_KEY = 'panda'

export interface ProjectionOwnedTool {
  readonly command?: string
}

export interface ProjectionOwnedSkill {
  readonly entryPath?: string
}

export interface ProjectionOwnedMcpServer {
  readonly command?: string
  readonly args?: readonly string[]
}

/** The value stored under the reserved root key in a projected native file. */
export interface ProjectionOwnedSubtree {
  readonly version: number
  readonly tools: Readonly<Record<string, ProjectionOwnedTool>>
  readonly mcpServers: Readonly<Record<string, ProjectionOwnedMcpServer>>
  readonly skills: Readonly<Record<string, ProjectionOwnedSkill>>
}

export type DriftKind = 'legacy-marker' | 'unknown-shape'

export interface DriftEntry {
  readonly kind: DriftKind
  /** Locator of the drifted content inside the native document (dot notation). */
  readonly location: string
  readonly detail: string
}

export interface ProjectionMergeRequest {
  /** Registry entries grouped by kind, as consumed by the engine. */
  readonly entries: RegistryEntriesByKind
  /** Rendered owned content the target must claim in its native format. */
  readonly ownedContent: ProjectionOwnedSubtree
  /** Current native text; '' when the file does not exist yet. */
  readonly nativeText: string
}

export interface ProjectionMergeOutcome {
  /** Merged native text with the rendered content claimed by this target. */
  readonly text: string
  /** Unclassifiable panda-shaped content found in the native text. */
  readonly drift: readonly DriftEntry[]
  /** Entry ids present in the registry but not projected by this target kind. */
  readonly skippedEntryIds?: readonly string[]
}

/**
 * Per-target strategy port (AD-9 contract home): declares which file it owns
 * and merges rendered owned content into current native text. The
 * format-specific merge lives entirely behind this interface.
 */
export interface ProjectionTarget {
  readonly targetId: string
  readonly filePath: string
  merge(request: ProjectionMergeRequest): ProjectionMergeOutcome | Promise<ProjectionMergeOutcome>
}

export interface ProjectionResult {
  readonly targetId: string
  readonly written: boolean
  /** Absolute byte-length delta between the previous and next file contents. */
  readonly byteDelta: number
  readonly drift: readonly DriftEntry[]
  /** Entry ids present in the registry but not projected by this target kind. */
  readonly skippedEntryIds: readonly string[]
}

export interface ProjectionFailure {
  readonly targetId: string
  readonly error: PandaError
}

/** Registry entries grouped by kind, as projection consumes them. */
export type RegistryEntriesByKind = Readonly<Record<RegistryEntryType, readonly RegistryEntry[]>>

type OwnedSectionKey = 'tools' | 'mcpServers' | 'skills'

const OWNED_SECTION_KEYS: readonly OwnedSectionKey[] = ['tools', 'mcpServers', 'skills']

function isEntryMap(value: unknown): value is Readonly<Record<string, unknown>> {
  if (!isRecord(value)) return false
  return Object.values(value).every((entry) => isRecord(entry))
}

function hasOnlyOptionalStrings(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.entries(value).every(([key, field]) =>
    keys.includes(key) ? typeof field === 'string' : false,
  )
}

function isValidToolLeaf(value: unknown): boolean {
  return isRecord(value) && hasOnlyOptionalStrings(value, ['command'])
}

function isValidSkillLeaf(value: unknown): boolean {
  return isRecord(value) && hasOnlyOptionalStrings(value, ['entryPath'])
}

function isValidMcpServerLeaf(value: unknown): boolean {
  if (!isRecord(value)) return false
  for (const [key, field] of Object.entries(value)) {
    if (key === 'args') {
      if (!Array.isArray(field) || !field.every((item) => typeof item === 'string')) return false
    } else if (key === 'command') {
      if (typeof field !== 'string') return false
    } else {
      return false
    }
  }
  return true
}

const SECTION_LEAF_VALIDATORS: Readonly<Record<OwnedSectionKey, (value: unknown) => boolean>> = {
  tools: isValidToolLeaf,
  mcpServers: isValidMcpServerLeaf,
  skills: isValidSkillLeaf,
}

/**
 * Classifies a panda marker found inside a native document against the
 * current grammar. An absent marker yields no drift; anything else either
 * matches grammar v1 exactly (sections AND entry leaves) or classifies as
 * legacy-marker (older/other version) or unknown-shape (wrong layout), so
 * callers can report it without rewriting regions they cannot own.
 */
export function classifyOwnedMarker(marker: unknown): readonly DriftEntry[] {
  if (marker === undefined) return []
  const location = `$.${PROJECTION_RESERVED_ROOT_KEY}`
  if (!isRecord(marker)) {
    return [{ kind: 'unknown-shape', location, detail: 'reserved marker is not an object' }]
  }
  const version = marker['version']
  const versionLocation = `${location}.version`
  if (version === undefined) {
    return [
      { kind: 'legacy-marker', location: versionLocation, detail: 'reserved marker is missing its version key' },
    ]
  }
  if (version !== PROJECTION_GRAMMAR_VERSION) {
    return [
      {
        kind: 'legacy-marker',
        location: versionLocation,
        detail: `marker declares grammar version ${JSON.stringify(version)} but this build projects version ${PROJECTION_GRAMMAR_VERSION}`,
      },
    ]
  }
  const issues: DriftEntry[] = []
  for (const section of OWNED_SECTION_KEYS) {
    const sectionValue = marker[section]
    if (!isEntryMap(sectionValue)) {
      issues.push({
        kind: 'unknown-shape',
        location: `${location}.${section}`,
        detail: `'${section}' must be an object of entry objects`,
      })
      continue
    }
    const validLeaf = SECTION_LEAF_VALIDATORS[section]
    for (const [id, leaf] of Object.entries(sectionValue)) {
      if (id === '' || !validLeaf(leaf)) {
        issues.push({
          kind: 'unknown-shape',
          location: `${location}.${section}.${id}`,
          detail: `'${id}' does not match the grammar v1 entry shape for '${section}'`,
        })
      }
    }
  }
  for (const key of Object.keys(marker)) {
    if (key !== 'version' && !(OWNED_SECTION_KEYS as readonly string[]).includes(key)) {
      issues.push({
        kind: 'unknown-shape',
        location: `${location}.${key}`,
        detail: `'${key}' is not part of grammar version ${PROJECTION_GRAMMAR_VERSION}`,
      })
    }
  }
  return issues
}
