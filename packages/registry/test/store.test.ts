import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { PANDA_ERROR_CODES, PandaError } from '@panda/contracts'
import { RegistryStore } from '../src'

const tempRoots: string[] = []
afterAll(() => Promise.all(tempRoots.map((dir) => rm(dir, { recursive: true, force: true }))))

// Each test gets isolated directories so store state never leaks between cases.
async function makeDirs(): Promise<{ homeDir: string; projectDir: string }> {
  const homeDir = await mkdtemp(join(tmpdir(), 'panda-registry-home-'))
  const projectDir = await mkdtemp(join(tmpdir(), 'panda-registry-project-'))
  tempRoots.push(homeDir, projectDir)
  return { homeDir, projectDir }
}

function makeStore(dirs: { homeDir: string; projectDir?: string }): RegistryStore {
  return new RegistryStore({ homeDir: dirs.homeDir, projectDir: dirs.projectDir })
}

describe('RegistryStore', () => {
  it('registers a valid entry at global scope and reads it back after reload', async () => {
    const dirs = await makeDirs()
    await makeStore(dirs).register({ type: 'mcp-server', id: 'demo-tool' }, 'global')

    // A fresh instance over the same directories is the reload path.
    expect(await makeStore(dirs).get('mcp-server', 'demo-tool')).toEqual({ type: 'mcp-server', id: 'demo-tool' })
  })

  it('returns NOTHING from register/remove: storage-time transformation is invisible', async () => {
    const dirs = await makeDirs()
    const store = makeStore(dirs)
    expect(await store.register({ type: 'mcp-server', id: 'demo-tool' }, 'global')).toBeUndefined()
    expect(await store.remove('mcp-server', 'demo-tool', 'global')).toBeUndefined()
  })

  it('persists atomically: the store document is complete and no temp files survive', async () => {
    const dirs = await makeDirs()
    await makeStore(dirs).register(
      { type: 'skill', id: 'demo-skill', extensions: { steps: ['a', 'b'] } },
      'global',
    )
    const pandaDir = join(dirs.homeDir, '.panda')
    const files = await readdir(pandaDir)
    expect(files).toContain('registry.json')
    expect(files.filter((file) => file.endsWith('.tmp'))).toHaveLength(0)
    const document = JSON.parse(await readFile(join(pandaDir, 'registry.json'), 'utf8')) as Record<string, unknown>
    expect(document['version']).toBe(1)
  })

  it('rejects an invalid envelope BEFORE any write with a coded error naming the field', async () => {
    const dirs = await makeDirs()
    try {
      await makeStore(dirs).register({ type: 'mcp-server' }, 'global')
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(PandaError)
      expect((error as PandaError).code).toBe(PANDA_ERROR_CODES.registryInvalidEntry)
      expect((error as PandaError).message).toContain("'id'")
    }
    await expect(readdir(join(dirs.homeDir, '.panda'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects provider payloads outside the extensions namespace, naming the rule', async () => {
    const dirs = await makeDirs()
    try {
      await makeStore(dirs).register({ type: 'mcp-server', id: 'demo', model: 'sonnet' }, 'global')
      expect.unreachable()
    } catch (error) {
      expect((error as PandaError).code).toBe(PANDA_ERROR_CODES.registryInvalidEntry)
      expect((error as PandaError).message).toContain("'model'")
      expect((error as PandaError).message).toContain("'extensions'")
    }
  })

  it('normalizes ONLY declared path fields; ids and extensions stay verbatim on disk', async () => {
    const dirs = await makeDirs()
    const store = makeStore(dirs)
    await store.register(
      {
        type: 'skill',
        id: '~tilde-id',
        entryPath: join(dirs.homeDir, 'skills', 'demo.ts'),
        extensions: { notes: '~/notes.txt' },
      },
      'global',
    )

    const rawDocument = await readFile(join(dirs.homeDir, '.panda', 'registry.json'), 'utf8')
    // No machine-specific absolute path under home ever reaches disk...
    expect(rawDocument).not.toContain(dirs.homeDir)
    // ...the designated field carries the ~/ marker...
    const persisted = JSON.parse(rawDocument) as { entries: Array<Record<string, unknown>> }
    expect((persisted.entries[0]!.entryPath as string).startsWith('~/')).toBe(true)
    // ...while id and extension payloads are untouched.
    expect(persisted.entries[0]!.id).toBe('~tilde-id')
    expect(persisted.entries[0]!.extensions).toEqual({ notes: '~/notes.txt' })

    // Reads expand uniformly.
    expect(await store.get('skill', '~tilde-id')).toEqual({
      type: 'skill',
      id: '~tilde-id',
      entryPath: join(dirs.homeDir, 'skills', 'demo.ts'),
      extensions: { notes: '~/notes.txt' },
    })
  })

  it('escapes literal leading tildes in path fields so hand-written ~/values survive', async () => {
    const dirs = await makeDirs()
    const store = makeStore(dirs)
    await store.register({ type: 'skill', id: 'literal', entryPath: '~/relative-but-literal' }, 'global')

    const rawDocument = await readFile(join(dirs.homeDir, '.panda', 'registry.json'), 'utf8')
    expect(rawDocument).toContain('~~/relative-but-literal')

    const readBack = await makeStore(dirs).get('skill', 'literal')
    expect(readBack?.entryPath).toBe('~/relative-but-literal')
  })

  it('reads with scope precedence agent > project > global, expanding ALL scopes uniformly', async () => {
    const dirs = await makeDirs()
    const store = makeStore(dirs)
    const entry = { type: 'mcp-server', id: 'layered' }
    await store.register({ ...entry, extensions: { source: 'global' } }, 'global')
    await store.register({ ...entry, extensions: { source: 'project' } }, 'project')

    expect(await store.get('mcp-server', 'layered')).toEqual({
      type: 'mcp-server',
      id: 'layered',
      extensions: { source: 'project' },
    })

    const homePath = join(dirs.homeDir, 'bin', 'agent-tool.exe')
    await store.register({ ...entry, extensions: { source: 'agent' }, command: homePath }, 'agent')
    expect(await store.get('mcp-server', 'layered')).toEqual({
      type: 'mcp-server',
      id: 'layered',
      command: homePath,
      extensions: { source: 'agent' },
    })
    // Agent scope expands like every other scope — no asymmetry.
    expect(homePath.startsWith(dirs.homeDir)).toBe(true)

    // Agent entries overlay in memory only; they never reach disk.
    const rawGlobal = await readFile(join(dirs.homeDir, '.panda', 'registry.json'), 'utf8')
    expect(rawGlobal).not.toContain('agent')
  })

  it('refuses a project directory that IS the home directory, because the two scopes would be one file', async () => {
    // `#storePath` puts global at `<home>/.panda/registry.json` and project at
    // `<project>/.panda/registry.json`. Equal directories alias them, and every
    // scope-aware operation then lies: `list('project')` returns the global rows
    // under a project label, and `remove(type, id, 'project')` empties the
    // GLOBAL document while reporting a project-scope removal. Refused in the
    // constructor so no caller can reach the aliased state by forgetting to
    // check — the CLI, `initProject`, `diagnose`, or a third party holding this
    // class directly.
    const dirs = await makeDirs()
    expect(() => new RegistryStore({ homeDir: dirs.homeDir, projectDir: dirs.homeDir })).toThrow(
      expect.objectContaining({ code: PANDA_ERROR_CODES.registryStoreUnavailable }),
    )
    // Spelled differently, still the same directory.
    expect(
      () => new RegistryStore({ homeDir: dirs.homeDir, projectDir: join(dirs.homeDir, '.') }),
    ).toThrow(expect.objectContaining({ code: PANDA_ERROR_CODES.registryStoreUnavailable }))
    // A genuinely different project directory is untouched by the guard.
    expect(() => makeStore(dirs)).not.toThrow()
  })

  it('lists ONE scope on request, because the merged view drops the scope that produced a row', async () => {
    const dirs = await makeDirs()
    const store = makeStore(dirs)
    const entry = { type: 'mcp-server', id: 'layered' }
    await store.register({ ...entry, extensions: { source: 'global' } }, 'global')
    await store.register({ ...entry, extensions: { source: 'project' } }, 'project')
    await store.register({ type: 'mcp-server', id: 'only-global' }, 'global')
    await store.register({ ...entry, extensions: { source: 'agent' } }, 'agent')

    // The merged view keeps one row per `type:id` — which is right for a
    // projection and useless to a reader that has to say WHERE an entry lives.
    expect((await store.list()).map((row) => row.id).sort()).toEqual(['layered', 'only-global'])
    expect(
      (await store.list('global')).map((row) => [row.id, (row.extensions as { source?: string })?.source]),
    ).toEqual([
      ['layered', 'global'],
      ['only-global', undefined],
    ])
    expect(
      (await store.list('project')).map((row) => [row.id, (row.extensions as { source?: string })?.source]),
    ).toEqual([['layered', 'project']])
    // The in-memory scope answers for itself and reaches no disk document.
    expect(
      (await store.list('agent')).map((row) => [row.id, (row.extensions as { source?: string })?.source]),
    ).toEqual([['layered', 'agent']])
  })

  it('removes entries per scope; removing an override lets get fall back to the wider scope', async () => {
    const dirs = await makeDirs()
    const store = makeStore(dirs)
    const entry = { type: 'mcp-server', id: 'overridden' }
    await store.register({ ...entry, extensions: { source: 'global' } }, 'global')
    await store.register({ ...entry, extensions: { source: 'project' } }, 'project')
    expect(((await store.get('mcp-server', 'overridden'))?.extensions as { source: string }).source).toBe('project')

    await store.remove('mcp-server', 'overridden', 'project')
    expect(((await store.get('mcp-server', 'overridden'))?.extensions as { source: string }).source).toBe('global')

    await store.remove('mcp-server', 'overridden', 'global')
    expect(await store.get('mcp-server', 'overridden')).toBeUndefined()
  })

  it('serializes mutations to the SAME scope so neither write is lost', async () => {
    const dirs = await makeDirs()
    const store = makeStore(dirs)
    await Promise.all([
      store.register({ type: 'mcp-server', id: 'one' }, 'global'),
      store.register({ type: 'mcp-server', id: 'two' }, 'global'),
      store.register({ type: 'mcp-server', id: 'three' }, 'global'),
    ])
    const ids = (await makeStore(dirs).list()).map((entry) => entry.id).sort()
    expect(ids).toEqual(['one', 'three', 'two'])
  })

  it('persists two concurrent mutations to DIFFERENT scopes and releases both locks', async () => {
    const dirs = await makeDirs()
    const store = makeStore(dirs)
    await Promise.all([
      store.register({ type: 'mcp-server', id: 'global-one' }, 'global'),
      store.register({ type: 'mcp-server', id: 'project-one' }, 'project'),
    ])
    expect(await makeStore(dirs).get('mcp-server', 'global-one')).toBeDefined()
    expect(await makeStore(dirs).get('mcp-server', 'project-one')).toBeDefined()

    expect(await readdir(join(dirs.homeDir, '.panda'))).toEqual(['registry.json'])
    expect(await readdir(join(dirs.projectDir, '.panda'))).toEqual(['registry.json'])
  })

  it('dispose during an in-flight mutation waits for it: lock released late, write kept', async () => {
    const dirs = await makeDirs()
    const store = makeStore(dirs)
    const mutation = store.register({ type: 'mcp-server', id: 'in-flight' }, 'global')
    // No awaiting: dispose() must serialize against the mutation above.
    await store.dispose()

    await mutation
    expect(await makeStore(dirs).get('mcp-server', 'in-flight')).toBeDefined()
    await expect(readdir(join(dirs.homeDir, '.panda'))).resolves.toEqual(['registry.json'])

    await expect(store.register({ type: 'mcp-server', id: 'after-dispose' }, 'global')).rejects.toMatchObject({
      code: PANDA_ERROR_CODES.registryInactive,
    })
    await expect(store.list()).rejects.toMatchObject({ code: PANDA_ERROR_CODES.registryInactive })
  })

  it('raises INACTIVE for operations that start after dispose completed', async () => {
    const dirs = await makeDirs()
    const store = makeStore(dirs)
    await store.dispose()
    await expect(store.register({ type: 'mcp-server', id: 'x' }, 'global')).rejects.toMatchObject({
      code: PANDA_ERROR_CODES.registryInactive,
    })
  })

  it('reports a missing project directory as STORE_UNAVAILABLE (configuration, not bad entry)', async () => {
    const dirs = await makeDirs()
    const store = new RegistryStore({ homeDir: dirs.homeDir })
    try {
      await store.register({ type: 'mcp-server', id: 'x' }, 'project')
      expect.unreachable()
    } catch (error) {
      expect((error as PandaError).code).toBe(PANDA_ERROR_CODES.registryStoreUnavailable)
      expect((error as PandaError).message).toContain('project')
    }
  })

  /** One store, one document, one read. The two arms below differ only in `version`. */
  async function refuseVersion(version: unknown): Promise<PandaError> {
    const dirs = await makeDirs()
    const pandaDir = join(dirs.homeDir, '.panda')
    await mkdir(pandaDir)
    await writeFile(join(pandaDir, 'registry.json'), JSON.stringify({ version, entries: [] }), 'utf8')
    try {
      await makeStore(dirs).get('mcp-server', 'anything')
    } catch (error) {
      return error as PandaError
    }
    expect.unreachable()
  }

  it('rejects a future-version store document as a NEWER panda-s, naming both versions', async () => {
    // Rejection is unchanged (version by REJECT, never migrate); what changed is
    // that the refusal is CODED apart from a damaged document, because the two
    // have opposite actions -- install a newer panda, versus repair or remove
    // the file. `panda doctor` used to print the latter at this intact document.
    const error = await refuseVersion(999)
    expect(error.code).toBe(PANDA_ERROR_CODES.registryStoreVersionMismatch)
    expect(error.message).toContain('written by a newer panda')
    expect(error.message).toContain('store schema version 999')
    expect(error.message).toContain('this build reads version 1')
  })

  it.each([
    ['a version BELOW this build-s', 0],
    ['a version that is a string', '1'],
    ['a version that is fractional', 1.5],
    ['a version that is absent', undefined],
  ])('CONTROL: refuses %s as unrecognised rather than as newer', async (_label, version) => {
    // Without these the row above measures the happy arm alone: every one of
    // these is a document this build cannot read AT ALL, and no newer panda
    // exists to install for it.
    const error = await refuseVersion(version)
    expect(error.code).toBe(PANDA_ERROR_CODES.registryStoreUnavailable)
    expect(error.message).not.toContain('newer panda')
    expect(error.message).toContain('this build expects 1')
  })

  it('never flows hand-edited malformed entries out of get/list', async () => {
    const dirs = await makeDirs()
    const pandaDir = join(dirs.homeDir, '.panda')
    await mkdir(pandaDir)
    const corrupt = {
      version: 1,
      entries: [{ type: 'mcp-server', id: 'good' }, { type: 'mcp-server', id: 42 }],
    }
    await writeFile(join(pandaDir, 'registry.json'), JSON.stringify(corrupt), 'utf8')

    await expect(makeStore(dirs).get('mcp-server', 'good')).rejects.toMatchObject({
      code: PANDA_ERROR_CODES.registryStoreUnavailable,
    })
    await expect(makeStore(dirs).list()).rejects.toMatchObject({
      code: PANDA_ERROR_CODES.registryStoreUnavailable,
    })
  })
})

// --- ensure(): the store document a fresh machine has to end up with -------

describe('RegistryStore.ensure', () => {
  it('creates a readable store document for a scope that has never been written', async () => {
    const dirs = await makeDirs()
    const path = await makeStore(dirs).ensure('global')

    expect(path).toBe(join(dirs.homeDir, '.panda', 'registry.json'))
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version: 1, entries: [] })
    // The format stays the store's: a caller writing `{version, entries}` by
    // hand would fork it the first time either side changed.
    expect(await makeStore(dirs).list()).toEqual([])
  })

  it('leaves an existing document byte-for-byte alone, unknown keys included', async () => {
    const dirs = await makeDirs()
    const path = join(dirs.homeDir, '.panda', 'registry.json')
    await mkdir(join(dirs.homeDir, '.panda'), { recursive: true })
    // A key this build does not model — a newer panda's, or a human's note.
    const original = '{"version":1,"entries":[{"type":"tool","id":"demo"}],"writtenBy":"panda-next"}'
    await writeFile(path, original, 'utf8')

    await makeStore(dirs).ensure('global')

    // Re-persisting would write this build's RECONSTRUCTION of the document and
    // destroy `writtenBy` — on every `panda init`, silently.
    expect(await readFile(path, 'utf8')).toBe(original)
  })

  it('does not take the lock, so preparing a machine cannot lose to a concurrent writer', async () => {
    const dirs = await makeDirs()
    const path = await makeStore(dirs).ensure('global')
    // A live, healthy lock held by this very process: any contender waits out
    // its deadline and fails with CONTENTION. A read-only ensure must not.
    await writeFile(
      `${path}.lock`,
      JSON.stringify({ pid: process.pid, host: 'localhost', acquiredAt: new Date().toISOString(), token: 't' }),
      'utf8',
    )
    await expect(makeStore(dirs).ensure('global')).resolves.toBe(path)
  })

  it('fails coded on a corrupt document instead of replacing it', async () => {
    const dirs = await makeDirs()
    const path = join(dirs.homeDir, '.panda', 'registry.json')
    await mkdir(join(dirs.homeDir, '.panda'), { recursive: true })
    await writeFile(path, 'not json', 'utf8')

    await expect(makeStore(dirs).ensure('global')).rejects.toMatchObject({
      code: PANDA_ERROR_CODES.registryStoreUnavailable,
    })
    expect(await readFile(path, 'utf8')).toBe('not json')
  })

  it('refuses the agent scope, which is in-memory and has no document', async () => {
    const dirs = await makeDirs()
    await expect(
      (makeStore(dirs) as unknown as { ensure(scope: string): Promise<string> }).ensure('agent'),
    ).rejects.toBeInstanceOf(PandaError)
  })
})

// Story M4.E. `tool` left the registry vocabulary, and removing a word must not
// turn a registry that already holds one into an unreadable store — ONE entry
// violating the envelope fails the WHOLE document, which blocks `panda list`,
// `panda remove` and `panda init`: the very commands that would take it out.
//
// The bytes below are not hand-written. They are the exact document the SHIPPED
// binary produced for `panda add tool rg --command rg`, `panda add tool localfmt
// --command <under home>`, `panda add mcp-server ctx ...` and `panda add skill
// demo ...`, with the `~/` marker exactly as that build normalized it.
const RETIRED_FIXTURE = [
  '{',
  '  "version": 1,',
  '  "entries": [',
  '    {',
  '      "type": "tool",',
  '      "id": "rg",',
  '      "command": "rg"',
  '    },',
  '    {',
  '      "type": "tool",',
  '      "id": "localfmt",',
  '      "command": "~/bin\\\\fmt.exe"',
  '    },',
  '    {',
  '      "type": "mcp-server",',
  '      "id": "ctx",',
  '      "command": "npx",',
  '      "args": [',
  '        "-y",',
  '        "@ctx/server"',
  '      ]',
  '    },',
  '    {',
  '      "type": "skill",',
  '      "id": "demo",',
  '      "entryPath": "./skills/demo"',
  '    }',
  '  ]',
  '}',
].join('\n')

async function withRetiredFixture(): Promise<{ homeDir: string; projectDir: string; path: string }> {
  const dirs = await makeDirs()
  const path = join(dirs.homeDir, '.panda', 'registry.json')
  await mkdir(join(dirs.homeDir, '.panda'), { recursive: true })
  await writeFile(path, RETIRED_FIXTURE, 'utf8')
  return { ...dirs, path }
}

describe('a registry written before a type was retired stays readable', () => {
  it('lists every entry, retired ones included, with their paths expanded', async () => {
    const dirs = await withRetiredFixture()
    expect(await makeStore(dirs).list('global')).toEqual([
      { type: 'tool', id: 'rg', command: 'rg' },
      // Expanded through the RETIRED type's own path-field allowlist. Reading
      // the declared record instead yields `undefined` and throws on iteration.
      { type: 'tool', id: 'localfmt', command: join(dirs.homeDir, 'bin\\fmt.exe') },
      { type: 'mcp-server', id: 'ctx', command: 'npx', args: ['-y', '@ctx/server'] },
      { type: 'skill', id: 'demo', entryPath: './skills/demo' },
    ])
    // The backslash is REAL, and this row exists because it silently was not:
    // the fixture and the expectation both wrote ONE backslash, which JSON and
    // JS both read as \f -- a form feed -- so the two sides collapsed to the
    // same wrong bytes and the assertion passed while measuring nothing.
    const BACKSLASH = String.fromCharCode(92)
    expect(RETIRED_FIXTURE).toContain(BACKSLASH + BACKSLASH)
    expect((await makeStore(dirs).get('tool', 'localfmt', 'global'))?.command).toContain(BACKSLASH)
  })

  it('serves and REMOVES a retired entry, so the exit is inside the product', async () => {
    const dirs = await withRetiredFixture()
    const store = makeStore(dirs)
    expect(await store.get('tool', 'rg', 'global')).toEqual({ type: 'tool', id: 'rg', command: 'rg' })

    await store.remove('tool', 'rg', 'global')
    await store.remove('tool', 'localfmt', 'global')

    expect(await makeStore(dirs).list('global')).toEqual([
      { type: 'mcp-server', id: 'ctx', command: 'npx', args: ['-y', '@ctx/server'] },
      { type: 'skill', id: 'demo', entryPath: './skills/demo' },
    ])
  })

  it('removes ONE type:id and leaves an entry sharing that id under another type', async () => {
    // The registry's identity is `type:id`, and after this story that collision
    // is the SANCTIONED post-migration state: the spec's whole argument for
    // retiring `tool` is that an `mcp-server` carries what a `tool` carried, so
    // `tool:rg` beside `mcp-server:rg` is exactly what a user re-registering the
    // live entry produces -- while `panda remove tool rg` is the command doctor
    // prints. A `remove` that filtered on the id alone would take the live entry
    // with it and empty the registry, and every other row in this suite stayed
    // green under precisely that mutation.
    const dirs = await withRetiredFixture()
    const store = makeStore(dirs)
    await store.register({ type: 'mcp-server', id: 'rg', command: 'rg-server' }, 'global')

    await store.remove('tool', 'rg', 'global')

    expect(await makeStore(dirs).get('mcp-server', 'rg', 'global')).toEqual({
      type: 'mcp-server',
      id: 'rg',
      command: 'rg-server',
    })
    expect(await makeStore(dirs).get('tool', 'rg', 'global')).toBeUndefined()
  })

  it('refuses to REGISTER one, so the document cannot gain another', async () => {
    const dirs = await withRetiredFixture()
    await expect(makeStore(dirs).register({ type: 'tool', id: 'new', command: 'x' }, 'global')).rejects.toMatchObject(
      { code: PANDA_ERROR_CODES.registryInvalidEntry },
    )
  })

  it('still fails the WHOLE store on an entry that is genuinely malformed', async () => {
    // The line the Ask-First clause of M4.E draws: recognising a retired word is
    // not leniency. A retired type carrying a field it never had is as broken as
    // any other corrupt row, and must not be readable because `tool` is.
    const dirs = await makeDirs()
    const path = join(dirs.homeDir, '.panda', 'registry.json')
    await mkdir(join(dirs.homeDir, '.panda'), { recursive: true })
    await writeFile(path, JSON.stringify({ version: 1, entries: [{ type: 'tool', id: 'x', entryPath: './y' }] }), 'utf8')

    await expect(makeStore(dirs).list('global')).rejects.toMatchObject({
      code: PANDA_ERROR_CODES.registryStoreUnavailable,
    })
  })
})
