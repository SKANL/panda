import { readFile, stat } from 'node:fs/promises'
import { PandaError, PANDA_ERROR_CODES } from '@panda/contracts'
import type {
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
import type { ProjectionLedger } from './ledger.ts'

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

export interface RunProjectionOptions {
  readonly entries: RegistryEntriesByKind
  readonly targets: readonly ProjectionTarget[]
  /** Required: without a ledger panda cannot know which entries are its own. */
  readonly ledger: ProjectionLedger
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
  target: ProjectionTarget,
  entries: RegistryEntriesByKind,
  records: readonly ProjectionLedgerRecord[],
): Promise<{ result: ProjectionResult; records: readonly ProjectionLedgerRecord[] }> {
  const { text: nativeText, snapshot } = await readNativeFile(target.filePath)
  const outcome = await target.merge({ entries, records, nativeText })
  const written = outcome.text !== nativeText
  if (written) {
    if (await hasFileChangedSince(target.filePath, snapshot)) {
      throw new PandaError(
        PANDA_ERROR_CODES.projectionTargetFailed,
        `projection target '${target.targetId}' failed: file modified during projection: '${target.filePath}'`,
      )
    }
    await atomicWriteText(target.filePath, outcome.text)
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
  const ledger = await options.ledger.read()
  const warnings: ProjectionWarning[] = [...ledger.warnings]
  const results: ProjectionResult[] = []
  const failures: ProjectionFailure[] = []

  for (const target of options.targets) {
    const scope = { targetId: target.targetId, filePath: resolveOwnedPath(target.filePath) }
    const claimed = ledger.records.filter(
      (record) =>
        record.targetId === scope.targetId &&
        sameOwnedPath(resolveOwnedPath(record.filePath), scope.filePath),
    )
    let projected: { result: ProjectionResult; records: readonly ProjectionLedgerRecord[] }
    try {
      projected = await projectTarget(target, options.entries, claimed)
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
    if (ledger.state === 'unreadable') continue
    try {
      await options.ledger.update(scope, projected.records)
    } catch (error) {
      failures.push(toTargetFailure(target.targetId, error))
    }
  }

  return { results, failures, warnings }
}
