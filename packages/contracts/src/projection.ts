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
 * One entry panda wrote, at one native location, in one file. `contentHash`
 * hashes EXACTLY the text panda placed there — not the surrounding separators
 * — which is what lets a later run tell an untouched entry from an edited one
 * without parsing the vendor's document as a whole.
 */
export interface ProjectionLedgerRecord {
  readonly targetId: string
  readonly filePath: string
  /** Vendor-native location, e.g. `mcpServers.context7`, `mcp_servers.context7`. */
  readonly nativeLocation: string
  readonly entryId: string
  readonly contentHash: string
}

/**
 * The three ledger-versus-disk verdicts. All of them are REPORTED and none of
 * them is resolved by writing: panda only ever overwrites content whose hash
 * still matches what panda itself last wrote.
 */
export type DriftKind =
  /** In the ledger, present on disk, content changed since panda wrote it. */
  | 'edited'
  /** In the ledger, absent from disk: the user deleted it; never re-added. */
  | 'removed-by-user'
  /** Occupying the native location but absent from the ledger: not panda's. */
  | 'foreign-collision'

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
export interface ProjectionTarget {
  readonly targetId: string
  readonly filePath: string
  merge(request: ProjectionMergeRequest): ProjectionMergeOutcome | Promise<ProjectionMergeOutcome>
}

export interface ProjectionResult {
  readonly targetId: string
  readonly written: boolean
  /** Absolute byte-length delta between the previous and next file contents. */
  readonly byteDelta: number
  readonly drift: readonly DriftEntry[]
  /** Entry ids present in the registry but not projected by this target. */
  readonly skippedEntryIds: readonly string[]
}

export interface ProjectionFailure {
  readonly targetId: string
  readonly error: PandaError
}

/** Registry entries grouped by kind, as projection consumes them. */
export type RegistryEntriesByKind = Readonly<Record<RegistryEntryType, readonly RegistryEntry[]>>
