import type { PandaError, PandaErrorCode } from './errors.ts'
import type { RegistryEntry, RegistryEntryType } from './registry.ts'

// Native projection vocabulary (correction-01). Panda's registry vocabulary is
// the INPUT of a projection and never its output: a target renders each entry
// in the EXECUTOR's own schema, at the location that executor actually reads.
// That is why nothing here describes a panda namespace, a reserved key or a
// marker — a marker inside a vendor structure has nowhere to live in a JSON
// array or a directory tree, and a vendor running its strictest validation
// rejects it as an unknown field, taking the user's whole config down with it.
//
// Ownership therefore lives in a durable panda-side LEDGER (AD-6): a record
// written at creation, never inferred from the file. The ledger is also
// strictly more informative than a marker could be, because comparing it
// against disk separates "the user edited this" from "the user deleted this"
// from "panda never wrote this" — distinctions a marker's presence or absence
// cannot express.

/**
 * An MCP server reduced to the fields EVERY vendor schema can express. Each
 * target maps this into its own vocabulary (`args` array vs. argv-joined
 * `command`); nothing outside a target ever sees a vendor's field names.
 */
export interface ProjectionMcpEntry {
  readonly id: string
  readonly command: string
  readonly args: readonly string[]
}

export const PROJECTION_LEDGER_VERSION = 1

/**
 * One absolute path panda wrote, with a hash of the exact bytes it put there.
 *
 * This is what ownership becomes once a target materialises a DIRECTORY TREE
 * rather than a region of text: a tree has no "the text panda placed here" to
 * hash, so ownership is enumerated path by path. It is also the authority for
 * the first operation in which panda DELETES from a user's filesystem — panda
 * removes exactly these paths and only while each still hashes to what panda
 * wrote, so a file the user added beside them, or edited among them, is not
 * something panda can reach.
 */
export interface ProjectionOwnedPath {
  readonly path: string
  /**
   * Hash of the exact BYTES panda wrote. The only predicate allowed to
   * authorise a removal, because a false match precedes `rm`.
   */
  readonly contentHash: string
  /**
   * Hash of the same bytes with line endings normalised. Decides whether panda
   * may REFRESH its own tree — a distinction `contentHash` cannot make, and
   * without it `core.autocrlf` on a skills root kept in a dotfiles repository
   * flips every materialised file to `edited` permanently, with no adopt or
   * force path in the product to get back out of it.
   *
   * Optional so a record written before this field existed stays readable; its
   * absence falls back to `contentHash`, which is the conservative direction.
   */
  readonly canonicalHash?: string
}

/**
 * One entry panda wrote, at one native location, in one file. `contentHash`
 * hashes EXACTLY the text panda placed there — not the surrounding separators
 * — which is what lets a later run tell an untouched entry from an edited one
 * without parsing the vendor's document as a whole.
 *
 * For a MATERIALISATION target the same record describes a tree: `filePath` is
 * the ROOT the target owns, `nativeLocation` is the entry's root-relative
 * directory, `contentHash` covers the tree as a whole, and `ownedPaths`
 * enumerates every file. `ownedPaths` is what makes a record authority for a
 * removal — a record without it can never authorise deleting a path, which is
 * why the field is optional rather than a version bump: a ledger written by an
 * older build stays readable, and its records simply claim no paths.
 */
export interface ProjectionLedgerRecord {
  readonly targetId: string
  readonly filePath: string
  /** Vendor-native location, e.g. `mcpServers.context7`, `mcp_servers.context7`. */
  readonly nativeLocation: string
  readonly entryId: string
  readonly contentHash: string
  /** Materialisation only: every path panda wrote for this entry. */
  readonly ownedPaths?: readonly ProjectionOwnedPath[]
}

/**
 * The three ledger-versus-disk verdicts. All of them are REPORTED and none of
 * them is resolved by a PROJECTION: panda only ever overwrites content whose
 * hash still matches what panda itself last wrote. Leaving one of these states
 * is a decision, and a decision is a user's — see {@link REMEDIATION_KINDS}.
 *
 * A VALUE, not only a type, because the totality proof that every reportable
 * state has an exit needs to enumerate these at runtime rather than repeat them
 * in a list that can fall behind the union.
 */
export const DRIFT_KINDS = [
  /** In the ledger, present on disk, content changed since panda wrote it. */
  'edited',
  /** In the ledger, absent from disk: the user deleted it; never re-added. */
  'removed-by-user',
  /** Occupying the native location but absent from the ledger: not panda's. */
  'foreign-collision',
] as const

export type DriftKind = (typeof DRIFT_KINDS)[number]

export interface DriftEntry {
  readonly kind: DriftKind
  readonly entryId: string
  /** The vendor-native location the verdict is about. */
  readonly location: string
  readonly detail: string
}

/** A non-fatal condition a projection ran through, surfaced rather than thrown. */
export interface ProjectionWarning {
  readonly code: PandaErrorCode
  readonly detail: string
}

/**
 * An entry a target could not express, in the TARGET's own words (C5).
 *
 * `skippedEntryIds` carries ids alone, so every reason had to be re-derived by
 * the caller from the registry entry — accurate while the only skippable shapes
 * were "a kind no target projects" and "an mcp-server with no command", and
 * wrong the moment a target has a reason of its own ("this skill's `entryPath`
 * cannot be read"). A target that knows why says so here.
 */
export interface ProjectionSkip {
  readonly entryId: string
  readonly reason: string
}

export interface ProjectionMergeRequest {
  /** Registry entries grouped by kind, as consumed by the engine. */
  readonly entries: RegistryEntriesByKind
  /** The ledger records this target already owns in this file. */
  readonly records: readonly ProjectionLedgerRecord[]
  /** Current native text; '' when the file does not exist yet. */
  readonly nativeText: string
}

export interface ProjectionMergeOutcome {
  /** Merged native text, in the vendor's own vocabulary. */
  readonly text: string
  /** Ledger-versus-disk verdicts; every one of them left `text` alone. */
  readonly drift: readonly DriftEntry[]
  /** Entry ids present in the registry but not projected by this target. */
  readonly skippedEntryIds?: readonly string[]
  /**
   * The records that are true of `text`. They REPLACE this target's previous
   * records wholesale, so an entry panda stopped writing stops being claimed.
   */
  readonly records: readonly ProjectionLedgerRecord[]
  /**
   * Ascending, non-overlapping spans of `text` panda owns, each covering the
   * separator characters panda introduced along with the entry itself.
   * Verification surface: deleting every span from `text` removes exactly
   * what panda rendered in this run and nothing else. On a file panda never
   * wrote that leaves the native input byte for byte; over panda's own prior
   * output it leaves every foreign byte and no rendered entry. A run that
   * writes must report a non-empty span, or it has proven nothing.
   */
  readonly ownedSpans: readonly (readonly [number, number])[]
}

/**
 * Per-target strategy port (AD-9 contract home): declares which file it owns
 * and merges the registry's intent into the current native text. The
 * format-specific merge lives entirely behind this interface.
 */
export interface ProjectionConfigTarget {
  /** Optional so every target written before materialisation existed still fits. */
  readonly kind?: 'config'
  readonly targetId: string
  readonly filePath: string
  merge(request: ProjectionMergeRequest): ProjectionMergeOutcome | Promise<ProjectionMergeOutcome>
  /**
   * The ledger record that would claim whatever currently occupies one entry's
   * native location — the ADOPT half of the remediation vocabulary.
   *
   * Only the target knows where an entry lives in its own format and what "the
   * same entry" means there, and `contentHash` has to be computed exactly the
   * way {@link merge} computes it or the adopted claim would read as `edited`
   * on the very next run. So the record is built HERE, by the same code, rather
   * than reconstructed by a caller from the outside.
   *
   * OPTIONAL, and the absence is a refusal rather than a gap: a target that
   * cannot say what occupies its location gets no adoption, because claiming
   * bytes panda cannot identify is the one thing this vocabulary must not do.
   */
  claim?(request: ProjectionClaimRequest): ProjectionClaim
}

export interface ProjectionClaimRequest {
  /** Current native text; '' when the file does not exist. */
  readonly nativeText: string
  readonly entryId: string
}

/**
 * What a target found at one entry's native location.
 *
 * The three answers are distinct on purpose: `record` — claimable, and this is
 * the claim; `refusal` — occupied by something panda must not claim, with the
 * reason in the target's own words; neither — the location is FREE, so there is
 * nothing to adopt.
 */
export interface ProjectionClaim {
  /** Vendor-native location the answer is about, e.g. `mcpServers.context7`. */
  readonly location: string
  /** Bytes currently occupying the location; 0 when it is free. */
  readonly byteLength: number
  readonly record?: ProjectionLedgerRecord
  readonly refusal?: string
  /**
   * Absolute paths a LATER run would be allowed to overwrite and to REMOVE on
   * this claim's authority.
   *
   * Adoption writes no vendor byte, so this is not a list of what changes now —
   * it is the consequence, and it has to be in the description before the claim
   * is written because taking it is what makes those paths deletable. Absent for
   * a config claim, which authorises replacing a REGION inside a file and can
   * never remove the file itself.
   */
  readonly ownedPaths?: readonly string[]
  /**
   * True when the registry does NOT hold this entry, so the next ordinary run
   * would REMOVE what the claim covers rather than converge it. The sharpest
   * consequence adoption can have, and the one a user must be told before it is
   * taken.
   */
  readonly removedNext?: boolean
}

// --- Materialisation (correction-01 C4) -------------------------------------
//
// A skill in Claude Code, Codex and OpenCode is a DIRECTORY (`<root>/<id>/SKILL.md`),
// not a config entry, and "surgically merge a region of a text file" cannot
// express that. So the port grows a second kind whose unit is a tree.
//
// The split of labour is deliberate and is the whole safety argument: a
// materialisation target only ever DESCRIBES what the registry wants — which
// files, copied from which source paths — and never touches the filesystem
// destination. Every write, every delete, every ledger-versus-disk comparison
// happens in one place in the engine, because this is the first projection in
// which panda removes a user's files and a second implementation of that
// decision is exactly what must not exist.

/** One file panda will place, copied VERBATIM: panda never authors skill content. */
export interface ProjectionMaterialiseFile {
  /** Root-relative destination, POSIX-separated, always under the entry's own directory. */
  readonly relativePath: string
  /** Absolute path of the file whose bytes are copied. */
  readonly sourcePath: string
}

export interface ProjectionMaterialiseEntry {
  readonly entryId: string
  /** The entry's own root-relative directory; the unit ownership and removal use. */
  readonly location: string
  readonly files: readonly ProjectionMaterialiseFile[]
}

export interface ProjectionMaterialiseRequest {
  readonly entries: RegistryEntriesByKind
  /** The ledger records this target already owns under this root. */
  readonly records: readonly ProjectionLedgerRecord[]
  readonly rootPath: string
}

export interface ProjectionMaterialisePlan {
  /** What the registry wants on disk, in stable entry-id order. */
  readonly entries: readonly ProjectionMaterialiseEntry[]
  /**
   * EVERY entry id this target answers for, including the ones it could not
   * render. Removal authority comes from absence in the REGISTRY, never from
   * unrenderability: a skill whose source went missing must be reported, not
   * deleted from every executor.
   */
  readonly presentEntryIds: readonly string[]
  readonly skipped?: readonly ProjectionSkip[]
}

export interface ProjectionMaterialiseTarget {
  readonly kind: 'materialise'
  readonly targetId: string
  /** The directory ROOT this target owns; panda never removes the root itself. */
  readonly rootPath: string
  plan(
    request: ProjectionMaterialiseRequest,
  ): ProjectionMaterialisePlan | Promise<ProjectionMaterialisePlan>
}

export type ProjectionTarget = ProjectionConfigTarget | ProjectionMaterialiseTarget

/**
 * The single filesystem location a target owns — a vendor's file for a config
 * target, a directory root for a materialisation one. One spelling, so a
 * caller reporting "where panda writes for this executor" cannot answer the
 * question differently from the engine that keys ownership on it.
 */
export function projectionTargetLocation(target: ProjectionTarget): string {
  return target.kind === 'materialise' ? target.rootPath : target.filePath
}

export interface ProjectionResult {
  readonly targetId: string
  readonly written: boolean
  /** Absolute byte-length delta between the previous and next file contents. */
  readonly byteDelta: number
  readonly drift: readonly DriftEntry[]
  /** Entry ids present in the registry but not projected by this target. */
  readonly skippedEntryIds: readonly string[]
  /** The same ids with the target's OWN reason, where the target has one. */
  readonly skipped?: readonly ProjectionSkip[]
}

export interface ProjectionFailure {
  readonly targetId: string
  readonly error: PandaError
}

/** Registry entries grouped by kind, as projection consumes them. */
export type RegistryEntriesByKind = Readonly<Record<RegistryEntryType, readonly RegistryEntry[]>>

// --- Remediation (M4.C) -----------------------------------------------------
//
// Every verdict above is REPORTED and none is resolved by projecting again —
// that refusal is the guarantee the whole subsystem rests on and it is correct.
// What was wrong is that the refusal was TERMINAL: the only exit from `edited`,
// `removed-by-user` or `foreign-collision` was hand-editing the ownership
// ledger, which is the file every one of those guarantees is stored in.
//
// The vocabulary below is the exit. Four verbs, chosen against what each state
// actually needs rather than against what is easy to build:
//
//   adopt   — panda claims what is at its own location, exactly as it is now.
//             This is the ownership TRANSFER decision AD-6 always implied and
//             no story had taken: ownership is a durable record, so transferring
//             it is writing that record, never inferring one from the path.
//   release — panda stops claiming a location. The file is not read, not
//             written, not looked at.
//   repair  — panda rewrites its OWN ledger document to hold exactly the records
//             it can still read. Touches no vendor file, ever.
//   discard — panda removes its OWN prior output from a vendor file
//             (correction-01 C6): a `$.panda` key or a `# BEGIN panda-managed`
//             block a previous build wrote at a location no executor reads.
//
// THREE OF THE FOUR TOUCH NO USER FILE AT ALL. That is a deliberate design
// property, not an accident of scope: `adopt` and `release` change what panda
// CLAIMS and let the ordinary projection converge afterwards, so the one command
// a user reaches for while something is already wrong cannot lose a byte they
// wrote. `discard` is the single exception and the only bytes it can remove are
// panda's own vocabulary.
//
// WHAT IS DELIBERATELY NOT HERE: a verb that writes a registry entry's rendering
// straight into a vendor file. Panda already has one — `panda init` — and it
// refuses only because the ledger disagrees with the disk. Fixing the
// disagreement is `adopt`; a second renderer beside the merge is exactly the
// divergent code path correction-01 and `panda doctor` exist to not have.

export const REMEDIATION_KINDS = ['adopt', 'release', 'repair', 'discard'] as const

export type RemediationKind = (typeof REMEDIATION_KINDS)[number]

/**
 * One thing a remediation will change — or, under inspection, WOULD change.
 *
 * This is the description AND the act: the same value is produced by the same
 * call in both modes, so a preview cannot describe something other than what
 * lands. `byteDelta` is 0 for every ledger-only change, which is how a reader
 * sees at a glance that a remediation is not touching their file.
 */
export interface RemediationChange {
  /** Panda's own ownership record, or a file panda did not author. */
  readonly subject: 'ledger' | 'native-file'
  readonly action: 'claim' | 'unclaim' | 'rewrite'
  /** Absolute path of the file this change lands in. */
  readonly path: string
  /** Vendor-native location, or the ledger scope, the change is about. */
  readonly location: string
  /** Absolute byte-length delta of `path`; 0 for a ledger claim. */
  readonly byteDelta: number
  readonly detail: string
}

/**
 * A remediation panda will not perform, flattened to the two fields a caller
 * acts on. A live `Error` serialises to `{}` for every caller that prints this.
 */
export interface RemediationRefusal {
  readonly code: PandaErrorCode
  readonly message: string
}

export interface RemediationOutcome {
  readonly remediation: RemediationKind
  readonly targetId: string
  /** The entry the remediation is about; `''` where the verb has no entry. */
  readonly entryId: string
  /** The location the remediation is about — a native location or a file. */
  readonly location: string
  /**
   * Exactly what changed, or under inspection exactly what WOULD change.
   * Empty with no refusal means the state was already the one asked for.
   */
  readonly changes: readonly RemediationChange[]
  /** False under inspection, and false whenever `refusal` is set. */
  readonly applied: boolean
  /** Set when panda refused; `changes` is then what it declined to do, if anything. */
  readonly refusal?: RemediationRefusal
}
