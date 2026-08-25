import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { PANDA_ERROR_CODES, PandaError } from '@panda/contracts'
import type {
  DriftEntry,
  ProjectionTarget,
  RegistryEntriesByKind,
  RegistryEntry,
} from '@panda/contracts'
import { createClaudeSettingsTarget } from '../src/targets/claude-settings.ts'
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
  { type: 'skill', id: 'commit-lint', entryPath: '~/.panda/skills/commit-lint.ts' },
] satisfies RegistryEntry[]

describe('groupByKind', () => {
  it('groups registry entries by kind', () => {
    expect(groupByKind(ENTRIES)).toEqual({
      tool: [{ type: 'tool', id: 'ripgrep', command: 'rg' }],
      skill: [ENTRIES[1]],
      'mcp-server': [],
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
    const filePath = join(homeDir, '.claude', 'settings.json')
    const run = await runProjection({
      entries: groupByKind(ENTRIES),
      targets: [createClaudeSettingsTarget({ filePath })],
    })

    expect(run.failures).toEqual([])
    expect(run.results).toHaveLength(1)
    expect(run.results[0]).toMatchObject({ targetId: 'claude-settings', written: true })
    expect(run.results[0]!.byteDelta).toBeGreaterThan(0)

    // Atomic temp+rename leaves no temp files behind.
    expect(await readdir(join(homeDir, '.claude'))).toEqual(['settings.json'])
    expect(JSON.parse(await readFile(filePath, 'utf8'))['panda']).toMatchObject({
      version: 1,
      tools: { ripgrep: { command: 'rg' } },
    })
  })

  it('is idempotent on disk: the second run writes nothing and reports zero delta', async () => {
    const homeDir = await makeHome()
    const target = createClaudeSettingsTarget({
      filePath: join(homeDir, '.claude', 'settings.json'),
    })
    await runProjection({ entries: groupByKind(ENTRIES), targets: [target] })
    const before = await readFile(target.filePath, 'utf8')

    const secondRun = await runProjection({ entries: groupByKind(ENTRIES), targets: [target] })
    expect(secondRun.results[0]).toMatchObject({ written: false, byteDelta: 0, drift: [] })
    expect(await readFile(target.filePath, 'utf8')).toBe(before)
  })

  it('contains a malformed native file: only that target fails, siblings still project', async () => {
    const homeDir = await makeHome()
    const goodPath = join(homeDir, 'good', 'settings.json')
    const badDir = join(homeDir, 'bad')
    const badPath = join(badDir, 'settings.json')
    await mkdir(badDir, { recursive: true })
    await writeFile(badPath, '{ "broken"', 'utf8')

    const run = await runProjection({
      entries: groupByKind(ENTRIES),
      targets: [
        { ...createClaudeSettingsTarget({ filePath: goodPath }), targetId: 'claude-good' },
        { ...createClaudeSettingsTarget({ filePath: badPath }), targetId: 'claude-bad' },
      ],
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

  it('contains RENDER failures: unprojectable entries fail every target without throwing', async () => {
    const homeDir = await makeHome()
    const poisoned: RegistryEntriesByKind = {
      ...groupByKind(ENTRIES),
      tool: [
        { type: 'tool', id: '__proto__', command: 'evil' } as unknown as RegistryEntry,
      ],
    }
    const goodPath = join(homeDir, 'a', 'settings.json')
    const otherPath = join(homeDir, 'b', 'settings.json')

    const run = await runProjection({
      entries: poisoned,
      targets: [
        createClaudeSettingsTarget({ filePath: goodPath }),
        createClaudeSettingsTarget({ filePath: otherPath }),
      ],
    })

    expect(run.results).toEqual([])
    expect(run.failures).toHaveLength(2)
    for (const failure of run.failures) {
      expect(failure.error).toBeInstanceOf(PandaError)
      expect(failure.error.message).toContain("'__proto__'")
    }
    await expect(stat(goodPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('contains duplicate-id entries with a contention-style coded error', async () => {
    const homeDir = await makeHome()
    const duplicated: RegistryEntriesByKind = {
      ...groupByKind(ENTRIES),
      tool: [
        { type: 'tool', id: 'dup', command: 'one' },
        { type: 'tool', id: 'dup', command: 'two' },
      ] as unknown as RegistryEntry[],
    }
    const run = await runProjection({
      entries: duplicated,
      targets: [createClaudeSettingsTarget({ filePath: join(homeDir, 'settings.json') })],
    })
    expect(run.results).toEqual([])
    expect(run.failures[0]!.error.code).toBe(PANDA_ERROR_CODES.registryContention)
    expect(run.failures[0]!.error.message).toContain("'dup'")
  })

  it('surfaces target drift verbatim and reports written:false for drift-only outcomes', async () => {
    const drift: DriftEntry[] = [
      { kind: 'legacy-marker', location: '$.panda.version', detail: 'old grammar' },
    ]
    const staticTarget: ProjectionTarget = {
      targetId: 'drifty',
      filePath: join(await makeHome(), 'unused.json'),
      merge: ({ nativeText }) => ({ text: nativeText, drift }),
    }
    const run = await runProjection({ entries: groupByKind(ENTRIES), targets: [staticTarget] })
    expect(run.failures).toEqual([])
    expect(run.results[0]).toMatchObject({ written: false, byteDelta: 0, drift })

    const rewritingDriftTarget: ProjectionTarget = {
      targetId: 'drifty-writer',
      filePath: join(await makeHome(), 'unused.json'),
      merge: ({ nativeText }) => ({ text: nativeText + '\n', drift }),
    }
    const secondRun = await runProjection({
      entries: groupByKind(ENTRIES),
      targets: [rewritingDriftTarget],
    })
    expect(secondRun.results[0]).toMatchObject({ written: true, drift })
  })

  it('reports entry ids the target does not project through skippedEntryIds', async () => {
    const homeDir = await makeHome()
    const run = await runProjection({
      entries: groupByKind([
        ...ENTRIES,
        { type: 'profile', id: 'frontend-profile' },
      ] satisfies RegistryEntry[]),
      targets: [createClaudeSettingsTarget({ filePath: join(homeDir, 'settings.json') })],
    })
    expect(run.results[0]!.skippedEntryIds).toEqual(['frontend-profile'])
  })

  it('fails the target when the file is modified between read and write', async () => {
    const homeDir = await makeHome()
    const filePath = join(homeDir, 'settings.json')
    const target = createClaudeSettingsTarget({ filePath })
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

    const run = await runProjection({ entries: groupByKind(ENTRIES), targets: [target] })
    expect(run.results).toEqual([])
    expect(run.failures).toHaveLength(1)
    expect(run.failures[0]!.error.code).toBe(PANDA_ERROR_CODES.projectionTargetFailed)
    expect(run.failures[0]!.error.message).toContain('file modified during projection')
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
    expect(await hasFileChangedSince(filePath, undefined)).toBe(false)
  })
})

describe.skipIf(process.platform === 'win32')('atomic write file modes', () => {
  it('copies the previous permissions onto the replaced file', async () => {
    const dir = await makeHome()
    const filePath = join(dir, 'settings.json')
    await writeFile(filePath, '{}\n', 'utf8')
    await chmod(filePath, 0o600)
    await runProjection({ entries: groupByKind(ENTRIES), targets: [createClaudeSettingsTarget({ filePath })] })
    expect((await stat(filePath)).mode & 0o777).toBe(0o600)
  })
})
