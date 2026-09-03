import { registryEntryIssues } from '@panda/contracts'
import type { RegistryEntry, ToolProvider } from '@panda/contracts'

// The machine `ToolProvider` (FR-13b): the first implementation of a port that
// shipped finished with none, and the twin of `skills-source.ts` for the other
// entry type `REGISTRY_ENTRY_TYPES` declares.
//
// ONE MCP SERVER IS ONE KEY UNDER THE VENDOR'S OWN CONTAINER, and its id is that
// key. That is the exact inverse of what the projection writes: panda projects
// `<container>.<id>` from an entry with that id, so reading the key back as the
// id is the only shape that round-trips.
//
// WHAT THIS FILE DOES NOT KNOW, and must not:
//
//   - WHICH FILES. They are the `machineConfig` locations `@panda/environment`
//     derived from the shipped executor traits, every one verified against the
//     real binary. A default path spelled here would be a second table drifting
//     from the one panda writes into.
//   - HOW to read one. Each vendor's document is a different format with a
//     different entry shape, and both live in `@panda/projection`, which sits
//     ABOVE this package in AD-2's topology. So a reader arrives per location
//     rather than being imported — the same reason `skills-source.ts` takes
//     `entryFileName` instead of copying `SKILL_ENTRY_FILE`.
//   - WHICH ids panda already owns. The ownership ledger is
//     `@panda/projection`'s too. The caller reads it and hands the pairs in.
//
// That last one is load-bearing rather than a formality, and sharper here than
// for skills: panda writes its own servers into the SAME file the user's live
// in, under the same container. A naive read of `~/.claude.json` reads panda's
// own projection back, and the second run would differ from the first. The
// ledger is the only thing that tells the two apart.

/** A candidate this source looked at and did not contribute, and why. */
export interface McpSourceWarning {
  readonly kind: 'unreadable-config' | 'unreadable-entry' | 'unusable-id' | 'id-collision'
  /** The vendor document the observation is about. */
  readonly path: string
  readonly detail: string
}

/** One vendor entry, already read out of its native shape by the caller. */
export interface McpSourceEntry {
  readonly id: string
  readonly command: string
  readonly args: readonly string[]
  /** Native keys the registry envelope cannot carry; reported, never lost. */
  readonly dropped: readonly string[]
}

/** What one vendor document held, in the vocabulary the registry stores. */
export interface McpSourceReading {
  readonly entries: readonly McpSourceEntry[]
  /** Ids that are present and out of which no entry could be read, and why. */
  readonly unreadable: readonly { readonly id: string; readonly detail: string }[]
  /**
   * The file is there and could not be read at all, in the OS's own errno.
   *
   * Neither absence nor failure: this executor's servers were NOT considered,
   * and a run that stayed silent about that would tell a user they were.
   */
  readonly unreadableFile?: string
}

/** One verified vendor config location, and how to read it. */
export interface McpSourceLocation {
  /**
   * The projection target that owns this file. Half of the ownership match key
   * — never `nativeLocation`, which is a RENDERING of this and the entry id,
   * and matching on a rendering is how two answers come to differ.
   */
  readonly targetId: string
  /** Reported in every warning, so a user knows which file to open. */
  readonly filePath: string
  /**
   * `undefined` means the file is simply not there: an executor is allowed not
   * to be installed, and an absence is not a failure (AD-5).
   */
  readonly read: () => Promise<McpSourceReading | undefined>
}

/** One `targetId` + `entryId` pair panda's own ownership ledger claims. */
export interface McpSourceOwnedEntry {
  readonly targetId: string
  readonly entryId: string
  /**
   * The caller's own rendering of the two ids above, carried through to
   * `excluded` untouched and NEVER matched on. D3's match key is the two ids;
   * matching on a rendering is how two answers come to differ, and passing it
   * through rather than re-deriving it is what keeps this file from having to
   * know a vendor's container key at all.
   */
  readonly nativeLocation: string
}

/** An entry left where it is because panda itself put it there. */
export interface McpSourceExclusion extends McpSourceOwnedEntry {
  readonly filePath: string
}

/** An ingested entry whose vendor document carried more than panda can hold. */
export interface McpSourceDropped {
  readonly entryId: string
  readonly filePath: string
  readonly keys: readonly string[]
}

export interface McpSourceOptions {
  /** Consulted in order. A location whose file is absent contributes nothing. */
  readonly locations: readonly McpSourceLocation[]
  /** `targetId` + `entryId` pairs panda's ledger claims: never re-ingested. */
  readonly ownedEntries?: readonly McpSourceOwnedEntry[]
}

/**
 * A `ToolProvider` that also reports what it decided NOT to contribute.
 *
 * `IngestWarning` has exactly one kind (`empty-source`) and the port's `list()`
 * returns entries and nothing else, so a server panda skipped has no channel
 * through the ingest driver. Reporting it on the source is what keeps "panda
 * skipped 2 of the 5 servers it found" from becoming silence.
 */
export interface MachineMcpSource extends ToolProvider {
  /**
   * Narrowed from the port's `Promise | array`: this source always reads files,
   * so a caller never has to decide which of the two it got.
   */
  list(): Promise<readonly RegistryEntry[]>
  /** Populated by `list()`; replaced, not appended to, on a second call. */
  readonly warnings: readonly McpSourceWarning[]
  /** Entries left alone because panda's ownership ledger claims them. */
  readonly excluded: readonly McpSourceExclusion[]
  /** Ingested entries whose vendor document carried keys panda cannot hold. */
  readonly dropped: readonly McpSourceDropped[]
}

/**
 * The ownership identity every ingested server records.
 *
 * STABLE, and that is the whole of its job: `ingestProviders` refuses to
 * overwrite an entry owned by a different origin, so a renamed source id would
 * make every previously ingested server an unrelocatable conflict.
 */
export const MACHINE_MCP_SOURCE_ID = 'panda.machine-mcp'

/** One location's offer of one id, in the order the locations were consulted. */
interface Candidate {
  readonly location: McpSourceLocation
  readonly entry: RegistryEntry
  readonly dropped: readonly string[]
}

/**
 * What D7 splits on: the RENDERED command and arguments, and nothing else.
 *
 * Two executors describing one server in two native vocabularies still agree
 * about what runs, which is the only thing panda would project — so this is the
 * comparison, rather than the native text, which can differ while meaning the
 * same thing.
 */
function rendering(entry: RegistryEntry): string {
  return JSON.stringify([entry.command, entry.args ?? []])
}

/**
 * The ownership match key: BOTH facts, unambiguously.
 *
 * JSON, not a separator character, because a registry id may legally contain
 * whatever separator gets picked — and then `a` + `b c` and `a b` + `c` are one
 * key, which silently excludes an entry panda never wrote.
 */
function ownedKey(targetId: string, entryId: string): string {
  return JSON.stringify([targetId, entryId])
}

export function createMachineMcpSource(options: McpSourceOptions): MachineMcpSource {
  const owned = new Map(
    (options.ownedEntries ?? []).map((entry) => [ownedKey(entry.targetId, entry.entryId), entry]),
  )
  const warnings: McpSourceWarning[] = []
  const excluded: McpSourceExclusion[] = []
  const dropped: McpSourceDropped[] = []

  return {
    sourceId: MACHINE_MCP_SOURCE_ID,
    warnings,
    excluded,
    dropped,
    async list(): Promise<readonly RegistryEntry[]> {
      // Replaced rather than appended to: a second `list()` over an unchanged
      // machine must report what it saw, not twice what it saw.
      warnings.length = 0
      excluded.length = 0
      dropped.length = 0
      // Keyed by id, in first-seen order, so the answer does not depend on which
      // location an id happened to be read from.
      const offers = new Map<string, Candidate[]>()

      for (const location of options.locations) {
        // A malformed document, an unaddressable container, a file panda may not
        // read: every one of those throws coded from the reader and is left to
        // propagate. `ingestProviders` collects and validates EVERY origin before
        // it writes anything, so a refusal here reaches the caller with the store
        // untouched — which is why a lenient second read path would be worse than
        // no ingest at all.
        const reading = await location.read()
        if (reading === undefined) continue
        if (reading.unreadableFile !== undefined) {
          // Reported and stepped over. A file panda may not open must not take
          // the skills half of the same run down with it, and must not pass in
          // silence either.
          warnings.push({
            kind: 'unreadable-config',
            path: location.filePath,
            detail: `'${location.filePath}' exists and panda could not read it (${reading.unreadableFile}), so the servers it declares were not considered`,
          })
          continue
        }

        for (const item of reading.unreadable) {
          warnings.push({
            kind: 'unreadable-entry',
            path: location.filePath,
            detail: `'${item.id}' in '${location.filePath}' is not a server panda can ingest: ${item.detail}; panda skipped it`,
          })
        }

        for (const item of reading.entries) {
          const claim = owned.get(ownedKey(location.targetId, item.id))
          if (claim !== undefined) {
            // Panda's own projection. Ingesting it would make the registry a
            // copy of its own output and the second run would differ from the
            // first. The caller's own record is echoed back, so the location
            // reported beside an exclusion is the one that caused it.
            excluded.push({ ...claim, filePath: location.filePath })
            continue
          }
          const entry: RegistryEntry = {
            type: 'mcp-server',
            id: item.id,
            command: item.command,
            args: [...item.args],
          }
          // The CONTRACT's rule, asked of the contract. A second copy of "what is
          // a legal id" here would be a rule that drifts from the one the store
          // enforces — and `ingestProviders` raises a rejection for the whole
          // run, so a key panda cannot name has to be filtered out before it gets
          // there rather than after.
          const issues = registryEntryIssues(entry)
          if (issues.length > 0) {
            const idIssues = issues.filter((issue) => issue.message.startsWith("'id'"))
            warnings.push({
              kind: idIssues.length > 0 ? 'unusable-id' : 'unreadable-entry',
              path: location.filePath,
              // The ID sentence only for an ID fault. A `command`/`args` issue is a
              // fault in the VALUE, and printing it as "cannot be a registry id"
              // sent a user looking at the wrong half of their own entry.
              detail: idIssues.length > 0
                ? `'${item.id}' in '${location.filePath}' cannot be a registry id: ${idIssues
                    .map((issue) => issue.message)
                    .join('; ')}; panda skipped it rather than renaming it to something you could not predict`
                : `'${item.id}' in '${location.filePath}' is not an entry the registry accepts: ${issues
                    .map((issue) => issue.message)
                    .join('; ')}; panda skipped it`,
            })
            continue
          }
          const candidate: Candidate = { location, entry, dropped: item.dropped }
          const offered = offers.get(item.id)
          if (offered === undefined) offers.set(item.id, [candidate])
          else offered.push(candidate)
        }
      }

      const listed: RegistryEntry[] = []
      for (const [id, candidates] of offers) {
        const first = candidates[0]!
        if (candidates.length > 1 && candidates.some((item) => rendering(item.entry) !== rendering(first.entry))) {
          // D7, and the skills source's amended rule rather than a second one:
          // where the candidates agree about what runs there is no decision to
          // make, and where they DISAGREE picking one would silently choose
          // between two different servers.
          warnings.push({
            kind: 'id-collision',
            path: first.location.filePath,
            // Every location that offered it, in ONE warning: a user deciding
            // which copy to keep needs all of them, and one warning per extra
            // location reports the same fact as many times as it was seen.
            detail: `mcp-server id '${id}' is offered by ${candidates.length} executor configurations that do not agree about what it runs (${candidates
              .map((item) => `'${item.location.filePath}'`)
              .join(', ')}); panda ingested none of them rather than picking between servers that differ`,
          })
          continue
        }
        // The FIRST location that offered it. The choice has to be made because
        // ONE row is written, and first-offered is the caller's own declared
        // location order rather than a preference invented here — stable across
        // runs and machines, which is what a byte-identical second run rests on.
        listed.push(first.entry)
        if (first.dropped.length > 0) {
          dropped.push({ entryId: id, filePath: first.location.filePath, keys: [...first.dropped] })
        }
      }
      return listed
    },
  }
}

