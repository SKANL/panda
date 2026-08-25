import { PANDA_ERROR_CODES, PANDA_SOURCE_EXTENSION_KEY, PandaError, validateRegistryEntry } from '@panda/contracts'
import { isNonEmptyString, isRecord } from '@panda/contracts/validation'
import type {
  IngestOrigin,
  IngestOutcome,
  IngestWarning,
  RegistryEntry,
  RegistryEntryType,
  SkillSource,
  SourceTracking,
  SourcedSkill,
  ToolProvider,
} from '@panda/contracts'
import type { RegistryStore } from './store.ts'

// Provider ingestion (FR-13b/FR-13c): the ONE driver behind the ToolProvider
// and SkillSource ports.
//
// The run is strictly TWO-PHASE — collect and validate EVERY contribution from
// EVERY origin first, then write. What that buys is precise: no VALIDATION
// rejection ever reaches the store. A bad envelope, a wrong entry type for the
// port, a forged ownership stamp, an id collision, a failing list() — every one
// of them is raised before the first register() call, so the store is untouched.
//
// It does NOT make phase 2 atomic. Phase 2 is N separate lock-protected writes
// and RegistryStore.register() throws routinely: contention, EPERM on the
// Windows rename retry, registryInactive on a concurrent dispose. A store-level
// I/O failure mid-write therefore leaves whatever already landed. That is
// REPORTED, never rolled back — a compensating remove() loop runs against the
// same failing store and turns one partial write into an unbounded mess. The
// thrown IngestWriteFailure carries the partial outcome instead.
//
// Ownership: every ingested entry records the contributing `sourceId`. A later
// run refuses to overwrite an entry owned by a DIFFERENT origin — or owned by
// nobody, i.e. hand-registered — so "never last-write-wins" holds ACROSS runs
// and not merely within one. Change detection is the origin's business: a
// SkillSource reports an opaque contentHash, panda compares it against the one
// recorded on the stored entry and re-registers only on a difference, so an
// unchanged source produces no store write.

// Provider catalogs are machine-wide, and global is the only scope that needs
// no project directory. Not configurable: the port contract says nothing about
// scopes, and a knob here would silently split one origin's catalog in two.
const INGEST_SCOPE = 'global'

const TOOL_PROVIDER_TYPES: readonly RegistryEntryType[] = ['tool', 'mcp-server']
const SKILL_SOURCE_TYPES: readonly RegistryEntryType[] = ['skill']

export interface IngestProvidersOptions {
  readonly toolProviders?: readonly ToolProvider[]
  readonly skillSources?: readonly SkillSource[]
}

/** Raised when a phase-2 store write fails, carrying what already landed. */
export class IngestWriteFailure extends PandaError {
  /** Keys registered before the failure, plus every warning phase 1 collected. */
  readonly partial: IngestOutcome

  constructor(message: string, partial: IngestOutcome, cause: unknown) {
    // The store's own code is the accurate one (contention, inactive, ...);
    // STORE_UNAVAILABLE is the fallback for a non-PandaError cause.
    super(
      cause instanceof PandaError ? cause.code : PANDA_ERROR_CODES.registryStoreUnavailable,
      message,
      { cause },
    )
    this.name = 'IngestWriteFailure'
    this.partial = partial
  }
}

/** A validated contribution held in memory until the whole run has passed. */
interface Contribution {
  readonly key: string
  readonly sourceId: string
  /** Ready to write: source tracking already stamped in. */
  readonly entry: RegistryEntry
  readonly changed: boolean
}

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function rejected(sourceId: string, entryId: string, detail: string, cause?: unknown): PandaError {
  return new PandaError(
    PANDA_ERROR_CODES.registryProviderRejected,
    `origin '${sourceId}' contributed a rejected entry '${entryId}': ${detail}`,
    { cause },
  )
}

function conflict(detail: string): PandaError {
  return new PandaError(PANDA_ERROR_CODES.registryOriginConflict, detail)
}

/** Opaque display key; never parsed back apart (ids may contain a colon). */
function displayKey(entry: Pick<RegistryEntry, 'type' | 'id'>): string {
  return `${entry.type}:${entry.id}`
}

// A rejection must name the offending entry even when the payload is too
// malformed to have a usable id — capped, the string is provider-supplied.
function describeId(candidate: unknown): string {
  return isRecord(candidate) && isNonEmptyString(candidate['id'])
    ? candidate['id'].slice(0, 200)
    : '<unknown>'
}

async function listOrigin<T>(
  origin: IngestOrigin & { list(): Promise<readonly T[]> | readonly T[] },
): Promise<readonly T[]> {
  let listed: readonly T[]
  try {
    listed = await origin.list()
  } catch (error) {
    throw new PandaError(
      PANDA_ERROR_CODES.registryProviderRejected,
      `origin '${origin.sourceId}' failed while listing its contributions: ${detailOf(error)}`,
      { cause: error },
    )
  }
  if (!Array.isArray(listed)) {
    throw new PandaError(
      PANDA_ERROR_CODES.registryProviderRejected,
      `origin '${origin.sourceId}' failed while listing its contributions: list() did not resolve to an array`,
    )
  }
  // Snapshot: the collect loop awaits, and an origin mutating the array it just
  // handed us would make the driver skip or double-process entries.
  return [...listed]
}

async function applyOriginSchema(origin: IngestOrigin, entry: RegistryEntry): Promise<void> {
  if (origin.entrySchema === undefined) return
  const standard: unknown = origin.entrySchema['~standard']
  if (!isRecord(standard) || standard['version'] !== 1 || typeof standard['validate'] !== 'function') {
    throw rejected(
      origin.sourceId,
      entry.id,
      "entrySchema is not a Standard Schema v1 (expected '~standard.version' 1)",
    )
  }
  let result: unknown
  try {
    result = await (standard['validate'] as (value: unknown) => unknown)(entry)
  } catch (error) {
    // A third-party schema that throws must still fail the coded way.
    throw rejected(origin.sourceId, entry.id, `origin schema threw: ${detailOf(error)}`, error)
  }
  if (!isRecord(result)) {
    throw rejected(origin.sourceId, entry.id, 'origin schema returned no Standard Schema result')
  }
  // `result.value` is deliberately ignored — see IngestOrigin.entrySchema.
  const issues = result['issues']
  if (issues === undefined) return
  const messages = Array.isArray(issues)
    ? issues
        .map((candidate) =>
          isRecord(candidate) && typeof candidate['message'] === 'string' ? candidate['message'] : '',
        )
        .filter((message) => message !== '')
    : []
  throw rejected(
    origin.sourceId,
    entry.id,
    `origin schema: ${messages.length === 0 ? 'rejected without stating an issue' : messages.join('; ')}`,
  )
}

async function validateContribution(
  origin: IngestOrigin,
  candidate: unknown,
  allowedTypes: readonly RegistryEntryType[],
): Promise<RegistryEntry> {
  // Deep copy at the trust boundary: validateRegistryEntry returns the SAME
  // object, phase 2 writes it after every other origin's awaits, and a provider
  // holding the reference could otherwise mutate it in between.
  let snapshot: unknown
  try {
    snapshot = structuredClone(candidate)
  } catch (error) {
    throw rejected(
      origin.sourceId,
      describeId(candidate),
      `entry is not structurally cloneable: ${detailOf(error)}`,
      error,
    )
  }
  let entry: RegistryEntry
  try {
    entry = validateRegistryEntry(snapshot)
  } catch (error) {
    throw rejected(origin.sourceId, describeId(snapshot), detailOf(error), error)
  }
  if (!allowedTypes.includes(entry.type)) {
    throw rejected(
      origin.sourceId,
      entry.id,
      `type '${entry.type}' is not contributable through this port (expected ${allowedTypes.join(' or ')})`,
    )
  }
  if (entry.extensions !== undefined && Object.hasOwn(entry.extensions, PANDA_SOURCE_EXTENSION_KEY)) {
    // Without this an origin forges an ownership stamp and the cross-run
    // ownership check below is decorative.
    throw rejected(
      origin.sourceId,
      entry.id,
      `'extensions.${PANDA_SOURCE_EXTENSION_KEY}' is reserved for panda's own source tracking`,
    )
  }
  await applyOriginSchema(origin, entry)
  return entry
}

function storedTracking(entry: RegistryEntry | undefined): SourceTracking | undefined {
  const tracking = entry?.extensions?.[PANDA_SOURCE_EXTENSION_KEY]
  if (!isRecord(tracking) || !isNonEmptyString(tracking['sourceId'])) return undefined
  const contentHash = tracking['contentHash']
  return typeof contentHash === 'string'
    ? { sourceId: tracking['sourceId'], contentHash }
    : { sourceId: tracking['sourceId'] }
}

/**
 * Ownership gate + change detection, read at the scope this run WRITES to. The
 * merged view would let an entry shadowing from another scope hide a stale
 * target-scope entry forever. Returns whether the entry needs a write.
 */
async function resolveChange(
  store: RegistryStore,
  origin: IngestOrigin,
  entry: RegistryEntry,
  contentHash: string | undefined,
): Promise<boolean> {
  const key = displayKey(entry)
  const stored = await store.get(entry.type, entry.id, INGEST_SCOPE)
  if (stored === undefined) return true
  const tracking = storedTracking(stored)
  if (tracking === undefined) {
    throw conflict(
      `entry '${key}' already exists in the ${INGEST_SCOPE} registry and was not contributed by an origin; origin '${origin.sourceId}' will not overwrite it`,
    )
  }
  if (tracking.sourceId !== origin.sourceId) {
    // Reported even when the hashes match: calling a handover 'unchanged' would
    // silently keep the previous origin's entry on disk forever.
    throw conflict(
      `entry '${key}' is owned by origin '${tracking.sourceId}' and cannot be taken over by origin '${origin.sourceId}'`,
    )
  }
  return contentHash === undefined || tracking.contentHash !== contentHash
}

function withSourceTracking(entry: RegistryEntry, sourceId: string, contentHash?: string): RegistryEntry {
  const tracking: SourceTracking = contentHash === undefined ? { sourceId } : { sourceId, contentHash }
  return { ...entry, extensions: { ...entry.extensions, [PANDA_SOURCE_EXTENSION_KEY]: tracking } }
}

function claim(collected: Map<string, Contribution>, contribution: Contribution): void {
  const existing = collected.get(contribution.key)
  if (existing === undefined) {
    collected.set(contribution.key, contribution)
    return
  }
  // Last-write-wins would make the catalog depend on origin ordering and
  // silently hide one origin's work, so a collision is always fatal.
  throw conflict(
    existing.sourceId === contribution.sourceId
      ? `entry '${contribution.key}' is contributed twice by origin '${contribution.sourceId}'`
      : `entry '${contribution.key}' is contributed by both origin '${existing.sourceId}' and origin '${contribution.sourceId}'`,
  )
}

async function collectContribution(
  store: RegistryStore,
  collected: Map<string, Contribution>,
  origin: IngestOrigin,
  candidate: unknown,
  allowedTypes: readonly RegistryEntryType[],
  contentHash?: string,
): Promise<void> {
  const entry = await validateContribution(origin, candidate, allowedTypes)
  claim(collected, {
    key: displayKey(entry),
    sourceId: origin.sourceId,
    entry: withSourceTracking(entry, origin.sourceId, contentHash),
    changed: await resolveChange(store, origin, entry, contentHash),
  })
}

function emptySource(sourceId: string): IngestWarning {
  return { kind: 'empty-source', sourceId, detail: `origin '${sourceId}' contributed no entries` }
}

/**
 * Drives every configured origin into the Registry in one two-phase run.
 *
 * Every VALIDATION rejection — bad envelope, wrong entry type for the port,
 * forged ownership stamp, id collision within the run or against a stored entry
 * owned by someone else, a failing `list()` — is raised as a coded PandaError
 * before any store mutation, so the store is untouched. A store-level write
 * failure during phase 2 is different: whatever already landed stays, and the
 * thrown {@link IngestWriteFailure} reports it.
 */
export async function ingestProviders(
  store: RegistryStore,
  options: IngestProvidersOptions = {},
): Promise<IngestOutcome> {
  const warnings: IngestWarning[] = []
  const collected = new Map<string, Contribution>()

  // --- Phase 1: collect + validate everything ------------------------------
  for (const provider of options.toolProviders ?? []) {
    const listed = await listOrigin(provider)
    if (listed.length === 0) warnings.push(emptySource(provider.sourceId))
    for (const candidate of listed) {
      // Tool contributions carry no change token: nothing to compare, so an
      // entry this origin already owns is always re-registered.
      await collectContribution(store, collected, provider, candidate, TOOL_PROVIDER_TYPES)
    }
  }

  for (const source of options.skillSources ?? []) {
    const listed = await listOrigin<SourcedSkill>(source)
    if (listed.length === 0) warnings.push(emptySource(source.sourceId))
    for (const candidate of listed) {
      if (!isRecord(candidate) || !isNonEmptyString(candidate['contentHash'])) {
        throw rejected(
          source.sourceId,
          describeId(isRecord(candidate) ? candidate['entry'] : undefined),
          "'contentHash' must be a non-empty string",
        )
      }
      await collectContribution(
        store,
        collected,
        source,
        candidate['entry'],
        SKILL_SOURCE_TYPES,
        candidate['contentHash'],
      )
    }
  }

  // --- Phase 2: write ------------------------------------------------------
  const registered: string[] = []
  const unchanged: string[] = []
  for (const contribution of collected.values()) {
    if (!contribution.changed) {
      unchanged.push(contribution.key)
      continue
    }
    try {
      await store.register(contribution.entry, INGEST_SCOPE)
    } catch (error) {
      throw new IngestWriteFailure(
        `ingest failed while registering '${contribution.key}' after ${registered.length} entries already landed: ${detailOf(error)}`,
        { registered: [...registered], unchanged: [...unchanged], warnings: [...warnings] },
        error,
      )
    }
    registered.push(contribution.key)
  }
  return { registered, unchanged, warnings }
}
