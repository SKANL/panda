import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { PANDA_ERROR_CODES, PandaError } from '@panda/contracts'
import type {
  DriftEntry,
  ProjectionTarget,
  RegistryEntriesByKind,
  RegistryEntry,
} from '@panda/contracts'
import { ProjectionLedger } from '../src/ledger.ts'
import { createClaudeMcpTarget } from '../src/targets/claude-mcp.ts'
import { groupByKind, hasFileChangedSince, runProjection } from '../src/engine.ts'

const tempRoots: string[] = []
afterAll(() => Promise.all(tempRoots.map((dir) => rm(dir, { recursive: true, force: true }))))

async function makeHome(): Promise<string> {
  const homeDir = await mkdtemp(join(tmpdir(), 'panda-projection-engine-'))
  tempRoots.push(homeDir)
  return homeDir
}

const ENTRIES = [
  { type: 'tool', id: 'ripgrep', command: 'rg' },
  { type: 'mcp-server', id: 'context7', command: 'npx', args: ['-y', '@upstash/context7-mcp'] },
] satisfies RegistryEntry[]

function ledgerIn(homeDir: string): ProjectionLedger {
  return new ProjectionLedger({ homeDir })
}

describe('groupByKind', () => {
  it('groups registry entries by kind', () => {
    expect(groupByKind(ENTRIES)).toEqual({
      tool: [{ type: 'tool', id: 'ripgrep', command: 'rg' }],
      skill: [],
      'mcp-server': [ENTRIES[1]],
      profile: [],
    })
  })

  it('skips entries with unknown kinds instead of crashing', () => {
    const corrupted = [{ type: 'alien', id: 'x' } as unknown as RegistryEntry]
    expect(groupByKind([...corrupted])).toEqual({
      tool: [],
      skill: [],
      'mcp-server': [],
      profile: [],
    })
  })
})

describe('runProjection', () => {
  it('creates a missing native file atomically and reports the write', async () => {
    const homeDir = await makeHome()
    const filePath = join(homeDir, 'claude', '.claude.json')
    const run = await runProjection({
      entries: groupByKind(ENTRIES),
      targets: [createClaudeMcpTarget({ filePath })],
      ledger: ledgerIn(homeDir),
    })

    expect(run.failures).toEqual([])
    expect(run.warnings).toEqual([])
    expect(run.results).toHaveLength(1)
    expect(run.results[0]).toMatchObject({ targetId: 'claude-mcp', written: true })
    expect(run.results[0]!.byteDelta).toBeGreaterThan(0)

    // Atomic temp+rename leaves no temp files behind.
    expect(await readdir(join(homeDir, 'claude'))).toEqual(['.claude.json'])
    expect(JSON.parse(await readFile(filePath, 'utf8'))['mcpServers']).toEqual({
      context7: { type: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp'] },
    })
  })

  it('is idempotent on disk: the second run writes nothing and reports zero delta', async () => {
    const homeDir = await makeHome()
    const target = createClaudeMcpTarget({ filePath: join(homeDir, '.claude.json') })
    const ledger = ledgerIn(homeDir)
    await runProjection({ entries: groupByKind(ENTRIES), targets: [target], ledger })
    const before = await readFile(target.filePath, 'utf8')

    const secondRun = await runProjection({ entries: groupByKind(ENTRIES), targets: [target], ledger })
    expect(secondRun.results[0]).toMatchObject({ written: false, byteDelta: 0, drift: [] })
    expect(await readFile(target.filePath, 'utf8')).toBe(before)
  })

  it('contains a malformed native file: only that target fails, siblings still project', async () => {
    const homeDir = await makeHome()
    const goodPath = join(homeDir, 'good', '.claude.json')
    const badDir = join(homeDir, 'bad')
    const badPath = join(badDir, '.claude.json')
    await mkdir(badDir, { recursive: true })
    await writeFile(badPath, '{ "broken"', 'utf8')

    const run = await runProjection({
      entries: groupByKind(ENTRIES),
      targets: [
        { ...createClaudeMcpTarget({ filePath: goodPath }), targetId: 'claude-good' },
        { ...createClaudeMcpTarget({ filePath: badPath }), targetId: 'claude-bad' },
      ],
      ledger: ledgerIn(homeDir),
    })

    expect(run.failures).toHaveLength(1)
    expect(run.failures[0]!.targetId).toBe('claude-bad')
    expect(run.failures[0]!.error.code).toBe(PANDA_ERROR_CODES.projectionNativeMalformed)
    expect(run.failures[0]!.error.message).toContain(badPath)
    expect(run.results).toHaveLength(1)
    expect(run.results[0]!.targetId).toBe('claude-good')
    expect(run.results[0]!.written).toBe(true)
    // The malformed file is untouched.
    expect(await readFile(badPath, 'utf8')).toBe('{ "broken"')
  })

  it.each([
    ['an array', '{"mcpServers": []}'],
    ['a string', '{"mcpServers": "not an object"}'],
  ])('reports a container holding %s as UNCLAIMABLE, not as corruption', async (_label, native) => {
    const homeDir = await makeHome()
    const filePath = join(homeDir, '.claude.json')
    await writeFile(filePath, native, 'utf8')

    const run = await runProjection({
      entries: groupByKind(ENTRIES),
      targets: [createClaudeMcpTarget({ filePath })],
      ledger: ledgerIn(homeDir),
    })

    expect(run.results).toEqual([])
    // The file is valid JSON. Telling the user it is malformed would be a lie.
    expect(run.failures[0]!.error.code).toBe(PANDA_ERROR_CODES.projectionNativeUnclaimable)
    expect(run.failures[0]!.error.message).toContain('cannot place entries there')
    expect(await readFile(filePath, 'utf8')).toBe(native)
  })

  it('contains duplicate-id entries with a contention-style coded error', async () => {
    const homeDir = await makeHome()
    const duplicated: RegistryEntriesByKind = {
      ...groupByKind(ENTRIES),
      'mcp-server': [
        { type: 'mcp-server', id: 'dup', command: 'one' },
        { type: 'mcp-server', id: 'dup', command: 'two' },
      ] as unknown as RegistryEntry[],
    }
    const filePath = join(homeDir, '.claude.json')
    const run = await runProjection({
      entries: duplicated,
      targets: [createClaudeMcpTarget({ filePath })],
      ledger: ledgerIn(homeDir),
    })
    expect(run.results).toEqual([])
    expect(run.failures[0]!.error.code).toBe(PANDA_ERROR_CODES.registryContention)
    expect(run.failures[0]!.error.message).toContain("'dup'")
    // Nothing landed: a render failure never half-writes a native file.
    await expect(stat(filePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('surfaces target drift verbatim and reports written:false for drift-only outcomes', async () => {
    const homeDir = await makeHome()
    const drift: DriftEntry[] = [
      {
        kind: 'edited',
        entryId: 'context7',
        location: 'mcpServers.context7',
        detail: 'edited by hand',
      },
    ]
    const staticTarget: ProjectionTarget = {
      targetId: 'drifty',
      filePath: join(homeDir, 'unused.json'),
      merge: ({ nativeText }) => ({ text: nativeText, drift, records: [], ownedSpans: [] }),
    }
    const run = await runProjection({
      entries: groupByKind(ENTRIES),
      targets: [staticTarget],
      ledger: ledgerIn(homeDir),
    })
    expect(run.failures).toEqual([])
    expect(run.results[0]).toMatchObject({ written: false, byteDelta: 0, drift })
  })

  it('reports entry kinds the target does not project through skippedEntryIds', async () => {
    const homeDir = await makeHome()
    const run = await runProjection({
      entries: groupByKind([
        ...ENTRIES,
        { type: 'profile', id: 'frontend-profile' },
      ] satisfies RegistryEntry[]),
      targets: [createClaudeMcpTarget({ filePath: join(homeDir, '.claude.json') })],
      ledger: ledgerIn(homeDir),
    })
    expect(run.results[0]!.skippedEntryIds).toEqual(['frontend-profile', 'ripgrep'])
  })

  it('keeps a failed target’s previous claims instead of forgetting what it wrote', async () => {
    const homeDir = await makeHome()
    const filePath = join(homeDir, '.claude.json')
    const target = createClaudeMcpTarget({ filePath })
    const ledger = ledgerIn(homeDir)
    await runProjection({ entries: groupByKind(ENTRIES), targets: [target], ledger })
    const claimed = (await ledger.read()).records
    expect(claimed).toHaveLength(1)

    // The file becomes unreadable for this target; its claims must survive, or
    // the next successful run would treat its own entry as foreign.
    await writeFile(filePath, '{ "broken"', 'utf8')
    const run = await runProjection({ entries: groupByKind(ENTRIES), targets: [target], ledger })

    expect(run.failures).toHaveLength(1)
    expect((await ledger.read()).records).toEqual(claimed)
  })

  it('fails the target when the file is modified between read and write', async () => {
    const homeDir = await makeHome()
    const filePath = join(homeDir, '.claude.json')
    const target = createClaudeMcpTarget({ filePath })
    await writeFile(filePath, '{}\n', 'utf8')

    // Mutate the file between the target's read hook and its write by racing
    // against the comparison helper itself.
    const originalMerge = target.merge.bind(target)
    ;(
      target as { merge: typeof target.merge }
    ).merge = async (request) => {
      const outcome = originalMerge(request)
      await utimes(filePath, new Date(), new Date(Date.now() + 5_000))
      return outcome
    }

    const run = await runProjection({
      entries: groupByKind(ENTRIES),
      targets: [target],
      ledger: ledgerIn(homeDir),
    })
    expect(run.results).toEqual([])
    expect(run.failures).toHaveLength(1)
    expect(run.failures[0]!.error.code).toBe(PANDA_ERROR_CODES.projectionTargetFailed)
    expect(run.failures[0]!.error.message).toContain('file modified during projection')
  })

  it('FAILS the target when its claims cannot be recorded', async () => {
    const homeDir = await makeHome()
    const filePath = join(homeDir, '.claude.json')
    const ledger = new ProjectionLedger({ homeDir })
    // The ledger reads fine and the write fails — a full disk, a revoked
    // permission. The read-failure path is deliberately different (see
    // ledger.test.ts): it must NOT fail targets, because it must not write.
    ;(ledger as { update: ProjectionLedger['update'] }).update = () =>
      Promise.reject(
        new PandaError(PANDA_ERROR_CODES.projectionLedgerUnavailable, 'ledger write failed: no space'),
      )

    const run = await runProjection({
      entries: groupByKind(ENTRIES),
      targets: [createClaudeMcpTarget({ filePath })],
      ledger,
    })

    // An unrecorded write is not a warning: the file already holds new bytes
    // while the ledger holds the old hash, which locks panda out of its own
    // entry forever. The caller has to know the projection did not complete —
    // and that is what `failures` carries.
    expect(run.failures[0]!.error.code).toBe(PANDA_ERROR_CODES.projectionLedgerUnavailable)

    // But the RESULT still travels, and reports the write that actually
    // happened. Suppressing it here reported `written: false` for bytes already
    // on disk, and the next run then classified them as `edited` — panda
    // accusing the user of editing what panda itself wrote, after which the
    // entry never tracks the registry again. The bytes are the evidence.
    expect(run.results).toHaveLength(1)
    expect(run.results[0]).toMatchObject({ targetId: 'claude-mcp', written: true })
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toMatchObject({
      mcpServers: { context7: { type: 'stdio' } },
    })
  })

  it('does not CREATE a config file for an empty registry', async () => {
    const homeDir = await makeHome()
    const filePath = join(homeDir, '.claude.json')
    const run = await runProjection({
      entries: groupByKind([]),
      targets: [createClaudeMcpTarget({ filePath })],
      ledger: ledgerIn(homeDir),
    })
    expect(run.failures).toEqual([])
    expect(run.results[0]).toMatchObject({ written: false, byteDelta: 0 })
    await expect(stat(filePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses to overwrite a file that APPEARED during the merge window', async () => {
    const homeDir = await makeHome()
    const filePath = join(homeDir, '.claude.json')
    const target = createClaudeMcpTarget({ filePath })
    const vendorWrote = '{"numStartups": 1}'
    const originalMerge = target.merge.bind(target)
    ;(target as { merge: typeof target.merge }).merge = async (request) => {
      const outcome = await originalMerge(request)
      // The vendor CLI creates its own state file while panda is merging.
      await writeFile(filePath, vendorWrote, 'utf8')
      return outcome
    }

    const run = await runProjection({
      entries: groupByKind(ENTRIES),
      targets: [target],
      ledger: ledgerIn(homeDir),
    })

    expect(run.results).toEqual([])
    expect(run.failures[0]!.error.message).toContain('file modified during projection')
    expect(await readFile(filePath, 'utf8')).toBe(vendorWrote)
  })
})

describe('hasFileChangedSince', () => {
  it('detects mtime and size changes and ignores an absent-file snapshot', async () => {
    const dir = await makeHome()
    const filePath = join(dir, 'file.txt')
    await writeFile(filePath, 'abc', 'utf8')
    const snapshot = await stat(filePath).then((stats) => ({
      mtimeMs: stats.mtimeMs,
      size: stats.size,
    }))
    expect(await hasFileChangedSince(filePath, snapshot)).toBe(false)

    await writeFile(filePath, 'abcd', 'utf8')
    expect(await hasFileChangedSince(filePath, snapshot)).toBe(true)

    await utimes(filePath, new Date(), new Date(Date.now() + 9_000))
    expect(await hasFileChangedSince(filePath, snapshot)).toBe(true)
  })

  it('treats an absent snapshot as "the file must still be absent"', async () => {
    const dir = await makeHome()
    const missing = join(dir, 'not-there.json')
    expect(await hasFileChangedSince(missing, undefined)).toBe(false)
    await writeFile(missing, 'someone else wrote me', 'utf8')
    expect(await hasFileChangedSince(missing, undefined)).toBe(true)
  })
})

describe('unprojectable entry ids', () => {
  it('fails coded rather than using a prototype key as a native location', async () => {
    const homeDir = await makeHome()
    const poisoned: RegistryEntriesByKind = {
      tool: [],
      skill: [],
      'mcp-server': [
        { type: 'mcp-server', id: '__proto__', command: 'evil' } as unknown as RegistryEntry,
      ],
      profile: [],
    }
    const run = await runProjection({
      entries: poisoned,
      targets: [createClaudeMcpTarget({ filePath: join(homeDir, '.claude.json') })],
      ledger: ledgerIn(homeDir),
    })
    expect(run.results).toEqual([])
    expect(run.failures[0]!.error).toBeInstanceOf(PandaError)
    expect(run.failures[0]!.error.code).toBe(PANDA_ERROR_CODES.registryInvalidEntry)
    expect(run.failures[0]!.error.message).toContain("'__proto__'")
  })
})

describe.skipIf(process.platform === 'win32')('atomic write file modes', () => {
  it('copies the previous permissions onto the replaced file', async () => {
    const dir = await makeHome()
    const filePath = join(dir, '.claude.json')
    await writeFile(filePath, '{}\n', 'utf8')
    await chmod(filePath, 0o600)
    await runProjection({
      entries: groupByKind(ENTRIES),
      targets: [createClaudeMcpTarget({ filePath })],
      ledger: ledgerIn(dir),
    })
    expect((await stat(filePath)).mode & 0o777).toBe(0o600)
  })
})

// --- The two ways a projection could damage state it does not own ----------

describe('projection never replaces what it was pointed at', () => {
  it('writes THROUGH a symlinked config instead of replacing the link', async () => {
    const homeDir = await makeHome()
    const dotfiles = join(homeDir, 'dotfiles')
    await mkdir(dotfiles, { recursive: true })
    const real = join(dotfiles, 'claude.json')
    await writeFile(real, '{\n  "numStartups": 3\n}\n', 'utf8')
    const link = join(homeDir, '.claude.json')
    try {
      await symlink(real, link)
    } catch {
      // Windows without Developer Mode refuses symlink() for unprivileged users;
      // the clause is real everywhere it can be created.
      return
    }

    const run = await runProjection({
      entries: groupByKind(ENTRIES),
      targets: [createClaudeMcpTarget({ filePath: link })],
      ledger: ledgerIn(homeDir),
    })
    expect(run.failures).toEqual([])
    expect(run.results[0]!.written).toBe(true)

    // `~/.claude.json -> ~/dotfiles/claude.json` is how these files are kept in
    // a repo. A rename over the link leaves a regular file, orphans the source,
    // and every later edit in the dotfiles repo goes nowhere — silently, exit 0.
    expect((await lstat(link)).isSymbolicLink()).toBe(true)
    const source = JSON.parse(await readFile(real, 'utf8')) as Record<string, unknown>
    expect(source['numStartups']).toBe(3)
    expect(source['mcpServers']).toMatchObject({ context7: { type: 'stdio' } })
  })

  it('refuses a dangling symlink with a code instead of materialising a file', async () => {
    const homeDir = await makeHome()
    const link = join(homeDir, '.claude.json')
    try {
      await symlink(join(homeDir, 'nowhere', 'claude.json'), link)
    } catch {
      return
    }
    const run = await runProjection({
      entries: groupByKind(ENTRIES),
      targets: [createClaudeMcpTarget({ filePath: link })],
      ledger: ledgerIn(homeDir),
    })
    expect(run.results).toEqual([])
    expect(run.failures[0]!.error.code).toBe(PANDA_ERROR_CODES.projectionNativeUnclaimable)
    expect((await lstat(link)).isSymbolicLink()).toBe(true)
  })

  it('names the file and the reason when the config path is not a readable file', async () => {
    const homeDir = await makeHome()
    const filePath = join(homeDir, '.claude.json')
    await mkdir(filePath, { recursive: true })
    const run = await runProjection({
      entries: groupByKind(ENTRIES),
      targets: [createClaudeMcpTarget({ filePath })],
      ledger: ledgerIn(homeDir),
    })
    // A bare EISDIR names neither the path nor what panda wanted with it.
    expect(run.failures[0]!.error.code).toBe(PANDA_ERROR_CODES.projectionNativeUnclaimable)
    expect(run.failures[0]!.error.message).toContain(filePath)
    expect(run.failures[0]!.error.message).toContain('EISDIR')
  })
})

describe('two ledgers over one file cannot lose a claim', () => {
  it('keeps both claims when concurrent runs share the ledger path', async () => {
    const homeDir = await makeHome()
    const machineFile = join(homeDir, '.claude.json')
    const projectFile = join(homeDir, 'project', '.mcp.json')
    await mkdir(join(homeDir, 'project'), { recursive: true })

    // Two ProjectionLedger INSTANCES over the same document, which is exactly
    // what `initMachine()` and `initProject()` running concurrently are. An
    // instance-scoped queue serialises neither, and `update` rewrites the whole
    // document from a read taken before the other one wrote: one claim is lost
    // permanently and its entry is a foreign collision from then on.
    await Promise.all([
      runProjection({
        entries: groupByKind(ENTRIES),
        targets: [createClaudeMcpTarget({ filePath: machineFile })],
        ledger: new ProjectionLedger({ homeDir }),
      }),
      runProjection({
        entries: groupByKind(ENTRIES),
        targets: [createClaudeMcpTarget({ filePath: projectFile })],
        ledger: new ProjectionLedger({ homeDir }),
      }),
    ])

    const ledger = await new ProjectionLedger({ homeDir }).read()
    expect(ledger.state).toBe('readable')
    expect(ledger.records.map((record) => record.filePath).sort()).toEqual(
      [resolve(machineFile), resolve(projectFile)].sort(),
    )
  })
})
