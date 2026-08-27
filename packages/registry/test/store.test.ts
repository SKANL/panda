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
    await makeStore(dirs).register({ type: 'tool', id: 'demo-tool' }, 'global')

    // A fresh instance over the same directories is the reload path.
    expect(await makeStore(dirs).get('tool', 'demo-tool')).toEqual({ type: 'tool', id: 'demo-tool' })
  })

  it('returns NOTHING from register/remove: storage-time transformation is invisible', async () => {
    const dirs = await makeDirs()
    const store = makeStore(dirs)
    expect(await store.register({ type: 'tool', id: 'demo-tool' }, 'global')).toBeUndefined()
    expect(await store.remove('tool', 'demo-tool', 'global')).toBeUndefined()
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
      await makeStore(dirs).register({ type: 'tool' }, 'global')
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
      await makeStore(dirs).register({ type: 'tool', id: 'demo', model: 'sonnet' }, 'global')
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
    const entry = { type: 'tool', id: 'layered' }
    await store.register({ ...entry, extensions: { source: 'global' } }, 'global')
    await store.register({ ...entry, extensions: { source: 'project' } }, 'project')

    expect(await store.get('tool', 'layered')).toEqual({
      type: 'tool',
      id: 'layered',
      extensions: { source: 'project' },
    })

    const homePath = join(dirs.homeDir, 'bin', 'agent-tool.exe')
    await store.register({ ...entry, extensions: { source: 'agent' }, command: homePath }, 'agent')
    expect(await store.get('tool', 'layered')).toEqual({
      type: 'tool',
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
    const entry = { type: 'tool', id: 'layered' }
    await store.register({ ...entry, extensions: { source: 'global' } }, 'global')
    await store.register({ ...entry, extensions: { source: 'project' } }, 'project')
    await store.register({ type: 'tool', id: 'only-global' }, 'global')
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
    const entry = { type: 'tool', id: 'overridden' }
    await store.register({ ...entry, extensions: { source: 'global' } }, 'global')
    await store.register({ ...entry, extensions: { source: 'project' } }, 'project')
    expect(((await store.get('tool', 'overridden'))?.extensions as { source: string }).source).toBe('project')

    await store.remove('tool', 'overridden', 'project')
    expect(((await store.get('tool', 'overridden'))?.extensions as { source: string }).source).toBe('global')

    await store.remove('tool', 'overridden', 'global')
    expect(await store.get('tool', 'overridden')).toBeUndefined()
  })

  it('serializes mutations to the SAME scope so neither write is lost', async () => {
    const dirs = await makeDirs()
    const store = makeStore(dirs)
    await Promise.all([
      store.register({ type: 'tool', id: 'one' }, 'global'),
      store.register({ type: 'tool', id: 'two' }, 'global'),
      store.register({ type: 'tool', id: 'three' }, 'global'),
    ])
    const ids = (await makeStore(dirs).list()).map((entry) => entry.id).sort()
    expect(ids).toEqual(['one', 'three', 'two'])
  })

  it('persists two concurrent mutations to DIFFERENT scopes and releases both locks', async () => {
    const dirs = await makeDirs()
    const store = makeStore(dirs)
    await Promise.all([
      store.register({ type: 'tool', id: 'global-one' }, 'global'),
      store.register({ type: 'tool', id: 'project-one' }, 'project'),
    ])
    expect(await makeStore(dirs).get('tool', 'global-one')).toBeDefined()
    expect(await makeStore(dirs).get('tool', 'project-one')).toBeDefined()

    expect(await readdir(join(dirs.homeDir, '.panda'))).toEqual(['registry.json'])
    expect(await readdir(join(dirs.projectDir, '.panda'))).toEqual(['registry.json'])
  })

  it('dispose during an in-flight mutation waits for it: lock released late, write kept', async () => {
    const dirs = await makeDirs()
    const store = makeStore(dirs)
    const mutation = store.register({ type: 'tool', id: 'in-flight' }, 'global')
    // No awaiting: dispose() must serialize against the mutation above.
    await store.dispose()

    await mutation
    expect(await makeStore(dirs).get('tool', 'in-flight')).toBeDefined()
    await expect(readdir(join(dirs.homeDir, '.panda'))).resolves.toEqual(['registry.json'])

    await expect(store.register({ type: 'tool', id: 'after-dispose' }, 'global')).rejects.toMatchObject({
      code: PANDA_ERROR_CODES.registryInactive,
    })
    await expect(store.list()).rejects.toMatchObject({ code: PANDA_ERROR_CODES.registryInactive })
  })

  it('raises INACTIVE for operations that start after dispose completed', async () => {
    const dirs = await makeDirs()
    const store = makeStore(dirs)
    await store.dispose()
    await expect(store.register({ type: 'tool', id: 'x' }, 'global')).rejects.toMatchObject({
      code: PANDA_ERROR_CODES.registryInactive,
    })
  })

  it('reports a missing project directory as STORE_UNAVAILABLE (configuration, not bad entry)', async () => {
    const dirs = await makeDirs()
    const store = new RegistryStore({ homeDir: dirs.homeDir })
    try {
      await store.register({ type: 'tool', id: 'x' }, 'project')
      expect.unreachable()
    } catch (error) {
      expect((error as PandaError).code).toBe(PANDA_ERROR_CODES.registryStoreUnavailable)
      expect((error as PandaError).message).toContain('project')
    }
  })

  it('rejects a future-version store document instead of guessing', async () => {
    const dirs = await makeDirs()
    const pandaDir = join(dirs.homeDir, '.panda')
    await mkdir(pandaDir)
    await writeFile(join(pandaDir, 'registry.json'), JSON.stringify({ version: 999, entries: [] }), 'utf8')

    try {
      await makeStore(dirs).get('tool', 'anything')
      expect.unreachable()
    } catch (error) {
      expect((error as PandaError).code).toBe(PANDA_ERROR_CODES.registryStoreUnavailable)
      expect((error as PandaError).message).toContain('999')
      expect((error as PandaError).message).toContain(String(1))
    }
  })

  it('never flows hand-edited malformed entries out of get/list', async () => {
    const dirs = await makeDirs()
    const pandaDir = join(dirs.homeDir, '.panda')
    await mkdir(pandaDir)
    const corrupt = {
      version: 1,
      entries: [{ type: 'tool', id: 'good' }, { type: 'tool', id: 42 }],
    }
    await writeFile(join(pandaDir, 'registry.json'), JSON.stringify(corrupt), 'utf8')

    await expect(makeStore(dirs).get('tool', 'good')).rejects.toMatchObject({
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
