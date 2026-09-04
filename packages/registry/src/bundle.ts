// The Registry leaving the machine (FR-21, NFR-5, NFR-6).
//
// A bundle is the global scope's own document, sorted and stripped of anything
// that looks like a credential. It is NOT a vendor file and is not written by
// the projection engine's symlink-resolving writer: it is a new file at a path
// the user named, so the store's own atomic write is what it needs.
//
// NFR-6 is not re-derived here. `RegistryStore.register` normalizes machine
// paths at WRITE time, so the entries this module reads are already portable —
// `~/x` rather than `/home/someone/x` — with `~~` escaping a literal tilde.

import { randomUUID } from 'node:crypto'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import {
  PandaError,
  PANDA_ERROR_CODES,
  REGISTRY_ENTRY_TYPES,
  isStoredEntryType,
  normalizeRegistryEntryPaths,
  registryEntryIssues,
} from '@panda/contracts'
import type { RegistryEntry, StoredEntryType } from '@panda/contracts'
import { strictFaultLocation } from './document-fault.ts'

/** Bumped only when a reader of an older build could MISREAD the document. */
export const BUNDLE_VERSION = 1

/** Names the artifact in its own bytes, so a stray JSON file is not mistaken for one. */
export const BUNDLE_KIND = 'panda-bundle'

/** Every envelope field a credential can stop an entry on. */
export const OMITTED_FIELDS = ['id', 'command', 'entryPath', 'args', 'extensions'] as const

/**
 * The envelope field whose value matched.
 *
 * DERIVED from the array above rather than written beside it, which is the
 * spelling `RETIRED_ENTRY_TYPES` (`contracts/src/registry.ts:48-56`) already
 * ships. The two used to be one list written twice, and only the harmless
 * direction was gated: ADDING a word to the array without adding it to the union
 * was a compile error, but REMOVING one was silent — `panda export` then wrote a
 * bundle `panda import` refused, accusing the user's document one command after
 * producing it.
 *
 * CLOSED rather than `string`, and that is load-bearing too: an open `string` is
 * what let the two arms of `OmittedEntry` share one shape, and sharing one shape
 * is how the `id` arm came to carry the credential it exists to withhold.
 */
export type OmittedField = (typeof OMITTED_FIELDS)[number]

/**
 * An entry that did not travel, and the field that stopped it.
 *
 * The VALUE is never here — not the token, not an excerpt, not its length. What
 * this carries is what a person needs to re-create the entry by hand on the
 * other machine, and what a later import needs in order to list it as pending
 * rather than silently lack it.
 *
 * That guarantee is STRUCTURAL, not a promise in this paragraph. When the field
 * that matched is `id`, the credential IS the id — so that arm has no `id` slot
 * at all and there is nowhere for a later edit to put one back. A placeholder
 * string was rejected for exactly that reason: a redacted value is still a slot.
 *
 * WHAT THIS COSTS, written down rather than discovered later: `sortKey` orders
 * the `id` arm by its `type` alone, so two `id`-arm records of the same type
 * tie. `Array.prototype.sort` is stable and one store read twice yields one
 * input order, so the criterion that matters — the same store exported twice is
 * byte-identical — still holds. What degrades is the weaker second claim, that
 * two bundles from different machines are comparable line by line, and only for
 * this arm.
 */
export type OmittedEntry =
  | {
      readonly type: StoredEntryType
      readonly id: string
      readonly field: Exclude<OmittedField, 'id'>
    }
  | {
      readonly type: StoredEntryType
      readonly field: 'id'
      /**
       * DECLARED ABSENT rather than merely left out, and this is not decoration.
       *
       * What was MEASURED, on this build's tsc, and nothing wider. Without this
       * slot, two routes admit `{ type, id, field }` against a bare
       * `{ type, field: 'id' }`: one where `field` is an un-narrowed
       * `OmittedField` — exactly the line this story removed from
       * {@link createBundle} — and one where the value is pre-built and so no
       * longer fresh. A fresh literal whose `field` is the LITERAL `'id'` is
       * rejected either way, because TypeScript discriminates first and then
       * applies excess-property checking per arm. So this slot closes those two
       * routes; it is not a general rule about unions, and an earlier draft of
       * this comment claimed one.
       *
       * `bundle.test.ts`'s `OmittedEntry` rows are what keep it here: deleting
       * it left every runtime clause in this package green.
       */
      readonly id?: never
    }

export interface RegistryBundle {
  readonly version: typeof BUNDLE_VERSION
  readonly kind: typeof BUNDLE_KIND
  /**
   * Which scope travelled. Stated rather than implied: `agent` is an in-memory
   * map that dies with its process and `project` names a directory the
   * destination machine does not have, so `global` is the only scope that can
   * cross — and a later story that widens this changes a value, not a meaning.
   */
  readonly scope: 'global'
  readonly entries: readonly RegistryEntry[]
  readonly omitted: readonly OmittedEntry[]
}

// --- The detector ----------------------------------------------------------
//
// Measured against a corpus with controls in BOTH directions before it was
// written: eleven credential shapes all detected, seventeen legitimate values
// all clean. The corpus is `test/bundle.test.ts`, and it is the test rather
// than a comment because this is the one part of the story where being wrong is
// a security failure rather than a defect.

/** Prefixes their issuers publish, so a match is near-certain. */
const PROVIDER_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{20,}/, // OpenAI, Anthropic
  /\bgh[pousr]_[A-Za-z0-9]{20,}/, // GitHub classic PAT family
  /\bgithub_pat_[A-Za-z0-9_]{20,}/, // GitHub fine-grained PAT
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/, // Slack
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{35}\b/, // Google
  /\bglpat-[A-Za-z0-9_-]{20,}/, // GitLab
]

/**
 * Long mixed-case runs that are NOT credentials, checked BEFORE the generic
 * rule below because they would otherwise match it.
 *
 * The line this draws, said plainly rather than left to be discovered: a git
 * object name is exactly 40 lowercase hex and a sha256 is exactly 64, so a
 * credential that happened to be exactly one of those lengths and all lowercase
 * hex would travel. A 32-hex token — the realistic raw-token length — still does
 * not. The alternative was to treat every hex run as a secret, which omits a
 * `--ref <sha>` argument from a legitimate server.
 */
const NOT_A_CREDENTIAL: readonly RegExp[] = [
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, // UUID
  /^[0-9a-f]{40}$/, // git object name
  /^[0-9a-f]{64}$/, // sha256
  /^sha256:[0-9a-f]{64}$/, // an OCI digest
]

/**
 * A token with no published prefix: at least 32 characters of an opaque
 * alphabet, carrying BOTH letters and digits. The two halves matter — a long
 * dashed English phrase has no digits and a long numeric id has no letters, and
 * neither is a credential.
 */
const OPAQUE_TOKEN = /(?:^|[\s=:])([A-Za-z0-9_-]{32,})(?:$|[\s])/

function looksLikePath(value: string): boolean {
  return value.includes('/') || value.includes('\\') || value.startsWith('~')
}

/**
 * A flag whose NAME says its value is a secret.
 *
 * This is the "second signal" `deferred-work.md` said the hex exclusion needed
 * and could not find. It was in hand the whole time: `args` is an ORDERED array
 * and a flag may be inline, so the thing that names a value travels next to it.
 * Matched on the flag's TAIL so a vendor prefix counts (`--openai-api-key`) and
 * a word that merely contains one does not (`--keyring`, `--tokenizer`).
 */
const SECRET_FLAG =
  /(?:^|[-_])(?:token|tokens|key|keys|secret|secrets|password|passwd|pwd|auth|authorization|credential|credentials|bearer)$/i

function flagNamesASecret(flag: string | undefined): boolean {
  return flag !== undefined && flag.startsWith('-') && SECRET_FLAG.test(flag)
}

/**
 * `--flag=value` as its two halves; anything else as a bare value.
 *
 * Splitting is what makes the two spellings agree. Before it, the exclusion was
 * tested against the WHOLE argument, so `--ref=<sha>` did not match `^hex40$`,
 * fell through to the opaque-token rule, and DROPPED a legitimate entry — while
 * `--ref <sha>` travelled. Same value, same flag, opposite verdict, decided by a
 * separator.
 */
function splitInlineFlag(argument: string): readonly [string | undefined, string] {
  if (!argument.startsWith('-')) return [undefined, argument]
  const equals = argument.indexOf('=')
  return equals === -1 ? [undefined, argument] : [argument.slice(0, equals), argument.slice(equals + 1)]
}

/**
 * Whether one string should keep panda's Registry off another machine, given
 * whatever named it.
 *
 * The flag is consulted for ONE decision only: whether an exactly-40 or
 * exactly-64 hex run is a git object name or a token. A provider-shaped value is
 * a credential whatever names it, and a value with no naming flag behaves exactly
 * as it did before — so this widens detection without widening false positives,
 * which is the trade the original exclusion was measured on.
 */
function isCredentialNamedBy(flag: string | undefined, value: string): boolean {
  const [inlineFlag, named] = splitInlineFlag(value)
  return credentialUnderFlag(inlineFlag ?? flag, named)
}

/** Whether one string should keep panda's Registry off another machine. */
export function isCredential(value: string): boolean {
  return isCredentialNamedBy(undefined, value)
}

function credentialUnderFlag(flag: string | undefined, value: string): boolean {
  if (PROVIDER_PATTERNS.some((pattern) => pattern.test(value))) return true
  if (NOT_A_CREDENTIAL.some((pattern) => pattern.test(value))) return flagNamesASecret(flag)
  // A normalized path is long and mixed by nature; it is also the one thing this
  // envelope is FULL of, so excluding it is what keeps the detector usable.
  if (looksLikePath(value)) return false
  const match = OPAQUE_TOKEN.exec(` ${value} `)
  if (match === null) return false
  const token = match[1]
  if (token === undefined) return false
  return /[A-Za-z]/.test(token) && /[0-9]/.test(token)
}

/** Every string reachable inside a value of unknown shape (`extensions`). */
function stringsWithin(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap((item) => stringsWithin(item))
  if (typeof value === 'object' && value !== null) {
    // KEYS as well as values: a payload keyed by an API token is as much a leak
    // as one that holds it.
    return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => [
      key,
      ...stringsWithin(item),
    ])
  }
  return []
}

/**
 * The first envelope field carrying a credential, or undefined.
 *
 * Field ORDER is fixed rather than incidental: the answer is written into the
 * omission record, and a record whose `field` changed between two runs over the
 * same entry would break D5's byte-identity.
 */
function credentialField(entry: RegistryEntry): OmittedField | undefined {
  if (isCredential(entry.id)) return 'id'
  if (entry.command !== undefined && isCredential(entry.command)) return 'command'
  if (entry.entryPath !== undefined && isCredential(entry.entryPath)) return 'entryPath'
  // PAIRED, because the flag that names a value is the argument before it. An
  // unnamed value behaves exactly as it did when this line read `isCredential`.
  if (entry.args?.some((argument, index) => isCredentialNamedBy(entry.args?.[index - 1], argument)) === true) {
    return 'args'
  }
  if (entry.extensions !== undefined && stringsWithin(entry.extensions).some(isCredential)) {
    return 'extensions'
  }
  return undefined
}

// --- The bundle ------------------------------------------------------------

/**
 * Total over BOTH arms of an omission record as well as over an entry.
 *
 * The `id` arm has no id, so it sorts under its type alone. That was decided
 * here rather than papered over with `?? ''` because the compiler is what asked
 * the question: widening `id` to optional without answering it would have let
 * the arm fall through to `undefined` inside a template literal, which sorts
 * fine and reads as `mcp-server:undefined`.
 */
function sortKey(entry: { readonly type: string; readonly id?: string }): string {
  return entry.id === undefined ? entry.type : `${entry.type}:${entry.id}`
}

/**
 * The global scope's entries as a portable artifact.
 *
 * Pure: it reads no file and writes none, so the whole of the secret rule and
 * the whole of determinism are testable without a filesystem.
 *
 * Entries are SORTED. The store's own order is registration order — `register`
 * filters the old entry out and appends the new one — so re-registering an
 * unchanged entry moves it, and two machines holding identical content would
 * otherwise produce different bytes. The criterion only asks that one store
 * export identically twice; sorting additionally makes two bundles comparable,
 * which is what anyone diffing them expects.
 */
export function createBundle(entries: readonly RegistryEntry[], homeDir: string): RegistryBundle {
  const kept: RegistryEntry[] = []
  const omitted: OmittedEntry[] = []
  for (const raw of entries) {
    // NORMALIZED here, and the reason is a measurement that was wrong until the
    // binary was driven. The store persists normalized paths, but `list()` maps
    // `expandRegistryEntryPaths` over everything it hands back, so what reaches
    // this function is `C:\Users\someone\...` again. Normalizing at the write
    // and reading the writer is not the same as reading what the CALLER gets.
    const entry = normalizeRegistryEntryPaths(raw, homeDir)
    // Scanned AFTER normalizing, so the detector sees the bytes that would
    // actually travel — a home directory containing a long opaque segment must
    // not decide whether an entry is a credential.
    const field = credentialField(entry)
    if (field === undefined) kept.push(entry)
    // The `id` arm is built WITHOUT an id, and the type is what makes that the
    // only spelling available: there is no slot to write `entry.id` into.
    else if (field === 'id') omitted.push({ type: entry.type, field })
    else omitted.push({ type: entry.type, id: entry.id, field })
  }
  return {
    version: BUNDLE_VERSION,
    kind: BUNDLE_KIND,
    scope: 'global',
    entries: [...kept].sort((left, right) => sortKey(left).localeCompare(sortKey(right))),
    omitted: [...omitted].sort((left, right) => sortKey(left).localeCompare(sortKey(right))),
  }
}

/** The bytes a bundle is, so the writer and any comparison agree on them. */
export function serializeBundle(bundle: RegistryBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`
}

function unavailable(path: string, cause: unknown): PandaError {
  return new PandaError(
    PANDA_ERROR_CODES.registryBundleUnavailable,
    `bundle cannot be written to '${path}': ${cause instanceof Error ? cause.message : String(cause)}`,
    { cause },
  )
}

/**
 * Writes the bundle at the path the user named.
 *
 * Same shape as the store's own persistence — a temp file beside the target,
 * then a rename over it — so a reader never observes half a document and a
 * failed write leaves the previous file intact rather than truncated. It is
 * NOT the projection engine's symlink-resolving writer: that one exists to
 * converge onto a vendor's own file, and this is a new artifact at a
 * user-chosen destination.
 */
export async function writeBundle(path: string, bundle: RegistryBundle): Promise<void> {
  const directory = dirname(path)
  const tempPath = join(directory, `${basename(path)}.${randomUUID()}.tmp`)
  try {
    await writeFile(tempPath, serializeBundle(bundle), 'utf8')
    await rename(tempPath, path)
  } catch (error) {
    await unlink(tempPath).catch(() => {})
    throw unavailable(path, error)
  }
}

// --- Reading one back (FR-22) ----------------------------------------------

/**
 * `detail` is a string panda AUTHORS, and there is no `cause` parameter any
 * more — that is what enforces it, because a cause is reachable from any printed
 * stack. `document-fault.ts` holds the rule: a bundle carries `mcp-server`
 * args, and V8's parse message quoted a planted credential straight out of one
 * through `panda import` (Spec M17.A, Change Log 1).
 */
function unreadable(path: string, detail: string): PandaError {
  return new PandaError(
    PANDA_ERROR_CODES.registryBundleUnavailable,
    `bundle at '${path}' cannot be imported: ${detail}`,
  )
}

/**
 * Parses and VALIDATES a bundle, or refuses by name.
 *
 * Nothing this returns is half-checked, and that is the point: an import that
 * registered three entries and then refused the fourth would leave a registry
 * in a state with no verb to get out of. Every refusal below happens before a
 * caller has written anything.
 *
 * A RETIRED entry type is admitted, exactly as the store's own read path admits
 * one. A bundle is a document written by another build, and refusing a word
 * panda has since retired would make removing a word able to brick an import —
 * the dead end M4.E exists to abolish.
 */
export function parseBundle(path: string, text: string): RegistryBundle {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // LOCATED, never quoted.
    throw unreadable(path, `it is not valid JSON: ${strictFaultLocation(text)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw unreadable(path, 'the document is not an object')
  }
  const document = parsed as Record<string, unknown>
  if (document['kind'] !== BUNDLE_KIND) {
    // Before the version check: a file that is not a bundle at all has no
    // version to be incompatible about, and telling its author about schema
    // majors would send them looking in the wrong direction.
    throw unreadable(path, `it is not a panda bundle (expected kind '${BUNDLE_KIND}')`)
  }
  const version = document['version']
  if (version !== BUNDLE_VERSION) {
    // Two sentences because two different things are wrong, and only one of them
    // is the user's cue to upgrade. "Newer" is the case Story 5.2 names.
    throw unreadable(
      path,
      typeof version === 'number' && Number.isInteger(version) && version > BUNDLE_VERSION
        ? `it was written by a newer panda (bundle schema version ${version}); this build reads version ${BUNDLE_VERSION}`
        : `its schema version ${JSON.stringify(version)} is not one this build recognises (this build reads version ${BUNDLE_VERSION})`,
    )
  }
  if (document['scope'] !== 'global') {
    throw unreadable(path, `it declares scope ${JSON.stringify(document['scope'])}; only 'global' can be imported`)
  }
  const rawEntries = document['entries']
  if (!Array.isArray(rawEntries)) throw unreadable(path, "it has no 'entries' array")
  const rawOmitted = document['omitted']
  if (!Array.isArray(rawOmitted)) throw unreadable(path, "it has no 'omitted' array")

  // EVERY issue across EVERY entry, not the first. An author fixing a bundle by
  // hand should learn what is wrong with it in one run, which is the same rule
  // the kernel's manifest validation was given in M7.B.
  const issues: string[] = []
  for (const [index, candidate] of rawEntries.entries()) {
    for (const issue of registryEntryIssues(candidate, true)) {
      issues.push(`entries[${index}]: ${issue.message}`)
    }
  }
  const omitted: OmittedEntry[] = []
  for (const [index, candidate] of rawOmitted.entries()) {
    const read = readOmittedEntry(candidate)
    if ('entry' in read) omitted.push(read.entry)
    else for (const issue of read.issues) issues.push(`omitted[${index}]: ${issue}`)
  }
  if (issues.length > 0) throw unreadable(path, `it holds invalid entries: ${issues.join('; ')}`)

  return {
    version: BUNDLE_VERSION,
    kind: BUNDLE_KIND,
    scope: 'global',
    entries: rawEntries as readonly RegistryEntry[],
    omitted,
  }
}

/** The three keys an omission record may carry, on either arm. */
const OMITTED_ROOT_KEYS: ReadonlySet<string> = new Set(['type', 'id', 'field'])

/**
 * One omission record, BUILT from the fields it validated — or every way it
 * violates its envelope.
 *
 * The same policy {@link registryEntryIssues} gives the sibling `entries[]`
 * array in the loop above, not a second one: the same type vocabulary (retired
 * words admitted, because a bundle is a document another build wrote), unknown
 * root keys refused, and every issue reported rather than the first.
 *
 * It CONSTRUCTS rather than narrowing the document with a predicate, and that is
 * the difference this function exists for. A predicate leaves the parsed object
 * itself in the process — carrying whatever properties it arrived with — and
 * `runImportCommand` copies that object onto `panda import`'s stdout, a fourth
 * exit site beside the three the story enumerates. Two holes came through it: a
 * record could smuggle a credential in a key nobody declared (`__proto__`
 * included, since `JSON.parse` makes it an own data property), and `type` was
 * declared `StoredEntryType` while being checked as a bare string, which left it
 * the one free-text slot on the arm that must carry none. Building the record is
 * what makes the type's structural guarantee TRUE at the boundary where a
 * document enters, rather than asserted about it with `as`.
 */
function readOmittedEntry(value: unknown): { entry: OmittedEntry } | { issues: readonly string[] } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { issues: ['an omission record must be an object'] }
  }
  const record = value as Record<string, unknown>
  const issues: string[] = []
  for (const key of Object.keys(record)) {
    // The KEY, never its value: an unknown key can hold anything, including the
    // credential the record exists to withhold.
    if (!OMITTED_ROOT_KEYS.has(key)) issues.push(`'${key}' is not allowed on an omission record`)
  }
  const type = record['type']
  const field = record['field']
  if (!isStoredEntryType(type) || !isOmittedField(field)) {
    if (!isStoredEntryType(type)) issues.push(`'type' must be one of: ${REGISTRY_ENTRY_TYPES.join(', ')}`)
    if (!isOmittedField(field)) issues.push(`'field' must be one of: ${OMITTED_FIELDS.join(', ')}`)
    return { issues }
  }
  if (field === 'id') {
    // A record that names this arm AND carries an id was written by a build that
    // leaked the credential into the record. REFUSED rather than
    // accepted-and-stripped: stripping means reading it first, and reading it is
    // what puts the value in this process. Not a BUNDLE_VERSION bump either —
    // that moves when an older reader could MISREAD a document, and a refusal is
    // not a misread. The remedy is named because a refusal that only describes
    // the shape it wanted hands the problem back: the bundle is simply stale.
    if (Object.hasOwn(record, 'id')) {
      issues.push(
        "'id' must be absent when 'field' is 'id', because there the id IS the credential; export it again from the source machine with this build",
      )
    }
    return issues.length > 0 ? { issues } : { entry: { type, field } }
  }
  const id = record['id']
  if (typeof id !== 'string' || id.length === 0) {
    issues.push("'id' must be a non-empty string")
    return { issues }
  }
  return issues.length > 0 ? { issues } : { entry: { type, id, field } }
}

function isOmittedField(value: unknown): value is OmittedField {
  return typeof value === 'string' && (OMITTED_FIELDS as readonly string[]).includes(value)
}

/** Reads and validates the bundle at `path`. */
export async function readBundle(path: string): Promise<RegistryBundle> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    // The errno alone: it names why the OS refused and can hold no part of the
    // document, unlike the parse message above it.
    throw unreadable(path, `it could not be read (${(error as NodeJS.ErrnoException)?.code ?? 'unknown error'})`)
  }
  return parseBundle(path, text)
}
