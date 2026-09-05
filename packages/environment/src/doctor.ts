import { access, constants, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import { PANDA_ERROR_CODES, REGISTRY_ENTRY_TYPES } from '@skanl/panda-contracts'
import type {
  DriftEntry,
  DriftKind,
  PandaErrorCode,
  ProjectionWarning,
  RemediationKind,
} from '@skanl/panda-contracts'
import type { ExecutorDetection } from './executors.ts'
import { noExecutorsDetected, runScope, scopeDirectory } from './init.ts'
import type {
  LegacyBlock,
  RetiredEntry,
  ScopeTarget,
  SkippedExecutor,
  TargetFailure,
  UnprojectableEntry,
} from './init.ts'

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
  /**
   * The registry document was written by a build NEWER than this one.
   *
   * Not `registry-unreadable`, and the split is the whole of spec M31.A: that
   * kind's exit says *"Repair or remove that document"*, and this document is
   * healthy — following the instruction destroys intact data. Panda knows both
   * version numbers, so it can name the one action that works. Routed on the
   * store's CODE, never on its message text (AD-7).
   */
  | 'registry-version-ahead'
  /**
   * A stored entry whose TYPE panda has retired (story M4.E).
   *
   * Not `unprojectable`: that one is about an entry panda still declares which
   * no target happens to express, and it is reported per target because a target
   * is what refused it. This one is about the REGISTRY holding a word panda no
   * longer has — no target ever saw it, so no target can report it, and the file
   * it is about is panda's own registry document.
   */
  | 'retired-type'
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
  /**
   * Panda's OWN prior output, still in a vendor file at a location no executor
   * reads (correction-01 C6).
   *
   * Not drift: no ledger record claims it and no corrected build can produce it.
   * It is litter a PREVIOUS build left, and until `panda remediate discard`
   * existed nothing in the product could take it back — which is why it was not
   * reported before this story. A state panda reports and cannot leave is
   * exactly what M4.C exists to abolish, so the report and the exit ship
   * together.
   */
  | 'legacy-block'
  /** This target could not be diagnosed at all; the others still were. */
  | 'target-failed'
  /**
   * A worktree removal that was interrupted between recording its intent and
   * finishing it (spec M16.A, D3/D4).
   *
   * It is REPORTED here and resolved by a verb, never swept at startup: a sweep
   * that removed on every process start would make panda destructive on a run
   * the user did not ask to be destructive — the same reasoning `remediate`
   * rests on, which is why the exit below is a command rather than something
   * this command performs.
   *
   * The leftovers arrive through {@link DiagnoseOptions.worktreeLeftovers}
   * rather than being discovered here. `@skanl/panda-environment` may not import a
   * workspace implementation (`test/guard.test.ts`), and doctor may not open a
   * file of its own; the caller that already holds the worktree capability
   * hands the facts in, and this file phrases them — the same shape every other
   * row here has, where `runScope` supplies and doctor words.
   */
  | 'worktree-leftover'

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
export const RESOLUTION: Record<DiagnosisFindingKind, string> = {
  edited: "panda never overwrites an entry that changed since it wrote it; projecting again leaves your edit exactly as it is",
  'removed-by-user': 'panda never re-adds an entry you deleted; projecting again leaves it absent',
  'foreign-collision': 'panda never resolves a collision with content its ledger does not claim; projecting again leaves it untouched',
  'not-initialised': "`panda init` (or `panda project init`) creates panda's state here; doctor creates nothing",
  'no-executor': 'panda projects into configurations that already exist and creates none, so `panda init` would write nothing here and exits 2',
  'registry-unreadable': 'panda never replaces a registry document it cannot read; `panda init` fails on it and projects nothing, so no entry is deleted from any vendor file',
  'registry-version-ahead': 'the document is not damaged: this build is simply older than the one that wrote it, and panda refuses a format it does not speak rather than reading half of it. `panda init` fails on it and projects nothing, so no entry is deleted from any vendor file and not one byte of the document is changed',
  'retired-type': 'panda reads and lists the entry but hands it to no target, so projecting again neither writes nor removes anything for it; panda never deletes a registry entry by itself, because removing one is a decision and a decision is yours',
  'ledger-damaged': 'panda leaves the ledger exactly as it is and claims nothing it cannot read; until it is readable again panda reports its own entries as foreign and touches none of them',
  'projection-warning': 'panda surfaced this from the projection run and resolves none of it by itself; `panda init` runs through the same condition',
  'out-of-date': 'projecting makes this location match the registry — for a skills root that can mean REMOVING a tree panda wrote, not only writing one. Panda checked the location is writable, which is weaker than a guarantee: an ACL, a mount option or another process holding it can still refuse the write, and on Windows that check sees only the read-only attribute',
  'not-writable': 'panda cannot write here, so projecting fails on this location and changes nothing rather than half-applying it',
  unprojectable: 'no target can express this entry, so projecting again changes nothing for it; it stays out of this configuration',
  'legacy-block': "`panda remediate discard --executor <id>` removes exactly this block and leaves every other byte of the file alone; projecting again neither reads nor removes it. Where the detail says panda will NOT take it, that is the reason, and panda leaves the file untouched",
  'target-failed': 'projecting again fails the same way for this executor and leaves its file untouched; the other executors are unaffected',
  'worktree-leftover': 'projecting neither reads nor touches a worktree, so `panda init` would do nothing about this; panda never sweeps a leftover on its own, because removing a checkout on a run nobody asked to be destructive is exactly what a startup sweep would be',
}

/**
 * How one reported state is LEFT. Three shapes, because they are three different
 * promises and collapsing them is how a diagnosis starts lying:
 *
 *   `remediation`  — panda performs it, named by the user, one at a time. These
 *                    are the states whose only previous exit was hand-editing
 *                    `~/.panda/projection-ledger.json`.
 *   `command`      — an existing panda command already leaves this state.
 *   `outside-panda`— panda cannot leave it and says what does. Naming a
 *                    remediation here would be the same false promise the
 *                    `out-of-date`/`not-writable` split was written to remove.
 */
export type FindingExit =
  | { readonly by: 'remediation'; readonly remediations: readonly RemediationKind[]; readonly detail: string }
  | { readonly by: 'command'; readonly command: string; readonly detail: string }
  | { readonly by: 'outside-panda'; readonly detail: string }

/**
 * The exit for every state panda reports — TOTAL over {@link DiagnosisFindingKind},
 * so a finding kind added without one does not compile.
 *
 * IT LIVES IN DOCTOR, beside the kinds, and not beside `remediate` — because the
 * first version put it beside the capability, nothing outside the tests consumed
 * it, and `panda doctor` went on printing *"panda never overwrites an entry that
 * changed since it wrote it; projecting again leaves your edit exactly as it is"*
 * for four of the five states this story gave an exit to. The trap was closed in
 * the code and left open on the only surface a user reads. Every `resolution`
 * below is now composed from this record, so the product cannot know an exit the
 * report does not print.
 */
export const FINDING_EXITS: Record<DiagnosisFindingKind, FindingExit> = {
  edited: {
    by: 'remediation',
    remediations: ['adopt', 'release'],
    detail:
      "`adopt` takes ownership of what is there now, after which `panda init` replaces it with the registry's version — that is how you get panda's version back, and it is a REPLACEMENT of your edit. `release` drops the claim and leaves your edit alone permanently",
  },
  'removed-by-user': {
    by: 'remediation',
    remediations: ['release'],
    detail:
      '`release` drops the claim, which makes the location free again, so the next `panda init` writes the entry back. To keep it absent instead, the entry has to leave the registry, which is `panda remove <type> <id>` (`panda project remove <type> <id>` for a project-scope entry)',
  },
  'foreign-collision': {
    by: 'remediation',
    remediations: ['adopt', 'release'],
    detail:
      "`adopt` takes ownership of what occupies panda's location, exactly as it is now — including panda's OWN tree left unclaimed by a crash, and a tree that is only PARTLY there, which it claims as the subset that exists. It claims what is THERE and nothing else, so where the location holds nothing panda can identify there is nothing to claim and `adopt` refuses rather than writing an empty claim. `release` is the exit where the collision comes from a claim panda holds and cannot use. Where the detail says the VENDOR's document is ambiguous — a location declared twice, a container panda cannot address — neither verb applies until that is fixed in the file itself, and panda's own ledger is not involved",
  },
  'ledger-damaged': {
    by: 'remediation',
    remediations: ['repair'],
    detail:
      "`repair` rewrites panda's own ledger to hold exactly the records it can read. It describes what it will drop before it drops it, and it touches no vendor file",
  },
  'legacy-block': {
    by: 'remediation',
    remediations: ['discard'],
    detail:
      "`discard` removes exactly the block a previous panda build wrote and nothing else. Where the detail says panda will NOT take it — markers it cannot bound, a key it cannot attribute — that is the reason, panda leaves the file untouched, and the block has to be removed by hand",
  },
  'not-initialised': {
    by: 'command',
    command: 'panda init',
    // ONLY WHAT THE OTHER HALF DID NOT SAY. `RESOLUTION['not-initialised']`
    // already names the command and says doctor creates nothing; this said the
    // same sentence again, and the user read both in one line.
    detail: "it writes panda's own state directory and registry document, and nothing into any executor's configuration",
  },
  'out-of-date': {
    by: 'command',
    command: 'panda init',
    detail: 'projecting is what makes this location match the registry; that is `panda init`',
  },
  'no-executor': {
    by: 'outside-panda',
    // The premise -- that panda projects into configurations and creates none --
    // belongs to `RESOLUTION` and was restated here for eleven words. This half
    // carries the ACTION, which is the only part the other one cannot give.
    detail:
      'Run one of them at least once so a configuration exists to project into; nothing in panda has to be fixed first',
  },
  'registry-unreadable': {
    by: 'outside-panda',
    // The refusal and its reason are `RESOLUTION`'s sentence; repeating them
    // here cost eight words before the part a user acts on.
    detail:
      "Repair or remove that document. Panda's ownership ledger is a different file and is not involved, so nothing it already claims is at risk while you do",
  },
  // The ONE action, and it is the opposite of the sibling's above. The premise —
  // the document is intact and panda refuses it whole — is `RESOLUTION`'s
  // sentence; this half carries only what the user does about it, which is the
  // part that other one cannot give.
  'registry-version-ahead': {
    by: 'outside-panda',
    detail:
      'Install a panda at least as new as the build that wrote it; the detail above names both versions. The document itself needs nothing done to it, and deleting it or editing it back into a shape this older build accepts is how the entries in it get lost',
  },
  'not-writable': {
    by: 'outside-panda',
    detail: 'panda cannot grant itself permission; the location has to become writable',
  },
  // A COMMAND, and it has to be: retiring a word from the registry vocabulary
  // while the entries written under it stay unreadable-or-unremovable is the
  // dead end M4.C exists to abolish, reached this time by upgrading. `panda
  // remove` therefore accepts a retired type even though `panda add` refuses
  // one, and the finding's own detail names the exact spelling for this entry.
  'retired-type': {
    by: 'command',
    command: 'panda remove <type> <id>',
    detail:
      'the entry is not damaged and the document is not corrupt — panda simply no longer declares that word. `panda remove` still accepts a retired type even though `panda add` refuses one, which is how an entry written by an older build leaves without hand-editing the document',
  },
  // Reclassified OUT of `outside-panda` by story M4.D, which is the SAFE
  // direction: the M4.C ledger flagged reclassification INTO `outside-panda` as
  // the move that weakens the totality proof, because it lets a hard state be
  // answered with a plausible sentence. This goes the other way — the sentence
  // is replaced by a command the binary dispatches.
  unprojectable: {
    by: 'command',
    command: 'panda remove <type> <id>',
    detail:
      'this is informational and is never counted as a problem, so nothing has to be done about it. Nothing makes the entry PROJECTABLE — no target can express it — and what `panda remove <type> <id>` changes is that it stops being reported, because the entry has left the registry. Use `panda project remove <type> <id>` for an entry registered at a project scope',
  },
  'target-failed': {
    by: 'outside-panda',
    detail:
      'the coded error on the finding names the cause; panda leaves this executor untouched until it is addressed, and the others are unaffected',
  },
  'projection-warning': {
    by: 'outside-panda',
    detail:
      'a condition the projection run surfaced with no more specific reading than its own code; panda resolves none of it by itself',
  },
  // A COMMAND, and the same shape `retired-type` reached: the state is fully
  // resolvable and the thing that resolves it is a verb the binary dispatches.
  // Naming the removal here is also what keeps the report and the capability one
  // answer -- the verb re-runs the identical removal the interrupted one was
  // performing, so a leftover cannot be resolved by a second code path that
  // reasons differently from the first.
  'worktree-leftover': {
    by: 'command',
    command: 'panda workspace remove <id>',
    detail:
      'the removal is finished by running it again: the same checks, the same refusals, and the same retirement the interrupted one was performing. It removes only what panda holds a record for, and it still refuses a tree with modified or untracked files or one whose commit no ref contains -- resuming an interrupted removal is not a licence to skip the checks. Run it with no id to resolve every leftover in the project at once',
  },
}

/** Every kind this remediation is the named exit for. Derived, never listed. */
export function findingKindsFor(remediation: RemediationKind): DiagnosisFindingKind[] {
  return (Object.keys(FINDING_EXITS) as DiagnosisFindingKind[]).filter((kind) => {
    const exit = FINDING_EXITS[kind]
    return exit.by === 'remediation' && exit.remediations.includes(remediation)
  })
}

/**
 * The exit, as the sentence a user reads. Composed from {@link FINDING_EXITS} so
 * the command the product prints and the command the capability accepts are one
 * string, and a remediation renamed upstream renames itself here.
 */
function exitSentence(kind: DiagnosisFindingKind, command?: string): string {
  const exit = FINDING_EXITS[kind]
  if (exit.by === 'remediation') {
    return `To LEAVE this state, name it: ${exit.remediations
      .map((remediation) => `\`panda remediate ${remediation}\``)
      .join(' or ')}. ${exit.detail}`
  }
  // `command` is the SPELLING for this one finding, where the caller holds the
  // concrete values. `FINDING_EXITS` can only declare the shape of the exit --
  // `panda remove <type> <id>` -- and printing a placeholder at a finding that
  // already knows the type and the id makes the user translate a command panda
  // could have written out. `unprojectable` still prints the template, because
  // its rows carry an entry id and no type; `retired-type` carries both.
  if (exit.by === 'command') return `To leave this state: \`${command ?? exit.command}\`. ${exit.detail}`
  return `Panda cannot leave this state itself. ${exit.detail}`
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
  // A PROBLEM, and the `unprojectable` test is what earns it: the light CAN be
  // got back to green, by installing the build the document was already written
  // for. It also names a condition OF THIS MACHINE — an older panda in front of
  // a newer document — rather than a standing architectural fact, so it fires on
  // approximately no runs instead of on every one (spec M4.A's test, passed).
  'registry-version-ahead': 'problem',
  // A PROBLEM rather than info, and the exit code is again the reason. The test
  // is whether a user can get the light back to green: `unprojectable` is info
  // because no target can express the entry and deleting one the user
  // deliberately registered is not a fix. Here one command clears it
  // for good, and the entry is one no current build can create — leaving it
  // silent would hide the single visible consequence of an upgrade.
  'retired-type': 'problem',
  'ledger-damaged': 'problem',
  'projection-warning': 'problem',
  'out-of-date': 'problem',
  'not-writable': 'problem',
  // The one INFO kind, and the exit code is the whole reason: no target can
  // express the entry — a `skill` reaching a config target, a `skill` at project
  // scope, an `mcp-server` with no command — so the only way exit 1 here could
  // be got back to 0 is DELETING an entry the user deliberately registered,
  // which is not a fix. Reported in full, never counted as diagnosed. (Story
  // M4.D gave the kind a real exit, `panda remove`; that changes how it is LEFT,
  // not whether having it is wrong.)
  unprojectable: 'info',
  'target-failed': 'problem',
  // A PROBLEM, and the Codex case is why: a `# BEGIN panda-managed` block puts
  // foreign sub-keys inside `[tools]` and `[skills]`, so a documented
  // `--strict-config` run fails to load the user's ENTIRE config.toml. It is
  // also fully resolvable, which is what earns a non-zero exit — the exit code
  // is a promise that the light can be got back to green.
  'legacy-block': 'problem',
  // A PROBLEM: a half-removed worktree is a real state of panda's own store,
  // and one command clears it for good. The `unprojectable` test applies and
  // passes — the light CAN be got back to green — so silence here would hide
  // the one visible consequence of a run that was killed.
  'worktree-leftover': 'problem',
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

/**
 * How a failed registry read is read, keyed on the store's own CODE — never on
 * its message text (AD-7). Every code the store can raise that is NOT listed
 * here is a document panda could not read, which is what the fallback says.
 */
const REGISTRY_ERROR_KIND: Partial<Record<PandaErrorCode, DiagnosisFindingKind>> = {
  [PANDA_ERROR_CODES.registryStoreVersionMismatch]: 'registry-version-ahead',
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
  /**
   * Panda's own prior output found in a vendor file (correction-01 C6). Every
   * row here was produced by the `discard` remediation under INSPECTION, so the
   * sentence reported is the sentence that remediation acts on.
   */
  readonly legacy: readonly LegacyBlock[]
  readonly skipped: readonly SkippedExecutor[]
  readonly warnings: readonly ProjectionWarning[]
  /** Empty means clean. `severity: 'problem'` is what a non-zero exit answers for. */
  readonly findings: readonly DiagnosisFinding[]
}

/**
 * One interrupted worktree removal, as the caller who found it describes it.
 *
 * A STRUCTURAL shape, deliberately: `@skanl/panda-environment` may not import the
 * worktree implementation, and the one type both sides would otherwise share
 * would have to live in `@skanl/panda-contracts` — a third-party port surface, for a
 * detail of one provider's own store. The caller holds the capability that
 * discovers these; this file only phrases them.
 */
export interface WorktreeLeftover {
  /** The workspace id, e.g. `w-3`. It is what the exit command takes. */
  readonly id: string
  /** The tree the interrupted removal was working on. */
  readonly path: string
  /** What the capability found, in its own words. */
  readonly detail: string
}

export interface DiagnoseOptions {
  /** Defaults to the OS home directory. */
  readonly homeDir?: string
  /** Read only for the project scope, where it defaults to `process.cwd()`. */
  readonly projectDir?: string
  /** Defaults to `'machine'`, mirroring `panda init`. */
  readonly scope?: 'machine' | 'project'
  /**
   * Interrupted worktree removals the caller already found (spec M16.A, D4).
   *
   * Supplied rather than discovered, for the reason `WorktreeLeftover` gives.
   * Absent means the caller did not look — which is NOT the same as "there are
   * none", so nothing here reports an empty list as a clean bill of health; a
   * caller that did look and found nothing simply produces no findings, exactly
   * as it would for any other row.
   */
  readonly worktreeLeftovers?: readonly WorktreeLeftover[]
}

/** True when at least one finding is something wrong — the non-zero condition. */
export function hasProblem(diagnosis: Diagnosis): boolean {
  return diagnosis.findings.some((found) => found.severity === 'problem')
}

function finding(
  kind: DiagnosisFindingKind,
  detail: string,
  about: Omit<DiagnosisFinding, 'kind' | 'severity' | 'detail' | 'resolution'> = {},
  /** The concrete spelling of a `by: 'command'` exit; see {@link exitSentence}. */
  command?: string,
): DiagnosisFinding {
  // Two halves, always: what PROJECTING again would do (which for five kinds is
  // "nothing, forever"), and how to LEAVE the state. Shipping only the first is
  // what made this command tell users four remediable states were terminal.
  return {
    kind,
    severity: SEVERITY[kind],
    ...about,
    detail,
    resolution: `${RESOLUTION[kind]} — ${exitSentence(kind, command)}`,
  }
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
  retired: readonly RetiredEntry[],
  worktreeLeftovers: readonly WorktreeLeftover[],
): Promise<DiagnosisFinding[]> {
  const findings: DiagnosisFinding[] = []
  if (registryError !== undefined) {
    findings.push(
      finding(
        REGISTRY_ERROR_KIND[registryError.code] ?? 'registry-unreadable',
        `${registryError.code}: ${registryError.message}`,
        { filePath: diagnosis.registryPath },
      ),
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
  for (const row of retired) {
    // Both halves come from the ROW, never from the scope being diagnosed: the
    // verb is the grammar that reaches the document the entry is actually in,
    // and `filePath` is that document. `panda project doctor` reads the global
    // registry too, so deriving either from `diagnosis.scope` printed
    // `panda project remove <id>` for a global entry -- a command that exits 1,
    // against a project document that does not hold it. The two spellings are
    // separate literals so the printed-command invariant sees a real verb in
    // each, and the concrete command goes to the EXIT sentence rather than into
    // this detail, so the rendered line states the fact once and the command once.
    const { entry } = row
    const removeCommand =
      row.scope === 'global'
        ? `panda remove ${entry.type} ${entry.id}`
        : `panda project remove ${entry.type} ${entry.id}`
    findings.push(
      finding(
        'retired-type',
        `'${entry.id}' is a '${entry.type}' entry in the ${row.scope} registry, and '${entry.type}' is a type panda no longer declares (it has ${REGISTRY_ENTRY_TYPES.join(', ')}); no target will ever take it`,
        { filePath: row.registryPath, entryId: entry.id },
        removeCommand,
      ),
    )
  }
  for (const leftover of worktreeLeftovers) {
    // The command is SPELLED OUT with this leftover's own id rather than left as
    // the `<id>` template the exit declares, for the reason `retired-type`'s
    // block gives: a finding that already knows the id makes the user translate
    // a command panda could have written out.
    findings.push(
      finding(
        'worktree-leftover',
        leftover.detail,
        { filePath: leftover.path },
        `panda workspace remove ${leftover.id}`,
      ),
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
  for (const block of diagnosis.legacy) {
    findings.push(
      finding('legacy-block', block.detail, {
        executorId: block.executorId,
        filePath: block.filePath,
      }),
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
  const { homeDir = homedir(), projectDir, scope = 'machine', worktreeLeftovers = [] } = options
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
    legacy: report.legacy,
    skipped: report.skipped,
    warnings: report.warnings,
  }
  return {
    ...body,
    findings: await findingsFor(body, report.registryError, report.retired, worktreeLeftovers),
  }
}
