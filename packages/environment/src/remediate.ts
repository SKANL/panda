import { homedir } from 'node:os'
import { PANDA_ERROR_CODES, projectionTargetLocation } from '@skanl/panda-contracts'
import type {
  ProjectionTarget,
  RemediationKind,
  RemediationOutcome,
  RemediationRefusal,
} from '@skanl/panda-contracts'
import { ProjectionLedger, groupByKind, runRemediation } from '@skanl/panda-projection'
import type { ProjectionMode } from '@skanl/panda-projection'
// The exit table lives in `doctor.ts`, beside the finding kinds it is total
// over, and this file only ASKS it which kinds a verb resolves. Owning it here
// is what shipped the first time, and the consequence was a product that printed
// a terminal resolution for four states it could actually leave: the report and
// the exit have to be one table.
import { diagnose, findingKindsFor } from './doctor.ts'
import type { Diagnosis, DiagnosisFinding } from './doctor.ts'
import { EXECUTOR_PROFILES } from './executors.ts'
import { scopeDirectory, storeFor, targetsFor } from './init.ts'

// `panda remediate`: the way OUT of every state `panda doctor` reports.
//
// This file composes and decides nothing else. `diagnose` produces the findings
// — the same call, under the same inspection mode, that `panda doctor` prints —
// and `runRemediation` in `@skanl/panda-projection` performs the act. What lives here
// is the one thing neither of them owns: WHICH exit belongs to which reported
// state, and the rule that a user names exactly one of them.
//
// EXPLICIT, PER FINDING, ALWAYS. A remediation runs only for a finding this very
// run reported, named by the user, resolved to exactly one row. Zero matches is
// a refusal; more than one is a refusal that lists them. There is no sweep, no
// "fix everything", and no default — a bulk fix is where a user loses something
// they meant to keep, and the unit of remediation is the unit of reporting so
// the thing they consent to is the thing they were shown.

export interface RemediateOptions {
  /** Defaults to the OS home directory. */
  readonly homeDir?: string
  /** Read only for the project scope, where it defaults to `process.cwd()`. */
  readonly projectDir?: string
  /** Defaults to `'machine'`, mirroring `panda init` and `panda doctor`. */
  readonly scope?: 'machine' | 'project'
  readonly remediation: RemediationKind
  /** Narrows the finding; required whenever more than one would match. */
  readonly executorId?: string
  readonly entryId?: string
  /**
   * Defaults to `'inspect'` — the OPPOSITE default from `runProjection`, and
   * deliberately so. A projection converges a machine a user asked panda to
   * manage; a remediation changes who owns what, and describing it first is the
   * frozen requirement. A caller that wants the act asks for `'apply'`.
   */
  readonly mode?: ProjectionMode
}

export interface RemediationReport {
  readonly scope: 'machine' | 'project'
  readonly remediation: RemediationKind
  readonly mode: ProjectionMode
  /** The finding acted on, exactly as `panda doctor` reports it. */
  readonly finding?: DiagnosisFinding
  readonly outcome?: RemediationOutcome
  /** Why panda did not select a finding to act on. */
  readonly refusal?: RemediationRefusal
  /**
   * Every finding this remediation is the exit for, in this run. Present
   * whenever the request matched none or more than one, because "name one of
   * these" is only actionable if the user can see them.
   */
  readonly candidates: readonly DiagnosisFinding[]
  /** The full diagnosis the selection was made from; nothing here is invented. */
  readonly diagnosis: Diagnosis
}

function refusalOf(message: string): RemediationRefusal {
  return { code: PANDA_ERROR_CODES.projectionRemediationRefused, message }
}

function describeFinding(found: DiagnosisFinding): string {
  const about = [found.executorId, found.entryId, found.location, found.filePath].filter(
    (part): part is string => part !== undefined,
  )
  return `${found.kind}${about.length === 0 ? '' : ` (${about.join(' · ')})`}`
}

/** The target whose location a finding is about, out of the ones this scope runs. */
function targetFor(
  finding: DiagnosisFinding,
  planned: readonly { readonly profile: { readonly executorId: string }; readonly target: ProjectionTarget }[],
): ProjectionTarget | undefined {
  return planned.find(
    (candidate) =>
      candidate.profile.executorId === finding.executorId &&
      projectionTargetLocation(candidate.target) === finding.filePath,
  )?.target
}

/**
 * Describes — or, with `mode: 'apply'`, performs — exactly one remediation for
 * exactly one finding this run reported.
 *
 * Nothing else is touched. `adopt` and `release` change only what panda claims;
 * `repair` rewrites only panda's own ledger; `discard` removes only panda's own
 * prior output from one vendor file. No other entry, no other finding and no
 * foreign neighbour is read or written, which is what makes "nothing unnamed is
 * touched" a property of the design rather than a promise about the code.
 */
export async function remediate(options: RemediateOptions): Promise<RemediationReport> {
  // Every caller-controlled field read ONCE, before the first await — the same
  // TOCTOU rule `initMachine` and `diagnose` follow, and it decides here which
  // machine gets written to.
  const {
    homeDir = homedir(),
    projectDir,
    scope = 'machine',
    remediation,
    executorId,
    entryId,
    mode = 'inspect',
  } = options
  const home = await scopeDirectory('the home directory', homeDir)
  const root =
    scope === 'machine'
      ? home
      : await scopeDirectory('the project directory', projectDir ?? process.cwd())

  const diagnosis = await diagnose({ homeDir: home, projectDir: root, scope })
  const base = { scope, remediation, mode, diagnosis }
  const kinds = findingKindsFor(remediation)
  if (kinds.length === 0) {
    return {
      ...base,
      candidates: [],
      refusal: refusalOf(
        `'${remediation}' is not the exit for any state panda reports, so there is nothing it could be asked to do`,
      ),
    }
  }
  const candidates = diagnosis.findings.filter((found) => kinds.includes(found.kind))
  const selected = candidates.filter(
    (found) =>
      (executorId === undefined || found.executorId === executorId) &&
      (entryId === undefined || found.entryId === entryId),
  )
  if (selected.length === 0) {
    return {
      ...base,
      candidates,
      refusal: refusalOf(
        candidates.length === 0
          ? `panda reported no ${kinds.join(' or ')} finding in this run, so there is nothing for '${remediation}' to resolve; panda never remediates a state it did not just report`
          : `no ${kinds.join(' or ')} finding in this run matches ${JSON.stringify({ executorId, entryId })}; panda reported ${candidates.map(describeFinding).join(', ')}`,
      ),
    }
  }
  if (selected.length > 1) {
    return {
      ...base,
      candidates: selected,
      refusal: refusalOf(
        `'${remediation}' resolves one finding at a time and ${selected.length} match: ${selected
          .map(describeFinding)
          .join(', ')}. Name one with --executor and --entry`,
      ),
    }
  }
  const finding = selected[0]!
  const ledger = new ProjectionLedger({ homeDir: home })

  if (remediation === 'repair') {
    return { ...base, finding, candidates: [], outcome: await runRemediation({ remediation, ledger, mode }) }
  }

  if (remediation === 'discard') {
    const profile = EXECUTOR_PROFILES.find((candidate) => candidate.executorId === finding.executorId)
    const location = profile?.legacyConfig?.(home)
    if (profile === undefined || location === undefined) {
      return {
        ...base,
        finding,
        candidates: [],
        refusal: refusalOf(
          `panda knows no location where a previous build could have written into '${finding.executorId ?? 'an unnamed executor'}'`,
        ),
      }
    }
    return {
      ...base,
      finding,
      candidates: [],
      // `rootPath: home`, so the containment check in `runRemediation` is against
      // the scope panda was pointed at rather than against a path this file made
      // up. A legacy location is machine-scoped by measurement (see the profile).
      outcome: await runRemediation({
        remediation,
        legacy: { targetId: profile.targetId, rootPath: home, ...location },
        mode,
      }),
    }
  }

  const { planned, skills } = targetsFor(scope, diagnosis.detected, home, root)
  const target = targetFor(finding, [...planned, ...skills])
  if (target === undefined || finding.entryId === undefined) {
    return {
      ...base,
      finding,
      candidates: [],
      refusal: refusalOf(
        `panda could not tie ${describeFinding(finding)} back to one projection target and one registry entry, so it will not act on it`,
      ),
    }
  }
  if (remediation === 'release') {
    return {
      ...base,
      finding,
      candidates: [],
      outcome: await runRemediation({ remediation, target, entryId: finding.entryId, ledger, mode }),
    }
  }
  // `adopt` alone needs the registry: the claim's paths come from the TARGET's
  // own plan of what panda would write, never from a directory listing, so a
  // file the user put beside panda's is not swept into a record that later
  // authorises deleting it.
  const store = storeFor(scope, home, root)
  let entries
  try {
    entries = groupByKind(await store.list())
  } finally {
    await store.dispose()
  }
  return {
    ...base,
    finding,
    candidates: [],
    outcome: await runRemediation({ remediation, target, entryId: finding.entryId, entries, ledger, mode }),
  }
}
