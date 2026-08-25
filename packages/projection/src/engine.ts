import { readFile, stat } from 'node:fs/promises'
import { PandaError, PANDA_ERROR_CODES } from '@panda/contracts'
import type {
  ProjectionFailure,
  ProjectionOwnedSubtree,
  ProjectionResult,
  ProjectionTarget,
  RegistryEntriesByKind,
  RegistryEntry,
} from '@panda/contracts'
import { atomicWriteText } from './atomic-write.ts'
import { renderOwnedSubtree } from './owned-subtree.ts'

// Projection engine (FR-12): renders registry entries once and runs every
// target SEQUENTIALLY against the rendered owned content — targets are never
// executed concurrently, and a single projected file is assumed to have ONE
// writer: concurrent runProjection calls over the same file are unsupported in
// v1. Every failure — render, malformed native file, mid-projection external
// modification, anything else — is CONTAINED per target: it becomes a typed
// failure for that target alone and never affects sibling targets or escapes
// runProjection.

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
}

export interface ProjectionRun {
  readonly results: ProjectionResult[]
  readonly failures: ProjectionFailure[]
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
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { text: '', snapshot: undefined }
    throw error
  }
}

/**
 * Defense against a read-write race: if the native file changed on disk
 * between the read and the write, the projection is stale and MUST NOT land.
 */
export async function hasFileChangedSince(
  filePath: string,
  snapshot: NativeFileSnapshot | undefined,
): Promise<boolean> {
  if (snapshot === undefined) return false
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
  ownedContent: ProjectionOwnedSubtree,
): Promise<ProjectionResult> {
  const { text: nativeText, snapshot } = await readNativeFile(target.filePath)
  const outcome = await target.merge({ entries, ownedContent, nativeText })
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
    targetId: target.targetId,
    written,
    byteDelta: written
      ? Math.abs(Buffer.byteLength(outcome.text, 'utf8') - Buffer.byteLength(nativeText, 'utf8'))
      : 0,
    drift: outcome.drift,
    skippedEntryIds: outcome.skippedEntryIds ?? [],
  }
}

export async function runProjection(options: RunProjectionOptions): Promise<ProjectionRun> {
  let ownedContent: ProjectionOwnedSubtree
  try {
    ownedContent = renderOwnedSubtree(options.entries)
  } catch (error) {
    // Render failures (e.g. unprojectable ids) are contained: every target
    // reports the same typed failure instead of runProjection throwing.
    return {
      results: [],
      failures: options.targets.map((target) => toTargetFailure(target.targetId, error)),
    }
  }
  const results: ProjectionResult[] = []
  const failures: ProjectionFailure[] = []
  for (const target of options.targets) {
    try {
      results.push(await projectTarget(target, options.entries, ownedContent))
    } catch (error) {
      failures.push(toTargetFailure(target.targetId, error))
    }
  }
  return { results, failures }
}
