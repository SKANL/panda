import { mkdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  PANDA_ERROR_CODES,
  PandaError,
  isRetiredEntryType,
  projectionTargetLocation,
} from '@panda/contracts'
import type {
  DriftEntry,
  PandaErrorCode,
  ProjectionResult,
  ProjectionTarget,
  ProjectionWarning,
  RegistryEntry,
  RegistryScope,
} from '@panda/contracts'
import { createMemoryLogSink } from '@panda/kernel'
import type { LogSink } from '@panda/kernel'
import { ProjectionLedger, groupByKind, runProjection, runRemediation } from '@panda/projection'
import type { ProjectionMode } from '@panda/projection'
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
  /**
   * The vendor's own location, as that vendor reads it: a configuration FILE in
   * `targets`, a skills ROOT DIRECTORY in `skills`.
   */
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
  /**
   * The skills root of every detected executor whose location panda has
   * VERIFIED, one row each — a separate array rather than more `targets` rows
   * because the two surfaces are not the same thing: one names a file panda
   * merges text into, the other a directory tree panda materialises and, when a
   * skill leaves the registry, removes. Empty where no verified location
   * applies, which is every executor at project scope.
   */
  readonly skills: readonly TargetProjection[]
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

/**
 * True when no executor was found — the caller's non-zero-exit condition.
 *
 * Takes the DETECTION, not an `InitResult`: `panda doctor` has to answer the
 * same question about the same evidence, and two spellings of "did panda find
 * anything" is how the two commands come to disagree about one machine.
 */
export function noExecutorsDetected(result: { readonly detected: readonly ExecutorDetection[] }): boolean {
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
 * A target that KNOWS why says so itself, through `ProjectionResult.skipped`,
 * and its reason wins wherever it is present — the skills target is the first
 * one with reasons of its own ("this skill names a source panda cannot read"),
 * which no derivation from the registry entry could ever have produced.
 *
 * `skillsHandled` is the other half of the same correction. Once an executor has
 * a verified skills root, "this executor has no native representation for a
 * skill" is FALSE for that executor, so skill entries stop being candidates
 * here; an id left with no candidate at all is dropped from the config row
 * entirely rather than explained by a sentence that is no longer true.
 */
function reasonUnprojectable(
  entries: readonly RegistryEntry[],
  executorId: string,
  skillsHandled: boolean,
): string | undefined {
  const candidates = entries.filter(
    (entry) =>
      (entry.type !== 'mcp-server' || entry.command === undefined) &&
      !(skillsHandled && entry.type === 'skill'),
  )
  if (candidates.length === 0) {
    // Only when this executor materialises skills can an id legitimately have no
    // candidate left, and then the id belongs to the skills row, not this one.
    if (skillsHandled && entries.length > 0) return undefined
    // Otherwise no entry panda handed over can explain this id: said plainly
    // rather than guessed, because a reason panda cannot establish is still a fact.
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

/**
 * The per-entry reasons a target row carries: the target's own words where it
 * had any, and the registry-derived sentence everywhere else.
 */
function unprojectableFor(
  result: ProjectionResult | undefined,
  byId: ReadonlyMap<string, RegistryEntry[]>,
  executorId: string,
  skillsHandled: boolean,
): UnprojectableEntry[] {
  const stated = new Map((result?.skipped ?? []).map((skip) => [skip.entryId, skip.reason]))
  const rows: UnprojectableEntry[] = []
  for (const entryId of result?.skippedEntryIds ?? []) {
    const reason =
      stated.get(entryId) ?? reasonUnprojectable(byId.get(entryId) ?? [], executorId, skillsHandled)
    if (reason !== undefined) rows.push({ entryId, reason })
  }
  return rows
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
export async function scopeDirectory(label: string, value: string): Promise<string> {
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

interface PlannedTarget {
  readonly profile: ExecutorProfile
  readonly target: ProjectionTarget
}

/**
 * Panda's OWN prior output still sitting in a vendor file (correction-01 C6).
 *
 * Every field of every row is produced by `runRemediation` under INSPECTION —
 * the same call, in the same file, that `discard` performs. So the sentence
 * `panda doctor` prints about a legacy block is the sentence the remediation
 * will act on, and the two cannot describe different regions.
 */
export interface LegacyBlock {
  readonly executorId: string
  readonly targetId: string
  readonly filePath: string
  /** What panda found and would remove, or why it will not touch it. */
  readonly detail: string
  /** Bytes the file would lose; 0 when panda refuses. */
  readonly byteDelta: number
  readonly refusal?: TargetFailure
}

/**
 * MACHINE SCOPE, AND `'inspect'` HARD-CODED. Two separate deliberate choices:
 *
 * Machine scope, because the builds that wrote these locations had no project
 * scope at all — `panda project init` arrives in Story 2.7a, after correction-01
 * — so there is no project-scope file that can hold one.
 *
 * `'inspect'` written here rather than threaded from `runScope`'s own `mode`,
 * because `panda init` must never remove a legacy block: removal is a decision,
 * and this story's whole rule is that a decision is a user's, named one at a
 * time. Passing the caller's mode through would make `panda init` silently
 * rewrite a vendor file — pinned by a test in `test/remediate.test.ts`.
 */
async function legacyFor(
  detected: readonly ExecutorDetection[],
  homeDir: string,
): Promise<LegacyBlock[]> {
  const present = new Set(
    detected.filter((detection) => detection.present).map((detection) => detection.executorId),
  )
  const rows: LegacyBlock[] = []
  for (const profile of EXECUTOR_PROFILES) {
    if (!present.has(profile.executorId) || profile.legacyConfig === undefined) continue
    const location = profile.legacyConfig(homeDir)
    let outcome
    try {
      outcome = await runRemediation({
        remediation: 'discard',
        legacy: { targetId: profile.targetId, rootPath: homeDir, ...location },
        mode: 'inspect',
      })
    } catch {
      // A file panda cannot READ is not evidence that litter is in it, and this
      // finding's only resolution is a removal panda would then be unable to
      // perform — which is the false promise `panda doctor`'s own Never clause
      // forbids. Silence here, and the two of these three files that a target
      // owns already report the read failure as `target-failed`.
      continue
    }
    const change = outcome.changes[0]
    if (outcome.refusal !== undefined) {
      rows.push({
        executorId: profile.executorId,
        targetId: profile.targetId,
        filePath: location.filePath,
        detail: outcome.refusal.message,
        byteDelta: 0,
        refusal: outcome.refusal,
      })
      continue
    }
    if (change === undefined) continue
    rows.push({
      executorId: profile.executorId,
      targetId: profile.targetId,
      filePath: location.filePath,
      detail: change.detail,
      byteDelta: change.byteDelta,
    })
  }
  return rows
}

export function targetsFor(
  scope: 'machine' | 'project',
  detected: readonly ExecutorDetection[],
  homeDir: string,
  projectDir: string,
): {
  readonly planned: readonly PlannedTarget[]
  /**
   * The skills roots, planned only where the executor has a location panda
   * VERIFIED. Machine scope only: no executor has a project-scope skills
   * location panda has proven, so `panda project init` materialises none and
   * the skills stay reported as unprojectable — the same refusal that keeps
   * Codex out of a project's MCP configuration.
   */
  readonly skills: readonly PlannedTarget[]
  readonly skipped: readonly SkippedExecutor[]
} {
  const planned: PlannedTarget[] = []
  const skills: PlannedTarget[] = []
  const skipped: SkippedExecutor[] = []
  const present = new Set(
    detected.filter((detection) => detection.present).map((detection) => detection.executorId),
  )
  for (const profile of EXECUTOR_PROFILES) {
    if (!present.has(profile.executorId)) continue
    const rootPath = scope === 'machine' ? profile.machineSkills?.(homeDir) : undefined
    if (rootPath !== undefined && profile.createSkillsTarget !== undefined) {
      skills.push({ profile, target: profile.createSkillsTarget(rootPath) })
    }
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
  return { planned, skills, skipped }
}

/**
 * Records without letting a broken sink break the run it is describing — the
 * same containment rule the kernel applies to its own call sites. Panda's
 * subjects are bounded by construction, so the only way this throws is a hostile
 * sink; the sink's own `dropped` counter remains the loss signal.
 */
function recordProjection(
  log: LogSink | undefined,
  event: 'action.invoked' | 'action.completed' | 'action.failed',
  targetId: string,
): void {
  // No sink means there is no action to record: `diagnose` passes none, because
  // an `action.invoked` for a projection that deliberately never ran would put a
  // projection panda did not perform into the record stream NFR-4 exists to make
  // reconstructable. `initMachine`/`initProject` always pass one.
  if (log === undefined) return
  try {
    log.record({ event, subject: `${PROJECTION_ACTION_ID}#${targetId}` })
  } catch {
    // Contained by contract; a diagnostic never aborts what it describes.
  }
}

/**
 * A per-target row in BOTH modes. `changed` is the one fact whose SENTENCE the
 * mode decides — the merged text differs from the bytes on disk — so it is named
 * for the fact and never for the write: `initMachine`/`initProject` map it to
 * `written`, `diagnose` maps it to `wouldWrite`, and neither reading can be
 * mistaken for the other by a caller holding the wrong one.
 */
export interface ScopeTarget {
  readonly executorId: string
  readonly targetId: string
  readonly filePath: string
  readonly changed: boolean
  readonly drift: readonly DriftEntry[]
  readonly unprojectable: readonly UnprojectableEntry[]
  readonly error?: TargetFailure
}

/** Everything one scope's engine run produced, before either caller phrases it. */
export interface ScopeReport {
  readonly pandaDir: string
  /**
   * This scope's registry document. Under `'apply'` it exists by the time the
   * report is built; under `'inspect'` it is only a PATH, and whether anything
   * is there is the answer to "has panda been initialised here".
   */
  readonly registryPath: string
  readonly ledgerPath: string
  readonly entryCount: number
  readonly detected: readonly ExecutorDetection[]
  readonly targets: readonly ScopeTarget[]
  /** One row per VERIFIED skills root; see `InitResult.skills`. */
  readonly skills: readonly ScopeTarget[]
  readonly skipped: readonly SkippedExecutor[]
  /**
   * Panda's own prior output found in a vendor file. Computed under `'inspect'`
   * ONLY: `panda init` neither reports nor removes it, because removing it is a
   * decision and this story's rule is that a decision is a user's.
   */
  readonly legacy: readonly LegacyBlock[]
  readonly warnings: readonly ProjectionWarning[]
  /**
   * Set ONLY under `'inspect'`, and only when panda's own registry document
   * could not be read. `'apply'` rethrows instead: projecting against a registry
   * panda cannot read would delete every entry it holds from every vendor file.
   * When this is set, `targets` is EMPTY — with no registry there is nothing
   * panda can honestly say projecting would do.
   */
  readonly registryError?: TargetFailure
  /**
   * Entries whose type panda has RETIRED — readable, listed and removable, and
   * never handed to a target. Reported by `panda doctor` because a word panda no
   * longer has is a state a user has to be told about AND given an exit from;
   * `panda init` neither projects nor removes them, because removing an entry is
   * a decision and a decision is a user's.
   */
  readonly retired: readonly RetiredEntry[]
}

/**
 * One retired entry AND the document that actually holds it.
 *
 * The scope is carried rather than inferred, and that is the whole point of this
 * type. `RegistryEntry` has no scope field and `store.list()` is the MERGED
 * view, so a caller holding only the entry has to guess — and the only guess
 * available is the scope being diagnosed. `panda project doctor` reads the
 * GLOBAL registry too, so that guess attributed a global entry to the (possibly
 * empty) project document and told the user to run `panda project remove`, which
 * exits 1 for an entry that is not there. A finding that names a file must name
 * the file the entry is actually in.
 */
export interface RetiredEntry {
  readonly entry: RegistryEntry
  readonly scope: Exclude<RegistryScope, 'agent'>
  /** The document holding it — NOT necessarily the one being diagnosed. */
  readonly registryPath: string
}

/**
 * A thrown error flattened to the two fields a caller acts on. A live `Error`
 * serialises to `{}` for every caller that prints the result.
 */
function toTargetFailure(error: unknown): TargetFailure {
  const code: unknown = (error as { code?: unknown } | null | undefined)?.code
  return {
    // Duck-typed on `code`, like the CLI's own `describe()`: the registry throws
    // `PandaError`, but a code that arrived some other way is still the fact.
    code: typeof code === 'string' && code.length > 0
      ? (code as PandaErrorCode)
      : PANDA_ERROR_CODES.registryStoreUnavailable,
    message: error instanceof Error ? error.message : String(error),
  }
}

/** Panda's own state directory for a scope root. One spelling, two callers. */
function pandaDirOf(root: string): string {
  return join(root, '.panda')
}

export function storeFor(scope: 'machine' | 'project', homeDir: string, projectDir: string): RegistryStore {
  return new RegistryStore(scope === 'machine' ? { homeDir } : { homeDir, projectDir })
}

/**
 * What would actually DELIVER one entry at one scope, and — when nothing at
 * that scope would — which scope does.
 *
 * DERIVED, never asserted. `panda add` used to end with a sentence written
 * beside the command ("`panda project init` puts it into every detected
 * executor"), and for a project-scope SKILL that sentence was false: no
 * executor has a project-scope skills root panda has verified, machine-scope
 * projection cannot see a project-scope entry, and the entry was inert forever
 * while the command it named exited 0. A promise can be kept syntactically and
 * broken in substance, which is exactly what the printed-command invariant
 * cannot catch.
 *
 * So nothing here knows which entry TYPE has a location at which scope. It runs
 * `targetsFor` — the same planner `panda init` runs — and then asks each target
 * it planned whether it would take THIS entry, in the target's own words:
 *
 *   - a config target is asked to merge into an EMPTY document. That call is
 *     pure text (`nativeText: ''` is the contract's "the file does not exist
 *     yet"), so no vendor file is read and none is written; an entry the target
 *     cannot express comes back in `skippedEntryIds`.
 *   - a materialise target is asked to PLAN. It describes what it would place
 *     and never touches the destination, and where it refuses it says why.
 *
 * Consequence, and it is the point: giving any `ExecutorProfile` a project-scope
 * skills root changes what `panda add` prints with no edit to the CLI and none
 * to this function, and removing every skills root changes it the other way.
 */
export interface EntryDelivery {
  readonly scope: 'machine' | 'project'
  /** The command that projects this scope. Always one the binary dispatches. */
  readonly command: string
  /** Detected executors whose target for this scope would take the entry. */
  readonly executorIds: readonly string[]
  /** Where a target refused, in the target's own words. */
  readonly reasons: readonly string[]
  /**
   * Set ONLY when nothing at this scope takes the entry and another scope
   * would. Naming it is the difference between a dead end and a next step.
   */
  readonly elsewhere?: EntryDelivery
  /**
   * Set when panda could not work the answer out at all. The entry is already
   * registered by the time this runs, so a failure here reports itself and
   * never turns a completed registration into a failed command.
   */
  readonly undetermined?: string
}

/** The command that projects one scope. One spelling, two callers. */
function projectCommandFor(scope: 'machine' | 'project'): string {
  return scope === 'machine' ? 'panda init' : 'panda project init'
}

async function takenBy(
  entry: RegistryEntry,
  detected: readonly ExecutorDetection[],
  scope: 'machine' | 'project',
  homeDir: string,
  projectDir: string,
): Promise<{ executorIds: string[]; reasons: string[] }> {
  const { planned, skills } = targetsFor(scope, detected, homeDir, projectDir)
  const byKind = groupByKind([entry])
  const executorIds: string[] = []
  const reasons: string[] = []
  for (const { profile, target } of [...planned, ...skills]) {
    if (target.kind === 'materialise') {
      const plan = await target.plan({ entries: byKind, records: [], rootPath: target.rootPath })
      if (plan.entries.some((row) => row.entryId === entry.id)) {
        executorIds.push(profile.executorId)
        continue
      }
      for (const skip of plan.skipped ?? []) {
        if (skip.entryId === entry.id) reasons.push(`${profile.executorId}: ${skip.reason}`)
      }
      continue
    }
    const outcome = await target.merge({ entries: byKind, records: [], nativeText: '' })
    if (!(outcome.skippedEntryIds ?? []).includes(entry.id)) executorIds.push(profile.executorId)
  }
  return { executorIds, reasons }
}

/**
 * {@link EntryDelivery} for one scope, with the OTHER scope answered too
 * whenever this one takes the entry nowhere.
 *
 * Contained: a target that throws while being asked leaves `undetermined` set
 * rather than propagating, because the caller has already registered the entry
 * and a message is not worth losing a completed write over.
 */
export async function deliveryFor(
  entry: RegistryEntry,
  scope: 'machine' | 'project',
  homeDir: string,
  projectDir: string,
): Promise<EntryDelivery> {
  const command = projectCommandFor(scope)
  let detected: readonly ExecutorDetection[]
  try {
    detected = await detectExecutors(homeDir)
    const here = await takenBy(entry, detected, scope, homeDir, projectDir)
    if (here.executorIds.length > 0) {
      return { scope, command, executorIds: here.executorIds, reasons: here.reasons }
    }
    const otherScope = scope === 'machine' ? 'project' : 'machine'
    const there = await takenBy(entry, detected, otherScope, homeDir, projectDir)
    return {
      scope,
      command,
      executorIds: [],
      reasons: here.reasons,
      ...(there.executorIds.length === 0
        ? {}
        : {
            elsewhere: {
              scope: otherScope,
              command: projectCommandFor(otherScope),
              executorIds: there.executorIds,
              reasons: there.reasons,
            },
          }),
    }
  } catch (error) {
    const failure = toTargetFailure(error)
    return {
      scope,
      command,
      executorIds: [],
      reasons: [],
      undetermined: `${failure.code}: ${failure.message}`,
    }
  }
}

/**
 * The ONLY two writes into panda's own state that `panda init` performs: its
 * directory, and the registry store document. They live here — OUTSIDE
 * `runScope`, which `init` and `diagnose` share — so the read-only caller cannot
 * reach them by construction rather than by remembering not to.
 * `test/doctor.test.ts` proves the consequence at byte level.
 */
async function prepareScope(
  scope: 'machine' | 'project',
  root: string,
  homeDir: string,
  projectDir: string,
): Promise<string> {
  const pandaDir = pandaDirOf(root)
  // Panda's own directory, created by panda. `recursive` here means "tolerate an
  // existing directory", not "build a tree": the parent was validated as an
  // existing directory above, so the only thing this can still meet is `.panda`
  // occupied by a FILE, which arrives as a bare doubled EEXIST naming nothing.
  try {
    await mkdir(pandaDir, { recursive: true })
  } catch (error) {
    throw scopeUnavailable(
      `panda's own state directory '${pandaDir}' cannot be created (${(error as NodeJS.ErrnoException)?.code ?? 'unknown error'})`,
      error,
    )
  }
  const store = storeFor(scope, homeDir, projectDir)
  try {
    // Materialised through the store itself, so the document's version and shape
    // stay the registry's to define. A corrupt store fails coded here rather than
    // being silently replaced.
    return await store.ensure(scope === 'machine' ? 'global' : 'project')
  } finally {
    await store.dispose()
  }
}

/**
 * Registry -> detection -> projection engine, for one scope. `panda init` and
 * `panda doctor` are THIS function under the two projection modes and nothing
 * else: same entries, same detection, same targets, same engine call, same drift
 * classification. Two code paths could disagree about what applying would do,
 * and they would disagree exactly when a user is trying to fix something.
 *
 * Every line below either reads, or writes through the projection engine — which
 * under `'inspect'` writes nothing at all.
 */
export async function runScope(
  scope: 'machine' | 'project',
  homeDir: string,
  projectDir: string,
  log: LogSink | undefined,
  mode: ProjectionMode,
): Promise<ScopeReport> {
  const store = storeFor(scope, homeDir, projectDir)
  const registryPath = store.storePath(scope === 'machine' ? 'global' : 'project')
  let entries: RegistryEntry[] = []
  const retired: RetiredEntry[] = []
  let registryError: TargetFailure | undefined
  try {
    entries = await store.list()
    // Read PER SCOPE as well, rather than filtered out of the merged view above:
    // the merge keeps one row per `type:id` and DROPS the scope that produced
    // it, which is exactly the fact every message about a retired entry needs.
    // Same scopes, in the same order, that `panda list` walks under each
    // grammar — so `panda project doctor` reports a global entry against the
    // global document, with the global verb.
    const retiredScopes: readonly Exclude<RegistryScope, 'agent'>[] =
      scope === 'machine' ? ['global'] : ['global', 'project']
    for (const candidateScope of retiredScopes) {
      for (const entry of await store.list(candidateScope)) {
        if (!isRetiredEntryType(entry.type)) continue
        retired.push({ entry, scope: candidateScope, registryPath: store.storePath(candidateScope) })
      }
    }
  } catch (error) {
    // Panda's OWN two state files, classified the same way. A corrupt ledger is
    // already a reported finding; a corrupt registry throwing out of the command
    // whose job is diagnosing panda's state would be the opposite treatment for
    // the same class of fault. `'apply'` still throws: `panda init` must not
    // project against a registry it cannot read.
    if (mode === 'apply') throw error
    registryError = toTargetFailure(error)
  } finally {
    await store.dispose()
  }

  const detected = await detectExecutors(homeDir)
  const { planned, skills, skipped } = targetsFor(scope, detected, homeDir, projectDir)
  const ledger = new ProjectionLedger({ homeDir })
  if (registryError !== undefined) {
    // No engine call at all: every per-target verdict is derived from the
    // registry, so reporting rows computed against an empty one would tell the
    // user panda is about to delete entries it simply could not read.
    return {
      pandaDir: pandaDirOf(scope === 'machine' ? homeDir : projectDir),
      registryPath,
      ledgerPath: ledger.filePath,
      entryCount: 0,
      detected,
      targets: [],
      skills: [],
      skipped,
      legacy: scope === 'machine' && mode === 'inspect' ? await legacyFor(detected, homeDir) : [],
      warnings: [],
      registryError,
      retired: [],
    }
  }

  const everyTarget = [...planned, ...skills]
  for (const { target } of everyTarget) recordProjection(log, 'action.invoked', target.targetId)

  const run = await runProjection({
    entries: groupByKind(entries),
    targets: everyTarget.map((plan) => plan.target),
    ledger,
    mode,
  })

  // Built from the entries the engine was actually GIVEN: a retired entry is
  // never handed to a target, so it can never be the explanation for an id a
  // target skipped — and an id spelled the same in both vocabularies would
  // otherwise be explained by the entry nobody projected, naming a type panda no
  // longer declares. `test/init.test.ts` forces exactly that collision.
  const byId = new Map<string, RegistryEntry[]>()
  for (const entry of entries) {
    if (isRetiredEntryType(entry.type)) continue
    byId.set(entry.id, [...(byId.get(entry.id) ?? []), entry])
  }
  const results = new Map(run.results.map((result) => [result.targetId, result]))
  const failures = new Map(run.failures.map((failure) => [failure.targetId, failure]))

  // Walked over `planned`, which is catalogue order, so one executor failing can
  // never reshuffle the report — and so a target that BOTH wrote and then failed
  // its ledger update yields ONE row carrying both facts. Two rows, or a row
  // hardcoding `changed: false` for a failure, is how panda came to report
  // `written: false` for bytes it had already landed.
  const materialising = new Set(skills.map(({ profile }) => profile.executorId))
  const rowFor = ({ profile, target }: PlannedTarget): ScopeTarget => {
    const result = results.get(target.targetId)
    const failure = failures.get(target.targetId)
    recordProjection(log, failure === undefined ? 'action.completed' : 'action.failed', target.targetId)
    return {
      executorId: profile.executorId,
      targetId: target.targetId,
      filePath: projectionTargetLocation(target),
      changed: result?.written ?? false,
      drift: result?.drift ?? [],
      // A config row stops claiming an executor cannot express a SKILL once that
      // executor has a verified skills root: the skills row below is the
      // authority for those ids, and two rows answering for one entry is how a
      // user is told a skill was both materialised and impossible.
      //
      // KNOWN LOSS OF GRANULARITY, and it is deliberate. When the skills target
      // FAILS outright, its row carries the coded error and an empty
      // `unprojectable` list, while this row has already dropped those ids — so
      // no row names the individual skills. The alternative is worse: the config
      // row's only sentence is "this executor has no native representation for a
      // skill", which is false for an executor that has a verified root and
      // merely could not be written to this run. A per-target failure is loud in
      // its own right (`error` on the row, `target-failed` in doctor, non-zero
      // exit), so what is lost is which entries it covered, not the failure.
      unprojectable: unprojectableFor(
        result,
        byId,
        profile.executorId,
        target.kind !== 'materialise' && materialising.has(profile.executorId),
      ),
      ...(failure === undefined
        ? {}
        : { error: { code: failure.error.code, message: failure.error.message } }),
    }
  }
  const targets: ScopeTarget[] = planned.map(rowFor)
  const skillRows: ScopeTarget[] = skills.map(rowFor)

  return {
    pandaDir: pandaDirOf(scope === 'machine' ? homeDir : projectDir),
    registryPath,
    ledgerPath: ledger.filePath,
    entryCount: entries.length,
    detected,
    targets,
    skills: skillRows,
    skipped,
    legacy: scope === 'machine' && mode === 'inspect' ? await legacyFor(detected, homeDir) : [],
    warnings: run.warnings,
    retired,
  }
}

function toTargetProjection(row: ScopeTarget): TargetProjection {
  // Named field by field, NOT spread. A spread rebuilds the row in the spread's
  // order and silently moved `written` from index 3 to last, after `error`, with
  // both suites green — and this is a documented payload a caller prints.
  // `test/init.test.ts` pins the order.
  return {
    executorId: row.executorId,
    targetId: row.targetId,
    filePath: row.filePath,
    written: row.changed,
    drift: row.drift,
    unprojectable: row.unprojectable,
    // A row carrying no `error` key keeps carrying none: an `error: undefined`
    // in the payload reads to every JSON consumer as a field panda decided to
    // say nothing about.
    ...(row.error === undefined ? {} : { error: row.error }),
  }
}

function toInitResult(scope: 'machine' | 'project', registryPath: string, report: ScopeReport): InitResult {
  return {
    scope,
    pandaDir: report.pandaDir,
    registryPath,
    ledgerPath: report.ledgerPath,
    entryCount: report.entryCount,
    detected: report.detected,
    targets: report.targets.map(toTargetProjection),
    skills: report.skills.map(toTargetProjection),
    skipped: report.skipped,
    warnings: report.warnings,
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
  const registryPath = await prepareScope('machine', home, home, home)
  const report = await runScope('machine', home, home, log ?? createMemoryLogSink(), 'apply')
  return toInitResult('machine', registryPath, report)
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
  const registryPath = await prepareScope('project', projectRoot, home, projectRoot)
  const report = await runScope('project', home, projectRoot, log ?? createMemoryLogSink(), 'apply')
  return toInitResult('project', registryPath, report)
}
