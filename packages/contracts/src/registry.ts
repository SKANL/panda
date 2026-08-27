import { join, sep } from 'node:path'
import { PandaError, PANDA_ERROR_CODES } from './errors.ts'
import { defineStandardSchema } from './standard-schema.ts'
import type { StandardSchemaIssue, StandardSchemaResult, StandardSchemaV1 } from './standard-schema.ts'
import { isNonEmptyString, isRecord, issue } from './validation.ts'

// The vocabulary panda DECLARES: every word here reaches an executor, `skill`
// through a materialise target and `mcp-server` through a config target. Both,
// and only both — exactly the two kinds the projection layer renders.
export type RegistryEntryType = 'skill' | 'mcp-server'

export const REGISTRY_ENTRY_TYPES: readonly RegistryEntryType[] = ['skill', 'mcp-server']

// --- Retired vocabulary --------------------------------------------------
//
// A word panda no longer declares AND that a registry document written by an
// older build may still hold. `tool` was retired by story M4.E: no executor has
// a non-MCP location for "an identity plus an executable command" (codex's
// `[tools]` is a closed struct of built-in toggles and rejects `tools.rg` under
// `--strict-config`; opencode types `tools` as an enable-map; Claude Code's
// command-bearing keys are role-bound singletons), so an `mcp-server` entry
// already carries exactly what a `tool` entry carried and reaches all three.
//
// `profile` was retired by story M4.F, on the PRD's own glossary rather than on
// executor evidence: a Profile is "a named, versioned bundle of Registry
// SELECTIONS", and "Bundles carry one or more Profiles". That makes it a
// container OVER `skill` and `mcp-server`, not a peer of them, and the symptom
// was already in this file — its path-field list was `[]` because a container
// has no leaf field to carry. FR-21's "Registry+Profiles+SkillSources" lists
// three things because there are three things. Bundles are Epic 5, so designing
// Profile here would be designing the contained before the container; it
// returns there, designed.
//
// RECOGNISING a retired type is NOT relaxing validation, and the difference is
// the whole safety property. A retired entry is validated against the SAME
// envelope with the SAME per-type field fit, using the fields that type carried
// when it was live — so `{type:'tool', id:'rg', command:'rg'}` still parses and
// `{type:'tool', id:'rg', entryPath:'x'}`, `{type:'nope', ...}` and an entry
// with no id are still rejected whole-store, exactly as before. What changes is
// that removing a word cannot turn an existing registry into an unreadable
// store — the dead end M4.C exists to abolish, reachable by upgrading.
//
// Retired types are accepted at READ time only. Nothing can create one: every
// write goes through `validateRegistryEntry`, which never admits them.
export type RetiredEntryType = 'tool' | 'profile'

/** What each retired type carried while it was live. Same reading as {@link REGISTRY_PATH_FIELDS}. */
export const RETIRED_PATH_FIELDS: Readonly<Record<RetiredEntryType, readonly string[]>> = {
  tool: ['command'],
  profile: [],
}

export const RETIRED_ENTRY_TYPES: readonly RetiredEntryType[] = Object.keys(
  RETIRED_PATH_FIELDS,
) as RetiredEntryType[]

/** What a stored document may hold: the declared vocabulary plus the retired one. */
export type StoredEntryType = RegistryEntryType | RetiredEntryType

/** The types `panda remove` accepts, so a retired entry has an in-product exit. */
export const REMOVABLE_ENTRY_TYPES: readonly StoredEntryType[] = [
  ...REGISTRY_ENTRY_TYPES,
  ...RETIRED_ENTRY_TYPES,
]

export type RegistryScope = 'global' | 'project' | 'agent'

export const REGISTRY_SCOPES: readonly RegistryScope[] = ['global', 'project', 'agent']

// The canonical entry envelope every registry write validates against BEFORE
// persistence. Provider-specific payloads are accepted ONLY under the reserved
// `extensions` namespace: unknown keys at the entry root are rejected, so the
// envelope can grow canonically without silent provider drift.
//
// The root fields below are panda-owned state; the per-type PATH FIELDS
// allowlist (`REGISTRY_PATH_FIELDS`) declares which of them may carry paths,
// which is what write-time home-directory normalization applies to — never to
// ids or extension payloads.
export interface RegistryEntry {
  /**
   * WIDE on purpose: a document written by an older build may hold a retired
   * type, so every reader that keys off the type has to say what it does with
   * one. Nothing WRITES a retired type — `validateRegistryEntry` refuses it —
   * and `groupByKind` drops it before projection ever sees it.
   */
  readonly type: StoredEntryType
  readonly id: string
  /** Executable command (mcp-server). */
  readonly command?: string
  /** Skill entry file (skill). */
  readonly entryPath?: string
  /** Command arguments (mcp-server); entries may be paths. */
  readonly args?: readonly string[]
  readonly extensions?: Readonly<Record<string, unknown>>
}

// Per-entry-type allowlist of the envelope fields that BELONG to each type —
// and, because every one of them carries a path, the same record is what NFR-6
// home-directory normalization is applied to at write time. Everything else —
// ids, extensions payloads — stays verbatim on disk.
//
// The two readings are one record on purpose: an `mcp-server` that carries an
// `entryPath` would otherwise be accepted, persisted, and then silently ignored
// by every target, and the only other way to reject it is a second per-type
// table that drifts from this one (the frozen Ask-First clause of story M4.D).
//
// ponytail: the fit check below reads this record for EVERY optional root key,
// so an envelope field added without a path meaning would be rejected for every
// type until it is listed here. That fails closed and loudly. Upgrade path: a
// separate `REGISTRY_TYPE_FIELDS` record the moment a non-path field exists.
export const REGISTRY_PATH_FIELDS: Readonly<Record<RegistryEntryType, readonly string[]>> = {
  skill: ['entryPath'],
  'mcp-server': ['command', 'args'],
}

// Ids that would collide with Object.prototype members or otherwise cannot
// become a key in a projected document. Rejected at REGISTRATION, not at
// projection: an entry that persists with such an id makes every projection
// target fail permanently, with no way to remove it through a provider.
export const UNPROJECTABLE_ENTRY_IDS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  'toString',
  'valueOf',
])

// Universal state, plus the reserved provider namespace, plus EVERY field any
// type declares — declared or retired.
//
// The retired half is not decoration. A retired type's field names are checked
// against this set by the unknown-root-key rule, so a retired type whose field
// no live type still uses would make every one of its stored entries fail that
// rule, and one failing entry fails the WHOLE store: the M4.C dead end, inside
// the mechanism built to abolish it. It holds today only because `tool`'s field
// is `command`, which `mcp-server` still declares — retiring `skill` would move
// `entryPath` here and make the hand-written line look prunable. Derived, so
// the containment is a fact rather than a coincidence.
const KNOWN_ROOT_KEYS: ReadonlySet<string> = new Set([
  'type',
  'id',
  'extensions',
  ...Object.values(REGISTRY_PATH_FIELDS).flat(),
  ...Object.values(RETIRED_PATH_FIELDS).flat(),
])

// The root keys whose presence depends on the entry TYPE: everything panda owns
// at the root that is not universal state (`type`, `id`) or the reserved
// provider namespace (`extensions`). Derived, so a widened envelope cannot leave
// a new field unchecked here.
const TYPED_ROOT_KEYS: readonly string[] = [...KNOWN_ROOT_KEYS].filter(
  (key) => key !== 'type' && key !== 'id' && key !== 'extensions',
)

/**
 * The path/field allowlist for any type a STORED document may hold — declared
 * or retired. One lookup, so a reader cannot answer for the declared vocabulary
 * and then crash on the retired one: `REGISTRY_PATH_FIELDS[entry.type]` on a
 * retired entry is `undefined`, and iterating it throws.
 */
export function pathFieldsFor(type: StoredEntryType): readonly string[] {
  return isRegistryEntryType(type) ? REGISTRY_PATH_FIELDS[type] : RETIRED_PATH_FIELDS[type]
}

/** The fields a type carries, as the sentence a rejection prints. */
function fieldsSentence(type: StoredEntryType): string {
  const fields = pathFieldsFor(type)
  return fields.length === 0
    ? `a '${type}' entry carries no field beyond 'type' and 'id'`
    : `a '${type}' entry carries ${fields.map((field) => `'${field}'`).join(', ')}`
}

/** True for a word panda DECLARES — the vocabulary that reaches an executor. */
export function isRegistryEntryType(value: unknown): value is RegistryEntryType {
  return typeof value === 'string' && REGISTRY_ENTRY_TYPES.includes(value as RegistryEntryType)
}

/** True for a word panda has RETIRED: readable where it is stored, never writable. */
export function isRetiredEntryType(value: unknown): value is RetiredEntryType {
  return typeof value === 'string' && RETIRED_ENTRY_TYPES.includes(value as RetiredEntryType)
}

function isStoredEntryType(value: unknown): value is StoredEntryType {
  return isRegistryEntryType(value) || isRetiredEntryType(value)
}

function isRegistryScopeValue(value: unknown): value is RegistryScope {
  return typeof value === 'string' && REGISTRY_SCOPES.includes(value as RegistryScope)
}

/**
 * Every way one entry violates the canonical envelope.
 *
 * `admitRetired` is the READ path and nothing else: it widens the accepted
 * vocabulary by exactly {@link RETIRED_ENTRY_TYPES} and changes NOTHING else —
 * the id rules, the field types, the per-type field fit and the unknown-root-key
 * rejection all still apply, with the retired type's own field allowlist. A
 * genuinely malformed entry is still rejected under it; that is the difference
 * between recognising a retired word and relaxing validation.
 */
export function registryEntryIssues(value: unknown, admitRetired = false): StandardSchemaIssue[] {
  if (!isRecord(value)) return [issue('registry entry must be an object')]
  const issues: StandardSchemaIssue[] = []
  const acceptsType = admitRetired ? isStoredEntryType : isRegistryEntryType
  if (!acceptsType(value['type'])) {
    issues.push(issue(`'type' must be one of: ${REGISTRY_ENTRY_TYPES.join(', ')}`))
  }
  if (!isNonEmptyString(value['id'])) {
    issues.push(issue("'id' must be a non-empty string"))
  } else if (UNPROJECTABLE_ENTRY_IDS.has(value['id'])) {
    issues.push(issue(`'id' must not be '${value['id']}': it can never be used as a projected key`))
  }
  const command = value['command']
  if (command !== undefined && !isNonEmptyString(command)) {
    issues.push(issue("'command' must be a non-empty string when present"))
  }
  const entryPath = value['entryPath']
  if (entryPath !== undefined && !isNonEmptyString(entryPath)) {
    issues.push(issue("'entryPath' must be a non-empty string when present"))
  }
  const args = value['args']
  if (args !== undefined && (!Array.isArray(args) || !args.every(isNonEmptyString))) {
    issues.push(issue("'args' must be an array of non-empty strings when present"))
  }
  const extensions = value['extensions']
  if (extensions !== undefined && !isRecord(extensions)) {
    issues.push(issue("'extensions' must be an object when present"))
  }
  // A field that is well-formed and belongs to a DIFFERENT type. Reported here,
  // in the contract, and never by a caller: a CLI or provider deciding which
  // flag suits which type would be a second copy of `REGISTRY_PATH_FIELDS`.
  const type = value['type']
  if (acceptsType(type)) {
    const fields = pathFieldsFor(type)
    for (const key of TYPED_ROOT_KEYS) {
      if (value[key] !== undefined && !fields.includes(key)) {
        issues.push(issue(`'${key}' does not belong on a '${type}' entry; ${fieldsSentence(type)}`))
      }
    }
  }
  for (const key of Object.keys(value)) {
    if (!KNOWN_ROOT_KEYS.has(key)) {
      issues.push(
        issue(
          `'${key}' is not allowed at the entry root; provider-specific payloads belong under the reserved 'extensions' namespace`,
        ),
      )
    }
  }
  return issues
}

function throwSchemaViolation(issues: readonly StandardSchemaIssue[]): never {
  throw new PandaError(
    PANDA_ERROR_CODES.registryInvalidEntry,
    `invalid registry entry: ${issues.map((entry) => entry.message).join('; ')}`,
  )
}

// Programmatic validation: raises a coded PandaError on schema violations.
export function validateRegistryEntry(value: unknown): RegistryEntry {
  const issues = registryEntryIssues(value)
  if (issues.length > 0) throwSchemaViolation(issues)
  return value as RegistryEntry
}

export function validateRegistryScope(value: unknown): RegistryScope {
  if (!isRegistryScopeValue(value)) {
    throw new PandaError(
      PANDA_ERROR_CODES.registryInvalidEntry,
      `invalid registry entry: 'scope' must be one of: ${REGISTRY_SCOPES.join(', ')}`,
    )
  }
  return value
}

export const REGISTRY_ENTRY_SCHEMA: StandardSchemaV1<RegistryEntry> = defineStandardSchema(
  (value): StandardSchemaResult<RegistryEntry> => {
    const issues = registryEntryIssues(value)
    return issues.length > 0 ? { issues } : { value: value as RegistryEntry }
  },
)

// --- Write-time path normalization (NFR-6) -------------------------------
//
// Only the type's declared path fields are transformed; ids and extensions
// stay verbatim. The leading '~' of a normalized value is RESERVED as a
// marker, so literal values starting with '~' are escaped with a second '~':
//   writer: '<home>/bin/x' -> '~/bin/x' ; any other '~/x' or '~x' -> '~~...'
//   reader: '~' -> home ; '~/...' -> under home ; '~~...' -> literal '~...'
// making the round trip lossless. On win32 the home-prefix comparison ignores
// case (drive letters and user names vary in casing between processes).

function caseFold(text: string): string {
  return process.platform === 'win32' ? text.toLowerCase() : text
}

function normalizePathValue(value: unknown, homeDir: string): unknown {
  if (typeof value === 'string') {
    if (caseFold(value) === caseFold(homeDir)) return '~'
    const prefix = homeDir.endsWith(sep) ? homeDir : homeDir + sep
    if (caseFold(value).startsWith(caseFold(prefix))) return '~/' + value.slice(prefix.length)
    if (value.startsWith('~')) return '~' + value
    return value
  }
  if (Array.isArray(value)) return value.map((item) => normalizePathValue(item, homeDir))
  return value
}

function expandPathValue(value: unknown, homeDir: string): unknown {
  if (typeof value === 'string') {
    if (value === '~') return homeDir
    if (value.startsWith('~/')) return join(homeDir, value.slice(2))
    if (value.startsWith('~~')) return value.slice(1)
    return value
  }
  if (Array.isArray(value)) return value.map((item) => expandPathValue(item, homeDir))
  return value
}

function withTransformedPaths(
  entry: RegistryEntry,
  homeDir: string,
  transform: (value: unknown, homeDir: string) => unknown,
): RegistryEntry {
  const result = { ...entry } as Record<string, unknown>
  // `pathFieldsFor`, never `REGISTRY_PATH_FIELDS`: a stored entry may carry a
  // retired type, and indexing the declared record with one yields `undefined`.
  for (const field of pathFieldsFor(entry.type)) {
    if (result[field] !== undefined) result[field] = transform(result[field], homeDir)
  }
  return result as unknown as RegistryEntry
}

/** Write-time transform: designated path fields get machine-independent markers. */
export function normalizeRegistryEntryPaths(entry: RegistryEntry, homeDir: string): RegistryEntry {
  return withTransformedPaths(entry, homeDir, normalizePathValue)
}

/** Read-time inverse of {@link normalizeRegistryEntryPaths}. */
export function expandRegistryEntryPaths(entry: RegistryEntry, homeDir: string): RegistryEntry {
  return withTransformedPaths(entry, homeDir, expandPathValue)
}

export { isRegistryScopeValue }
