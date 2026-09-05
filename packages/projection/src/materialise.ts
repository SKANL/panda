import { lstat, mkdir, readdir, readFile, rm, rmdir, stat } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { PANDA_ERROR_CODES, PandaError } from '@skanl/panda-contracts'
import type {
  DriftEntry,
  ProjectionClaim,
  ProjectionLedgerRecord,
  ProjectionMaterialisePlan,
  ProjectionMaterialiseTarget,
  ProjectionOwnedPath,
  ProjectionResult,
  ProjectionSkip,
  RegistryEntriesByKind,
} from '@skanl/panda-contracts'
import { atomicWriteBytes } from './atomic-write.ts'
import {
  canonicalBytesHash,
  hashOwnedBytes,
  hashOwnedText,
  isUnderRoot,
  resolveOwnedPath,
  sameOwnedPath,
} from './ledger.ts'

// Materialisation (correction-01 C4): the half of projection whose unit is a
// DIRECTORY TREE. It carries the same four guarantees the config merge does —
// atomic writes, idempotence, foreign content untouched, per-target failure
// isolation — and it is the first place panda DELETES from a user's filesystem.
//
// That last sentence is the reason every decision below lives HERE rather than
// in a target. A target says what the registry wants; nothing else. What is on
// disk, whether panda put it there, and whether panda may take it away is
// decided once, in this file, against the ledger.
//
// THE REMOVAL RULE, in full. Panda removes a path only when ALL of these hold:
//   1. a ledger record for this target and this root claims that exact path;
//   2. that path, and every directory between it and the root, is a real file
//      or directory rather than a LINK — a reparse point is not the path panda
//      wrote, whatever the bytes behind it hash to;
//   3. the RESOLVED path is inside the root. Checked here rather than trusted:
//      a record is a file panda parsed, so a corrupted or hostile one must not
//      be able to name `~/.claude.json`, and a relative one must not resolve
//      against the process working directory;
//   4. the file still hashes BYTE FOR BYTE to what the record says panda wrote,
//      and so does every OTHER path in the same record;
//   5. the entry is absent from the REGISTRY — not merely unrenderable, because
//      "panda cannot read this skill's source today" must never become "delete
//      it from every executor";
//   6. no record that SURVIVES this run claims the same path. Two registry ids
//      can land on one path (`alpha` and `Alpha` are one directory on Windows),
//      and dropping one of them must not delete the other's file.
// A tree the user has edited fails (4) and is REPORTED as drift rather than
// removed: that is a decision, and the spec makes it a human's.
//
// WHY LINKS ARE THEIR OWN CLAUSE. The safety argument for foreign content used
// to rest entirely on `rmdir` refusing a non-empty directory. Measured: `rmdir`
// on a junction to a non-empty directory REMOVES THE LINK without consulting
// the target. And a hash check reads THROUGH a link, so a user who moved a
// materialised tree into their own repository and left a junction behind would
// read as `intact` — panda would then delete their real file outside its own
// root. So every claimed path is `lstat`ed along its whole length below the
// root, and any link at all disqualifies the record from removal.
//
// TWO PREDICATES, DELIBERATELY DIFFERENT. Removal compares raw BYTES, because a
// false match precedes `rm`. The overwrite decision compares an EOL-normalised
// form, because `core.autocrlf` on a skills root kept in a dotfiles repository
// would otherwise flip every materialised file to `edited` permanently, and
// there is no adopt or force path in the product to get back out of that. The
// per-file write decision stays byte-exact, so idempotence is exact and a
// CRLF-flipped file is quietly rewritten back to what the source says.
//
// An unreadable ledger yields no records at all, so every clause above is
// unsatisfiable and nothing is removed. That is the refusal the spec asks for,
// and it needs no branch of its own.

/** One file panda will place, with the bytes and what was there before. */
interface PlannedWrite {
  readonly path: string
  readonly bytes: Uint8Array
  /** Bytes currently on disk, kept so a failed run can be rolled back exactly. */
  readonly previous: Uint8Array | undefined
}

/** The ledger-versus-disk verdict for one claimed tree. */
type TreeState = 'intact' | 'edited' | 'gone'

/** The two verdicts a claimed tree gets, under the two predicates above. */
interface TreeStates {
  /** Byte-exact. The only one that may authorise an `rm`. */
  readonly remove: TreeState
  /** EOL-normalised. Decides whether panda may refresh its own tree. */
  readonly write: TreeState
}

function driftEntry(
  kind: DriftEntry['kind'],
  entryId: string,
  location: string,
  detail: string,
): DriftEntry {
  return { kind, entryId, location, detail }
}

/**
 * `undefined` — nothing there. `'unreadable'` — something IS there and panda
 * cannot read it (a directory where a file was, a mode the user changed).
 *
 * The second case is deliberately not a throw: it means "present and not what
 * panda wrote", which is drift on one entry, and throwing would fail the whole
 * target and unmaterialise every OTHER skill for that executor.
 */
async function readIfPresent(path: string): Promise<Uint8Array | 'unreadable' | undefined> {
  try {
    return await readFile(path)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    return code === 'ENOENT' || code === 'ENOTDIR' ? undefined : 'unreadable'
  }
}

// `isUnderRoot` is the shared boundary check in `ledger.ts`, beside the path
// canonicalisation it is inseparable from. The destination of every write is
// built from a root-relative path a target supplied, and a target is ordinary
// code: it is what stops `../..` in a registry id from turning a projection into
// an arbitrary write. The REMOVAL path applies the same check to every path a
// ledger record names, because a record is parsed from a file and is therefore
// input, not fact — and so does the ADOPT path, because the record it writes is
// an authority to delete on some later run.

function absolutePathOf(root: string, relativePath: string, entryId: string): string {
  const resolved = resolveOwnedPath(join(root, ...relativePath.split('/')))
  if (!isUnderRoot(resolved, root)) {
    throw new PandaError(
      PANDA_ERROR_CODES.projectionTraitsInvalid,
      `materialisation target planned '${relativePath}' for entry '${entryId}', which resolves outside its own root '${root}'`,
    )
  }
  return resolved
}

async function isLink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * Whether reaching `path` from `root` passes through any link.
 *
 * `lstat` refuses to follow only the FINAL component, so checking the file
 * alone would miss the case that matters most: a junction at `<root>/<id>`
 * whose files resolve perfectly through it.
 */
async function traversesLink(path: string, root: string): Promise<boolean> {
  let current = path
  while (isUnderRoot(current, root)) {
    if (await isLink(current)) return true
    current = dirname(current)
  }
  return false
}

/** Machine-independent identity of a whole tree: its paths and their bytes. */
function treeHash(root: string, owned: readonly ProjectionOwnedPath[]): string {
  return hashOwnedText(
    JSON.stringify(
      owned.map((entry) => [relative(root, entry.path).split(sep).join('/'), entry.contentHash]),
    ),
  )
}

/**
 * `rmdir` upward from a directory panda emptied, stopping at the first one that
 * is not empty and never reaching the root.
 *
 * `rmdir` rather than a recursive delete on purpose: it REFUSES a directory
 * that still holds anything, so a foreign file the user put inside panda's tree
 * keeps its directory alive without panda having to notice it. It does NOT
 * refuse a junction to a non-empty directory — measured — so a link stops the
 * walk before `rmdir` is ever reached.
 */
async function pruneEmptyDirectories(from: string, root: string): Promise<void> {
  let directory = from
  while (isUnderRoot(directory, root)) {
    if (await isLink(directory)) return
    try {
      await rmdir(directory)
    } catch {
      return
    }
    directory = dirname(directory)
  }
}

/**
 * Whether anything at all occupies `path`. An error panda cannot classify is
 * reported as OCCUPIED: the caller uses this to prove a location is free, and an
 * unreadable answer is not a proof.
 */
async function occupied(path: string): Promise<{ taken: boolean; detail: string }> {
  try {
    await stat(path)
    return { taken: true, detail: 'it already exists' }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { taken: false, detail: '' }
    return {
      taken: true,
      detail: `panda could not determine whether it is free (${code ?? 'unknown error'})`,
    }
  }
}

/**
 * Whether an entry's own DIRECTORY holds content panda must not resolve.
 *
 * AN EMPTY DIRECTORY IS NOBODY'S CONTENT, and treating one as a foreign
 * collision built a state with no exit that panda's own instructions walked the
 * user into: delete a materialised `SKILL.md` and its directory survives; doctor
 * reports `removed-by-user` and says `release` frees the location so the next
 * run writes it back; `release` drops the claim; the next run then finds the
 * EMPTY directory, calls it foreign and refuses; `adopt` has nothing to claim
 * and refuses; `release` has no claim left and refuses. Exit 1 forever, escapable
 * only with `rmdir` by hand. Panda was refusing to write in order to protect
 * nothing.
 *
 * The protection that stays exactly as it was: a directory holding ANY entry is
 * foreign, and so is one panda cannot list — an unreadable answer is not a proof
 * that a location is free. A LINK is occupation whatever it points at, because
 * writing through it lands outside the root panda owns.
 */
async function occupiedByContent(directory: string): Promise<{ taken: boolean; detail: string }> {
  const state = await occupied(directory)
  if (!state.taken) return state
  if (await isLink(directory)) return state
  try {
    if ((await readdir(directory)).length > 0) return state
  } catch {
    return state
  }
  return { taken: false, detail: '' }
}

/** One spelling of a path for set membership, matching `sameOwnedPath`. */
function pathKey(path: string): string {
  const resolved = resolveOwnedPath(path)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

export interface MaterialiseOutcome {
  readonly result: ProjectionResult
  readonly records: readonly ProjectionLedgerRecord[]
}

/** A plan with the entries that are ALREADY where they would be written taken out. */
interface PlannedMaterialisation {
  readonly plan: ProjectionMaterialisePlan
  /** Entry ids whose every source path IS the path panda would write it to. */
  readonly satisfied: ReadonlySet<string>
}

/**
 * The ONE place a materialisation plan is obtained, and the one place the
 * SOURCE-IS-THE-DESTINATION verdict is reached (spec M9.A amendment 3).
 *
 * `panda ingest` reads the same roots the projection writes into, so an ingested
 * skill arrives already sitting at one of its own destinations. Panda's ledger
 * does not claim it — panda did not write it — and the plain reading of that was
 * `foreign-collision`, so using the feature immediately reported a broken
 * environment. The verdict was also factually wrong: the bytes that should be
 * there ARE there, byte for byte, because the file panda would copy FROM and the
 * file panda would copy TO are the same file.
 *
 * So the entry is ALREADY SATISFIED: nothing to write, nothing to claim, no
 * drift. It stays in `presentEntryIds`, which is what keeps it out of the
 * removal path, and it is deliberately NOT reported as `skipped` — a skipped
 * entry is one a target could not express (C5), and this one is expressed
 * perfectly. Reporting it would be reporting a problem that is not there.
 *
 * NOT ADOPTED, and that is the load-bearing half: panda did not write these
 * bytes, so claiming them would make `panda remediate release` an authority to
 * delete a skill the user owns. The ledger keeps telling the truth.
 *
 * Both consumers of a plan route through here — the engine below and
 * {@link claimMaterialised} — so the rule is stated once rather than guarded at
 * each decision that would otherwise have to re-derive it.
 */
async function planFor(
  target: ProjectionMaterialiseTarget,
  entries: RegistryEntriesByKind,
  claimed: readonly ProjectionLedgerRecord[],
  root: string,
): Promise<PlannedMaterialisation> {
  const plan = await target.plan({ entries, records: claimed, rootPath: root })
  const satisfied = new Set<string>()
  for (const entry of plan.entries) {
    // CANONICAL comparison, never string equality: a target's `sourcePath` and
    // the destination panda builds from the root are two spellings arrived at by
    // different routes, and on win32 they can differ in drive-letter and
    // directory casing while naming one file. `pathKey` is the same spelling the
    // removal path keys ownership on.
    const same = entry.files.every((file) => {
      let destination: string
      try {
        destination = absolutePathOf(root, file.relativePath, entry.entryId)
      } catch {
        // Outside the root: not satisfied, and the ordinary path reports it.
        return false
      }
      return pathKey(destination) === pathKey(file.sourcePath)
    })
    if (same && entry.files.length > 0) satisfied.add(entry.entryId)
  }
  if (satisfied.size === 0) return { plan, satisfied }
  return {
    plan: { ...plan, entries: plan.entries.filter((entry) => !satisfied.has(entry.entryId)) },
    satisfied,
  }
}

/**
 * The ledger record that would claim the tree currently at one entry's location
 * — the materialisation half of `adopt`, and the exit from every reported state
 * a skills root can be in: a `foreign-collision` (panda's own tree left
 * unclaimed by a crash included), an `edited` tree, and a tree that is only
 * PARTLY there.
 *
 * IT LIVES HERE, BESIDE THE REMOVAL RULE, ON PURPOSE. A record this returns is
 * an authority to DELETE on some later run, so every clause of that rule is
 * applied while the record is built rather than trusted afterwards: the paths
 * come from the target's own plan (never from a directory listing, so a file the
 * user put beside panda's is not swept into the claim and cannot later be
 * removed); each is resolved and containment-checked against the root; a link
 * anywhere between the root and the file disqualifies it; and a path any OTHER
 * record already claims is refused rather than duplicated.
 *
 * A PARTIALLY PRESENT TREE IS CLAIMED AS THE SUBSET THAT IS THERE, and that is
 * the correction that gives that state an exit at all. Claiming the whole
 * planned set would write a record reading `edited` on the very next run — the
 * state adoption exists to leave — so panda claims exactly the files that exist,
 * the record reads `intact`, and the ordinary run writes the missing ones back.
 * Refusing instead (the first shipped shape) left three separate routes into a
 * tree with no exit but `rm -rf`: `release` on an edited tree, a crash inside
 * `land()` between two file writes, and a user deleting one file from a skill.
 *
 * ponytail: when a record claims MORE paths than the plan wants — a file that
 * left the source — adoption claims the planned subset and lets that path go
 * unclaimed, so the ordinary run stops being authorised to take it back and it
 * stays inside panda's tree. Under-claiming, which is the safe direction and the
 * one this whole file errs towards; the alternative is claiming the union, which
 * widens what an explicit user action makes deletable. Upgrade path: claim the
 * union once a case exists where the leftover file matters.
 *
 * WHEN THE ENTRY HAS LEFT THE REGISTRY the plan holds nothing for it, and the
 * ledger record is the fallback authority — that is the shape reported as
 * `edited` on the removal path, whose only other exit was `release`, which drops
 * the claim and leaves the tree on disk forever. Adoption there means the next
 * ordinary run REMOVES the tree, which is why the claim carries `removedNext`
 * and the caller has to say so before writing it.
 */
export async function claimMaterialised(
  target: ProjectionMaterialiseTarget,
  entries: RegistryEntriesByKind,
  claimed: readonly ProjectionLedgerRecord[],
  entryId: string,
): Promise<ProjectionClaim> {
  const root = resolveOwnedPath(target.rootPath)
  const { plan, satisfied } = await planFor(target, entries, claimed, root)
  const planned = plan.entries.find((candidate) => candidate.entryId === entryId)
  const held = claimed.find(
    (record) =>
      record.entryId === entryId &&
      record.targetId === target.targetId &&
      sameOwnedPath(resolveOwnedPath(record.filePath), root) &&
      (record.ownedPaths ?? []).length > 0,
  )
  const location = planned?.location ?? held?.nativeLocation ?? entryId
  const refuse = (refusal: string): ProjectionClaim => ({ location, byteLength: 0, refusal })
  if (planned === undefined && held === undefined) {
    if (satisfied.has(entryId)) {
      // Already satisfied, so there is nothing to adopt — and adopting is the
      // one thing that must not happen here: panda did not write these bytes,
      // and a claim over them is an authority to DELETE them on a later run.
      return refuse(
        `'${entryId}' under '${root}' is the very source panda would copy from, so it is already exactly what panda would write; panda did not put it there and will not claim a file it did not write`,
      )
    }
    const skipped = (plan.skipped ?? []).find((candidate) => candidate.entryId === entryId)
    return refuse(
      skipped?.reason ??
        `panda would not materialise '${entryId}' under '${root}' and holds no record of ever having done so, so there is nothing there for panda to claim`,
    )
  }

  // Every path a SURVIVING claim holds, so two registry ids that land on one
  // path cannot both own it — the same clause 6 the removal path applies, and
  // for the same reason: a record that claims another entry's file is an
  // authority to delete it.
  const otherClaims = new Set(
    claimed
      .filter((record) => record.entryId !== entryId)
      .flatMap((record) => (record.ownedPaths ?? []).map((item) => pathKey(item.path))),
  )

  // The plan's paths where panda would write, the RECORD's where panda no longer
  // would. Never a directory listing: a file the user added beside panda's must
  // stay outside every claim panda writes.
  let candidates: string[]
  if (planned !== undefined) {
    try {
      candidates = planned.files.map((file) => absolutePathOf(root, file.relativePath, entryId))
    } catch (error) {
      return refuse(error instanceof Error ? error.message : String(error))
    }
  } else {
    candidates = (held?.ownedPaths ?? []).map((item) => resolveOwnedPath(item.path))
  }

  const owned: ProjectionOwnedPath[] = []
  let byteLength = 0
  let absent = 0
  for (const path of candidates) {
    // Re-checked for the record-derived list too: a record is a file panda
    // PARSED, so its paths are input rather than fact.
    if (!isUnderRoot(path, root)) {
      return refuse(`'${path}' is outside '${root}'; panda will not claim a path it cannot prove it owns`)
    }
    if (await traversesLink(path, root)) {
      return refuse(
        `'${path}' is reached through a link, so it is not a path panda can prove it owns; panda will not claim it`,
      )
    }
    if (otherClaims.has(pathKey(path))) {
      return refuse(
        `'${path}' is already claimed by another registry entry at this root; panda will not claim one file twice`,
      )
    }
    const bytes = await readIfPresent(path)
    if (bytes === undefined) {
      // The subset rule. Not a refusal: claiming what IS there is what makes a
      // partially materialised tree leavable, and the ordinary run writes the
      // rest back because the record it reads is `intact`.
      absent += 1
      continue
    }
    if (bytes === 'unreadable') {
      return refuse(`'${path}' cannot be read, so panda cannot hash what it would be claiming`)
    }
    byteLength += bytes.byteLength
    owned.push({
      path,
      contentHash: hashOwnedBytes(bytes),
      canonicalHash: canonicalBytesHash(bytes),
    })
  }
  if (owned.length === 0) {
    return refuse(
      `nothing of '${entryId}' is on disk under '${root}'${absent === 0 ? '' : ` (${absent} path(s) panda would claim are absent)`}; there is nothing to claim`,
    )
  }
  return {
    location,
    byteLength,
    ownedPaths: owned.map((item) => item.path),
    removedNext: !plan.presentEntryIds.includes(entryId),
    record: {
      targetId: target.targetId,
      filePath: root,
      nativeLocation: location,
      entryId,
      contentHash: treeHash(root, owned),
      ownedPaths: owned,
    },
  }
}

/**
 * Runs one materialisation target: plan, classify against the ledger, then —
 * under `apply` — land exactly the difference.
 *
 * Under inspection NOTHING touches the filesystem except reads, and
 * `result.written` reads as "these paths WOULD change", which is the one field
 * whose sentence the mode alters.
 */
export async function materialiseTarget(
  target: ProjectionMaterialiseTarget,
  entries: RegistryEntriesByKind,
  claimed: readonly ProjectionLedgerRecord[],
  apply: boolean,
): Promise<MaterialiseOutcome> {
  const root = resolveOwnedPath(target.rootPath)
  const { plan } = await planFor(target, entries, claimed, root)

  const drift: DriftEntry[] = []
  const records: ProjectionLedgerRecord[] = []
  const skipped: ProjectionSkip[] = [...(plan.skipped ?? [])]
  const writes: PlannedWrite[] = []
  const candidateRemovals: string[] = []

  const keep = (record: ProjectionLedgerRecord): void => {
    records.push(record)
  }

  // A record is authority ONLY if it claims PATHS, and only paths inside this
  // root. Everything else is CARRIED THROUGH UNTOUCHED rather than dropped:
  // persisting a reduced record set is how a one-run under-claim becomes a
  // permanent orphan, which Story 2.8's review already declared terminal for
  // the whole-ledger case. The same rule has to hold per record.
  const authoritative: ProjectionLedgerRecord[] = []
  for (const record of claimed) {
    const owned = record.ownedPaths ?? []
    if (
      record.targetId !== target.targetId ||
      !sameOwnedPath(resolveOwnedPath(record.filePath), root) ||
      owned.length === 0
    ) {
      keep(record)
      continue
    }
    const escaping = owned.find((item) => !isUnderRoot(resolveOwnedPath(item.path), root))
    if (escaping !== undefined) {
      drift.push(
        driftEntry(
          'foreign-collision',
          record.entryId,
          record.nativeLocation,
          `panda's ledger claims '${escaping.path}' for '${record.entryId}', which is outside '${root}'; panda will not touch a path it cannot prove it owns`,
        ),
      )
      keep(record)
      continue
    }
    authoritative.push(record)
  }

  const sizes = new Map<string, number>()
  const states = new Map<string, TreeStates>()
  for (const record of authoritative) {
    const owned = record.ownedPaths ?? []
    let present = 0
    let exact = 0
    let canonical = 0
    let linked = false
    for (const item of owned) {
      if (await traversesLink(item.path, root)) {
        linked = true
        present += 1
        continue
      }
      const bytes = await readIfPresent(item.path)
      if (bytes === undefined) continue
      present += 1
      if (bytes === 'unreadable') continue
      sizes.set(item.path, bytes.byteLength)
      if (hashOwnedBytes(bytes) === item.contentHash) exact += 1
      // No `canonicalHash` means a record an older build wrote: fall back to the
      // exact hash, which is the conservative direction for both predicates.
      if (canonicalBytesHash(bytes) === (item.canonicalHash ?? item.contentHash)) canonical += 1
    }
    const total = owned.length
    const verdict = (matches: number): TreeState =>
      present === 0 ? 'gone' : !linked && present === total && matches === total ? 'intact' : 'edited'
    states.set(record.entryId, { remove: verdict(exact), write: verdict(canonical) })
  }

  const wanted = new Map(plan.entries.map((entry) => [entry.entryId, entry]))
  const registered = new Set(plan.presentEntryIds)
  const byEntry = new Map(authoritative.map((record) => [record.entryId, record]))

  // 1. Trees whose entry left the REGISTRY. The only removals panda performs.
  for (const record of [...authoritative].sort((a, b) => (a.entryId < b.entryId ? -1 : 1))) {
    if (wanted.has(record.entryId)) continue
    if (registered.has(record.entryId)) {
      // Registered, and this run could not render it (an unreadable source, an
      // id panda cannot use as a directory). The claim survives untouched, or
      // the next run would treat panda's own tree as foreign forever.
      keep(record)
      continue
    }
    const state = states.get(record.entryId)?.remove
    if (state === 'gone') continue
    if (state === 'edited') {
      drift.push(
        driftEntry(
          'edited',
          record.entryId,
          record.nativeLocation,
          `'${record.entryId}' under '${root}' is no longer byte-for-byte what panda wrote, or is reached through a link; panda will not remove a tree it no longer recognises`,
        ),
      )
      keep(record)
      continue
    }
    for (const owned of record.ownedPaths ?? []) candidateRemovals.push(owned.path)
  }

  // 2. Trees the registry holds. Panda writes only where it already owns the
  //    location or where the location is provably free.
  for (const entry of plan.entries) {
    const record = byEntry.get(entry.entryId)
    const directory = absolutePathOf(root, entry.location, entry.entryId)
    const planned = entry.files.map((file) => ({
      file,
      path: absolutePathOf(root, file.relativePath, entry.entryId),
    }))

    if (record === undefined) {
      const state = await occupiedByContent(directory)
      if (state.taken) {
        drift.push(
          driftEntry(
            'foreign-collision',
            entry.entryId,
            entry.location,
            `'${directory}' is not claimed by panda's ledger and ${state.detail}; panda will not resolve the collision`,
          ),
        )
        continue
      }
    } else {
      const state = states.get(entry.entryId)?.write
      if (state === 'edited') {
        drift.push(
          driftEntry(
            'edited',
            entry.entryId,
            entry.location,
            `'${entry.entryId}' under '${root}' has been edited since panda wrote it; panda will not overwrite it`,
          ),
        )
        keep(record)
        continue
      }
      if (state === 'gone') {
        drift.push(
          driftEntry(
            'removed-by-user',
            entry.entryId,
            entry.location,
            `panda wrote '${entry.entryId}' under '${root}' and it is gone; panda will not re-add it`,
          ),
        )
        keep(record)
        continue
      }
      // Intact, but a file the plan wants may still be someone else's: a path
      // inside panda's directory that no record claims was put there by hand.
      const owned = (record.ownedPaths ?? []).map((item) => pathKey(item.path))
      const foreign = planned.find((item) => !owned.includes(pathKey(item.path)))
      if (foreign !== undefined && (await occupied(foreign.path)).taken) {
        drift.push(
          driftEntry(
            'foreign-collision',
            entry.entryId,
            entry.location,
            `'${foreign.path}' exists and panda's ledger does not claim it; panda will not resolve the collision`,
          ),
        )
        keep(record)
        continue
      }
    }

    // Every source read BEFORE the first byte lands, so a skill whose source
    // cannot be read is reported with nothing of it partially materialised.
    let sources: Uint8Array[]
    try {
      sources = await Promise.all(planned.map(async (item) => await readFile(item.file.sourcePath)))
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code ?? 'unknown error'
      skipped.push({
        entryId: entry.entryId,
        reason: `'${entry.entryId}' names a source panda cannot read (${code}); nothing was materialised for it`,
      })
      if (record !== undefined) keep(record)
      continue
    }

    const newOwned: ProjectionOwnedPath[] = []
    for (const [index, item] of planned.entries()) {
      const bytes = sources[index]!
      const contentHash = hashOwnedBytes(bytes)
      const previous = await readIfPresent(item.path)
      const disk = previous === 'unreadable' ? undefined : previous
      // Byte-exact, not canonical: this is the idempotence predicate, and it is
      // also what quietly repairs a materialised file whose line endings were
      // rewritten under panda.
      if (disk === undefined || hashOwnedBytes(disk) !== contentHash) {
        writes.push({ path: item.path, bytes, previous: disk })
      }
      newOwned.push({ path: item.path, contentHash, canonicalHash: canonicalBytesHash(bytes) })
    }
    // A file that left the source is a file panda still claims: taking it back
    // is part of keeping the tree equal to the registry, and it is safe because
    // the whole tree is `intact`.
    if (record !== undefined) {
      const keptPaths = newOwned.map((item) => pathKey(item.path))
      for (const owned of record.ownedPaths ?? []) {
        if (!keptPaths.includes(pathKey(owned.path))) candidateRemovals.push(owned.path)
      }
    }
    records.push({
      targetId: target.targetId,
      filePath: root,
      nativeLocation: entry.location,
      entryId: entry.entryId,
      contentHash: treeHash(root, newOwned),
      ownedPaths: newOwned,
    })
  }

  // Clause 6, applied last because it needs the FINAL record set: a path some
  // surviving record still claims is never removed, whichever entry scheduled
  // it. Without this the survivor's file disappears with no drift and is then
  // locked out as `removed-by-user` on the next run.
  const stillClaimed = new Set(
    records.flatMap((record) => (record.ownedPaths ?? []).map((item) => pathKey(item.path))),
  )
  const removals: string[] = []
  for (const path of candidateRemovals) {
    if (!stillClaimed.has(pathKey(path))) {
      removals.push(path)
      continue
    }
    const location = relative(root, resolveOwnedPath(path)).split(sep).join('/')
    drift.push(
      driftEntry(
        'foreign-collision',
        location,
        location,
        `'${path}' is claimed by more than one registry entry at this root; panda kept it rather than removing a file another entry still owns`,
      ),
    )
  }

  const written = writes.length > 0 || removals.length > 0
  const byteDelta =
    writes.reduce(
      (total, write) => total + Math.abs(write.bytes.byteLength - (write.previous?.byteLength ?? 0)),
      0,
    ) + removals.reduce((total, path) => total + (sizes.get(path) ?? 0), 0)

  if (apply && written) await land(writes, removals, root)

  return {
    result: {
      targetId: target.targetId,
      written,
      byteDelta,
      drift,
      skippedEntryIds: [...skipped.map((item) => item.entryId)].sort((a, b) =>
        a < b ? -1 : a > b ? 1 : 0,
      ),
      skipped,
    },
    records,
  }
}

/**
 * Lands the plan, or leaves the filesystem as it found it.
 *
 * Writes come first and every one of them is reversible — a created file is
 * deleted again, an overwritten one is restored from the bytes read before the
 * write — so a failure halfway through a tree leaves no partial tree behind.
 *
 * ponytail: the removals that follow are not reversible, and they are last for
 * that reason. A removal that fails after earlier ones succeeded leaves those
 * entries still claimed in the ledger (the target failed, so no ledger write
 * happens) and the next run finishes the job. Upgrade path: a staging directory
 * per target, which buys real transactionality at the price of copying every
 * tree twice.
 */
async function land(
  writes: readonly PlannedWrite[],
  removals: readonly string[],
  root: string,
): Promise<void> {
  const applied: PlannedWrite[] = []
  try {
    for (const write of writes) {
      await mkdir(dirname(write.path), { recursive: true })
      await atomicWriteBytes(write.path, write.bytes)
      applied.push(write)
    }
  } catch (error) {
    for (const write of [...applied].reverse()) {
      if (write.previous === undefined) {
        await rm(write.path, { force: true }).catch(() => {})
        await pruneEmptyDirectories(dirname(write.path), root)
      } else {
        await atomicWriteBytes(write.path, write.previous).catch(() => {})
      }
    }
    throw error
  }
  const pruneFrom = new Set<string>()
  for (const path of removals) {
    // Last line of defence, and cheap: nothing reaches `rm` without being
    // inside the root panda owns. The list was filtered on the same predicate
    // when it was built; this is the copy that runs next to the syscall.
    const resolved = resolveOwnedPath(path)
    if (!isUnderRoot(resolved, root)) continue
    await rm(resolved, { force: true })
    pruneFrom.add(dirname(resolved))
  }
  for (const directory of pruneFrom) await pruneEmptyDirectories(directory, root)
}
