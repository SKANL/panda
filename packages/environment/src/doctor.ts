import { access, constants, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import { PANDA_ERROR_CODES } from '@panda/contracts'
import type { DriftEntry, DriftKind, PandaErrorCode, ProjectionWarning } from '@panda/contracts'
import type { ExecutorDetection } from './executors.ts'
import { noExecutorsDetected, runScope, scopeDirectory } from './init.ts'
import type { ScopeTarget, SkippedExecutor, TargetFailure, UnprojectableEntry } from './init.ts'

// `panda doctor`: what `panda init` / `panda project init` WOULD do, and every
// problem panda can see, with nothing written.
//
// This file computes no diagnosis of its own. It calls `runScope` — the exact
// function `initProject` calls, with the exact same detection, the same registry
// read, the same targets and the same projection-engine call — under the engine's
// inspection mode, and phrases the result. That is the whole design: a report
// derived from a second code path can disagree with what applying would actually
// do, and it would disagree exactly when a user is trying to fix something.
//
// It writes NOTHING, including panda's own directory and an absent registry.
// "It only created panda's own directory" is precisely the reasoning that makes
// a read-only tool stop being read-only, and doctor is what you run on a machine
// you would rather not change yet. The mechanism is structural rather than
// remembered: the two writes `panda init` makes into panda's own state live in
// `prepareScope`, which this file cannot reach, and the engine's `'inspect'`
// mode skips both of the writes a projection performs. `test/doctor.test.ts`
// hashes every byte AND every mtime under the scope before and after.
//
// It does not REMEDIATE. `panda init` converges; doctor tells you what
// converging would do, and every `resolution` below is a sentence about what
// panda itself would perform — never advice panda cannot carry out, and never a
// promise stronger than what panda actually checked.

/**
 * What one finding is about. The three drift kinds are the CONTRACT's
 * (`DriftKind`), not a second vocabulary: a doctor that classified drift itself
 * would be the divergence this command exists to not have, and widening
 * `DriftKind` upstream turns the two total records below red until this file
 * answers for the new kind.
 */
export type DiagnosisFindingKind =
  | DriftKind
  /** Panda has no registry document for this scope; nothing was initialised. */
  | 'not-initialised'
  /** Panda knows executors, and this machine has a configuration for none. */
  | 'no-executor'
  /** Panda's own registry document exists and cannot be read. */
  | 'registry-unreadable'
  /** Panda's own ownership ledger cannot be read, or has lost records. */
  | 'ledger-damaged'
  /** A projection warning with no more specific reading than its own code. */
  | 'projection-warning'
  /**
   * The bytes on disk differ from what projecting would produce.
   *
   * ponytail: FILE-level, not per entry. `ProjectionResult` reports THAT the
   * merged text differs, never which entries account for the difference, so a
   * per-entry answer here would have to be a second computation — the exact
   * divergence this command exists to not have. Upgrade path: the engine
   * surfaces the planned entries alongside `written` (deferred-work.md).
   */
  | 'out-of-date'
  /** Panda would write here and the location refused a writability check. */
  | 'not-writable'
  /** A registry entry this target cannot express (correction-01 C5). */
  | 'unprojectable'
  /** This target could not be diagnosed at all; the others still were. */
  | 'target-failed'

/**
 * Whether a finding is something WRONG or something merely true.
 *
 * The distinction exists because the exit code is a promise: a non-zero exit a
 * user cannot ever get back to zero is not a diagnosis, it is a stuck light. A
 * `tool` entry in the registry is an ordinary thing to register and is
 * unprojectable by every executor permanently — reporting it is required
 * (correction-01 C5), failing on it forever is not.
 */
export type DiagnosisFindingSeverity = 'problem' | 'info'

/**
 * One diagnosed problem, named so a user can act on it.
 *
 * The four locating fields are present EXACTLY when the finding is about them:
 * an entry-level finding carries all four, a target-level one carries the
 * executor and the file, a finding about panda's own state carries the file
 * alone, and a machine-level one carries none — which is why they are optional
 * rather than filled with a placeholder that reads as a fact.
 */
export interface DiagnosisFinding {
  readonly kind: DiagnosisFindingKind
  readonly severity: DiagnosisFindingSeverity
  /** The executor whose configuration this is about. */
  readonly executorId?: string
  /** The file this is about — a vendor's own, or one of panda's two. */
  readonly filePath?: string
  /** Vendor-native location, e.g. `mcpServers.context7`. */
  readonly location?: string
  readonly entryId?: string
  readonly detail: string
  /** What `panda init` / `panda project init` would do about it. */
  readonly resolution: string
}

/**
 * What `panda init` WOULD do about each kind — and only ever what panda can
 * itself perform. A `Record` over the closed kind union, so a kind added without
 * an answer here does not compile: "each finding carries what panda would do
 * about it" is a type error away from being false, rather than a promise.
 */
const RESOLUTION: Record<DiagnosisFindingKind, string> = {
  edited: "panda never overwrites an entry that changed since it wrote it; projecting again leaves your edit exactly as it is",
  'removed-by-user': 'panda never re-adds an entry you deleted; projecting again leaves it absent',
  'foreign-collision': 'panda never resolves a collision with content its ledger does not claim; projecting again leaves it untouched',
  'not-initialised': "`panda init` (or `panda project init`) creates panda's state here; doctor creates nothing",
  'no-executor': 'panda projects into configurations that already exist and creates none, so `panda init` would write nothing here and exits 2',
  'registry-unreadable': 'panda never replaces a registry document it cannot read; `panda init` fails on it and projects nothing, so no entry is deleted from any vendor file',
  'ledger-damaged': 'panda leaves the ledger exactly as it is and claims nothing it cannot read; until it is readable again panda reports its own entries as foreign and touches none of them',
  'projection-warning': 'panda surfaced this from the projection run and resolves none of it by itself; `panda init` runs through the same condition',
  'out-of-date': 'projecting makes this location match the registry — for a skills root that can mean REMOVING a tree panda wrote, not only writing one. Panda checked the location is writable, which is weaker than a guarantee: an ACL, a mount option or another process holding it can still refuse the write, and on Windows that check sees only the read-only attribute',
  'not-writable': 'panda cannot write here, so projecting fails on this location and changes nothing rather than half-applying it',
  unprojectable: 'no target can express this entry, so projecting again changes nothing for it; it stays out of this configuration',
  'target-failed': 'projecting again fails the same way for this executor and leaves its file untouched; the other executors are unaffected',
}

/**
 * Which findings the exit code answers for. Total over the same union, for the
 * same reason: a new kind has to be classified deliberately, not inherit
 * "problem" from a default nobody chose.
 */
const SEVERITY: Record<DiagnosisFindingKind, DiagnosisFindingSeverity> = {
  edited: 'problem',
  'removed-by-user': 'problem',
  'foreign-collision': 'problem',
  'not-initialised': 'problem',
  'no-executor': 'problem',
  'registry-unreadable': 'problem',
  'ledger-damaged': 'problem',
  'projection-warning': 'problem',
  'out-of-date': 'problem',
  'not-writable': 'problem',
  // The one INFO kind, and the exit code is the whole reason: no sequence of
  // panda commands makes a registered `tool` projectable, so exit 1 here can
  // never be got back to 0. Reported in full, never counted as diagnosed.
  unprojectable: 'info',
  'target-failed': 'problem',
}

/**
 * Every kind, derived from a record TypeScript proves total. Exported for the
 * tests that partition the kinds by what a finding of that kind must name — a
 * hand-written list there would fall behind the union silently.
 */
export const DIAGNOSIS_FINDING_KINDS = Object.keys(RESOLUTION) as readonly DiagnosisFindingKind[]

/**
 * How a projection warning is read. Keyed on the warning's own CODE rather than
 * assumed: the engine seeds warnings from the ledger today, and a second source
 * added upstream would otherwise ship silently wearing the ledger's resolution
 * text. An unmapped code says exactly that instead.
 */
const WARNING_KIND: Partial<Record<PandaErrorCode, DiagnosisFindingKind>> = {
  [PANDA_ERROR_CODES.projectionLedgerUnavailable]: 'ledger-damaged',
}

/** What happened to ONE executor's configuration, in the read-only reading. */
export interface DiagnosisTarget {
  readonly executorId: string
  readonly targetId: string
  /** The vendor's own file, at the location that vendor reads. */
  readonly filePath: string
  /** True when projecting WOULD change this file. Doctor changed nothing. */
  readonly wouldWrite: boolean
  readonly drift: readonly DriftEntry[]
  readonly unprojectable: readonly UnprojectableEntry[]
  readonly error?: TargetFailure
}

export interface Diagnosis {
  readonly scope: 'machine' | 'project'
  /** Panda's own state directory for this scope. Doctor never creates it. */
  readonly pandaDir: string
  /** This scope's registry document. Its absence is `not-initialised`. */
  readonly registryPath: string
  readonly ledgerPath: string
  /** Registry entries the diagnosis read from, across every scope it can see. */
  readonly entryCount: number
  /** EVERY executor panda knows, found or not, with the paths consulted. */
  readonly detected: readonly ExecutorDetection[]
  readonly targets: readonly DiagnosisTarget[]
  /**
   * The same reading for each VERIFIED skills root. Separate from `targets`
   * because `filePath` there names a file and here names a directory tree, and
   * because a skills root is the one location where "projecting would change
   * this" can mean panda REMOVING something.
   */
  readonly skills: readonly DiagnosisTarget[]
  readonly skipped: readonly SkippedExecutor[]
  readonly warnings: readonly ProjectionWarning[]
  /** Empty means clean. `severity: 'problem'` is what a non-zero exit answers for. */
  readonly findings: readonly DiagnosisFinding[]
}

export interface DiagnoseOptions {
  /** Defaults to the OS home directory. */
  readonly homeDir?: string
  /** Read only for the project scope, where it defaults to `process.cwd()`. */
  readonly projectDir?: string
  /** Defaults to `'machine'`, mirroring `panda init`. */
  readonly scope?: 'machine' | 'project'
}

/** True when at least one finding is something wrong — the non-zero condition. */
export function hasProblem(diagnosis: Diagnosis): boolean {
  return diagnosis.findings.some((found) => found.severity === 'problem')
}

function finding(
  kind: DiagnosisFindingKind,
  detail: string,
  about: Omit<DiagnosisFinding, 'kind' | 'severity' | 'detail' | 'resolution'> = {},
): DiagnosisFinding {
  return { kind, severity: SEVERITY[kind], ...about, detail, resolution: RESOLUTION[kind] }
}

async function isFile(path: string): Promise<boolean> {
  return await stat(path).then(
    (stats) => stats.isFile(),
    () => false,
  )
}

/**
 * Whether `access(W_OK)` is granted at `path` or, when nothing is there yet, at
 * its nearest EXISTING ancestor — three-valued, because "panda could not
 * determine" must not be reported as "panda cannot write".
 */
async function permitsWrite(path: string): Promise<boolean | undefined> {
  let candidate = path
  for (;;) {
    try {
      await access(candidate, constants.W_OK)
      return true
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code
      // EPERM is the Windows spelling for a read-only file; EACCES the POSIX one.
      if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return false
      if (code !== 'ENOENT') return undefined
      const parent = dirname(candidate)
      if (parent === candidate) return undefined
      candidate = parent
    }
  }
}

/**
 * Whether panda could write at `path` — modelling the write panda ACTUALLY
 * performs, which is not `open(path, 'w')`. Every byte panda lands goes through
 * one atomic writer: a temp file created in the target's own directory, then
 * renamed over the target.
 *
 * So the permission that decides the outcome is the DIRECTORY's, on both
 * platforms — the temp file has to be created there, and rename() consults the
 * containing directory, never the mode of the name it replaces. A 0444 target
 * whose directory is writable is replaced without complaint on POSIX. Windows
 * is the exception, and only Windows: rename over a file carrying the read-only
 * attribute fails EPERM there, so that one check is guarded by the platform
 * rather than applied to both. Both halves measured by execution (see the
 * differential rows in `test/doctor.test.ts`).
 *
 * ponytail: `access(W_OK)` is advisory, not a guarantee — on Windows it sees the
 * read-only attribute and not ACLs, and nothing survives another process taking
 * the directory between the check and the write. That is why a positive answer
 * only lets the `out-of-date` resolution say panda CHECKED, never that it will
 * succeed. Upgrade path: none worth having; a trial write is exactly the thing
 * this command may not do.
 *
 * ponytail: a SYMLINKED target is probed at the link's own directory, not at the
 * directory of the file `realpath` resolves to, which is where the writer lands
 * it. Ceiling accepted deliberately: `realpath` is not one of the four fs verbs
 * this package is allowed to import (`test/guard.test.ts`), and the answer is
 * advisory either way. Upgrade path: the engine reports the resolved write
 * target alongside the row, and this probes that.
 */
async function writableLocation(path: string): Promise<boolean | undefined> {
  if (process.platform === 'win32' && (await isFile(path))) {
    const target = await permitsWrite(path)
    if (target !== true) return target
  }
  return await permitsWrite(dirname(path))
}

/**
 * Everything wrong with one scope, in the order a reader needs it: panda's own
 * state first (a machine with nothing initialised explains every other row),
 * then per target in catalogue order.
 */
async function findingsFor(
  diagnosis: Omit<Diagnosis, 'findings'>,
  registryError: TargetFailure | undefined,
): Promise<DiagnosisFinding[]> {
  const findings: DiagnosisFinding[] = []
  if (registryError !== undefined) {
    findings.push(
      finding('registry-unreadable', `${registryError.code}: ${registryError.message}`, {
        filePath: diagnosis.registryPath,
      }),
    )
  } else if (!(await isFile(diagnosis.registryPath))) {
    // The REGISTRY DOCUMENT is the initialised signal, not panda's directory:
    // the ledger creates `<home>/.panda` on its own first write, so one
    // `panda project init` anywhere would otherwise make the machine scope read
    // as initialised forever — on the ordinary path, not an exotic one.
    findings.push(
      finding('not-initialised', `panda has no registry document at '${diagnosis.registryPath}'`, {
        filePath: diagnosis.registryPath,
      }),
    )
  }
  if (noExecutorsDetected(diagnosis)) {
    // `panda init` exits 2 on exactly this state, so a doctor that called it
    // clean would certify an environment the very next command refuses.
    findings.push(
      finding(
        'no-executor',
        `no configuration was found for any executor panda knows (${diagnosis.detected.map((detection) => detection.executorId).join(', ')})`,
      ),
    )
  }
  for (const warning of diagnosis.warnings) {
    findings.push(
      finding(WARNING_KIND[warning.code] ?? 'projection-warning', `${warning.code}: ${warning.detail}`, {
        ...(WARNING_KIND[warning.code] === 'ledger-damaged' ? { filePath: diagnosis.ledgerPath } : {}),
      }),
    )
  }
  // Panda's own ledger is written for EVERY target a run produces a result for,
  // changed or not, so an unwritable ledger fails a run that would otherwise be
  // a no-op — and inspection cannot discover that by failing, because the write
  // it would fail on is the one this mode skips.
  if (
    diagnosis.targets.length + diagnosis.skills.length > 0 &&
    (await writableLocation(diagnosis.ledgerPath)) === false
  ) {
    findings.push(
      finding(
        'not-writable',
        `panda's own ownership ledger '${diagnosis.ledgerPath}' is not writable, which fails every target of a run, not only the ones that would change`,
        { filePath: diagnosis.ledgerPath },
      ),
    )
  }
  // Config files first, then skills roots — the same catalogue order both
  // arrays already carry, so one executor's two surfaces read together.
  for (const target of [...diagnosis.targets, ...diagnosis.skills]) {
    const tree = diagnosis.skills.includes(target)
    const at = { executorId: target.executorId, filePath: target.filePath }
    if (target.error !== undefined) {
      findings.push(finding('target-failed', `${target.error.code}: ${target.error.message}`, at))
    }
    if (target.wouldWrite) {
      // Reported as one or the other, never both: `out-of-date` promises a write
      // panda would perform, and at a location panda cannot write that promise
      // is false forever — which is the one thing this command may not say.
      //
      // A skills ROOT is probed as itself rather than through its parent: the
      // writer creates the root when it is absent, so the nearest existing
      // ancestor is what decides, and `permitsWrite` walks up to find it. A
      // config file is probed through its DIRECTORY, because that is where the
      // temp-file-then-rename actually lands.
      const writable = tree ? await permitsWrite(target.filePath) : await writableLocation(target.filePath)
      findings.push(
        writable === false
          ? finding('not-writable', `panda would rewrite '${target.filePath}' and the location is not writable`, at)
          : finding(
              'out-of-date',
              tree
                ? `the skills panda materialises under '${target.filePath}' differ from what projecting would produce`
                : `the bytes in '${target.filePath}' differ from what projecting would produce`,
              at,
            ),
      )
    }
    for (const entry of target.drift) {
      findings.push(finding(entry.kind, entry.detail, { ...at, location: entry.location, entryId: entry.entryId }))
    }
    for (const entry of target.unprojectable) {
      findings.push(finding('unprojectable', entry.reason, { ...at, entryId: entry.entryId }))
    }
  }
  return findings
}

function toDiagnosisTarget(row: ScopeTarget): DiagnosisTarget {
  return {
    executorId: row.executorId,
    targetId: row.targetId,
    filePath: row.filePath,
    wouldWrite: row.changed,
    drift: row.drift,
    unprojectable: row.unprojectable,
    ...(row.error === undefined ? {} : { error: row.error }),
  }
}

/**
 * Diagnoses one scope and writes nothing at all.
 *
 * A clean environment yields no findings; anything wrong yields at least one
 * with `severity: 'problem'`, which is what lets a script branch on it.
 * Reporting stops at the scope the caller named: doctor never goes looking for
 * other projects panda has bound.
 */
export async function diagnose(options: DiagnoseOptions = {}): Promise<Diagnosis> {
  // Every field read ONCE, here, before the first await — the same TOCTOU rule
  // `initMachine` follows, and it bites harder here: an accessor that answered
  // with a temp directory now and the real home directory later would have the
  // real one diagnosed under a promise that nothing would be touched.
  const { homeDir = homedir(), projectDir, scope = 'machine' } = options
  const home = await scopeDirectory('the home directory', homeDir)
  // Resolved and validated only when it is the scope being diagnosed. `panda
  // doctor` must not fail on a working directory it was never asked about — and
  // `process.cwd()` THROWS when the process's directory has been deleted, which
  // is exactly the kind of machine this command gets run on.
  const root =
    scope === 'machine'
      ? home
      : await scopeDirectory('the project directory', projectDir ?? process.cwd())

  // No log sink: nothing is invoked, so nothing is recorded as invoked.
  const report = await runScope(scope, home, root, undefined, 'inspect')
  const body: Omit<Diagnosis, 'findings'> = {
    scope,
    pandaDir: report.pandaDir,
    registryPath: report.registryPath,
    ledgerPath: report.ledgerPath,
    entryCount: report.entryCount,
    detected: report.detected,
    // Named field by field rather than spread, so this payload's key order is
    // authored and pinned instead of inherited from a rest object.
    targets: report.targets.map(toDiagnosisTarget),
    skills: report.skills.map(toDiagnosisTarget),
    skipped: report.skipped,
    warnings: report.warnings,
  }
  return { ...body, findings: await findingsFor(body, report.registryError) }
}
