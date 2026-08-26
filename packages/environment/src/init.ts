import { mkdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { PANDA_ERROR_CODES, PandaError } from '@panda/contracts'
import type {
  DriftEntry,
  PandaErrorCode,
  ProjectionTarget,
  ProjectionWarning,
  RegistryEntry,
} from '@panda/contracts'
import { createMemoryLogSink } from '@panda/kernel'
import type { LogSink } from '@panda/kernel'
import { ProjectionLedger, groupByKind, runProjection } from '@panda/projection'
import { RegistryStore } from '@panda/registry'
import { EXECUTOR_PROFILES, detectExecutors } from './executors.ts'
import type { ExecutorDetection, ExecutorProfile } from './executors.ts'

// The first composed path panda has: registry -> projection -> a real
// executor's real configuration file. Everything here is COMPOSITION. The
// projection engine, its targets and its ownership ledger are Story 2.8's and
// are used exactly as they ship: this package decides WHICH targets run and
// reports what happened, and it is the ledger — never this file — that decides
// what panda is allowed to modify.
//
// Nothing in this package writes into a vendor's file. The only filesystem write
// it performs itself is `mkdir` of panda's OWN directory; `test/guard.test.ts`
// pins that by asserting the whole of `src/` reaches the filesystem module for
// nothing beyond `mkdir` and `stat`.
//
// On the kernel: a projection write is not an executor action, so AD-10's
// interception pipeline is not forced in here. What IS taken from the kernel is
// the Story 1.6 record sink (NFR-4), because "what did panda write into whose
// configuration" is the kind of thing that has to be reconstructable afterwards.
// The record shape is closed and has no free-form slot, so the sink carries THAT
// each target was projected and whether it succeeded, and the durable ledger
// carries what was written and where. Both halves are needed and neither is a
// substitute for the other.
//
// ponytail: one record per TARGET attempt, not per entry. The closed record
// shape has room for an event and a bounded subject and nothing else, so
// per-entry granularity has nowhere to go without a kernel record-shape change
// (LOG_RECORD_VERSION exists to carry one). Recorded in deferred-work.md.

/**
 * Subject PREFIX every projection record is written under. The subject is
 * `${PROJECTION_ACTION_ID}#${targetId}` — bounded by panda's own constants, so
 * it can never be rejected by the sink's identifier rules the way a file path
 * (unbounded length, arbitrary characters) could be.
 *
 * Exported because a reader of the record stream needs the same string panda
 * wrote; match with `subject.startsWith(PROJECTION_ACTION_ID + '#')`.
 */
export const PROJECTION_ACTION_ID = 'environment.projection'

/** A registry entry a target could not express natively, and why (correction-01 C5). */
export interface UnprojectableEntry {
  readonly entryId: string
  readonly reason: string
}

/** A detected executor that was not projected into, and why. */
export interface SkippedExecutor {
  readonly executorId: string
  readonly reason: string
}

/**
 * A per-target failure, flattened to code and message. A live `Error` would
 * serialise to `{}` for every caller that prints the result, and the code is the
 * part a caller acts on.
 */
export interface TargetFailure {
  readonly code: PandaErrorCode
  readonly message: string
}

/**
 * What happened to ONE executor's configuration. The four facts the caller has
 * to be able to tell apart are separate fields rather than one status word,
 * because they are not mutually exclusive: a single run can write one entry,
 * report a second as drifted, and report a third as unprojectable.
 *
 *   written   — `written === true`: the file on disk changed.
 *   unchanged — `written === false` with empty `drift` and no `error`.
 *   drifted   — `drift` is non-empty; nothing in it was overwritten.
 *   unprojectable — `unprojectable` is non-empty; nothing was written for those.
 *   failed    — `error` is set; this target alone is affected.
 */
export interface TargetProjection {
  readonly executorId: string
  readonly targetId: string
  /** The vendor's own file, at the location that vendor reads. */
  readonly filePath: string
  readonly written: boolean
  readonly drift: readonly DriftEntry[]
  readonly unprojectable: readonly UnprojectableEntry[]
  readonly error?: TargetFailure
}

export interface InitResult {
  readonly scope: 'machine' | 'project'
  /** Panda's own state directory for this scope; it exists once init returns. */
  readonly pandaDir: string
  /** The registry store this run read from; it exists once init returns. */
  readonly registryPath: string
  readonly ledgerPath: string
  /** Registry entries this run projected from, across every scope it can see. */
  readonly entryCount: number
  /** EVERY executor panda knows, found or not, with the paths consulted. */
  readonly detected: readonly ExecutorDetection[]
  readonly targets: readonly TargetProjection[]
  readonly skipped: readonly SkippedExecutor[]
  readonly warnings: readonly ProjectionWarning[]
}

export interface InitMachineOptions {
  /** Defaults to the OS home directory. */
  readonly homeDir?: string
  /**
   * Where the projection records go. Omitted, a memory sink is built and then
   * dropped — the records are still produced, simply unread.
   *
   * ponytail: the caller owns the sink they pass, draining included. Read
   * `sink.records` only after `await sink.drain()`.
   */
  readonly log?: LogSink
}

export interface InitProjectOptions extends InitMachineOptions {
  /** Defaults to `process.cwd()`. */
  readonly projectDir?: string
}

/** True when no executor was found — the caller's non-zero-exit condition. */
export function noExecutorsDetected(result: InitResult): boolean {
  return result.detected.every((detection) => !detection.present)
}

/**
 * Registry identity is `type:id`, but `ProjectionResult.skippedEntryIds` carries
 * BARE ids, so one id can arrive matching several entries — a `tool` named `x`
 * and an `mcp-server` named `x` are two different entries and only the first is
 * skipped. Reporting both reasons would tell the user that an mcp-server which
 * was projected successfully in this very run declares no command, and that
 * reason is the one field a user acts on.
 *
 * So the candidates are narrowed by the property that actually makes an entry
 * skippable, which is the same rule `collectMcpEntries` applies: any kind other
 * than mcp-server, or an mcp-server with no command. Nothing else can be behind
 * a skipped id.
 *
 * ponytail: the reason is DERIVED here rather than reported by the target,
 * because the projection outcome has no reason channel. Upgrade path: one on
 * `ProjectionMergeOutcome`, which belongs with Story 2.9's materialisation work,
 * where a target first has reasons of its own (deferred-work.md).
 */
function reasonUnprojectable(entries: readonly RegistryEntry[], executorId: string): string {
  const candidates = entries.filter((entry) => entry.type !== 'mcp-server' || entry.command === undefined)
  if (candidates.length === 0) {
    // No entry panda handed over can explain this id: said plainly rather than
    // guessed, because a reason panda cannot establish is still a fact.
    return `'${executorId}' reported this entry as unprojectable and the registry holds no entry that explains it`
  }
  return candidates
    .map((entry) =>
      entry.type === 'mcp-server'
        ? `the mcp-server entry declares no command, so there is nothing to render into '${executorId}'`
        : `'${executorId}' has no native representation for a ${entry.type} entry (correction-01 C5)`,
    )
    .join('; ')
}

function scopeUnavailable(detail: string, cause?: unknown): PandaError {
  return new PandaError(PANDA_ERROR_CODES.environmentScopeUnavailable, detail, { cause })
}

/**
 * The trust boundary. `homeDir` and `projectDir` are caller-supplied paths that
 * decide where panda creates directories and which vendor files it writes, so
 * every one of them is resolved ONCE here and rejected unless it already names a
 * directory.
 *
 * Three failures this closes, all of them observed: `homeDir: ''` — which is
 * exactly `process.env.HOME ?? ''` in a consumer — resolves to the CWD and
 * relocates the machine scope into whatever directory the process happens to be
 * in; `panda project init ~/typo` built the whole missing tree and wrote a
 * vendor config into it; and `panda project init ~/repo/.git` would have done
 * the same inside a git directory. Panda BINDS a project, it does not create one.
 */
async function scopeDirectory(label: string, value: string): Promise<string> {
  if (typeof value !== 'string' || value.trim() === '') {
    throw scopeUnavailable(
      `${label} must be a non-empty path, but panda was given ${JSON.stringify(value)}`,
    )
  }
  const resolved = resolve(value)
  let isDirectory: boolean
  try {
    isDirectory = (await stat(resolved)).isDirectory()
  } catch (error) {
    throw scopeUnavailable(
      `${label} '${resolved}' cannot be used (${(error as NodeJS.ErrnoException)?.code ?? 'unknown error'}); panda binds an existing directory and never creates one`,
      error,
    )
  }
  if (!isDirectory) {
    throw scopeUnavailable(`${label} '${resolved}' is not a directory`)
  }
  return resolved
}

function targetsFor(
  scope: 'machine' | 'project',
  detected: readonly ExecutorDetection[],
  homeDir: string,
  projectDir: string,
): {
  readonly planned: readonly { profile: ExecutorProfile; target: ProjectionTarget }[]
  readonly skipped: readonly SkippedExecutor[]
} {
  const planned: { profile: ExecutorProfile; target: ProjectionTarget }[] = []
  const skipped: SkippedExecutor[] = []
  const present = new Set(
    detected.filter((detection) => detection.present).map((detection) => detection.executorId),
  )
  for (const profile of EXECUTOR_PROFILES) {
    if (!present.has(profile.executorId)) continue
    const filePath =
      scope === 'machine' ? profile.machineConfig(homeDir) : profile.projectConfig?.(projectDir)
    if (filePath === undefined) {
      skipped.push({
        executorId: profile.executorId,
        reason: `'${profile.executorId}' has no project-scope configuration file; panda will not invent a location it does not read`,
      })
      continue
    }
    planned.push({ profile, target: profile.createTarget(filePath) })
  }
  return { planned, skipped }
}

/**
 * Records without letting a broken sink break the run it is describing — the
 * same containment rule the kernel applies to its own call sites. Panda's
 * subjects are bounded by construction, so the only way this throws is a hostile
 * sink; the sink's own `dropped` counter remains the loss signal.
 */
function recordProjection(log: LogSink, event: 'action.invoked' | 'action.completed' | 'action.failed', targetId: string): void {
  try {
    log.record({ event, subject: `${PROJECTION_ACTION_ID}#${targetId}` })
  } catch {
    // Contained by contract; a diagnostic never aborts what it describes.
  }
}

async function project(
  scope: 'machine' | 'project',
  homeDir: string,
  projectDir: string,
  log: LogSink,
): Promise<InitResult> {
  const root = scope === 'machine' ? homeDir : projectDir
  const pandaDir = join(root, '.panda')
  // Panda's own directory, created by panda. `recursive` here means "tolerate an
  // existing directory", not "build a tree": the parent was validated as an
  // existing directory above, so the only thing this can still meet is `.panda`
  // occupied by a FILE, which arrives as a bare doubled EEXIST naming nothing.
  // Everything below this line either writes into panda's own state through its
  // owner (the registry store, the ledger) or into a vendor's file through the
  // projection engine.
  try {
    await mkdir(pandaDir, { recursive: true })
  } catch (error) {
    throw scopeUnavailable(
      `panda's own state directory '${pandaDir}' cannot be created (${(error as NodeJS.ErrnoException)?.code ?? 'unknown error'})`,
      error,
    )
  }

  const store = new RegistryStore(
    scope === 'machine' ? { homeDir } : { homeDir, projectDir },
  )
  let registryPath: string
  let entries: RegistryEntry[]
  try {
    // Materialised through the store itself, so the document's version and shape
    // stay the registry's to define. A corrupt store fails coded here rather than
    // being silently replaced.
    registryPath = await store.ensure(scope === 'machine' ? 'global' : 'project')
    entries = await store.list()
  } finally {
    await store.dispose()
  }

  const detected = await detectExecutors(homeDir)
  const { planned, skipped } = targetsFor(scope, detected, homeDir, projectDir)
  const ledger = new ProjectionLedger({ homeDir })

  for (const { target } of planned) recordProjection(log, 'action.invoked', target.targetId)

  const run = await runProjection({
    entries: groupByKind(entries),
    targets: planned.map((plan) => plan.target),
    ledger,
  })

  const byId = new Map<string, RegistryEntry[]>()
  for (const entry of entries) byId.set(entry.id, [...(byId.get(entry.id) ?? []), entry])
  const results = new Map(run.results.map((result) => [result.targetId, result]))
  const failures = new Map(run.failures.map((failure) => [failure.targetId, failure]))

  // Walked over `planned`, which is catalogue order, so one executor failing can
  // never reshuffle the report — and so a target that BOTH wrote and then failed
  // its ledger update yields ONE row carrying both facts. Two rows, or a row
  // hardcoding `written: false` for a failure, is how panda came to report
  // `written: false` for bytes it had already landed.
  const targets: TargetProjection[] = planned.map(({ profile, target }) => {
    const result = results.get(target.targetId)
    const failure = failures.get(target.targetId)
    recordProjection(log, failure === undefined ? 'action.completed' : 'action.failed', target.targetId)
    return {
      executorId: profile.executorId,
      targetId: target.targetId,
      filePath: target.filePath,
      written: result?.written ?? false,
      drift: result?.drift ?? [],
      unprojectable: (result?.skippedEntryIds ?? []).map((entryId) => ({
        entryId,
        reason: reasonUnprojectable(byId.get(entryId) ?? [], profile.executorId),
      })),
      ...(failure === undefined
        ? {}
        : { error: { code: failure.error.code, message: failure.error.message } }),
    }
  })

  return {
    scope,
    pandaDir,
    registryPath,
    ledgerPath: ledger.filePath,
    entryCount: entries.length,
    detected,
    targets,
    skipped,
    warnings: run.warnings,
  }
}

/**
 * Prepares this machine: panda's own directory and registry store exist
 * afterwards, and the global registry is projected into every detected
 * executor's own machine-scope configuration.
 *
 * Idempotent. A second run over an unchanged registry writes no vendor byte and
 * reports every target as unchanged.
 */
export async function initMachine(options: InitMachineOptions = {}): Promise<InitResult> {
  // Every field read ONCE, here, before the first await. A later read of a
  // caller-controlled object is a TOCTOU hole: an accessor that answers with a
  // temp directory now and the real home directory later would get the real one
  // projected into.
  const { homeDir = homedir(), log } = options
  const home = await scopeDirectory('the home directory', homeDir)
  return await project('machine', home, home, log ?? createMemoryLogSink())
}

/**
 * Binds a project: panda's own directory and project registry store exist under
 * it afterwards, and the registry it can see — the project's entries over the
 * machine's — is projected into every detected executor that has a project-scope
 * configuration. An executor without one is reported as skipped, never written
 * to somewhere it does not read.
 */
export async function initProject(options: InitProjectOptions = {}): Promise<InitResult> {
  const { homeDir = homedir(), projectDir = process.cwd(), log } = options
  const home = await scopeDirectory('the home directory', homeDir)
  const projectRoot = await scopeDirectory('the project directory', projectDir)
  return await project('project', home, projectRoot, log ?? createMemoryLogSink())
}
