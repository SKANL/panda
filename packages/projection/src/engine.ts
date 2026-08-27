import { readFile, stat } from 'node:fs/promises'
import { PandaError, PANDA_ERROR_CODES, projectionTargetLocation } from '@panda/contracts'
import type {
  ProjectionConfigTarget,
  ProjectionFailure,
  ProjectionLedgerRecord,
  ProjectionResult,
  ProjectionTarget,
  ProjectionWarning,
  RegistryEntriesByKind,
  RegistryEntry,
} from '@panda/contracts'
import { atomicWriteText } from './atomic-write.ts'
import { resolveOwnedPath, sameOwnedPath } from './ledger.ts'
import type { ProjectionLedger, ProjectionLedgerScope } from './ledger.ts'
import { materialiseTarget } from './materialise.ts'

// Projection engine (FR-12): reads the ownership ledger once, then runs every
// target SEQUENTIALLY — targets are never executed concurrently. Every failure
// — malformed native file, unclaimable container, mid-projection external
// modification, anything else — is CONTAINED per target: it becomes a typed
// failure for that target alone and never affects sibling targets or escapes
// runProjection.
//
// Each target records its claims IMMEDIATELY after its own file lands, and a
// ledger write that fails FAILS THAT TARGET. Deferring the ledger to the end of
// the run leaves a window where the file already holds new bytes while the
// ledger still holds the old hash — and a warning there would leave panda
// permanently locked out of an entry it owns.
//
// An UNREADABLE ledger stops every ledger write for the run. Under-claiming for
// one run is recoverable (panda reports its own entries as foreign and touches
// nothing); persisting that under-claim would orphan every entry panda has
// written anywhere, permanently.

const ENTRY_KINDS = ['tool', 'skill', 'mcp-server', 'profile'] as const

export function groupByKind(entries: readonly RegistryEntry[]): RegistryEntriesByKind {
  const grouped: Record<(typeof ENTRY_KINDS)[number], RegistryEntry[]> = {
    tool: [],
    skill: [],
    'mcp-server': [],
    profile: [],
  }
  // Post-validation this branch is unreachable; a hand-corrupted entry object
  // must be skipped, never crash the engine.
  for (const entry of entries) {
    if ((ENTRY_KINDS as readonly string[]).includes(entry.type)) {
      grouped[entry.type].push(entry)
    }
  }
  return grouped
}

/**
 * Whether the run is allowed to LAND what it computes.
 *
 * `'inspect'` is the whole of `panda doctor`: the identical merge, the identical
 * drift classification, the identical ledger read — and neither of the two
 * writes a run performs. A diagnosis computed by a second code path can disagree
 * with what applying would do, and it would disagree exactly when a user is
 * trying to fix something.
 */
export type ProjectionMode = 'apply' | 'inspect'

/**
 * FAIL CLOSED. Not `mode !== 'inspect'`: that writes for `'Inspect'`,
 * `'inspect '`, `'dry-run'` and `null`, and the one thing this field decides is
 * whether panda writes into files it does not own. A no-op run is visible in its
 * own output; a write into a user's config on the say-so of a typo is not. So
 * both failures are loud. `=== undefined`, not `??`: `null` is a value a caller
 * PASSED, not an omission, and coalescing it into the writing default is the
 * same silent accept this guard exists to remove.
 *
 * Shared by `runProjection` and `runRemediation` so the two commands that can
 * write cannot disagree about what "do not touch this machine" means.
 */
export function resolveProjectionMode(mode: ProjectionMode | undefined): ProjectionMode {
  const resolved = mode === undefined ? 'apply' : mode
  if (resolved !== 'apply' && resolved !== 'inspect') {
    throw new PandaError(
      PANDA_ERROR_CODES.projectionModeInvalid,
      `projection mode ${JSON.stringify(resolved)} is not recognised; use 'apply' or 'inspect' (omitted means 'apply')`,
    )
  }
  return resolved
}

export interface RunProjectionOptions {
  readonly entries: RegistryEntriesByKind
  readonly targets: readonly ProjectionTarget[]
  /** Required: without a ledger panda cannot know which entries are its own. */
  readonly ledger: ProjectionLedger
  /**
   * Defaults to `'apply'`. Under `'inspect'` NOTHING is written — not the vendor
   * file, not the ledger — and `ProjectionResult.written` reads as "these bytes
   * WOULD have changed", which is the one field whose sentence the mode alters.
   */
  readonly mode?: ProjectionMode
}

export interface ProjectionRun {
  readonly results: ProjectionResult[]
  readonly failures: ProjectionFailure[]
  readonly warnings: ProjectionWarning[]
}

/** File identity snapshot taken when the native text is read. */
export interface NativeFileSnapshot {
  readonly mtimeMs: number
  readonly size: number
}

async function readNativeFile(
  filePath: string,
): Promise<{ text: string; snapshot: NativeFileSnapshot | undefined }> {
  try {
    const [text, stats] = await Promise.all([readFile(filePath, 'utf8'), stat(filePath)])
    return { text, snapshot: { mtimeMs: stats.mtimeMs, size: stats.size } }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT') return { text: '', snapshot: undefined }
    // A directory where the vendor's config file belongs, an unreadable mode, a
    // dangling link: all reach here as a bare errno naming neither the path nor
    // what panda wanted with it. Coded, and both facts in the message.
    throw new PandaError(
      PANDA_ERROR_CODES.projectionNativeUnclaimable,
      `native config file '${filePath}' cannot be read (${code ?? 'unknown error'}), so panda cannot place entries there`,
      { cause: error },
    )
  }
}

/**
 * Defense against a read-write race: if the native file changed on disk between
 * the read and the write, the projection is stale and MUST NOT land. An ABSENT
 * snapshot is not "nothing to compare": the merge was computed against an empty
 * document, so the file appearing in the meantime — a vendor CLI creating
 * `~/.claude.json` — is exactly the case where landing would overwrite it
 * wholesale.
 */
export async function hasFileChangedSince(
  filePath: string,
  snapshot: NativeFileSnapshot | undefined,
): Promise<boolean> {
  if (snapshot === undefined) {
    return await stat(filePath).then(
      () => true,
      (error: NodeJS.ErrnoException) => error.code !== 'ENOENT',
    )
  }
  const current = await stat(filePath)
  return current.mtimeMs !== snapshot.mtimeMs || current.size !== snapshot.size
}

function toTargetFailure(targetId: string, error: unknown): ProjectionFailure {
  if (error instanceof PandaError) return { targetId, error }
  const detail = error instanceof Error ? error.message : String(error)
  return {
    targetId,
    error: new PandaError(
      PANDA_ERROR_CODES.projectionTargetFailed,
      `projection target '${targetId}' failed: ${detail}`,
      { cause: error },
    ),
  }
}

async function projectTarget(
  target: ProjectionConfigTarget,
  entries: RegistryEntriesByKind,
  records: readonly ProjectionLedgerRecord[],
  apply: boolean,
): Promise<{ result: ProjectionResult; records: readonly ProjectionLedgerRecord[] }> {
  const { text: nativeText, snapshot } = await readNativeFile(target.filePath)
  const outcome = await target.merge({ entries, records, nativeText })
  const written = outcome.text !== nativeText
  if (written) {
    // Checked in BOTH modes, and that is the point rather than an oversight. It
    // is true that an inspection has no write window to lose — but the
    // PREDICTION is doctor's whole artifact, and a mode that skipped this would
    // answer "this file would be rewritten" for a target where applying returns
    // no result row and a failure instead. `~/.claude.json` is rewritten by
    // Claude Code itself, so this is the machine doctor gets run on.
    if (await hasFileChangedSince(target.filePath, snapshot)) {
      throw new PandaError(
        PANDA_ERROR_CODES.projectionTargetFailed,
        `projection target '${target.targetId}' failed: file modified during projection: '${target.filePath}'`,
      )
    }
    if (apply) await atomicWriteText(target.filePath, outcome.text)
  }
  return {
    result: {
      targetId: target.targetId,
      written,
      byteDelta: written
        ? Math.abs(Buffer.byteLength(outcome.text, 'utf8') - Buffer.byteLength(nativeText, 'utf8'))
        : 0,
      drift: outcome.drift,
      skippedEntryIds: outcome.skippedEntryIds ?? [],
    },
    records: outcome.records,
  }
}

export async function runProjection(options: RunProjectionOptions): Promise<ProjectionRun> {
  // Every caller-controlled field read ONCE, here, before the first await. A
  // caller object whose `mode` getter answers `'inspect'` now and `'apply'` on
  // the second read would land bytes on a machine the caller was promised would
  // not be touched, and `panda doctor` is precisely the command that promises it.
  const { entries, targets, ledger: store } = options
  const apply = resolveProjectionMode(options.mode) === 'apply'
  const ledger = await store.read()
  const warnings: ProjectionWarning[] = [...ledger.warnings]
  const results: ProjectionResult[] = []
  const failures: ProjectionFailure[] = []

  for (const target of targets) {
    // EVERYTHING derived from the target lives inside the try, including the
    // ownership scope. Computing it outside was a hole in the engine's own
    // containment promise: a target that is neither kind — a plain object
    // reaching a published port — threw out of `runProjection` and took every
    // sibling target with it.
    let projected: { result: ProjectionResult; records: readonly ProjectionLedgerRecord[] }
    let scope: ProjectionLedgerScope
    try {
      // One ownership scope for both kinds: a config target's file, or a
      // materialisation target's root. The ledger keys on it either way, so a
      // target's claims are exactly the ones taken under the location it owns.
      scope = {
        targetId: target.targetId,
        filePath: resolveOwnedPath(projectionTargetLocation(target)),
      }
      const claimed = ledger.records.filter(
        (record) =>
          record.targetId === scope.targetId &&
          sameOwnedPath(resolveOwnedPath(record.filePath), scope.filePath),
      )
      projected =
        target.kind === 'materialise'
          ? await materialiseTarget(target, entries, claimed, apply)
          : await projectTarget(target, entries, claimed, apply)
    } catch (error) {
      failures.push(toTargetFailure(target.targetId, error))
      continue
    }
    // The result is reported EVEN IF the ledger write below fails, and that
    // ordering is the whole point: by this line the vendor's file already holds
    // the new bytes. Reporting `written: false` for them — which is what
    // dropping the result on a ledger failure amounts to at every caller — makes
    // panda accuse the user of editing bytes panda wrote on the very next run,
    // after which the entry never tracks the registry again. The failure still
    // travels, so a caller learns the projection did not COMPLETE; what it no
    // longer learns is a falsehood about what landed on disk.
    results.push(projected.result)
    // The SECOND of the two writes, and inspection skips it here rather than
    // inside the ledger: a diagnosis that recorded claims for entries it did not
    // write would tell the next real run that panda owns bytes it never placed.
    if (!apply || ledger.state === 'unreadable') continue
    try {
      await store.update(scope, projected.records)
    } catch (error) {
      failures.push(toTargetFailure(target.targetId, error))
    }
  }

  return { results, failures, warnings }
}
