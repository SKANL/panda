import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { PANDA_ERROR_CODES, PandaError, registryEntryIssues } from '@skanl/panda-contracts'
import type { RegistryEntry, SkillSource, SourcedSkill } from '@skanl/panda-contracts'

// The filesystem `SkillSource` (FR-13c): the first implementation of a port that
// had none, so `ingestProviders` — 375 finished lines with zero production
// callers — finally has something to drive.
//
// ONE SKILL IS ONE DIRECTORY holding the entry file, and its id is the directory
// name. That is the exact inverse of what the projection's `filesFor` writes: it
// copies a whole tree under a SINGLE id, so reading a tree back as one id per
// directory is the only shape that round-trips.
//
// WHAT THIS FILE DOES NOT KNOW, and must not:
//
//   - WHICH roots. They are the `machineSkills` locations `@skanl/panda-environment`
//     derived from the shipped executor traits, every one of them verified by
//     running the real binary. A default root spelled here would be a second
//     table drifting from the one panda writes into.
//   - WHAT the entry file is called. `SKILL_ENTRY_FILE` belongs to
//     `@skanl/panda-projection`, which sits ABOVE this package in AD-2's topology, so
//     it arrives as an option rather than as a copied string constant.
//   - WHICH paths panda already owns. The ownership ledger is
//     `@skanl/panda-projection`'s too, and reaching it from here would invert the
//     topology. The caller reads it and hands the paths in.
//
// That third one is the load-bearing one, not a formality: panda PROJECTS skills
// into `~/.claude/skills`. A naive read of that directory reads panda's own
// output, and every run would grow the registry with a copy of its own
// projection. The ledger is the only thing that tells the two apart.

/** A candidate this source looked at and did not contribute, and why. */
export interface SkillsSourceWarning {
  readonly kind: 'not-a-skill' | 'unusable-id' | 'id-collision'
  /** The directory the observation is about. */
  readonly path: string
  readonly detail: string
}

export interface SkillsSourceOptions {
  /** Consulted in order. A root that does not exist contributes nothing. */
  readonly roots: readonly string[]
  /** The file name that makes a directory a skill; owned by the projection. */
  readonly entryFileName: string
  /** Absolute paths panda's ownership ledger claims: never re-ingested. */
  readonly ownedPaths?: readonly string[]
  /** Overrides the ownership identity recorded on every ingested entry. */
  readonly sourceId?: string
}

/**
 * A `SkillSource` that also reports what it decided NOT to contribute.
 *
 * `IngestWarning` has exactly one kind (`empty-source`) and the port's `list()`
 * returns skills and nothing else, so a directory that is not a skill has no
 * channel through the ingest driver. Reporting it on the source is what keeps
 * "panda skipped 3 of the 41 directories it found" from becoming silence — the
 * caller reads these after the run.
 */
export interface MachineSkillsSource extends SkillSource {
  /**
   * Narrowed from the port's `Promise | array`: this source always reads a
   * filesystem, so a caller never has to decide which of the two it got.
   */
  list(): Promise<readonly SourcedSkill[]>
  /** Populated by `list()`; replaced, not appended to, on a second call. */
  readonly warnings: readonly SkillsSourceWarning[]
  /** Directories left alone because the ownership ledger claims them. */
  readonly excluded: readonly string[]
}

/**
 * The ownership identity every ingested skill records.
 *
 * STABLE, and that is the whole of its job: `ingestProviders` refuses to
 * overwrite an entry owned by a different origin, so a renamed source id would
 * make every previously ingested skill an unrelocatable conflict.
 */
export const MACHINE_SKILLS_SOURCE_ID = 'panda.machine-skills'

/** win32 differs in drive-letter and directory casing between processes. */
function pathKey(path: string): string {
  const resolved = resolve(path)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function detailOf(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code
  return code ?? (error instanceof Error ? error.message : String(error))
}

function unreadable(detail: string): PandaError {
  // The same code `ingestProviders` wraps a failing `list()` in, so an origin
  // that fails on its own terms and one that fails inside the driver report
  // under one code rather than two spellings of the same fact.
  return new PandaError(PANDA_ERROR_CODES.registryProviderRejected, detail)
}

/**
 * The child directory names of one root, or `undefined` when the root is simply
 * not there.
 *
 * ABSENCE IS NOT FAILURE (AD-5): an executor is allowed not to be installed, and
 * `~/.codex/skills` on a machine without codex is the ordinary case rather than
 * an error. Everything else — a path that exists and is a file, a path panda
 * cannot look at — is coded and names the path, because both of those are a
 * misconfiguration a user can act on and neither is an absence.
 */
async function readRoot(root: string): Promise<readonly string[] | undefined> {
  let isDirectory: boolean
  try {
    isDirectory = (await stat(root)).isDirectory()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined
    throw unreadable(`skills root '${root}' cannot be read (${detailOf(error)})`)
  }
  if (!isDirectory) {
    throw unreadable(
      `skills root '${root}' exists and is not a directory; panda reads skills from a directory and will not guess at what this is`,
    )
  }
  try {
    // Sorted, so the same disk always lists in the same order and an outcome is
    // comparable between runs and machines.
    return [...(await readdir(root))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  } catch (error) {
    throw unreadable(`skills root '${root}' cannot be listed (${detailOf(error)})`)
  }
}

/**
 * The change token, and panda never interprets it (M7): mtime plus size is the
 * filesystem's cheapest honest answer to "did this move".
 *
 * ponytail: it covers the ENTRY FILE, not the whole tree, so a sibling file
 * edited beside an untouched `SKILL.md` reports unchanged. What that decides is
 * only whether the registry ROW is rewritten — the row holds a pointer, and the
 * projection re-reads the tree from disk on every run — so the ceiling costs a
 * redundant write, never a stale projection. Upgrade path: hash the tree, at the
 * cost of walking every skill on every run.
 */
function changeToken(mtimeMs: number, size: number): string {
  return `${mtimeMs}:${size}`
}

/**
 * The identity of a whole tree — every relative path under it and the bytes at
 * that path — order-independent, so two copies list-order cannot separate.
 *
 * DELIBERATELY NOT the change token above. That one is mtime plus size and
 * answers "did this path change"; two byte-identical trees copied at different
 * times carry different tokens, so it can never answer "are these the same
 * skill". This is the real content comparison amendment 2 needs, and it runs
 * ONLY on the collision path — 24 ids of 40 on the author's machine, never all
 * of them — because walking and hashing every skill on every run is exactly the
 * cost D5 chose the cheap token to avoid.
 *
 * `undefined` means panda could not read the tree, which the caller treats as
 * DIVERGENT: a tree panda cannot compare is one panda must not declare the same.
 */
async function treeIdentity(directory: string): Promise<string | undefined> {
  const files: (readonly [string, string])[] = []
  const walk = async (at: string, prefix: string): Promise<void> => {
    for (const item of await readdir(at, { withFileTypes: true })) {
      const child = join(at, item.name)
      const key = prefix === '' ? item.name : `${prefix}/${item.name}`
      // `stat`, not the dirent's kind, so a link inside a skill is compared by
      // what it points at — the same reading the projection copies it under.
      const stats = await stat(child)
      if (stats.isDirectory()) await walk(child, key)
      else if (stats.isFile()) {
        files.push([key, createHash('sha256').update(await readFile(child)).digest('hex')])
      }
    }
  }
  try {
    await walk(directory, '')
  } catch {
    return undefined
  }
  files.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  return createHash('sha256').update(JSON.stringify(files)).digest('hex')
}

/** One root's offer of one id, in the order the roots were consulted. */
interface Candidate {
  readonly directory: string
  readonly contentHash: string
}

export function createMachineSkillsSource(options: SkillsSourceOptions): MachineSkillsSource {
  const entryFileName = options.entryFileName
  const owned = new Set((options.ownedPaths ?? []).map(pathKey))
  // A root repeated in the list would collide with itself and report every one
  // of its skills as ambiguous, which is a fact about the argument rather than
  // about the machine.
  const roots = [...new Map(options.roots.map((root) => [pathKey(root), root])).values()]
  const warnings: SkillsSourceWarning[] = []
  const excluded: string[] = []

  return {
    sourceId: options.sourceId ?? MACHINE_SKILLS_SOURCE_ID,
    warnings,
    excluded,
    async list(): Promise<readonly SourcedSkill[]> {
      // Replaced rather than appended to: a second `list()` over an unchanged
      // disk must report what it saw, not twice what it saw.
      warnings.length = 0
      excluded.length = 0
      // Keyed by id, in first-seen order, so the answer does not depend on which
      // root a directory happened to be listed from.
      const offers = new Map<string, Candidate[]>()

      for (const root of roots) {
        const names = await readRoot(root)
        if (names === undefined) continue
        for (const name of names) {
          const directory = join(root, name)
          const entryPath = join(directory, entryFileName)
          let size: number
          let mtimeMs: number
          try {
            const stats = await stat(entryPath)
            if (!stats.isFile()) throw new Error('not a file')
            size = stats.size
            mtimeMs = stats.mtimeMs
          } catch {
            // A `.git`, an `assets` folder or a loose README beside real skills.
            // Reported and skipped, never fatal: one of those must not stop panda
            // from ingesting the skills that ARE there.
            warnings.push({
              kind: 'not-a-skill',
              path: directory,
              detail: `'${directory}' holds no ${entryFileName}, so no executor would discover it as a skill; panda skipped it`,
            })
            continue
          }
          if (owned.has(pathKey(entryPath))) {
            // Panda's own projection. Ingesting it would make the registry a copy
            // of its own output and the second run would differ from the first.
            excluded.push(directory)
            continue
          }
          const entry: RegistryEntry = { type: 'skill', id: name, entryPath: directory }
          // The CONTRACT's rule, asked of the contract. A second copy of "what is
          // a legal id" here would be a rule that drifts from the one the store
          // enforces — and `ingestProviders` raises a rejection for the whole
          // run, so a directory panda cannot name has to be filtered out before
          // it gets there rather than after.
          const issues = registryEntryIssues(entry)
          if (issues.length > 0) {
            warnings.push({
              kind: 'unusable-id',
              path: directory,
              detail: `'${directory}' cannot be a registry id: ${issues.map((item) => item.message).join('; ')}; panda skipped it rather than renaming it to something you could not predict`,
            })
            continue
          }
          const candidate: Candidate = { directory, contentHash: changeToken(mtimeMs, size) }
          const offered = offers.get(name)
          if (offered === undefined) offers.set(name, [candidate])
          else offered.push(candidate)
        }
      }

      const listed: SourcedSkill[] = []
      for (const [id, candidates] of offers) {
        const first = candidates[0]!
        const entry: RegistryEntry = { type: 'skill', id, entryPath: first.directory }
        if (candidates.length === 1) {
          listed.push({ entry, contentHash: first.contentHash })
          continue
        }
        // AMENDMENT 2. Two roots offering one id used to be refused outright,
        // which on the machine this was measured on refused 24 of 40 ids — the
        // MAIN case, because a user hand-syncing three roots is exactly panda's
        // target user. Eleven of those 24 trees are byte-identical: there is no
        // decision to make there, it is the same skill twice. The other 13
        // genuinely differ, and picking one of THOSE would silently choose
        // between two different skills, so that refusal stays.
        const identities = await Promise.all(candidates.map((item) => treeIdentity(item.directory)))
        if (identities.some((identity) => identity === undefined || identity !== identities[0])) {
          warnings.push({
            kind: 'id-collision',
            path: first.directory,
            // Every root that offered it, in one warning: a user deciding which
            // copy to keep needs all of them, and one warning per extra root
            // reported the same fact as many times as it was seen.
            detail: `skill id '${id}' is offered by ${candidates.length} roots with trees that are not identical (${candidates
              .map((item) => `'${item.directory}'`)
              .join(', ')}); panda ingested none of them rather than picking between skills that differ`,
          })
          continue
        }
        // The FIRST root that offered it, and the choice has to be made because
        // the PATH is what gets recorded and re-read on every later projection —
        // the bytes are identical, the path is not. First-offered is the caller's
        // own declared root order rather than a preference invented here, and it
        // is stable across runs and machines, which is what E14 (a second run
        // leaves the registry file byte-identical) actually rests on: a rule like
        // "newest mtime" or "shortest path" would rewrite the row whenever the
        // user touched a copy panda did not record.
        listed.push({ entry, contentHash: first.contentHash })
      }
      return listed
    },
  }
}
