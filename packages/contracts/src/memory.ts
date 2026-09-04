import { PandaError, PANDA_ERROR_CODES } from './errors.ts'
import { defineStandardSchema } from './standard-schema.ts'
import type { StandardSchemaIssue, StandardSchemaResult, StandardSchemaV1 } from './standard-schema.ts'
import { isNonEmptyString, isRecord, issue } from './validation.ts'

/**
 * The MemoryProvider port (FR-15), under RD-1.
 *
 * RD-1 is the whole shape of this file and is not negotiable here:
 * - writes are APPEND-ONLY with MANDATORY provenance — writer agent id,
 *   workspace id and timestamp, all three, always;
 * - supersession is by APPEND with temporal marking, never deletion;
 * - destructive overwrite is NOT REPRESENTABLE, and the overwrite-shaped
 *   operation the port names exists only to refuse with a coded error;
 * - there is no conflict-resolution policy beyond temporal supersession.
 *   Semantic merging is deferred by RD-1 by name and appears here in no form.
 *
 * And the port stays as dumb as FR-15 permits (D7): no transactions, no query
 * language, no indexes as contract surface, no streaming, no migration. Entry
 * payloads are opaque to the port — it stores and returns the bytes and never
 * interprets their structure.
 */

/** The format version this build writes and the ONLY one it will read. */
export const MEMORY_FORMAT_VERSION = 1

/**
 * RD-1's mandatory provenance. Caller-supplied, all three, on every write — the
 * timestamp included, so a caller replaying a log can preserve when a thing was
 * actually learned rather than when it was imported.
 *
 * `recordedAt` is the CANONICAL ISO-8601 UTC form, the one
 * `new Date().toISOString()` produces. The canonical form is required rather
 * than merely parseable, and the reason is FR-16: two providers with different
 * storage engines must round-trip the same bytes and order by the same
 * comparison, and canonical ISO-8601 sorts lexicographically the way it sorts
 * chronologically. A parseable-but-arbitrary string does neither.
 */
export interface MemoryProvenance {
  readonly agentId: string
  readonly workspaceId: string
  readonly recordedAt: string
}

/**
 * One stored entry. `sequence` is the store's append counter, 1-based and
 * strictly increasing: it is what makes timeline ordering DETERMINISTIC rather
 * than dependent on a timestamp two writes can share.
 *
 * `supersedes` is the temporal marking RD-1 asks for. It points BACKWARD, from
 * the new entry to the one it replaces, because that is the direction an
 * append-only log can write: the superseded entry is never touched again, and
 * it stays readable forever. There is deliberately no `supersededBy` on the
 * older entry — writing one would be the destructive update this port refuses.
 */
export interface MemoryEntry {
  readonly id: string
  readonly sequence: number
  readonly payload: string
  readonly provenance: MemoryProvenance
  readonly supersedes?: string
}

export interface MemorySaveRequest {
  readonly payload: string
  readonly provenance: MemoryProvenance
  /** The id of an entry already in this store that this write replaces. */
  readonly supersedes?: string
}

/**
 * The whole query surface, and deliberately not a query language (D7). Every
 * field is an AND-ed equality filter except `contains`, which is an exact,
 * case-SENSITIVE substring test over the opaque payload — exact because two
 * storage engines must agree, and SQL's `LIKE` and JavaScript's `includes`
 * disagree about case out of the box.
 *
 * An omitted field filters nothing. An empty query matches every entry.
 */
export interface MemorySearchQuery {
  readonly workspaceId?: string
  readonly agentId?: string
  readonly contains?: string
}

/**
 * A typed result, never `undefined` and never an error, for a search that
 * matched nothing (AD-5, E6): `{ entries: [], matched: 0 }`.
 */
export interface MemorySearchResult {
  readonly entries: readonly MemoryEntry[]
  readonly matched: number
}

/** Every entry in the store, ordered by `sequence` ascending. Empty is empty (E12). */
export interface MemoryTimeline {
  readonly entries: readonly MemoryEntry[]
}

/**
 * FR-15's lifecycle metadata: what this store IS, rather than what it holds.
 * `firstWriteAt`/`lastWriteAt` are the extremes of the stored `recordedAt`
 * values and are ABSENT — not empty strings, not epoch zero — on an empty
 * store, because an empty store has no first write and saying otherwise would
 * hand a caller a measurement that was never taken (AD-5).
 */
export interface MemoryStoreInfo {
  readonly formatVersion: number
  readonly entryCount: number
  readonly firstWriteAt?: string
  readonly lastWriteAt?: string
}

/**
 * The port. Four operations from FR-15 — save, search, timeline listing and
 * lifecycle metadata — plus the two the shape of an append-only store forces:
 * the overwrite that always refuses, and disposal.
 *
 * After `dispose()`, every operation raises `PANDA_CONTRACT_PROVIDER_DISPOSED`,
 * the same code and the same rule as `WorkspaceProvider` — `overwrite()`
 * included, and the disposal check runs FIRST, so a dead provider reports that
 * it is dead rather than lecturing the caller about append-only writes.
 * `dispose()` itself is idempotent and never destroys stored state: a memory
 * store outlives the process that wrote it, which is the entire point of E8's
 * reopen.
 */
export interface MemoryProvider {
  /** Appends one entry. Never modifies an existing one. */
  save(request: MemorySaveRequest): Promise<MemoryEntry>
  search(query: MemorySearchQuery): Promise<MemorySearchResult>
  timeline(): Promise<MemoryTimeline>
  describe(): Promise<MemoryStoreInfo>
  /**
   * ALWAYS rejects, with `PANDA_CONTRACT_MEMORY_OVERWRITE_UNSUPPORTED`, having
   * changed nothing. It is on the port so RD-1's prohibition has a coded door
   * rather than an absent method, and so both shipped providers refuse
   * identically. `Promise<never>` says the same thing to the type checker.
   *
   * It takes NO replacement value, deliberately: there is no code path that
   * could ever read one, and a parameter that exists only to be ignored is a
   * place a future edit starts using. The attempt is the CALL; the refusal
   * names the append that does what the caller wanted.
   */
  overwrite(entryId: string): Promise<never>
  dispose(): Promise<void>
}

function throwSaveInvalid(issues: readonly StandardSchemaIssue[]): never {
  throw new PandaError(
    PANDA_ERROR_CODES.contractMemorySaveInvalid,
    `memory save request is not admissible: ${issues.map((entry) => entry.message).join('; ')}`,
  )
}

/**
 * The canonical UTC instant test. `Date.parse` accepts a great deal that is not
 * ISO-8601 and normalises silently; this round-trips instead, so the only
 * accepted spelling is the one every provider will store and return verbatim.
 */
function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const parsed = new Date(value)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value
}

/**
 * Non-throwing issue collector, the shape `workspaceHandleIssues` established.
 * Every message NAMES the offending field, because E2 asks the refusal to say
 * which one is missing and a caller reading "invalid provenance" learns nothing.
 */
export function memorySaveRequestIssues(value: unknown): StandardSchemaIssue[] {
  if (!isRecord(value)) return [issue('save request must be an object')]
  const issues: StandardSchemaIssue[] = []
  // Opaque to the port, but a string: the port stores bytes and never inspects
  // their structure. An empty payload is legal — "nothing happened" is a fact.
  if (typeof value['payload'] !== 'string') issues.push(issue("'payload' must be a string"))
  const provenance = value['provenance']
  if (!isRecord(provenance)) {
    issues.push(issue("'provenance' must be an object carrying agentId, workspaceId and recordedAt"))
    return issues
  }
  if (!isNonEmptyString(provenance['agentId'])) {
    issues.push(issue("'provenance.agentId' must be a non-empty string"))
  }
  if (!isNonEmptyString(provenance['workspaceId'])) {
    issues.push(issue("'provenance.workspaceId' must be a non-empty string"))
  }
  if (!isCanonicalTimestamp(provenance['recordedAt'])) {
    issues.push(
      issue("'provenance.recordedAt' must be a canonical ISO-8601 UTC timestamp, as new Date().toISOString() produces"),
    )
  }
  const supersedes = value['supersedes']
  if (supersedes !== undefined && !isNonEmptyString(supersedes)) {
    issues.push(issue("'supersedes', when present, must be a non-empty entry id"))
  }
  return issues
}

/** Programmatic validation: raises `PANDA_CONTRACT_MEMORY_SAVE_INVALID` on violations. */
export function validateMemorySaveRequest(value: unknown): MemorySaveRequest {
  const issues = memorySaveRequestIssues(value)
  if (issues.length > 0) throwSaveInvalid(issues)
  return value as MemorySaveRequest
}

export function memoryEntryIssues(value: unknown): StandardSchemaIssue[] {
  if (!isRecord(value)) return [issue('memory entry must be an object')]
  const issues: StandardSchemaIssue[] = []
  if (!isNonEmptyString(value['id'])) issues.push(issue("'id' must be a non-empty string"))
  const sequence = value['sequence']
  if (typeof sequence !== 'number' || !Number.isInteger(sequence) || sequence < 1) {
    issues.push(issue("'sequence' must be an integer >= 1"))
  }
  issues.push(...memorySaveRequestIssues(value))
  return issues
}

export const MEMORY_ENTRY_SCHEMA: StandardSchemaV1<MemoryEntry> = defineStandardSchema(
  (value): StandardSchemaResult<MemoryEntry> => {
    const issues = memoryEntryIssues(value)
    return issues.length > 0 ? { issues } : { value: value as MemoryEntry }
  },
)

/**
 * The one refusal both providers raise, built once so they cannot drift apart.
 * FR-16 asks for identical behaviour envelopes; two hand-written throws with the
 * same code and different wording is where "identical" starts to erode.
 */
export function memoryOverwriteUnsupported(entryId: string): PandaError {
  return new PandaError(
    PANDA_ERROR_CODES.contractMemoryOverwriteUnsupported,
    `memory is append-only (RD-1): entry '${String(entryId)}' cannot be overwritten. Append a superseding entry with supersedes: '${String(entryId)}' instead`,
  )
}

/** The version refusal, likewise shared so both providers name both versions alike. */
export function memoryStoreVersionMismatch(location: string, found: unknown): PandaError {
  return new PandaError(
    PANDA_ERROR_CODES.contractMemoryStoreVersionMismatch,
    `memory store '${location}' has format version ${JSON.stringify(found)} but this build reads only ${MEMORY_FORMAT_VERSION}`,
  )
}
