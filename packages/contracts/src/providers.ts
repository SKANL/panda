import type { RegistryEntry } from './registry.ts'
import type { StandardSchemaV1 } from './standard-schema.ts'

// Provider-side ports (FR-13b/FR-13c): the supported seam for third parties to
// contribute catalog entries without driving `RegistryStore` imperatively and
// re-deriving change detection themselves. Implementing either port only ever
// requires installing @panda/contracts.
//
// Each port is deliberately narrow to ONE family of entry types: a ToolProvider
// contributes executables (`tool` | `mcp-server`), a SkillSource contributes
// skills (`skill`). The driver rejects an out-of-family contribution instead of
// silently accepting it, so an origin's declared responsibility and what it can
// actually write to the registry never drift apart.

/**
 * Reserved `extensions` key carrying panda's per-origin source-tracking state.
 *
 * It lives under `extensions` — never at the entry root — because the canonical
 * envelope rejects unknown root keys and the projection renderer reads only
 * known root fields. Recording tracking state here therefore needs no envelope
 * change, no extra persistence, and cannot leak a content hash into a projected
 * executor config.
 */
export const PANDA_SOURCE_EXTENSION_KEY = 'panda.source'

/**
 * Value stored under {@link PANDA_SOURCE_EXTENSION_KEY} on an ingested entry.
 *
 * `sourceId` is what makes an entry OWNED: a later run refuses to overwrite an
 * entry whose recorded owner is a different origin, so "never last-write-wins"
 * holds across runs and not merely within one. `contentHash` is absent for
 * ports that report no change token (a ToolProvider).
 */
export interface SourceTracking {
  readonly sourceId: string
  /** The origin's own opaque change token; panda compares it and nothing else. */
  readonly contentHash?: string
}

/** A skill contribution paired with the origin's opaque change token. */
export interface SourcedSkill {
  readonly entry: RegistryEntry
  /**
   * Opaque change token owned by the ORIGIN — file mtime+size, git blob sha,
   * HTTP ETag, anything. panda never computes or interprets it, it only
   * compares it against the token recorded on the stored entry, so an unchanged
   * source produces no store write and therefore a byte-identical projection.
   */
  readonly contentHash: string
}

/** What every origin declares, whichever port it implements. */
export interface IngestOrigin {
  /** Identifies this origin in every ingest error, warning and outcome row. */
  readonly sourceId: string
  /**
   * Optional Standard Schema v1 applied to each contributed ENTRY in addition
   * to the canonical envelope, so an origin can tighten its own contract
   * (required extensions payload, id shape) without panda knowing the medium.
   *
   * Only the issues are consulted; a returned `value` is DELIBERATELY discarded.
   * Adopting a transformed value would let an origin rewrite the entry after
   * envelope validation and land unvalidated content in the store.
   */
  readonly entrySchema?: StandardSchemaV1
}

/** Contributes `tool` and `mcp-server` entries. */
export interface ToolProvider extends IngestOrigin {
  list(): Promise<readonly RegistryEntry[]> | readonly RegistryEntry[]
}

/**
 * Contributes `skill` entries, each carrying its own change token.
 *
 * Ingestion is purely ADDITIVE: entries an origin stops listing are left in the
 * registry untouched. Reconciliation/pruning is a separate decision and is not
 * part of this story.
 */
export interface SkillSource extends IngestOrigin {
  list(): Promise<readonly SourcedSkill[]> | readonly SourcedSkill[]
}

export type IngestWarningKind = 'empty-source'

export interface IngestWarning {
  readonly kind: IngestWarningKind
  readonly sourceId: string
  readonly detail: string
}

export interface IngestOutcome {
  /**
   * Entries written to the store in this run, as OPAQUE display keys. The
   * `<type>:<id>` shape is for humans and log lines only — ids may contain a
   * colon, so nothing may parse these back apart.
   */
  readonly registered: readonly string[]
  /** Opaque display keys skipped because the origin reported an unchanged hash. */
  readonly unchanged: readonly string[]
  /**
   * Non-fatal observations. An origin that legitimately contributes nothing is
   * reported here rather than passing as silent success — the caller can tell a
   * working-but-empty source apart from one that was never consulted.
   */
  readonly warnings: readonly IngestWarning[]
}
