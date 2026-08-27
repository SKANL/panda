import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { RegistryStore } from '@panda/registry'
import { afterAll, describe, expect, it } from 'vitest'
import { DIAGNOSIS_FINDING_KINDS, diagnose, hasProblem } from '../src/doctor.ts'
import type { Diagnosis, DiagnosisFinding, DiagnosisFindingKind } from '../src/doctor.ts'
import { initMachine, initProject } from '../src/init.ts'

// `panda doctor`, row by row against the spec's I/O matrix.
//
// The clause this file exists for is "writes NOTHING". It is proven by hashing
// every byte under the scope — vendor files, panda's own directories, the
// registry, the ledger — before and after, and comparing the two maps; a
// diagnosis that created a directory, seeded a registry or rewrote a ledger with
// identical bytes all fail it. The states where writing is most tempting get
// their own rows: nothing initialised at all, and a ledger panda cannot read.

const tempRoots: string[] = []
afterAll(() => Promise.all(tempRoots.map((dir) => rm(dir, { recursive: true, force: true }))))

interface Fixture {
  /** The parent of both directories: what the byte snapshot covers. */
  readonly root: string
  readonly homeDir: string
  readonly projectDir: string
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'panda-doctor-'))
  tempRoots.push(root)
  const homeDir = join(root, 'home')
  const projectDir = join(root, 'project')
  await mkdir(homeDir, { recursive: true })
  await mkdir(projectDir, { recursive: true })
  return { root, homeDir, projectDir }
}

/**
 * Every byte under `root`, keyed by relative path — plus size and mtime, and
 * directories as their own entries. Contents alone would pass an mtime-only
 * touch and a created-but-empty `.panda`; both are writes.
 */
async function snapshot(root: string): Promise<Map<string, string>> {
  const bytes = new Map<string, string>()
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      const key = relative(root, path).replaceAll('\\', '/')
      const stats = await stat(path)
      const stamp = `${stats.size}@${stats.mtimeMs}`
      if (entry.isDirectory()) {
        bytes.set(`${key}/`, `<directory> ${stamp}`)
        await walk(path)
      } else if (entry.isFile()) {
        bytes.set(key, `${createHash('sha256').update(await readFile(path)).digest('hex')} ${stamp}`)
      } else {
        bytes.set(key, `<other> ${stamp}`)
      }
    }
  }
  await walk(root)
  return bytes
}

async function register(homeDir: string, entry: Record<string, unknown>): Promise<void> {
  const store = new RegistryStore({ homeDir })
  await store.register(entry, 'global')
  await store.dispose()
}

/**
 * A directory where Codex's config file belongs: the vendor config panda cannot
 * read at all, which is the per-target isolation row. A malformed TOML body is
 * NOT interchangeable here — the TOML strategy accepts more than it looks like it
 * does, and a fixture that never reaches the failure branch proves nothing.
 */
async function unreadableCodexConfig(homeDir: string): Promise<string> {
  const path = join(homeDir, '.codex', 'config.toml')
  await rm(path, { force: true })
  await mkdir(path, { recursive: true })
  return path
}

/** Claude Code present and its MCP file readable; the shape most rows start from. */
async function withClaude(homeDir: string, body = '{}\n'): Promise<string> {
  const path = join(homeDir, '.claude.json')
  await writeFile(path, body, 'utf8')
  return path
}

function kinds(diagnosis: Diagnosis): DiagnosisFindingKind[] {
  return diagnosis.findings.map((found) => found.kind)
}

function only(diagnosis: Diagnosis, kind: DiagnosisFindingKind): DiagnosisFinding {
  const matches = diagnosis.findings.filter((found) => found.kind === kind)
  expect(matches, `expected exactly one '${kind}' finding in ${JSON.stringify(kinds(diagnosis))}`).toHaveLength(1)
  return matches[0]!
}

describe('panda doctor writes nothing', () => {
  it('leaves every byte under the scope identical, on a machine with no panda state at all', async () => {
    const { root, homeDir } = await fixture()
    await withClaude(homeDir)
    const before = await snapshot(root)

    const diagnosis = await diagnose({ homeDir })

    // The tempting writes, all of them: `.panda/`, the registry document, the
    // ledger, and the vendor file panda would place an entry in.
    expect(await snapshot(root)).toEqual(before)
    await expect(stat(diagnosis.pandaDir)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(diagnosis.ledgerPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(kinds(diagnosis)).toContain('not-initialised')
  })

  it('leaves every byte identical over a ledger it cannot read', async () => {
    const { root, homeDir } = await fixture()
    await withClaude(homeDir)
    await register(homeDir, { type: 'mcp-server', id: 'ctx', command: 'ctx-server', args: [] })
    await initMachine({ homeDir })
    // Panda's own record of what it owns, corrupted. Reseeding it would orphan
    // every claim it holds — this is the state a "harmless" repair breaks.
    const ledgerPath = join(homeDir, '.panda', 'projection-ledger.json')
    await writeFile(ledgerPath, '{ broken', 'utf8')
    const before = await snapshot(root)

    const diagnosis = await diagnose({ homeDir })

    expect(await snapshot(root)).toEqual(before)
    expect(await readFile(ledgerPath, 'utf8')).toBe('{ broken')
    // Reported as a problem, never as a clean bill of health.
    expect(only(diagnosis, 'ledger-damaged').detail).toContain('PANDA_PROJECTION_LEDGER_UNAVAILABLE')
    expect(diagnosis.findings.length).toBeGreaterThan(0)
  })

  it('leaves every byte identical with drift, an unprojectable entry and a broken vendor file at once', async () => {
    const { root, homeDir } = await fixture()
    const claudeJson = await withClaude(homeDir)
    await mkdir(join(homeDir, '.codex'), { recursive: true })
    await register(homeDir, { type: 'mcp-server', id: 'ctx', command: 'ctx-server', args: [] })
    await register(homeDir, { type: 'tool', id: 'ripgrep', command: 'rg' })
    await initMachine({ homeDir })
    await writeFile(claudeJson, (await readFile(claudeJson, 'utf8')).replace('"ctx-server"', '"edited"'), 'utf8')
    await unreadableCodexConfig(homeDir)
    // Registered AFTER the projection, so there is a real pending write in this
    // state: without one the snapshot would pass even if inspection landed
    // bytes, because there would be no bytes to land.
    await register(homeDir, { type: 'mcp-server', id: 'fresh', command: 'fresh-server', args: [] })
    const before = await snapshot(root)

    const diagnosis = await diagnose({ homeDir })

    expect(await snapshot(root)).toEqual(before)
    expect(kinds(diagnosis)).toEqual(
      expect.arrayContaining(['out-of-date', 'edited', 'unprojectable', 'target-failed']),
    )
  })
})

describe('panda doctor reports what projecting would do', () => {
  it('finds nothing on an environment that was just projected', async () => {
    const { homeDir } = await fixture()
    await withClaude(homeDir)
    await register(homeDir, { type: 'mcp-server', id: 'ctx', command: 'ctx-server', args: [] })
    await initMachine({ homeDir })

    const diagnosis = await diagnose({ homeDir })

    expect(diagnosis.findings).toEqual([])
    expect(diagnosis.targets).toEqual([
      {
        executorId: 'claude-code',
        targetId: 'claude-mcp',
        filePath: join(homeDir, '.claude.json'),
        wouldWrite: false,
        drift: [],
        unprojectable: [],
      },
    ])
    expect(diagnosis.scope).toBe('machine')
    expect(diagnosis.entryCount).toBe(1)
    // A documented payload, so its key order is authored rather than inherited
    // from a rest object — the same defect that moved `written` in `init`.
    expect(Object.keys(diagnosis.targets[0]!)).toEqual([
      'executorId',
      'targetId',
      'filePath',
      'wouldWrite',
      'drift',
      'unprojectable',
    ])
  })

  it('converges: doctor finds work, project init does it, and doctor is then clean', async () => {
    const { homeDir, projectDir } = await fixture()
    await withClaude(homeDir)
    await register(homeDir, { type: 'mcp-server', id: 'ctx', command: 'ctx-server', args: [] })

    const before = await diagnose({ homeDir, scope: 'project', projectDir })
    const pending = only(before, 'out-of-date')
    expect(pending.executorId).toBe('claude-code')
    expect(pending.filePath).toBe(join(projectDir, '.mcp.json'))
    expect(before.targets[0]?.wouldWrite).toBe(true)

    // The write doctor predicted, performed by the command that owns writing.
    const applied = await initProject({ homeDir, projectDir })
    expect(applied.targets[0]?.written).toBe(true)
    expect(applied.targets[0]?.filePath).toBe(pending.filePath)

    const after = await diagnose({ homeDir, scope: 'project', projectDir })
    expect(after.findings).toEqual([])
    expect(after.targets[0]?.wouldWrite).toBe(false)
  })

  it('reports a hand-edited entry as `edited`, naming the executor, file, location and entry', async () => {
    const { homeDir } = await fixture()
    const claudeJson = await withClaude(homeDir)
    await register(homeDir, { type: 'mcp-server', id: 'ctx', command: 'ctx-server', args: [] })
    await initMachine({ homeDir })
    await writeFile(claudeJson, (await readFile(claudeJson, 'utf8')).replace('"ctx-server"', '"mine"'), 'utf8')

    const found = only(await diagnose({ homeDir }), 'edited')

    expect(found).toMatchObject({
      executorId: 'claude-code',
      filePath: claudeJson,
      location: 'mcpServers.ctx',
      entryId: 'ctx',
    })
    expect(found.detail).toContain('has been edited since panda wrote it')
    expect(found.resolution).toContain('never overwrites')
  })

  it('reports a deleted entry as `removed-by-user`, distinctly from `edited`', async () => {
    const { homeDir } = await fixture()
    const claudeJson = await withClaude(homeDir)
    await register(homeDir, { type: 'mcp-server', id: 'ctx', command: 'ctx-server', args: [] })
    await initMachine({ homeDir })
    await writeFile(claudeJson, '{}\n', 'utf8')

    const diagnosis = await diagnose({ homeDir })

    expect(kinds(diagnosis)).toEqual(['removed-by-user'])
    expect(only(diagnosis, 'removed-by-user')).toMatchObject({ entryId: 'ctx', location: 'mcpServers.ctx' })
    expect(only(diagnosis, 'removed-by-user').resolution).toContain('never re-adds')
  })

  it('reports a non-panda entry at a location panda would write as `foreign-collision`', async () => {
    const { homeDir } = await fixture()
    const claudeJson = await withClaude(
      homeDir,
      '{\n  "mcpServers": {\n    "ctx": { "type": "stdio", "command": "theirs", "args": [] }\n  }\n}\n',
    )
    await register(homeDir, { type: 'mcp-server', id: 'ctx', command: 'ctx-server', args: [] })

    const found = only(await diagnose({ homeDir }), 'foreign-collision')

    expect(found).toMatchObject({ executorId: 'claude-code', filePath: claudeJson, entryId: 'ctx' })
    // Panda states plainly that it will not resolve it — in the finding and in
    // what it says re-projecting would do.
    expect(found.detail).toContain('panda will not resolve the collision')
    expect(found.resolution).toContain('never resolves a collision')
  })

  it('reports an entry no target can express, per target, with the reason', async () => {
    const { homeDir } = await fixture()
    await withClaude(homeDir)
    await mkdir(join(homeDir, '.codex'), { recursive: true })
    await register(homeDir, { type: 'tool', id: 'ripgrep', command: 'rg' })

    const diagnosis = await diagnose({ homeDir })

    // Per target: both detected executors report it, each in its own name.
    expect(diagnosis.findings.filter((found) => found.kind === 'unprojectable')).toEqual([
      {
        kind: 'unprojectable',
        severity: 'info',
        executorId: 'claude-code',
        filePath: join(homeDir, '.claude.json'),
        entryId: 'ripgrep',
        detail: "'claude-code' has no native representation for a tool entry (correction-01 C5)",
        resolution: expect.stringContaining('no target can express this entry'),
      },
      {
        kind: 'unprojectable',
        severity: 'info',
        executorId: 'codex',
        filePath: join(homeDir, '.codex', 'config.toml'),
        entryId: 'ripgrep',
        detail: "'codex' has no native representation for a tool entry (correction-01 C5)",
        resolution: expect.stringContaining('no target can express this entry'),
      },
    ])
  })

  it('isolates a broken vendor config: that target is reported failed, the others are still diagnosed', async () => {
    const { homeDir } = await fixture()
    await withClaude(homeDir, 'this is not json')
    await mkdir(join(homeDir, '.codex'), { recursive: true })
    await register(homeDir, { type: 'mcp-server', id: 'ctx', command: 'ctx-server', args: [] })

    const diagnosis = await diagnose({ homeDir })

    const failed = only(diagnosis, 'target-failed')
    expect(failed).toMatchObject({ executorId: 'claude-code', filePath: join(homeDir, '.claude.json') })
    expect(failed.detail).toContain('PANDA_PROJECTION_NATIVE_MALFORMED')
    // Codex was diagnosed anyway, and says what projecting would do to it.
    const codex = diagnosis.targets.find((target) => target.executorId === 'codex')
    expect(codex?.error).toBeUndefined()
    expect(codex?.wouldWrite).toBe(true)
  })

  it('says plainly that nothing is initialised, and stays quiet about a project it was not asked about', async () => {
    const { homeDir, projectDir } = await fixture()
    await withClaude(homeDir)

    const machine = await diagnose({ homeDir })
    expect(only(machine, 'not-initialised').detail).toContain(join(homeDir, '.panda'))
    // The machine scope never reports on a project directory.
    expect(machine.pandaDir).toBe(join(homeDir, '.panda'))
    expect(JSON.stringify(machine)).not.toContain(projectDir)

    // And the project scope answers for the project, not the machine.
    const project = await diagnose({ homeDir, scope: 'project', projectDir })
    expect(only(project, 'not-initialised').detail).toContain(join(projectDir, '.panda'))
  })

  it('fails coded, rather than diagnosing, when the directory it was pointed at cannot be used', async () => {
    const { homeDir, root } = await fixture()
    await expect(
      diagnose({ homeDir, scope: 'project', projectDir: join(root, 'no', 'such', 'project') }),
    ).rejects.toMatchObject({ code: 'PANDA_ENVIRONMENT_SCOPE_UNAVAILABLE' })
  })
})

describe('the exit code is a promise a script can keep', () => {
  it('does not call a machine initialised because some OTHER scope created panda-s directory', async () => {
    // Reproduction: `project init` binds a project, and the ledger's own first
    // write creates `<home>/.panda` as a side effect. Keyed on the DIRECTORY,
    // the machine scope then reads as initialised forever — on the ordinary
    // path. `panda init` has still never run here.
    const { homeDir, projectDir } = await fixture()
    await withClaude(homeDir)
    await initProject({ homeDir, projectDir })
    expect((await stat(join(homeDir, '.panda'))).isDirectory()).toBe(true)

    const machine = await diagnose({ homeDir })

    expect(kinds(machine)).toContain('not-initialised')
    expect(only(machine, 'not-initialised').filePath).toBe(join(homeDir, '.panda', 'registry.json'))
    expect(hasProblem(machine)).toBe(true)
    // And the project scope, which WAS initialised, does not claim otherwise.
    expect(kinds(await diagnose({ homeDir, scope: 'project', projectDir }))).not.toContain('not-initialised')
  })

  it('reports no-executor as a finding, so it cannot certify what `panda init` refuses', async () => {
    // `panda init` exits 2 on this exact state. A doctor calling it clean makes
    // `panda doctor && panda init` run init on a certified environment and fail.
    const { homeDir } = await fixture()
    await initMachine({ homeDir }).catch(() => undefined)

    const diagnosis = await diagnose({ homeDir })

    expect(kinds(diagnosis)).toContain('no-executor')
    expect(only(diagnosis, 'no-executor').detail).toContain('claude-code')
    expect(hasProblem(diagnosis)).toBe(true)
  })

  it('never fails on an unprojectable entry alone, because no command can get back to 0', async () => {
    // A `tool` entry is an ordinary thing to register and is unprojectable by
    // every executor permanently. Reported in full (correction-01 C5), and NOT
    // counted as a problem — an exit 1 nothing can clear is a stuck light.
    const { homeDir } = await fixture()
    await withClaude(homeDir)
    await register(homeDir, { type: 'tool', id: 'ripgrep', command: 'rg' })
    await initMachine({ homeDir })

    const diagnosis = await diagnose({ homeDir })

    expect(kinds(diagnosis)).toEqual(['unprojectable'])
    expect(diagnosis.findings.every((found) => found.severity === 'info')).toBe(true)
    expect(hasProblem(diagnosis)).toBe(false)
  })
})

// --- The two rows below are DIFFERENTIAL ------------------------------------
//
// The invariant is not "a 0444 file is reported not-writable". It is that
// doctor's verdict and what `panda init` really does never disagree — which is
// this spec's whole thesis, and which a fixed mode number quietly replaced with
// one platform's semantics. `chmod(file, 0o444)` blocks nothing on POSIX,
// because panda writes through a temp file renamed over the target and rename()
// consults the containing DIRECTORY, never the mode of the name it replaces; on
// win32 the read-only attribute is exactly what refuses the rename, and a 0555
// directory is what blocks nothing. So each row builds the state that is
// genuinely unwritable HERE, proves it by attempting the real write, and only
// then asks doctor to agree with the outcome that was observed.

/**
 * Performs EXACTLY the write a projection performs — a temp file created in the
 * target's own directory, renamed over the target — carrying the target's
 * current bytes, so landing it proves the location accepts writes while
 * changing nothing about what is there.
 */
async function writeLands(target: string): Promise<boolean> {
  const temp = `${target}.control-write.tmp`
  const { mode } = await stat(target)
  try {
    await writeFile(temp, await readFile(target))
    await rename(temp, target)
  } catch {
    await rm(temp, { force: true }).catch(() => {})
    return false
  }
  // The rename replaced the INODE, so the target now wears the temp file's mode
  // — the control would otherwise destroy the very state it was performed on,
  // and the diagnosis below would be about a file that no longer exists.
  await chmod(target, mode)
  return true
}

/**
 * Makes `target` a location panda cannot write, whichever way actually blocks
 * the temp+rename on this platform, and returns the undo — or `undefined` when
 * the control write landed anyway, which means the state this test needs could
 * not be produced here (running as root, a filesystem that ignores modes) and
 * the caller must skip rather than assert something untrue.
 */
async function unwritable(target: string): Promise<(() => Promise<void>) | undefined> {
  const [path, closed, open] =
    process.platform === 'win32' ? [target, 0o444, 0o666] : [dirname(target), 0o555, 0o777]
  await chmod(path, closed)
  const undo = (): Promise<void> => chmod(path, open)
  if (await writeLands(target)) {
    await undo()
    return undefined
  }
  return undo
}

const CANNOT_BLOCK = `could not make the location unwritable on ${process.platform}: the control write landed anyway, so there is no unwritable state to diagnose here`

describe('panda doctor never promises a write panda cannot perform', () => {
  it('reports an unwritable vendor location as not-writable instead of out-of-date', async (context) => {
    const { homeDir } = await fixture()
    const claudeJson = await withClaude(homeDir)
    await register(homeDir, { type: 'mcp-server', id: 'ctx', command: 'ctx-server', args: [] })
    await initMachine({ homeDir })
    // The entry changes, so projecting would rewrite the file — and cannot.
    await register(homeDir, { type: 'mcp-server', id: 'ctx', command: 'ctx-server-2', args: [] })
    const undo = await unwritable(claudeJson)
    // `return`, not a bare call: `skip` throws, but its `never` is not narrowed
    // through a contextually-typed parameter, so the `finally` below would read
    // as possibly-undefined without it.
    if (undo === undefined) return context.skip(CANNOT_BLOCK)
    try {
      const diagnosis = await diagnose({ homeDir })

      expect(kinds(diagnosis)).toContain('not-writable')
      expect(kinds(diagnosis)).not.toContain('out-of-date')
      expect(only(diagnosis, 'not-writable')).toMatchObject({
        executorId: 'claude-code',
        filePath: claudeJson,
        severity: 'problem',
      })
      // The reproduction: `panda init` really does fail this write.
      const applied = await initMachine({ homeDir })
      expect(applied.targets[0]?.written).toBe(false)
      expect(applied.targets[0]?.error?.code).toBe('PANDA_PROJECTION_TARGET_FAILED')
      // And doctor says the same thing again afterwards, rather than promising
      // a write that already failed once.
      expect(kinds(await diagnose({ homeDir }))).toContain('not-writable')
    } finally {
      await undo()
    }
  })

  it('agrees with the write that lands, on the very state the other platform refuses', async () => {
    const { homeDir } = await fixture()
    const claudeJson = await withClaude(homeDir)
    await register(homeDir, { type: 'mcp-server', id: 'ctx', command: 'ctx-server', args: [] })
    await initMachine({ homeDir })
    await register(homeDir, { type: 'mcp-server', id: 'ctx', command: 'ctx-server-2', args: [] })
    // The control for the row above: a 0444 target inside a writable directory
    // is unwritable on win32 and perfectly writable on POSIX. Whichever it is
    // here, doctor must say the same thing the write itself does — asserting a
    // fixed kind on this state is what shipped a finding CI could disprove.
    await chmod(claudeJson, 0o444)
    try {
      const blocked = !(await writeLands(claudeJson))
      expect(kinds(await diagnose({ homeDir })).includes('not-writable')).toBe(blocked)
      const applied = await initMachine({ homeDir })
      expect(applied.targets[0]?.written).toBe(!blocked)
    } finally {
      await chmod(claudeJson, 0o666)
    }
  })

  it('reports an unwritable ledger, which inspection can never discover by failing', async (context) => {
    const { homeDir } = await fixture()
    await withClaude(homeDir)
    await register(homeDir, { type: 'mcp-server', id: 'ctx', command: 'ctx-server', args: [] })
    const applied = await initMachine({ homeDir })
    const undo = await unwritable(applied.ledgerPath)
    // `return`, not a bare call: `skip` throws, but its `never` is not narrowed
    // through a contextually-typed parameter, so the `finally` below would read
    // as possibly-undefined without it.
    if (undo === undefined) return context.skip(CANNOT_BLOCK)
    try {
      const diagnosis = await diagnose({ homeDir })

      // The target row itself is completely clean — panda's own ledger is where
      // the failure is born, and it is the write inspection skips.
      expect(diagnosis.targets[0]).toMatchObject({ wouldWrite: false, drift: [], unprojectable: [] })
      expect(only(diagnosis, 'not-writable').filePath).toBe(applied.ledgerPath)
      expect(hasProblem(diagnosis)).toBe(true)
      // The reproduction: an unwritable ledger fails EVERY target of a run that
      // would otherwise be a no-op.
      const second = await initMachine({ homeDir })
      expect(second.targets[0]?.error?.code).toBe('PANDA_PROJECTION_LEDGER_UNAVAILABLE')
    } finally {
      await undo()
    }
  })
})

describe('panda-s own two state files are diagnosed the same way', () => {
  it('reports an unreadable registry as a finding, not as an exception with no JSON', async () => {
    const { root, homeDir } = await fixture()
    await withClaude(homeDir)
    await register(homeDir, { type: 'mcp-server', id: 'ctx', command: 'ctx-server', args: [] })
    const registryPath = join(homeDir, '.panda', 'registry.json')
    await writeFile(registryPath, '{ not json', 'utf8')
    const before = await snapshot(root)

    const diagnosis = await diagnose({ homeDir })

    expect(only(diagnosis, 'registry-unreadable')).toMatchObject({
      filePath: registryPath,
      severity: 'problem',
    })
    expect(only(diagnosis, 'registry-unreadable').detail).toContain('PANDA_REGISTRY_STORE_UNAVAILABLE')
    // No per-target verdict is invented from a registry panda could not read.
    expect(diagnosis.targets).toEqual([])
    expect(diagnosis.entryCount).toBe(0)
    expect(await snapshot(root)).toEqual(before)
    // `panda init` still refuses outright: it must not project against it.
    await expect(initMachine({ homeDir })).rejects.toMatchObject({ code: 'PANDA_REGISTRY_STORE_UNAVAILABLE' })
  })
})

describe('every finding names what it is about', () => {
  /** The partition every finding is judged against; it must cover every kind. */
  const SCOPE_LEVEL: DiagnosisFindingKind[] = ['no-executor', 'projection-warning']
  const PANDA_STATE: DiagnosisFindingKind[] = ['not-initialised', 'registry-unreadable', 'ledger-damaged']
  const TARGET_SCOPED: DiagnosisFindingKind[] = ['target-failed', 'out-of-date', 'not-writable', 'legacy-block']
  const ENTRY_SCOPED: DiagnosisFindingKind[] = ['edited', 'removed-by-user', 'foreign-collision', 'unprojectable']

  it('partitions every kind that exists, so no kind escapes the rule below', () => {
    // Derived from the total RESOLUTION record, not hand-listed: a new kind
    // lands here as a missing partition entry rather than as silence.
    expect([...SCOPE_LEVEL, ...PANDA_STATE, ...TARGET_SCOPED, ...ENTRY_SCOPED].sort()).toEqual(
      [...DIAGNOSIS_FINDING_KINDS].sort(),
    )
  })

  it('carries an executor and a file for every executor-scoped kind, and an entry for every entry-scoped one', async () => {
    const { homeDir } = await fixture()
    const claudeJson = await withClaude(homeDir)
    await mkdir(join(homeDir, '.codex'), { recursive: true })
    await register(homeDir, { type: 'mcp-server', id: 'ctx', command: 'ctx-server', args: [] })
    await register(homeDir, { type: 'mcp-server', id: 'gone', command: 'gone-server', args: [] })
    await register(homeDir, { type: 'tool', id: 'ripgrep', command: 'rg' })
    await initMachine({ homeDir })
    // Two different drifts in one file, plus a target that cannot be read at all.
    const projected = JSON.parse(await readFile(claudeJson, 'utf8')) as {
      mcpServers: Record<string, { command: string }>
    }
    projected.mcpServers['ctx']!.command = 'mine'
    delete projected.mcpServers['gone']
    await writeFile(claudeJson, `${JSON.stringify(projected, null, 2)}\n`, 'utf8')
    await unreadableCodexConfig(homeDir)

    // A second scope where panda's own state is the problem, so the two
    // scope-level and panda-state kinds are exercised too rather than excluded
    // by the fixture that only produces target rows.
    const bare = await fixture()
    await writeFile(join(bare.homeDir, '.panda-not-a-dir'), 'x', 'utf8')
    const ledgerFixture = await fixture()
    await withClaude(ledgerFixture.homeDir)
    await register(ledgerFixture.homeDir, { type: 'mcp-server', id: 'ctx', command: 'ctx-server', args: [] })
    await initMachine({ homeDir: ledgerFixture.homeDir })
    await writeFile(join(ledgerFixture.homeDir, '.panda', 'projection-ledger.json'), '{ broken', 'utf8')

    const findings = [
      ...(await diagnose({ homeDir })).findings,
      ...(await diagnose({ homeDir: bare.homeDir })).findings,
      ...(await diagnose({ homeDir: ledgerFixture.homeDir })).findings,
    ]

    // The fixtures must actually reach the branches they name, or the loop below
    // asserts over an empty set and proves nothing. `projection-warning` and
    // `registry-unreadable` are deliberately NOT here — the first has no second
    // warning source to force yet (that is the point of the kind), and the
    // second has its own row above; both are still judged by the loop if they
    // ever appear.
    expect(new Set(findings.map((found) => found.kind))).toEqual(
      new Set([
        'edited',
        'removed-by-user',
        'foreign-collision',
        'unprojectable',
        'target-failed',
        'not-initialised',
        'no-executor',
        'ledger-damaged',
      ] satisfies DiagnosisFindingKind[]),
    )
    for (const found of findings) {
      expect(found.resolution.length, found.kind).toBeGreaterThan(0)
      expect(found.detail.length, found.kind).toBeGreaterThan(0)
      expect(SEVERITIES.includes(found.severity), found.kind).toBe(true)
      // A machine-level finding names no file, and must not pretend to.
      if (SCOPE_LEVEL.includes(found.kind)) {
        expect(found.executorId, found.kind).toBeUndefined()
        expect(found.filePath, found.kind).toBeUndefined()
      }
      // Panda's own state names the file it is about, and no executor.
      if (PANDA_STATE.includes(found.kind)) {
        expect(found.executorId, found.kind).toBeUndefined()
        expect(found.filePath, found.kind).toBeDefined()
      }
      if (TARGET_SCOPED.includes(found.kind) || ENTRY_SCOPED.includes(found.kind)) {
        expect(found.executorId, found.kind).toBeDefined()
        expect(found.filePath, found.kind).toBeDefined()
      }
      if (ENTRY_SCOPED.includes(found.kind)) expect(found.entryId, found.kind).toBeDefined()
      // Drift alone has a native location; unprojectable never reached one.
      if (found.kind !== 'unprojectable' && ENTRY_SCOPED.includes(found.kind)) {
        expect(found.location, found.kind).toBeDefined()
      }
    }
  })
})

const SEVERITIES = ['problem', 'info']
