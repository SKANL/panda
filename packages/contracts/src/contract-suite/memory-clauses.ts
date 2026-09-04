import { randomUUID } from 'node:crypto'
import { PandaError, PANDA_ERROR_CODES } from '../errors.ts'
import { MEMORY_ENTRY_SCHEMA, MEMORY_FORMAT_VERSION } from '../memory.ts'
import type { MemoryEntry, MemoryProvenance, MemoryProvider, MemorySaveRequest } from '../memory.ts'
import { describeThrown, failWith, pass } from './clause.ts'
import type { Clause, ClauseOutcome } from './clause.ts'

export const MEMORY_SUITE = 'memory-provider'

/**
 * The subject of every memory clause, and the reason it is not the bare
 * provider the workspace suite takes.
 *
 * A memory store that passes every clause in one process and loses everything
 * on restart has passed nothing, and no clause holding only a live provider
 * instance can tell the difference. So the harness carries SEAMS — ways to open
 * a provider over a medium the harness controls — and the clauses use them:
 *
 * - `reopen()` opens a NEW provider instance over the SAME medium, as after a
 *   process restart. `state-survives-reopen` is the clause that exists for it,
 *   and `disposed-provider-rejects-operations` borrows it for a throwaway
 *   instance so it never has to dispose the shared subject (which is why this
 *   suite, unlike the workspace one, has no clause-ordering constraint at the
 *   end).
 * - `openDivergentFormatVersion()` opens a provider over a medium stamped with
 *   a format version this build does not speak. It is a seam because only the
 *   provider's own package knows how to write one, and it is MANDATORY rather
 *   than optional because a clause that silently passes when a seam is missing
 *   is prose wearing a gate's clothes.
 *
 * `providerName` is folded into every violation detail by
 * `runMemoryContractSuite`, so a red clause says WHICH provider broke.
 */
export interface MemoryContractHarness {
  readonly providerName: string
  readonly provider: MemoryProvider
  readonly reopen: () => Promise<MemoryProvider>
  readonly openDivergentFormatVersion: () => Promise<MemoryProvider>
}

// Local, matching `workspace-clauses.ts`: each suite owns its rejection helper
// rather than sharing one, because each names its own vocabulary in the detail.
function expectRejection(
  action: string,
  expectedCode: string,
  attempt: Promise<unknown>,
): Promise<ClauseOutcome> {
  return attempt.then(
    () => failWith(`${action} was expected to reject with ${expectedCode} but resolved`),
    (error: unknown) => {
      if (error instanceof PandaError && error.code === expectedCode) return pass()
      const actual =
        error instanceof PandaError
          ? `code ${error.code}`
          : `non-coded error: ${describeThrown(error)}`
      return failWith(`${action} rejected with ${actual}, expected ${expectedCode}`)
    },
  )
}

function provenanceFor(tag: string, recordedAt = new Date().toISOString()): MemoryProvenance {
  return { agentId: `agent-${tag}`, workspaceId: `workspace-${tag}`, recordedAt }
}

/** Field-by-field provenance comparison, so a mismatch names the field. */
function provenanceMismatches(actual: MemoryProvenance, expected: MemoryProvenance): string[] {
  return (['agentId', 'workspaceId', 'recordedAt'] as const).flatMap((field) =>
    actual?.[field] === expected[field]
      ? []
      : [`${field} (${JSON.stringify(actual?.[field])} != ${JSON.stringify(expected[field])})`],
  )
}

async function entryById(provider: MemoryProvider, id: string): Promise<MemoryEntry | undefined> {
  return (await provider.timeline()).entries.find((entry) => entry.id === id)
}

async function entryCount(provider: MemoryProvider): Promise<number> {
  return (await provider.describe()).entryCount
}

export const MEMORY_CLAUSES: readonly Clause<MemoryContractHarness>[] = [
  {
    // E12. It runs FIRST because a store is empty exactly once, and it refuses
    // to be toothless about it: arriving at a non-empty store is a FAILURE
    // naming the misuse, not a quiet pass. A comment asking a caller to keep the
    // ordering would be the defect class AGENTS.md names; this is the gate.
    name: 'fresh-store-is-typed-empty',
    check: async ({ provider }) => {
      const info = await provider.describe()
      if (info.entryCount !== 0) {
        return failWith(
          `this clause must run first over a FRESH medium; the store already holds ${String(info.entryCount)} entries`,
        )
      }
      if (info.formatVersion !== MEMORY_FORMAT_VERSION) {
        return failWith(`store reports format version ${String(info.formatVersion)}, expected ${MEMORY_FORMAT_VERSION}`)
      }
      // AD-5: an empty store has no first write. Absent, not epoch zero and not
      // an empty string — either of which is a measurement nobody took.
      if (info.firstWriteAt !== undefined || info.lastWriteAt !== undefined) {
        return failWith(
          `an empty store reported write extremes: firstWriteAt=${JSON.stringify(info.firstWriteAt)} lastWriteAt=${JSON.stringify(info.lastWriteAt)}`,
        )
      }
      const timeline = await provider.timeline()
      if (!Array.isArray(timeline.entries) || timeline.entries.length !== 0) {
        return failWith(`timeline() over an empty store must return a typed empty entry list, got ${JSON.stringify(timeline)}`)
      }
      const searched = await provider.search({})
      if (searched?.matched !== 0 || searched.entries.length !== 0) {
        return failWith(`search({}) over an empty store must be typed empty, got ${JSON.stringify(searched)}`)
      }
      return pass()
    },
  },
  {
    // E1. Verbatim means verbatim, and it is checked on the STORED copy as well
    // as on the value save() returned — a provider that echoes its argument and
    // persists something else passes the weaker half of this.
    name: 'save-preserves-provenance-verbatim',
    check: async ({ provider }) => {
      const tag = randomUUID()
      const provenance = provenanceFor(tag)
      const payload = `payload-${tag}`
      const saved = await provider.save({ payload, provenance })

      const schema = await MEMORY_ENTRY_SCHEMA['~standard'].validate(saved)
      if (schema.issues) {
        return failWith(`saved entry violates the entry schema: ${schema.issues.map((entry) => entry.message).join('; ')}`)
      }
      if (saved.payload !== payload) return failWith(`save() returned payload ${JSON.stringify(saved.payload)}`)
      if (saved.supersedes !== undefined) return failWith('a save with no supersedes returned one')
      const returned = provenanceMismatches(saved.provenance, provenance)
      if (returned.length > 0) return failWith(`save() returned altered provenance: ${returned.join(', ')}`)

      const stored = await entryById(provider, saved.id)
      if (stored === undefined) return failWith(`the entry save() returned (${saved.id}) is not in the timeline`)
      if (stored.payload !== payload) return failWith(`the STORED payload is ${JSON.stringify(stored.payload)}`)
      if (stored.sequence !== saved.sequence) {
        return failWith(`the STORED sequence is ${String(stored.sequence)}, save() returned ${String(saved.sequence)}`)
      }
      const persisted = provenanceMismatches(stored.provenance, provenance)
      if (persisted.length > 0) return failWith(`the STORED provenance differs: ${persisted.join(', ')}`)

      const searched = await provider.search({ contains: payload })
      if (searched.matched !== 1 || searched.entries[0]?.id !== saved.id) {
        return failWith(`search({contains}) did not return exactly the saved entry: ${JSON.stringify(searched)}`)
      }
      return pass()
    },
  },
  {
    // E2. Each refusal must NAME the field, or "invalid provenance" sends a
    // caller reading three identical messages to guess which of three is wrong.
    // The control is first: a valid save through the same door must be ACCEPTED,
    // or a provider that refuses everything would pass this clause.
    name: 'save-without-complete-provenance-refused',
    check: async ({ provider }) => {
      const tag = randomUUID()
      const provenance = provenanceFor(tag)
      try {
        await provider.save({ payload: `control-${tag}`, provenance })
      } catch (error) {
        return failWith(`control: a fully-provenanced save was refused: ${describeThrown(error)}`)
      }
      const before = await entryCount(provider)

      for (const field of ['agentId', 'workspaceId', 'recordedAt'] as const) {
        const partial: Record<string, unknown> = { ...provenance }
        delete partial[field]
        const request = { payload: `missing-${field}-${tag}`, provenance: partial } as unknown as MemorySaveRequest
        let refusal: unknown
        try {
          await provider.save(request)
          return failWith(`save() with provenance.${field} missing resolved instead of refusing`)
        } catch (error) {
          refusal = error
        }
        if (!(refusal instanceof PandaError) || refusal.code !== PANDA_ERROR_CODES.contractMemorySaveInvalid) {
          return failWith(
            `save() missing provenance.${field} rejected with ${refusal instanceof PandaError ? `code ${refusal.code}` : `non-coded error: ${describeThrown(refusal)}`}, expected ${PANDA_ERROR_CODES.contractMemorySaveInvalid}`,
          )
        }
        if (!refusal.message.includes(field)) {
          return failWith(`the refusal for a missing provenance.${field} does not name the field: ${refusal.message}`)
        }
      }

      // The payload is opaque, but it is bytes: a non-string leaves through the
      // same coded door, because this port is reachable from untyped JavaScript.
      const nonString = { payload: 42, provenance } as unknown as MemorySaveRequest
      const nonStringOutcome = await expectRejection(
        'save() with a non-string payload',
        PANDA_ERROR_CODES.contractMemorySaveInvalid,
        provider.save(nonString),
      )
      if (!nonStringOutcome.ok) return nonStringOutcome

      const after = await entryCount(provider)
      if (after !== before) {
        return failWith(`refused saves changed the store: ${String(before)} entries before, ${String(after)} after`)
      }
      return pass()
    },
  },
  {
    // E3 / D5 / FR-15's second testable consequence, and the one property a
    // provider can plausibly get wrong while passing everything else: "a write
    // from workspace A is never visible as originating from workspace B."
    //
    // Two workspaces, two agents, writes INTERLEAVED — a provider that stamps
    // every row with the first (or last) writer it saw passes an A-then-B test
    // and fails this one. Both halves are checked: each entry's own provenance,
    // and the filtered reads, since a correct row reachable through the wrong
    // filter is the same leak seen from the other side.
    name: 'provenance-never-crosses-workspaces',
    check: async ({ provider }) => {
      const tag = randomUUID()
      const a = provenanceFor(`a-${tag}`)
      const b = provenanceFor(`b-${tag}`)
      const written: { entry: MemoryEntry; provenance: MemoryProvenance; payload: string }[] = []
      for (const [index, provenance] of [a, b, a, b].entries()) {
        const payload = `crossing-${tag}-${String(index)}`
        written.push({ entry: await provider.save({ payload, provenance }), provenance, payload })
      }

      const timeline = await provider.timeline()
      for (const { entry, provenance, payload } of written) {
        const stored = timeline.entries.find((candidate) => candidate.id === entry.id)
        if (stored === undefined) return failWith(`entry ${entry.id} (${payload}) vanished from the timeline`)
        const mismatches = provenanceMismatches(stored.provenance, provenance)
        if (mismatches.length > 0) {
          return failWith(`entry ${payload} reads back with someone else's provenance: ${mismatches.join(', ')}`)
        }
      }

      for (const [label, provenance] of [
        ['A', a],
        ['B', b],
      ] as const) {
        const expected = written.filter((row) => row.provenance === provenance).map((row) => row.entry.id).sort()
        for (const [field, query] of [
          ['workspaceId', { workspaceId: provenance.workspaceId }],
          ['agentId', { agentId: provenance.agentId }],
        ] as const) {
          const result = await provider.search(query)
          const actual = result.entries.map((entry) => entry.id).sort()
          if (actual.length !== expected.length || actual.some((id, index) => id !== expected[index])) {
            return failWith(
              `search by ${field} for workspace ${label} returned ${JSON.stringify(actual)}, expected exactly ${JSON.stringify(expected)}`,
            )
          }
          const leaked = result.entries.filter(
            (entry) => entry.provenance.workspaceId !== provenance.workspaceId || entry.provenance.agentId !== provenance.agentId,
          )
          if (leaked.length > 0) {
            return failWith(
              `search by ${field} for workspace ${label} returned entries belonging to another writer: ${JSON.stringify(leaked.map((entry) => entry.provenance))}`,
            )
          }
          if (result.matched !== result.entries.length) {
            return failWith(`search reported matched=${String(result.matched)} with ${String(result.entries.length)} entries`)
          }
        }
      }
      return pass()
    },
  },
  {
    // E4. Coded, matched on the CODE, and — the half a bare rejection test
    // misses — nothing partially applied: the replacement bytes must exist
    // nowhere in the store afterwards. That absence carries its own control, so
    // a search that cannot see anything could not report it as a clean refusal.
    name: 'overwrite-refused-and-store-unchanged',
    check: async ({ provider }) => {
      const tag = randomUUID()
      const provenance = provenanceFor(tag)
      const payload = `original-${tag}`
      const replacement = `replacement-${tag}`
      const saved = await provider.save({ payload, provenance })
      const before = await entryCount(provider)

      const refused = await expectRejection(
        'overwrite() of an existing entry',
        PANDA_ERROR_CODES.contractMemoryOverwriteUnsupported,
        provider.overwrite(saved.id),
      )
      if (!refused.ok) return refused

      // Categorical, not conditional on existence: RD-1 forbids the OPERATION,
      // so an unknown id must not turn the refusal into a lookup failure.
      const unknown = await expectRejection(
        'overwrite() of an id the store does not hold',
        PANDA_ERROR_CODES.contractMemoryOverwriteUnsupported,
        provider.overwrite(`absent-${tag}`),
      )
      if (!unknown.ok) return unknown

      const after = await entryCount(provider)
      if (after !== before) {
        return failWith(`a refused overwrite changed the entry count: ${String(before)} -> ${String(after)}`)
      }
      const stored = await entryById(provider, saved.id)
      if (stored?.payload !== payload) {
        return failWith(`a refused overwrite altered the entry: payload is now ${JSON.stringify(stored?.payload)}`)
      }
      const control = await provider.search({ contains: payload })
      if (control.matched !== 1) {
        return failWith(`control: the original payload is not findable (matched=${String(control.matched)}), so the absence below proves nothing`)
      }
      const leaked = await provider.search({ contains: replacement })
      if (leaked.matched !== 0) {
        return failWith(`the refused overwrite was partially applied: ${String(leaked.matched)} entries hold the replacement payload`)
      }
      return pass()
    },
  },
  {
    // E5. Supersession is an APPEND with temporal marking, and the superseded
    // entry stays readable — through the timeline AND through search, because a
    // store that quietly filters superseded rows out of queries has deleted them
    // everywhere it matters while keeping a row nobody can reach.
    name: 'supersession-appends-and-preserves-the-superseded',
    check: async ({ provider }) => {
      const tag = randomUUID()
      const first = provenanceFor(`first-${tag}`)
      const second = provenanceFor(`second-${tag}`)
      const originalPayload = `superseded-${tag}`
      const original = await provider.save({ payload: originalPayload, provenance: first })
      const before = await entryCount(provider)

      const superseding = await provider.save({
        payload: `superseding-${tag}`,
        provenance: second,
        supersedes: original.id,
      })
      if (superseding.supersedes !== original.id) {
        return failWith(`the superseding entry lost its marking: supersedes=${JSON.stringify(superseding.supersedes)}`)
      }
      if (superseding.sequence <= original.sequence) {
        return failWith(
          `the superseding entry is not later in the log: sequence ${String(superseding.sequence)} <= ${String(original.sequence)}`,
        )
      }
      const after = await entryCount(provider)
      if (after !== before + 1) {
        return failWith(`supersession must APPEND: entry count went ${String(before)} -> ${String(after)}, expected +1`)
      }

      const stored = await entryById(provider, original.id)
      if (stored === undefined) return failWith('the superseded entry was removed from the timeline')
      if (stored.payload !== originalPayload) {
        return failWith(`the superseded entry was rewritten: payload is ${JSON.stringify(stored.payload)}`)
      }
      if (stored.supersedes !== undefined) {
        return failWith('supersession wrote back into the superseded entry, which is the destructive update RD-1 forbids')
      }
      const mismatches = provenanceMismatches(stored.provenance, first)
      if (mismatches.length > 0) return failWith(`the superseded entry's provenance changed: ${mismatches.join(', ')}`)

      const reachable = await provider.search({ contains: originalPayload })
      if (reachable.matched !== 1) {
        return failWith(`the superseded entry is no longer findable by search (matched=${String(reachable.matched)})`)
      }
      return pass()
    },
  },
  {
    // Not in the matrix, and deliberate: an append-only log gets no second
    // chance to repair a supersession pointer at nothing, so the pointer is
    // checked at write time or never.
    name: 'supersedes-unknown-entry-refused',
    check: async ({ provider }) => {
      const tag = randomUUID()
      const before = await entryCount(provider)
      const outcome = await expectRejection(
        'save() superseding an entry the store does not hold',
        PANDA_ERROR_CODES.contractMemoryUnknownEntry,
        provider.save({ payload: `dangling-${tag}`, provenance: provenanceFor(tag), supersedes: `absent-${tag}` }),
      )
      if (!outcome.ok) return outcome
      const after = await entryCount(provider)
      if (after !== before) {
        return failWith(`a refused supersession still appended: ${String(before)} -> ${String(after)}`)
      }
      return pass()
    },
  },
  {
    // E6. A typed empty result, never an error and never `undefined` (AD-5) —
    // and the control comes FIRST, because a search that can see nothing would
    // otherwise report every absence as a clean miss.
    name: 'search-without-matches-is-typed-empty',
    check: async ({ provider }) => {
      const tag = randomUUID()
      const present = `present-${tag}`
      await provider.save({ payload: `holds ${present}`, provenance: provenanceFor(tag) })
      const control = await provider.search({ contains: present })
      if (control.matched !== 1) {
        return failWith(`control: search cannot find an entry that exists (matched=${String(control.matched)}); a zero below would mean "did not look"`)
      }
      for (const [label, query] of [
        ['contains', { contains: `absent-${tag}` }],
        ['workspaceId', { workspaceId: `absent-workspace-${tag}` }],
        ['agentId', { agentId: `absent-agent-${tag}` }],
        ['every filter at once', { workspaceId: `absent-${tag}`, agentId: `absent-${tag}`, contains: `absent-${tag}` }],
      ] as const) {
        let result
        try {
          result = await provider.search(query)
        } catch (error) {
          return failWith(`search by ${label} with no match threw instead of returning empty: ${describeThrown(error)}`)
        }
        if (result === undefined || !Array.isArray(result.entries)) {
          return failWith(`search by ${label} with no match returned ${JSON.stringify(result)}`)
        }
        if (result.entries.length !== 0 || result.matched !== 0) {
          return failWith(`search by ${label} with no match returned ${String(result.matched)} entries`)
        }
      }
      // A filter combination whose parts each match but whose conjunction does
      // not — the shape an OR-ing implementation gets wrong while passing above.
      const conjunction = await provider.search({ contains: present, workspaceId: `absent-workspace-${tag}` })
      if (conjunction.matched !== 0) {
        return failWith(`search filters must AND: a matching payload with a non-matching workspace returned ${String(conjunction.matched)} entries`)
      }
      return pass()
    },
  },
  {
    // E7. FR-16 permits a suite to MARK an ordering non-deterministic; this port
    // does not need the escape clause, because `sequence` is a strictly
    // increasing append counter and ordering by it cannot tie. The clause forces
    // the tie a timestamp ordering WOULD have: all five writes share one
    // `recordedAt`, so a provider ordering by time alone is unstable here and
    // says so on the second read.
    name: 'timeline-ordering-is-deterministic',
    check: async ({ provider }) => {
      const tag = randomUUID()
      const provenance = provenanceFor(tag, new Date().toISOString())
      const written: string[] = []
      for (let index = 0; index < 5; index += 1) {
        written.push((await provider.save({ payload: `ordered-${tag}-${String(index)}`, provenance })).id)
      }

      const first = await provider.timeline()
      const second = await provider.timeline()
      const firstIds = first.entries.map((entry) => entry.id)
      const secondIds = second.entries.map((entry) => entry.id)
      if (firstIds.length !== secondIds.length || firstIds.some((id, index) => id !== secondIds[index])) {
        return failWith('two consecutive timeline() reads returned different orderings')
      }
      for (let index = 1; index < first.entries.length; index += 1) {
        const previous = first.entries[index - 1]?.sequence ?? 0
        const current = first.entries[index]?.sequence ?? 0
        if (current <= previous) {
          return failWith(`timeline sequences are not strictly increasing: ${String(previous)} then ${String(current)}`)
        }
      }
      const positions = written.map((id) => firstIds.indexOf(id))
      if (positions.some((position) => position < 0)) {
        return failWith(`a just-written entry is missing from the timeline: ${JSON.stringify(written)}`)
      }
      if (positions.some((position, index) => index > 0 && position <= (positions[index - 1] ?? -1))) {
        return failWith(`entries written in order came back out of order: positions ${JSON.stringify(positions)}`)
      }
      return pass()
    },
  },
  {
    // E8, and the reason this suite takes a harness at all. A store that holds
    // everything in one process and nothing after it is a store that has passed
    // every other clause and failed at its job.
    name: 'state-survives-reopen',
    check: async ({ provider, reopen }) => {
      const tag = randomUUID()
      const provenance = provenanceFor(tag)
      const payload = `durable-${tag}`
      const saved = await provider.save({ payload, provenance })
      const expectedCount = await entryCount(provider)

      const reopened = await reopen()
      try {
        const info = await reopened.describe()
        if (info.entryCount !== expectedCount) {
          return failWith(
            `a new provider instance over the same medium sees ${String(info.entryCount)} entries, ${String(expectedCount)} were written`,
          )
        }
        const stored = await entryById(reopened, saved.id)
        if (stored === undefined) {
          return failWith(`the entry written before the reopen (${saved.id}) is absent after it — the medium did not receive the write`)
        }
        if (stored.payload !== payload) {
          return failWith(`the payload did not survive the reopen: ${JSON.stringify(stored.payload)}`)
        }
        if (stored.sequence !== saved.sequence) {
          return failWith(`the sequence did not survive the reopen: ${String(stored.sequence)} != ${String(saved.sequence)}`)
        }
        const mismatches = provenanceMismatches(stored.provenance, provenance)
        if (mismatches.length > 0) return failWith(`provenance did not survive the reopen: ${mismatches.join(', ')}`)
        const searched = await reopened.search({ contains: payload })
        if (searched.matched !== 1) {
          return failWith(`the reopened store cannot find the entry it holds (matched=${String(searched.matched)})`)
        }
      } finally {
        await reopened.dispose().catch(() => {
          // Cleanup only; clause verdicts come from the checks themselves.
        })
      }
      return pass()
    },
  },
  {
    // E9. Version by REJECT, never migrate. The refusal must name BOTH versions,
    // because "wrong version" without the numbers is a dead end for whoever has
    // to decide which build wrote the store.
    name: 'divergent-format-version-refused',
    check: async ({ openDivergentFormatVersion }) => {
      let opened: MemoryProvider | undefined
      try {
        opened = await openDivergentFormatVersion()
      } catch (error) {
        if (!(error instanceof PandaError) || error.code !== PANDA_ERROR_CODES.contractMemoryStoreVersionMismatch) {
          return failWith(
            `opening a store stamped with another format version rejected with ${error instanceof PandaError ? `code ${error.code}` : `non-coded error: ${describeThrown(error)}`}, expected ${PANDA_ERROR_CODES.contractMemoryStoreVersionMismatch}`,
          )
        }
        if (!error.message.includes(String(MEMORY_FORMAT_VERSION))) {
          return failWith(`the version refusal does not name the version this build reads: ${error.message}`)
        }
        return pass()
      }
      await opened.dispose().catch(() => {
        // Cleanup only.
      })
      return failWith('a store stamped with another format version opened instead of being refused')
    },
  },
  {
    // Disposal, on a THROWAWAY instance from the reopen seam — so this clause
    // never kills the shared subject and the suite carries no ordering
    // constraint. It also asserts what dispose() must NOT do: the store is
    // durable, and disposing a reader destroys nothing.
    name: 'disposed-provider-rejects-operations',
    check: async ({ provider, reopen }) => {
      const survivingCount = await entryCount(provider)
      const throwaway = await reopen()
      try {
        await throwaway.dispose()
        await throwaway.dispose()
      } catch (error) {
        return failWith(`dispose() must be idempotent and resolve: ${describeThrown(error)}`)
      }
      const code = PANDA_ERROR_CODES.contractProviderDisposed
      // THUNKS, for the reason written on the sibling clause in
      // `workspace-clauses.ts`: an array literal of calls starts all five before
      // the first `await`, and the `return` below abandons every one it did not
      // reach. Their rejections land in the consumer's process with no handler.
      // Five here against three there, so this is the worse of the two.
      for (const [action, attempt] of [
        [
          'save() after dispose',
          () => throwaway.save({ payload: 'post-dispose', provenance: provenanceFor('post-dispose') }),
        ],
        ['search() after dispose', () => throwaway.search({})],
        ['timeline() after dispose', () => throwaway.timeline()],
        ['describe() after dispose', () => throwaway.describe()],
        // Disposal wins over the append-only refusal: a dead provider reports
        // that it is dead rather than lecturing about RD-1.
        ['overwrite() after dispose', () => throwaway.overwrite('any')],
      ] as const) {
        const outcome = await expectRejection(action, code, attempt())
        if (!outcome.ok) return outcome
      }
      const stillThere = await entryCount(provider)
      if (stillThere !== survivingCount) {
        return failWith(`disposing one instance changed the shared store: ${String(survivingCount)} -> ${String(stillThere)}`)
      }
      return pass()
    },
  },
]
