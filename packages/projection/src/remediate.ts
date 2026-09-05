import { readFile, realpath, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { parse as parseJsonc } from 'jsonc-parser'
import type { ParseError } from 'jsonc-parser'
import { PANDA_ERROR_CODES, PandaError, isRecord, projectionTargetLocation } from '@skanl/panda-contracts'
import type {
  ProjectionClaim,
  ProjectionLedgerRecord,
  ProjectionTarget,
  RegistryEntriesByKind,
  RemediationChange,
  RemediationKind,
  RemediationOutcome,
  RemediationRefusal,
} from '@skanl/panda-contracts'
import { atomicWriteText } from './atomic-write.ts'
import { hasFileChangedSince, resolveProjectionMode } from './engine.ts'
import type { NativeFileSnapshot, ProjectionMode } from './engine.ts'
import { scanLegacyPandaBlock } from './formats.ts'
import type { FileFormat } from './formats.ts'
import {
  LEDGER_REPAIR_AUTHORITY,
  isUnderRoot,
  resolveOwnedPath,
  sameOwnedPath,
  serialiseLedgerDocument,
} from './ledger.ts'
import type { ProjectionLedger, ProjectionLedgerScope } from './ledger.ts'
import { claimMaterialised } from './materialise.ts'

// The way out of every state panda reports and cannot leave.
//
// Panda refuses to touch what it does not own, and M4.B made that refusal
// stricter for good reason. The refusal was never the defect; its TERMINALITY
// was. Until this file existed the only exit from `edited`, `removed-by-user`
// or `foreign-collision` — including panda's OWN tree left unclaimed by a crash
// between the write and the ledger update — was hand-editing
// `~/.panda/projection-ledger.json`, the file every safety guarantee in this
// subsystem is stored in.
//
// FOUR PROPERTIES HOLD FOR EVERY VERB BELOW, and each is a mechanism rather
// than an intention:
//
//   1. ONE CODE PATH DESCRIBES AND ACTS. `mode` is the engine's own
//      `'inspect' | 'apply'`, resolved through the engine's own validator. The
//      `changes` array is computed identically in both modes and is the whole
//      description; under `'inspect'` nothing lands. A preview computed by a
//      second path is a preview that can disagree with the act.
//   2. EXPLICIT AND SINGULAR. One verb, one named subject, per call. There is
//      no sweep, no "fix everything", no default, and nothing here runs unless
//      a caller asked for it by name.
//   3. THREE OF THE FOUR TOUCH NO USER FILE. `adopt` and `release` change what
//      panda CLAIMS and nothing else; `repair` rewrites panda's own ledger
//      document. Only `discard` writes a vendor file, and the only bytes it can
//      remove are panda's own vocabulary from a previous build (correction-01
//      C6). The command a user reaches for while something is already wrong
//      cannot lose a byte they wrote.
//   4. CONTAINMENT IS M4.B's, UNCHANGED. Every path is resolved and proven
//      inside the location panda owns, both where the decision is made and
//      again beside the write; a link anywhere below the root disqualifies a
//      path; a path a surviving claim still holds is never taken.
//
// A refusal is RETURNED, coded, not thrown: under inspection a caller has to be
// able to print "panda will not do this, and here is why" beside the state, and
// an exception is not a description.

/** A vendor file that may still hold panda's own prior output (correction-01 C6). */
export interface LegacyBlockLocation {
  /** The executor's target id, carried through so a caller can attribute the row. */
  readonly targetId: string
  readonly filePath: string
  readonly fileFormat: FileFormat
  /**
   * The scope directory this file must lie inside — the home directory for the
   * machine scope, the project root for a project. Panda derives `filePath` from
   * its own catalogue, and this is the check that says so out loud rather than
   * trusting it: a caller reaching this API from outside the CLI supplies both.
   */
  readonly rootPath: string
}

interface RemediationBase {
  /**
   * Defaults to `'inspect'` — the OPPOSITE default from `runProjection`, and the
   * same one `remediate` in `@skanl/panda-environment` uses.
   *
   * Two exported layers of one operation with opposite defaults is how the
   * describe-before-act guarantee becomes true of the command and false of the
   * SDK surface underneath it, and this is on the FR-29 surface where untyped
   * callers reach it. Under `'inspect'` NOTHING is written — not the ledger, not
   * a vendor file — and `changes` reads as "these are the changes this would
   * make", which is the one field whose sentence the mode alters.
   */
  readonly mode?: ProjectionMode
}

export interface AdoptRemediationOptions extends RemediationBase {
  readonly remediation: 'adopt'
  readonly target: ProjectionTarget
  readonly entryId: string
  /** What the registry wants; a materialisation target plans its files from it. */
  readonly entries: RegistryEntriesByKind
  readonly ledger: ProjectionLedger
}

export interface ReleaseRemediationOptions extends RemediationBase {
  readonly remediation: 'release'
  readonly target: ProjectionTarget
  readonly entryId: string
  readonly ledger: ProjectionLedger
}

export interface RepairRemediationOptions extends RemediationBase {
  readonly remediation: 'repair'
  readonly ledger: ProjectionLedger
}

export interface DiscardRemediationOptions extends RemediationBase {
  readonly remediation: 'discard'
  readonly legacy: LegacyBlockLocation
}

export type RunRemediationOptions =
  | AdoptRemediationOptions
  | ReleaseRemediationOptions
  | RepairRemediationOptions
  | DiscardRemediationOptions

function refusalOf(
  message: string,
  code: RemediationRefusal['code'] = PANDA_ERROR_CODES.projectionRemediationRefused,
): RemediationRefusal {
  return { code, message }
}

function refused(
  remediation: RemediationKind,
  targetId: string,
  entryId: string,
  location: string,
  refusal: RemediationRefusal,
): RemediationOutcome {
  return { remediation, targetId, entryId, location, changes: [], applied: false, refusal }
}

function ledgerChange(
  action: 'claim' | 'unclaim' | 'rewrite',
  ledgerPath: string,
  location: string,
  detail: string,
  byteDelta = 0,
): RemediationChange {
  return { subject: 'ledger', action, path: ledgerPath, location, byteDelta, detail }
}

/** The records one target holds at one location — the unit a ledger write replaces. */
function scopeOf(target: ProjectionTarget): ProjectionLedgerScope {
  return {
    targetId: target.targetId,
    filePath: resolveOwnedPath(projectionTargetLocation(target)),
  }
}

/**
 * The same predicate the engine uses to hand a target its own claims. Two
 * spellings of "which records belong to this target at this location" is how a
 * remediation comes to replace a set the projection would have computed
 * differently.
 */
function claimsIn(
  records: readonly ProjectionLedgerRecord[],
  scope: ProjectionLedgerScope,
): ProjectionLedgerRecord[] {
  return records.filter(
    (record) =>
      record.targetId === scope.targetId &&
      sameOwnedPath(resolveOwnedPath(record.filePath), scope.filePath),
  )
}

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined
    throw new PandaError(
      PANDA_ERROR_CODES.projectionNativeUnclaimable,
      `native config file '${path}' cannot be read (${code ?? 'unknown error'})`,
      { cause: error },
    )
  }
}

/**
 * Containment, applied to a record BEFORE it is written and again as the last
 * thing before the write — the M4.B rule, unchanged, on the one path that
 * creates a delete authority.
 *
 * A record's `ownedPaths` are what a later run takes to `rm`. `claimMaterialised`
 * proves each of them inside the root while it builds them; this is the copy
 * that runs next to `ledger.update`, so a record reaching here by any other
 * route is still checked. Both halves are deliberate: the guard nobody can show
 * firing is the guard that is not there.
 */
function escapingPath(record: ProjectionLedgerRecord, scope: ProjectionLedgerScope): string | undefined {
  if (!sameOwnedPath(resolveOwnedPath(record.filePath), scope.filePath)) return record.filePath
  return (record.ownedPaths ?? []).find((item) => !isUnderRoot(resolveOwnedPath(item.path), scope.filePath))
    ?.path
}

/** Whether the REGISTRY still holds this id — what decides overwrite vs. removal. */
function registered(entries: RegistryEntriesByKind, entryId: string): boolean {
  return Object.values(entries).some((kind) => kind.some((entry) => entry.id === entryId))
}

async function claimFor(
  options: AdoptRemediationOptions,
  claimed: readonly ProjectionLedgerRecord[],
): Promise<ProjectionClaim> {
  const { target, entryId, entries } = options
  if (target.kind === 'materialise') {
    return await claimMaterialised(target, entries, claimed, entryId)
  }
  if (target.claim === undefined) {
    return {
      location: entryId,
      byteLength: 0,
      refusal: `projection target '${target.targetId}' cannot say what occupies '${entryId}', so panda will not claim it`,
    }
  }
  const nativeText = (await readIfPresent(target.filePath)) ?? ''
  // A config target answers about ONE file and knows nothing of the registry, so
  // the consequence half is decided here. `removedNext` is what turns "the next
  // run rewrites this" into "the next run deletes it", and a user has to be told
  // which one before the claim is written, not after.
  return { ...target.claim({ nativeText, entryId }), removedNext: !registered(entries, entryId) }
}

/**
 * What taking this claim will let a LATER run do — the sentence the frozen
 * Always clause requires and the first shipped version did not carry.
 *
 * Adoption writes no vendor byte, and the first wording said exactly that and
 * stopped: *"no byte of that file is read again, written or removed"*. True of
 * the ACT and false of its consequence, and it was inverted relative to risk —
 * the branch where the occupant is a file the USER wrote got the reassuring
 * sentence, while the branch where the file was panda's to begin with got the
 * warning.
 *
 * It takes no re-claim/fresh-claim argument on purpose: the two branches differ
 * in what panda is DOING (taking ownership versus re-taking it), which `adopt`
 * says itself, and not in what ownership then permits. Making the consequence
 * depend on which branch you are in is exactly how the wording came to reassure
 * on the dangerous one.
 */
function consequenceOf(claim: ProjectionClaim): string {
  const paths = claim.ownedPaths ?? []
  const authority =
    paths.length === 0
      ? "panda gains no authority to delete any FILE: a config claim covers one region inside the file and can never remove the file itself"
      : `panda gains authority to overwrite AND to REMOVE exactly these path(s) on a later run: ${paths.join(', ')}`
  const next =
    claim.removedNext === true
      ? 'the registry does not hold this entry, so the next `panda init` REMOVES what this claim covers'
      : // The SAME sentence on both branches, and that is the correction. The
        // first version reassured on the fresh-claim branch — where the occupant
        // is a file the USER wrote and the stakes are highest — and warned only
        // on the re-claim one, where the file was panda's to begin with. The
        // wording was inverted relative to risk.
        'the next `panda init` REPLACES what is there with what the registry says'
  return `${authority}. Then ${next}. To keep what is there and have panda stop tracking it, use 'release' instead`
}

/**
 * Panda claims what is at its own location, exactly as it is now.
 *
 * This is the ownership TRANSFER decision AD-6 always implied and that no story
 * had taken: ownership is a durable record panda writes, so transferring it is
 * writing that record — never inferring one from a path, and never widening what
 * panda would have written anyway. The claim's paths come from the TARGET's own
 * plan, so a file the user put beside panda's is not swept in and cannot later
 * be removed on that authority.
 *
 * NOT A WRITE INTO A VENDOR FILE. Afterwards the location is panda's, and the
 * ordinary `panda init` converges it — which is why there is no fourth verb that
 * renders one entry outside the merge.
 */
async function adopt(options: AdoptRemediationOptions, apply: boolean): Promise<RemediationOutcome> {
  const { target, entryId, ledger } = options
  const scope = scopeOf(target)
  const deny = (message: string, code?: RemediationRefusal['code']): RemediationOutcome =>
    refused('adopt', target.targetId, entryId, scope.filePath, refusalOf(message, code))
  if (typeof entryId !== 'string' || entryId === '') {
    return deny('an adoption names one registry entry, and panda was given none')
  }
  const read = await ledger.read()
  if (read.state === 'unreadable') {
    return deny(
      `projection ledger '${ledger.filePath}' cannot be read, so panda will not add a claim to it; repair the ledger first`,
      PANDA_ERROR_CODES.projectionLedgerUnavailable,
    )
  }
  const claimed = claimsIn(read.records, scope)
  const claim = await claimFor(options, claimed)
  if (claim.refusal !== undefined) return deny(claim.refusal)
  const record = claim.record
  if (record === undefined) {
    return deny(
      `nothing occupies '${claim.location}' at '${scope.filePath}', so there is nothing for panda to claim`,
    )
  }
  const escaping = escapingPath(record, scope)
  if (escaping !== undefined) {
    return deny(
      `claiming '${entryId}' would record '${escaping}', which is outside '${scope.filePath}'; panda will not claim a path it cannot prove it owns`,
    )
  }
  const existing = claimed.find((candidate) => candidate.entryId === entryId)
  if (existing !== undefined && existing.contentHash === record.contentHash) {
    return {
      remediation: 'adopt',
      targetId: target.targetId,
      entryId,
      location: claim.location,
      changes: [],
      applied: apply,
    }
  }
  const changes: readonly RemediationChange[] = [
    ledgerChange(
      'claim',
      ledger.filePath,
      claim.location,
      `${
        existing === undefined
          ? `panda takes ownership of the ${claim.byteLength} byte(s) now at '${claim.location}' in '${scope.filePath}'`
          : `panda re-takes ownership of '${claim.location}' in '${scope.filePath}' at its CURRENT ${claim.byteLength} byte(s), replacing the hash it held`
      }. Nothing in that location is written by THIS command. ${consequenceOf(claim)}`,
    ),
  ]
  if (!apply) {
    return { remediation: 'adopt', targetId: target.targetId, entryId, location: claim.location, changes, applied: false }
  }
  // Entry-granular, and re-read inside the ledger's own queue. Handing back a
  // whole scope built from the read above would resurrect every claim another
  // writer legitimately dropped in between — panda would then claim a path it
  // does not own, which on a materialisation root is an authority to delete it.
  await ledger.updateEntry(scope, entryId, record)
  return { remediation: 'adopt', targetId: target.targetId, entryId, location: claim.location, changes, applied: true }
}

/**
 * Panda stops claiming a location. The file is not read, not written, not
 * looked at — this verb performs no filesystem operation except the ledger write
 * itself, which is what makes it the safe exit from a state a user wants to keep
 * exactly as they left it.
 */
async function release(options: ReleaseRemediationOptions, apply: boolean): Promise<RemediationOutcome> {
  const { target, entryId, ledger } = options
  const scope = scopeOf(target)
  const deny = (message: string, code?: RemediationRefusal['code']): RemediationOutcome =>
    refused('release', target.targetId, entryId, scope.filePath, refusalOf(message, code))
  if (typeof entryId !== 'string' || entryId === '') {
    return deny('a release names one registry entry, and panda was given none')
  }
  const read = await ledger.read()
  if (read.state === 'unreadable') {
    return deny(
      `projection ledger '${ledger.filePath}' cannot be read, so panda cannot tell which claim to drop; repair the ledger first`,
      PANDA_ERROR_CODES.projectionLedgerUnavailable,
    )
  }
  const claimed = claimsIn(read.records, scope)
  const dropped = claimed.filter((record) => record.entryId === entryId)
  if (dropped.length === 0) {
    return deny(`panda holds no claim for '${entryId}' at '${scope.filePath}', so there is nothing to release`)
  }
  const changes = dropped.map((record) =>
    ledgerChange(
      'unclaim',
      ledger.filePath,
      record.nativeLocation,
      `panda stops claiming '${record.nativeLocation}' in '${scope.filePath}'; whatever is there stays exactly as it is, and panda will treat it as foreign until it is adopted again. Nothing on disk is removed by this or by any later run while the claim is gone`,
    ),
  )
  if (!apply) {
    return { remediation: 'release', targetId: target.targetId, entryId, location: scope.filePath, changes, applied: false }
  }
  // Entry-granular for the same reason `adopt` is: a whole-scope replace built
  // from the read above resurrects claims another writer dropped in between.
  await ledger.updateEntry(scope, entryId, undefined)
  return { remediation: 'release', targetId: target.targetId, entryId, location: scope.filePath, changes, applied: true }
}

/**
 * Panda rewrites its OWN ledger document to hold exactly the records it can
 * still read.
 *
 * The one write in this file that does not merge, and the only exit from a
 * ledger panda carries and never repairs. Two shapes reach here and the
 * description distinguishes them, because their consequences are not comparable:
 * a document panda can read but whose individual records are malformed loses
 * only those records, while a document panda cannot read AT ALL is replaced with
 * an empty one — after which panda claims nothing, and every entry it ever wrote
 * reports as a foreign collision that `adopt` reclaims one at a time. That
 * sentence is in the preview, before anything happens.
 */
async function repair(options: RepairRemediationOptions, apply: boolean): Promise<RemediationOutcome> {
  const { ledger } = options
  const read = await ledger.read()
  const location = ledger.filePath
  const base = { remediation: 'repair' as const, targetId: '', entryId: '', location }
  if (read.state === 'absent') {
    return { ...base, changes: [], applied: apply }
  }
  if (read.state === 'readable' && read.warnings.length === 0) {
    return { ...base, changes: [], applied: apply }
  }
  const kept = read.records
  const current = await stat(ledger.filePath).then(
    (stats) => stats.size,
    () => 0,
  )
  const next = Buffer.byteLength(serialiseLedgerDocument(kept), 'utf8')
  const detail =
    read.state === 'unreadable'
      ? `panda cannot read any of '${ledger.filePath}' and will REPLACE it with an empty ledger: panda then claims nothing at all, every entry it has written anywhere reports as a foreign collision, and each one has to be adopted back deliberately`
      : `panda rewrites '${ledger.filePath}' holding exactly the ${kept.length} record(s) it can read; the records it cannot read are dropped and the entries behind them report as foreign collisions until they are adopted`
  const changes = [ledgerChange('rewrite', ledger.filePath, ledger.filePath, detail, Math.abs(next - current))]
  if (!apply) return { ...base, changes, applied: false }
  // The read that DECIDES the write happens inside the ledger's own queue.
  // Reading outside it and handing the result to the one write in the system
  // that does not merge destroyed any claim written in between — deterministic,
  // in-process, first try, and exactly the loss `ledger.ts`'s class header
  // describes. `adopt` and `release` have the same shape and were saved by
  // `update`'s merge; this method has no backstop, which is what made it the one
  // that lost data.
  //
  // ponytail: this closes the IN-CALL window and not the cross-invocation one. A
  // user who read a preview in one process and applied in another can still be
  // told "drop 1 record" and get an empty ledger, because the two calls share no
  // handle — the act reports what it really did, but only after doing it.
  // Upgrade path: a receipt on the preview that the act must match, which is the
  // same mechanism `adopt` needs for the same reason (deferred-work.md).
  await ledger.rewriteAll(LEDGER_REPAIR_AUTHORITY, (inQueue) => inQueue.records)
  return { ...base, changes, applied: true }
}

/**
 * Panda removes its OWN prior output from a vendor file — correction-01 C6.
 *
 * The one verb here that writes a file panda did not author, and the bytes it
 * takes are provably panda's own vocabulary: a reserved `$.panda` key or a
 * `# BEGIN panda-managed` block that no executor reads and that, in Codex's
 * case, makes the user's whole `config.toml` fail to load under a documented
 * flag. The region comes from `scanLegacyPandaBlock`, the SAME function
 * `panda doctor` reports it with, so the preview cannot name a region other
 * than the one removed.
 *
 * In the JSON family the result is re-PARSED before it lands: a remediation that
 * left a user's configuration unparseable would be a worse state than the one it
 * repaired. TOML gets no such check and that is the existing rule rather than an
 * omission — panda never parses foreign TOML (see the header of `formats.ts`),
 * and the removed region is bounded by panda's own two marker lines, so nothing
 * outside the block it wrote is inside the span.
 */
async function discard(options: DiscardRemediationOptions, apply: boolean): Promise<RemediationOutcome> {
  const { legacy } = options
  const filePath = resolveOwnedPath(legacy.filePath)
  const root = resolveOwnedPath(legacy.rootPath)
  const base = { remediation: 'discard' as const, targetId: legacy.targetId, entryId: '', location: filePath }
  const deny = (message: string): RemediationOutcome =>
    refused('discard', legacy.targetId, '', filePath, refusalOf(message))
  // Containment first, before the file is even opened, and against the REAL
  // path. `resolve()` is string arithmetic: with `~/.claude` a junction into a
  // dotfiles repository the write lands outside the very scope this refusal
  // promises it will not, which is the sixth attack — the one M4.B's five cases
  // do not cover, and the reason its removal rule checks links at every depth.
  const real = await realPathOf(filePath)
  const realRoot = await realPathOf(root)
  if (!isUnderRoot(real, realRoot)) {
    return deny(
      `'${filePath}' resolves to '${real}', which is outside '${realRoot}'; panda will not rewrite a file beyond the scope it was given, whatever a link in the way says`,
    )
  }
  const text = await readIfPresent(filePath)
  if (text === undefined) return { ...base, changes: [], applied: apply }
  const snapshot = await statSnapshot(filePath)
  const scan = scanLegacyPandaBlock(text, legacy.fileFormat)
  if (scan.refusal !== undefined) return deny(`${scan.refusal} in '${filePath}'`)
  if (scan.block === undefined) return { ...base, changes: [], applied: apply }
  const next = text.slice(0, scan.block.start) + text.slice(scan.block.end)
  if (legacy.fileFormat === 'jsonc') {
    // JSONC-aware, not `JSON.parse`. The first version used `JSON.parse` and so
    // SELF-DISABLED on exactly the inputs at risk — a file with a comment, a
    // trailing comma or a byte-order mark never "originally parsed", and those
    // are the same inputs `jsonRemovalSpan`'s whitespace walk handles worst (a
    // `// note` between the member and its comma leaves a dangling comma the
    // original did not have). Judged the way the vendor judges it, the guard
    // fires on precisely those files.
    if (parsesAsJsonc(text) && !parsesAsJsonc(next)) {
      return deny(
        `removing panda's own block from '${filePath}' would leave it unparseable, so panda left it alone; remove the block by hand`,
      )
    }
  }
  const changes = [
    {
      subject: 'native-file' as const,
      action: 'rewrite' as const,
      path: filePath,
      location: scan.block.detail,
      byteDelta: Math.abs(Buffer.byteLength(next, 'utf8') - Buffer.byteLength(text, 'utf8')),
      detail: `panda removes ${scan.block.detail} from '${filePath}'; every other byte of the file is left exactly as it is`,
    },
  ]
  if (!apply) return { ...base, changes, applied: false }
  // The same read-write race the engine defends against, restored after the
  // argument for omitting it was falsified. The claim was that the failing case
  // could not be built because the read and the write are one call; it can — the
  // atomic writer performs six further filesystem round-trips after the read, and
  // a competing write anywhere in that window is clobbered wholesale. The scope
  // half was wrong too: Claude Code writes `~/.claude/settings.json` itself.
  if (await hasFileChangedSince(filePath, snapshot)) {
    return deny(
      `'${filePath}' was modified while panda was reading it, so panda would have overwritten that change; nothing was written`,
    )
  }
  // A REFUSAL, NOT A THROW — the contract this file states about itself at the
  // top: "A refusal is RETURNED, coded, not thrown". `discard` is the one
  // remediation of four that writes a user's file, so this was the single state
  // in the whole surface that left by a different door.
  //
  // And it did not escape uncoded, which would have been the ordinary hole. It
  // escaped FALSELY coded: `describe()` duck-types `.code`, a Node
  // `ErrnoException` has one, so a libuv errno rendered in panda's coded-error
  // position and the user read `EPERM: EPERM: ... rename '<file>.<uuid>.tmp'`.
  // Doubled, exit 2 where every sibling refusal exits 1, and leaking the
  // temporary path panda writes through.
  //
  // BOTH shapes are caught deliberately. `atomicWriteText` can also throw a
  // CODED `PANDA_PROJECTION_NATIVE_UNCLAIMABLE` from its own containment check,
  // and catching only errnos would leave a coded error still escaping as a throw
  // out of a function whose refusals are values.
  //
  // Modelled on `config-write.ts`, not on `ledger.ts`: both code their boundary,
  // but the ledger speaks ledger vocabulary about panda's OWN document, and this
  // writes a VENDOR file — the same distinction `config-write.ts` already made
  // as the first non-engine caller to reach this rule.
  try {
    await atomicWriteText(filePath, next)
  } catch (error) {
    const detail = error instanceof PandaError ? error.code : (error as NodeJS.ErrnoException | null)?.code
    return deny(
      `'${filePath}' could not be replaced (${detail ?? String(error)}) and panda wrote nothing. A file made read-only was made read-only on purpose.`,
    )
  }
  return { ...base, changes, applied: true }
}

/** File identity for the race check; `undefined` when the file is not there. */
async function statSnapshot(path: string): Promise<NativeFileSnapshot | undefined> {
  return await stat(path).then(
    (stats) => ({ mtimeMs: stats.mtimeMs, size: stats.size }),
    () => undefined,
  )
}

/**
 * The real path, with links resolved. Falls back to the nearest existing
 * ancestor's real path when the target does not exist, so an absent file is
 * still judged against where it WOULD be created.
 */
async function realPathOf(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    const parent = dirname(path)
    return parent === path ? path : join(await realPathOf(parent), basename(path))
  }
}

/**
 * Whether jsonc-parser can read this document — comments, trailing commas and a
 * byte-order mark included, which is what the vendors themselves accept.
 */
function parsesAsJsonc(text: string): boolean {
  const errors: ParseError[] = []
  const parsed: unknown = parseJsonc(text.startsWith('\uFEFF') ? text.slice(1) : text, errors, {
    allowTrailingComma: true,
  })
  return errors.length === 0 && isRecord(parsed)
}

/**
 * Performs — or, under `'inspect'`, describes — exactly one remediation.
 *
 * The caller names the verb and its subject; nothing else is touched, and
 * nothing runs by default. A state panda will not leave is reported as a coded
 * refusal in the result rather than thrown, because under inspection "panda will
 * not do this, and here is why" is part of the description.
 */
export async function runRemediation(options: RunRemediationOptions): Promise<RemediationOutcome> {
  // Every caller-controlled field read ONCE, before the first await — the same
  // TOCTOU rule `runProjection` follows. An options object whose `mode` getter
  // answered `'inspect'` now and `'apply'` on a second read would write on a
  // machine the caller was promised would not be touched.
  // `=== undefined`, not `??`: `null` is a value a caller PASSED, not an
  // omission, and coalescing it into a default is the silent accept the shared
  // validator exists to remove. Only a genuine omission becomes `'inspect'`.
  const apply = resolveProjectionMode(options.mode === undefined ? 'inspect' : options.mode) === 'apply'
  switch (options.remediation) {
    case 'adopt':
      return await adopt(options, apply)
    case 'release':
      return await release(options, apply)
    case 'repair':
      return await repair(options, apply)
    case 'discard':
      return await discard(options, apply)
    default:
      // Unreachable through the typed surface; a plain object reaching a
      // published API must fail coded rather than silently do nothing.
      throw new PandaError(
        PANDA_ERROR_CODES.projectionRemediationRefused,
        `remediation ${JSON.stringify((options as { remediation?: unknown }).remediation)} is not recognised`,
      )
  }
}
