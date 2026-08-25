import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  PANDA_ERROR_CODES,
  PANDA_SOURCE_EXTENSION_KEY,
  PandaError,
  defineStandardSchema,
} from '@panda/contracts'
import type {
  RegistryEntry,
  RegistryScope,
  SkillSource,
  SourcedSkill,
  StandardSchemaV1,
  ToolProvider,
} from '@panda/contracts'
import { IngestWriteFailure, RegistryStore, ingestProviders } from '../src'

const tempRoots: string[] = []
afterAll(() => Promise.all(tempRoots.map((dir) => rm(dir, { recursive: true, force: true }))))

interface Harness {
  readonly store: RegistryStore
  readonly homeDir: string
  /** Entries that actually LANDED — the two-phase evidence. */
  readonly writes: unknown[]
}

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempRoots.push(dir)
  return dir
}

/**
 * register() is wrapped rather than the store file inspected because
 * re-registering an IDENTICAL entry produces identical bytes: only the call
 * itself distinguishes "skipped the write" from "wrote the same thing again".
 * `failWriteAt` makes the Nth write throw, exercising the phase-2 failure path.
 */
async function makeHarness(failWriteAt?: number): Promise<Harness> {
  const homeDir = await makeTempDir('panda-ingest-home-')
  const store = new RegistryStore({ homeDir })
  const writes: unknown[] = []
  const register = store.register.bind(store)
  let attempts = 0
  store.register = async (entry: unknown, scope: RegistryScope): Promise<void> => {
    attempts += 1
    if (attempts === failWriteAt) {
      throw new PandaError(PANDA_ERROR_CODES.registryContention, 'registry lock is held by 4242@builder')
    }
    await register(entry, scope)
    writes.push(entry)
  }
  return { store, homeDir, writes }
}

function toolProvider(
  sourceId: string,
  entries: readonly unknown[],
  entrySchema?: StandardSchemaV1,
): ToolProvider {
  return { sourceId, entrySchema, list: () => entries as readonly RegistryEntry[] }
}

function skillSource(
  sourceId: string,
  listed: readonly unknown[],
  entrySchema?: StandardSchemaV1,
): SkillSource {
  return { sourceId, entrySchema, list: () => listed as readonly SourcedSkill[] }
}

function sourcedSkill(id: string, contentHash: string, entryPath = `/skills/${id}.ts`): SourcedSkill {
  return { entry: { type: 'skill', id, entryPath }, contentHash }
}

async function expectRejection(
  run: Promise<unknown>,
  code: string,
  ...fragments: readonly string[]
): Promise<PandaError> {
  let caught: unknown
  let resolved = false
  try {
    await run
    resolved = true
  } catch (error) {
    caught = error
  }
  // Outside the try on purpose: a failed expectation here must not be swallowed
  // by the catch that is meant for the run itself.
  expect(resolved, 'expected the ingest run to reject, but it resolved').toBe(false)
  expect(caught).toBeInstanceOf(PandaError)
  expect((caught as PandaError).code).toBe(code)
  for (const fragment of fragments) expect((caught as PandaError).message).toContain(fragment)
  return caught as PandaError
}

/** No `.panda` directory means not one byte of any origin's catalog landed. */
async function expectStoreUntouched(harness: Harness): Promise<void> {
  expect(harness.writes).toEqual([])
  await expect(readdir(join(harness.homeDir, '.panda'))).rejects.toMatchObject({ code: 'ENOENT' })
}

describe('ingestProviders', () => {
  it('registers both ports into the GLOBAL store and round-trips every entry field', async () => {
    const harness = await makeHarness()
    const outcome = await ingestProviders(harness.store, {
      toolProviders: [
        toolProvider('catalog', [
          { type: 'tool', id: 'ripgrep', command: 'rg' },
          { type: 'mcp-server', id: 'files', command: 'mcp-fs', args: ['--root', '/srv', '--ro'] },
        ]),
      ],
      skillSources: [skillSource('skills-dir', [sourcedSkill('commit-lint', 'h1')])],
    })

    expect(outcome).toEqual({
      registered: ['tool:ripgrep', 'mcp-server:files', 'skill:commit-lint'],
      unchanged: [],
      warnings: [],
    })
    expect(await readdir(join(harness.homeDir, '.panda'))).toEqual(['registry.json'])

    expect(await harness.store.get('tool', 'ripgrep')).toEqual({
      type: 'tool',
      id: 'ripgrep',
      command: 'rg',
      extensions: { [PANDA_SOURCE_EXTENSION_KEY]: { sourceId: 'catalog' } },
    })
    expect(await harness.store.get('mcp-server', 'files')).toEqual({
      type: 'mcp-server',
      id: 'files',
      command: 'mcp-fs',
      args: ['--root', '/srv', '--ro'],
      extensions: { [PANDA_SOURCE_EXTENSION_KEY]: { sourceId: 'catalog' } },
    })

    const skill = await harness.store.get('skill', 'commit-lint')
    expect(skill?.extensions?.[PANDA_SOURCE_EXTENSION_KEY]).toEqual({
      sourceId: 'skills-dir',
      contentHash: 'h1',
    })
    // Tracking never becomes a root field: the envelope stays canonical and the
    // projection renderer (root fields only) can never emit the hash.
    expect(Object.keys(skill ?? {}).sort()).toEqual(['entryPath', 'extensions', 'id', 'type'])
  })

  it('rejects a schema-invalid tool definition coded, naming origin and entry, writing NOTHING', async () => {
    const harness = await makeHarness()
    await expectRejection(
      ingestProviders(harness.store, {
        toolProviders: [
          toolProvider('healthy', [{ type: 'tool', id: 'fine', command: 'ok' }]),
          toolProvider('broken', [{ type: 'tool', id: 'bad-tool', model: 'sonnet' }]),
        ],
      }),
      PANDA_ERROR_CODES.registryProviderRejected,
      "origin 'broken'",
      "'bad-tool'",
      "'model'",
    )
    // The healthy origin was collected BEFORE the rejection and still wrote nothing.
    await expectStoreUntouched(harness)
  })

  it('rejects an id that could never become a projected key, at the registration boundary', async () => {
    const harness = await makeHarness()
    await expectRejection(
      ingestProviders(harness.store, {
        toolProviders: [toolProvider('catalog', [{ type: 'tool', id: '__proto__', command: 'evil' }])],
      }),
      PANDA_ERROR_CODES.registryProviderRejected,
      "origin 'catalog'",
      "'__proto__'",
      'projected key',
    )
    await expectStoreUntouched(harness)
  })

  it("rejects an entry failing the origin's own declared Standard Schema", async () => {
    const harness = await makeHarness()
    const requiresCommand: StandardSchemaV1 = defineStandardSchema((value) =>
      typeof (value as { command?: unknown }).command === 'string'
        ? { value }
        : { issues: [{ message: 'this provider always declares a command' }] },
    )
    await expectRejection(
      ingestProviders(harness.store, {
        // Envelope-valid (command is optional there), rejected by the origin.
        toolProviders: [toolProvider('strict', [{ type: 'tool', id: 'no-command' }], requiresCommand)],
      }),
      PANDA_ERROR_CODES.registryProviderRejected,
      "origin 'strict'",
      "'no-command'",
      'always declares a command',
    )
    await expectStoreUntouched(harness)
  })

  it('applies a SkillSource schema to the ENTRY, not the {entry, contentHash} wrapper', async () => {
    const harness = await makeHarness()
    const observed: unknown[] = []
    const recording: StandardSchemaV1 = defineStandardSchema((value) => {
      observed.push(value)
      return { issues: [{ message: 'no skill passes this gate' }] }
    })
    await expectRejection(
      ingestProviders(harness.store, {
        skillSources: [skillSource('strict-skills', [sourcedSkill('commit-lint', 'h1')], recording)],
      }),
      PANDA_ERROR_CODES.registryProviderRejected,
      "origin 'strict-skills'",
      'no skill passes this gate',
    )
    expect(observed).toEqual([{ type: 'skill', id: 'commit-lint', entryPath: '/skills/commit-lint.ts' }])
    await expectStoreUntouched(harness)
  })

  it('awaits an ASYNC origin schema and rejects on the issues it resolves to', async () => {
    const harness = await makeHarness()
    const asyncSchema: StandardSchemaV1 = {
      '~standard': {
        version: 1,
        validate: async () => Promise.resolve({ issues: [{ message: 'async gate said no' }] }),
      },
    }
    await expectRejection(
      ingestProviders(harness.store, {
        toolProviders: [toolProvider('async-origin', [{ type: 'tool', id: 'x', command: 'x' }], asyncSchema)],
      }),
      PANDA_ERROR_CODES.registryProviderRejected,
      'async gate said no',
    )
    await expectStoreUntouched(harness)
  })

  it('keeps a throwing or unusable origin schema inside the coded contract', async () => {
    const harness = await makeHarness()
    const throwing: StandardSchemaV1 = {
      '~standard': {
        version: 1,
        validate: () => {
          throw new Error('schema blew up')
        },
      },
    }
    await expectRejection(
      ingestProviders(harness.store, {
        toolProviders: [toolProvider('thrower', [{ type: 'tool', id: 'x', command: 'x' }], throwing)],
      }),
      PANDA_ERROR_CODES.registryProviderRejected,
      'origin schema threw',
      'schema blew up',
    )

    // An empty issues array is still a rejection, and must read legibly.
    await expectRejection(
      ingestProviders(harness.store, {
        toolProviders: [
          toolProvider('mute', [{ type: 'tool', id: 'x', command: 'x' }], defineStandardSchema(() => ({ issues: [] }))),
        ],
      }),
      PANDA_ERROR_CODES.registryProviderRejected,
      'rejected without stating an issue',
    )

    await expectRejection(
      ingestProviders(harness.store, {
        toolProviders: [
          toolProvider('legacy', [{ type: 'tool', id: 'x', command: 'x' }], {
            '~standard': { version: 2, validate: () => ({ value: undefined }) },
          } as unknown as StandardSchemaV1),
        ],
      }),
      PANDA_ERROR_CODES.registryProviderRejected,
      'not a Standard Schema v1',
    )
    await expectStoreUntouched(harness)
  })

  it('rejects an entry type the port may not contribute, in either direction', async () => {
    const harness = await makeHarness()
    await expectRejection(
      ingestProviders(harness.store, {
        skillSources: [
          skillSource('mislabeled', [
            { entry: { type: 'tool', id: 'sneaky', command: 'x' }, contentHash: 'h1' },
          ]),
        ],
      }),
      PANDA_ERROR_CODES.registryProviderRejected,
      "origin 'mislabeled'",
      "'sneaky'",
      "type 'tool' is not contributable",
    )

    await expectRejection(
      ingestProviders(harness.store, {
        toolProviders: [toolProvider('wrong-port', [{ type: 'skill', id: 'a-skill', entryPath: '/s.ts' }])],
      }),
      PANDA_ERROR_CODES.registryProviderRejected,
      "origin 'wrong-port'",
      "'a-skill'",
      "type 'skill' is not contributable",
    )
    await expectStoreUntouched(harness)
  })

  it('rejects a contribution that forges the reserved source-tracking stamp, on both ports', async () => {
    const harness = await makeHarness()
    const forged = { [PANDA_SOURCE_EXTENSION_KEY]: { sourceId: 'someone-else', contentHash: 'h9' } }
    await expectRejection(
      ingestProviders(harness.store, {
        toolProviders: [toolProvider('forger', [{ type: 'tool', id: 'rg', command: 'rg', extensions: forged }])],
      }),
      PANDA_ERROR_CODES.registryProviderRejected,
      "origin 'forger'",
      PANDA_SOURCE_EXTENSION_KEY,
      'reserved',
    )

    await expectRejection(
      ingestProviders(harness.store, {
        skillSources: [
          skillSource('forger-skills', [
            { entry: { type: 'skill', id: 'x', entryPath: '/x.ts', extensions: forged }, contentHash: 'h1' },
          ]),
        ],
      }),
      PANDA_ERROR_CODES.registryProviderRejected,
      "origin 'forger-skills'",
      'reserved',
    )
    await expectStoreUntouched(harness)
  })

  it('re-registers a skill whose source reports a CHANGED content hash', async () => {
    const harness = await makeHarness()
    await ingestProviders(harness.store, {
      skillSources: [skillSource('dir', [sourcedSkill('commit-lint', 'h1', '/skills/old.ts')])],
    })

    const outcome = await ingestProviders(harness.store, {
      skillSources: [skillSource('dir', [sourcedSkill('commit-lint', 'h2', '/skills/new.ts')])],
    })

    expect(outcome.registered).toEqual(['skill:commit-lint'])
    expect(outcome.unchanged).toEqual([])
    expect(harness.writes).toHaveLength(2)
    const stored = await harness.store.get('skill', 'commit-lint')
    expect(stored?.entryPath).toBe('/skills/new.ts')
    expect(stored?.extensions?.[PANDA_SOURCE_EXTENSION_KEY]).toEqual({ sourceId: 'dir', contentHash: 'h2' })
  })

  it('discriminates on the HASH alone, never on entry equality', async () => {
    const harness = await makeHarness()
    await ingestProviders(harness.store, {
      skillSources: [skillSource('dir', [sourcedSkill('commit-lint', 'h1', '/skills/original.ts')])],
    })

    // Same hash, DIFFERENT content: the origin owns the definition of "changed",
    // so panda must believe it and skip the write.
    const stale = await ingestProviders(harness.store, {
      skillSources: [skillSource('dir', [sourcedSkill('commit-lint', 'h1', '/skills/moved.ts')])],
    })
    expect(stale).toEqual({ registered: [], unchanged: ['skill:commit-lint'], warnings: [] })
    expect(harness.writes).toHaveLength(1)
    expect((await harness.store.get('skill', 'commit-lint'))?.entryPath).toBe('/skills/original.ts')

    // Different hash, IDENTICAL content: still a write.
    const refreshed = await ingestProviders(harness.store, {
      skillSources: [skillSource('dir', [sourcedSkill('commit-lint', 'h2', '/skills/original.ts')])],
    })
    expect(refreshed.registered).toEqual(['skill:commit-lint'])
    expect(harness.writes).toHaveLength(2)
  })

  it('warns typed on an empty-but-valid origin instead of succeeding silently', async () => {
    const harness = await makeHarness()
    const outcome = await ingestProviders(harness.store, {
      toolProviders: [toolProvider('no-tools', [])],
      skillSources: [skillSource('no-skills', [])],
    })

    expect(outcome.registered).toEqual([])
    expect(outcome.warnings).toEqual([
      { kind: 'empty-source', sourceId: 'no-tools', detail: "origin 'no-tools' contributed no entries" },
      { kind: 'empty-source', sourceId: 'no-skills', detail: "origin 'no-skills' contributed no entries" },
    ])
  })

  it('rejects the same type+id from two origins in one run, naming both', async () => {
    const harness = await makeHarness()
    await expectRejection(
      ingestProviders(harness.store, {
        skillSources: [
          skillSource('vendor-a', [sourcedSkill('commit-lint', 'h1')]),
          skillSource('vendor-b', [sourcedSkill('commit-lint', 'h2')]),
        ],
      }),
      PANDA_ERROR_CODES.registryOriginConflict,
      "'skill:commit-lint'",
      "'vendor-a'",
      "'vendor-b'",
    )

    // Two tool providers collide the same way; the tool path has its own claim.
    await expectRejection(
      ingestProviders(harness.store, {
        toolProviders: [
          toolProvider('vendor-a', [{ type: 'tool', id: 'ripgrep', command: 'rg' }]),
          toolProvider('vendor-b', [{ type: 'tool', id: 'ripgrep', command: 'rg-fork' }]),
        ],
      }),
      PANDA_ERROR_CODES.registryOriginConflict,
      "'tool:ripgrep'",
      "'vendor-a'",
      "'vendor-b'",
    )

    // Same collision within ONE origin is equally fatal, and says so plainly.
    await expectRejection(
      ingestProviders(harness.store, {
        skillSources: [
          skillSource('vendor-a', [sourcedSkill('commit-lint', 'h1'), sourcedSkill('commit-lint', 'h2')]),
        ],
      }),
      PANDA_ERROR_CODES.registryOriginConflict,
      "contributed twice by origin 'vendor-a'",
    )
    await expectStoreUntouched(harness)
  })

  it('refuses to take over an entry a DIFFERENT origin already owns, equal hash included', async () => {
    const harness = await makeHarness()
    await ingestProviders(harness.store, {
      skillSources: [skillSource('vendor-a', [sourcedSkill('commit-lint', 'h1')])],
    })
    expect(harness.writes).toHaveLength(1)

    await expectRejection(
      // Equal hash: silently reporting 'unchanged' would keep vendor-a's entry forever.
      ingestProviders(harness.store, {
        skillSources: [skillSource('vendor-b', [sourcedSkill('commit-lint', 'h1')])],
      }),
      PANDA_ERROR_CODES.registryOriginConflict,
      "'skill:commit-lint'",
      "owned by origin 'vendor-a'",
      "origin 'vendor-b'",
    )
    expect(harness.writes).toHaveLength(1)
    expect((await harness.store.get('skill', 'commit-lint'))?.extensions?.[PANDA_SOURCE_EXTENSION_KEY]).toEqual({
      sourceId: 'vendor-a',
      contentHash: 'h1',
    })
  })

  it('refuses to clobber a hand-registered entry that no origin owns', async () => {
    const harness = await makeHarness()
    await harness.store.register({ type: 'tool', id: 'ripgrep', command: 'my-own-rg' }, 'global')

    await expectRejection(
      ingestProviders(harness.store, {
        toolProviders: [toolProvider('catalog', [{ type: 'tool', id: 'ripgrep', command: 'rg' }])],
      }),
      PANDA_ERROR_CODES.registryOriginConflict,
      "'tool:ripgrep'",
      'was not contributed by an origin',
      "origin 'catalog'",
    )
    expect((await harness.store.get('tool', 'ripgrep'))?.command).toBe('my-own-rg')
  })

  it('compares ownership at the WRITE scope, not through the merged view', async () => {
    const homeDir = await makeTempDir('panda-ingest-home-')
    const projectDir = await makeTempDir('panda-ingest-project-')
    const store = new RegistryStore({ homeDir, projectDir })
    // A project-scope entry shadows the global one for every merged read.
    await store.register({ type: 'skill', id: 'commit-lint', entryPath: '/project/override.ts' }, 'project')

    // Global is empty, so ingestion must still write there despite the shadow.
    const outcome = await ingestProviders(store, {
      skillSources: [skillSource('dir', [sourcedSkill('commit-lint', 'h1')])],
    })
    expect(outcome.registered).toEqual(['skill:commit-lint'])
    expect((await store.get('skill', 'commit-lint', 'global'))?.entryPath).toBe('/skills/commit-lint.ts')
    // The merged read still serves the project override, untouched.
    expect((await store.get('skill', 'commit-lint'))?.entryPath).toBe('/project/override.ts')
  })

  it('fails coded and wraps the cause when an origin throws while listing', async () => {
    const harness = await makeHarness()
    const cause = new Error('skills directory vanished')
    const error = await expectRejection(
      ingestProviders(harness.store, {
        toolProviders: [toolProvider('healthy', [{ type: 'tool', id: 'fine', command: 'ok' }])],
        skillSources: [{ sourceId: 'flaky', list: () => Promise.reject(cause) }],
      }),
      PANDA_ERROR_CODES.registryProviderRejected,
      "origin 'flaky'",
      'skills directory vanished',
    )
    expect(error.cause).toBe(cause)
    await expectStoreUntouched(harness)
  })

  it('rejects malformed origin output: a non-array listing or a missing content hash', async () => {
    const harness = await makeHarness()
    await expectRejection(
      ingestProviders(harness.store, {
        toolProviders: [{ sourceId: 'liar', list: () => undefined as unknown as readonly RegistryEntry[] }],
      }),
      PANDA_ERROR_CODES.registryProviderRejected,
      "origin 'liar'",
      'did not resolve to an array',
    )

    await expectRejection(
      ingestProviders(harness.store, {
        skillSources: [skillSource('hashless', [{ entry: { type: 'skill', id: 'x', entryPath: '/x.ts' } }])],
      }),
      PANDA_ERROR_CODES.registryProviderRejected,
      "origin 'hashless'",
      "'x'",
      "'contentHash'",
    )
    await expectStoreUntouched(harness)
  })

  it('names an unidentifiable entry rather than failing anonymously', async () => {
    const harness = await makeHarness()
    await expectRejection(
      ingestProviders(harness.store, { toolProviders: [toolProvider('junk', [null])] }),
      PANDA_ERROR_CODES.registryProviderRejected,
      "origin 'junk'",
      "'<unknown>'",
    )
    await expectStoreUntouched(harness)
  })

  it('does not let a provider mutate an entry between validation and write', async () => {
    const harness = await makeHarness()
    const mutable: Record<string, unknown> = { type: 'tool', id: 'ripgrep', command: 'rg' }
    const saboteur: ToolProvider = {
      sourceId: 'saboteur',
      // Runs AFTER the first origin was validated and BEFORE phase 2 writes it:
      // the driver must be holding its own copy by then.
      list: () => {
        mutable['command'] = 'rm -rf /'
        mutable['args'] = ['boom']
        return []
      },
    }
    await ingestProviders(harness.store, {
      toolProviders: [toolProvider('victim', [mutable]), saboteur],
    })
    expect(await harness.store.get('tool', 'ripgrep')).toEqual({
      type: 'tool',
      id: 'ripgrep',
      command: 'rg',
      extensions: { [PANDA_SOURCE_EXTENSION_KEY]: { sourceId: 'victim' } },
    })
  })

  it('reports what already landed when a phase-2 store write fails', async () => {
    const harness = await makeHarness(2)
    let caught: unknown
    try {
      await ingestProviders(harness.store, {
        toolProviders: [
          toolProvider('catalog', [
            { type: 'tool', id: 'first', command: 'a' },
            { type: 'tool', id: 'second', command: 'b' },
            { type: 'tool', id: 'third', command: 'c' },
          ]),
          toolProvider('quiet', []),
        ],
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(IngestWriteFailure)
    const failure = caught as IngestWriteFailure
    // The store's own code survives the wrapping; the partial outcome is not lost.
    expect(failure.code).toBe(PANDA_ERROR_CODES.registryContention)
    expect(failure.message).toContain("'tool:second'")
    expect(failure.partial.registered).toEqual(['tool:first'])
    expect(failure.partial.warnings).toEqual([
      { kind: 'empty-source', sourceId: 'quiet', detail: "origin 'quiet' contributed no entries" },
    ])
    // Documented behavior: what landed stays; there is no rollback.
    expect(await harness.store.get('tool', 'first')).toBeDefined()
    expect(await harness.store.get('tool', 'third')).toBeUndefined()
  })

  it('treats an empty option set as a no-op', async () => {
    const harness = await makeHarness()
    expect(await ingestProviders(harness.store, {})).toEqual({
      registered: [],
      unchanged: [],
      warnings: [],
    })
    await expectStoreUntouched(harness)
  })
})
