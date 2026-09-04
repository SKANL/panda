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
import { PandaError, PANDA_ERROR_CODES, normalizeRegistryEntryPaths, registryEntryIssues } from '@panda/contracts'
import type { RegistryEntry, StoredEntryType } from '@panda/contracts'
import { strictFaultLocation } from './document-fault.ts'

/** Bumped only when a reader of an older build could MISREAD the document. */
export const BUNDLE_VERSION = 1

/** Names the artifact in its own bytes, so a stray JSON file is not mistaken for one. */
export const BUNDLE_KIND = 'panda-bundle'

/**
 * An entry that did not travel, and the field that stopped it.
 *
 * The VALUE is never here — not the token, not an excerpt, not its length. What
 * this carries is what a person needs to re-create the entry by hand on the
 * other machine, and what a later import needs in order to list it as pending
 * rather than silently lack it.
 */
export interface OmittedEntry {
  readonly type: StoredEntryType
  readonly id: string
  /** The envelope field whose value matched: `id`, `command`, `entryPath`, `args` or `extensions`. */
  readonly field: string
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

/** Whether one string should keep panda's Registry off another machine. */
export function isCredential(value: string): boolean {
  if (PROVIDER_PATTERNS.some((pattern) => pattern.test(value))) return true
  if (NOT_A_CREDENTIAL.some((pattern) => pattern.test(value))) return false
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
function credentialField(entry: RegistryEntry): string | undefined {
  if (isCredential(entry.id)) return 'id'
  if (entry.command !== undefined && isCredential(entry.command)) return 'command'
  if (entry.entryPath !== undefined && isCredential(entry.entryPath)) return 'entryPath'
  if (entry.args?.some((argument) => isCredential(argument)) === true) return 'args'
  if (entry.extensions !== undefined && stringsWithin(entry.extensions).some(isCredential)) {
    return 'extensions'
  }
  return undefined
}

// --- The bundle ------------------------------------------------------------

function sortKey(entry: { readonly type: string; readonly id: string }): string {
  return `${entry.type}:${entry.id}`
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
  for (const [index, candidate] of rawOmitted.entries()) {
    if (!isOmittedEntry(candidate)) issues.push(`omitted[${index}]: must be {type, id, field} of strings`)
  }
  if (issues.length > 0) throw unreadable(path, `it holds invalid entries: ${issues.join('; ')}`)

  return {
    version: BUNDLE_VERSION,
    kind: BUNDLE_KIND,
    scope: 'global',
    entries: rawEntries as readonly RegistryEntry[],
    omitted: rawOmitted as readonly OmittedEntry[],
  }
}

function isOmittedEntry(value: unknown): value is OmittedEntry {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record['type'] === 'string' &&
    typeof record['id'] === 'string' &&
    typeof record['field'] === 'string'
  )
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
