import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { DRIFT_KINDS, REMEDIATION_KINDS } from '@panda/contracts'
import type { RemediationKind } from '@panda/contracts'
import { RegistryStore } from '@panda/registry'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DIAGNOSIS_FINDING_KINDS, FINDING_EXITS, diagnose, findingKindsFor } from '../src/doctor.ts'
import type { DiagnosisFindingKind } from '../src/doctor.ts'
import { initMachine } from '../src/init.ts'
import { remediate } from '../src/remediate.ts'
import { snapshotRealSkillsRoots } from './real-skills-roots.ts'

// "Every state panda reports has a way out", proven twice over.
//
// FIRST, STRUCTURALLY: the set of reportable states and the set of exits are
// both DERIVED — the kinds from doctor's own total `RESOLUTION` record, the
// verbs from the contracts' `REMEDIATION_KINDS` — and asserted to match. A hand
// written list of pairs would fall behind either side silently, which is the
// failure mode this proof exists to remove.
//
// SECOND, BY EXECUTION: every state whose exit is a remediation panda performs
// is BUILT on a real filesystem, reported by `panda doctor`, remediated, and
// reported again — and the finding has to be gone. The builder table is keyed by
// finding kind and its keys are asserted against the derived set, so a new
// remediation-backed state ships with a case that enters and leaves it or the
// suite goes red.

const tempRoots: string[] = []
let realRootsBefore: string

// Taken BEFORE the first test rather than lazily at the first fixture: the point
// is that nothing in this file reaches the developer's real skills roots, and a
// snapshot taken after some of the file has already run cannot say that.
beforeAll(async () => {
  realRootsBefore = await snapshotRealSkillsRoots()
})

afterAll(async () => {
  await Promise.all(tempRoots.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})))
  expect(await snapshotRealSkillsRoots()).toBe(realRootsBefore)
})

interface Fixture {
  readonly root: string
  readonly homeDir: string
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'panda-remediate-env-'))
  tempRoots.push(root)
  const homeDir = join(root, 'home')
  await mkdir(homeDir, { recursive: true })
  return { root, homeDir }
}

/** Every byte under `root`, keyed by relative path, with directories as entries. */
async function snapshot(root: string): Promise<Map<string, string>> {
  const bytes = new Map<string, string>()
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      const key = relative(root, path).replaceAll('\\', '/')
      if (entry.isDirectory()) {
        bytes.set(`${key}/`, '<directory>')
        await walk(path)
        continue
      }
      bytes.set(key, createHash('sha256').update(await readFile(path)).digest('hex'))
    }
  }
  await walk(root)
  return bytes
}

function changedPaths(before: Map<string, string>, after: Map<string, string>): string[] {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((key) => before.get(key) !== after.get(key))
    .sort()
}

async function register(homeDir: string, entry: Record<string, unknown>): Promise<void> {
  const store = new RegistryStore({ homeDir })
  await store.register(entry, 'global')
  await store.dispose()
}

async function withClaude(homeDir: string, body = '{}\n'): Promise<string> {
  const path = join(homeDir, '.claude.json')
  await writeFile(path, body, 'utf8')
  return path
}

async function kindsReported(homeDir: string): Promise<DiagnosisFindingKind[]> {
  return (await diagnose({ homeDir })).findings.map((found) => found.kind)
}

// --- the totality proof, structurally ---------------------------------------

describe('every state panda reports has an exit', () => {
  it('maps EXACTLY the finding kinds doctor can report, with neither side hand-listed', () => {
    // `DIAGNOSIS_FINDING_KINDS` is derived from the same `RESOLUTION` record
    // doctor phrases its findings from, so the two cannot drift; the exits are a
    // `Record` over the same union, so a kind added without one does not
    // compile. This is the runtime half: it catches a kind whose exit was
    // deleted as well as one that was never added.
    expect(Object.keys(FINDING_EXITS).sort()).toEqual([...DIAGNOSIS_FINDING_KINDS].sort())
    expect(DIAGNOSIS_FINDING_KINDS.length).toBeGreaterThan(0)
  })

  it('names a remediation panda performs for every drift verdict, because those had no other exit', () => {
    // The three drift kinds are the states whose ONLY exit was hand-editing
    // `~/.panda/projection-ledger.json`. Derived from the contracts' own
    // `DRIFT_KINDS`, so widening the drift vocabulary upstream turns this red
    // until the new verdict has an exit that is not a text file.
    for (const kind of DRIFT_KINDS) {
      expect(FINDING_EXITS[kind].by, kind).toBe('remediation')
    }
  })

  it('leaves no remediation unreachable, and no exit naming a verb panda does not have', () => {
    const named = new Set(
      DIAGNOSIS_FINDING_KINDS.flatMap((kind) => {
        const exit = FINDING_EXITS[kind]
        return exit.by === 'remediation' ? [...exit.remediations] : []
      }),
    )
    // Both directions, derived. A verb no reported state names is a verb no user
    // can ever be told to run; a state naming a verb that does not exist is a
    // resolution sentence that cannot be carried out.
    expect([...named].sort()).toEqual([...REMEDIATION_KINDS].sort())
    for (const remediation of REMEDIATION_KINDS) {
      expect(findingKindsFor(remediation).length, remediation).toBeGreaterThan(0)
    }
  })

  /** Which kind may name which command. Exhaustive, and checked both ways below. */
  const COMMAND_EXITS: Partial<Record<DiagnosisFindingKind, string>> = {
    'not-initialised': 'panda init',
    'out-of-date': 'panda init',
    'retired-type': 'panda remove <type> <id>',
    unprojectable: 'panda remove <type> <id>',
    'worktree-leftover': 'panda workspace remove <id>',
  }

  it('says what leaves the states panda cannot leave itself, rather than promising one it cannot perform', () => {
    for (const kind of DIAGNOSIS_FINDING_KINDS) {
      const exit = FINDING_EXITS[kind]
      // A whitespace-only detail satisfied the first version of this clause.
      expect(exit.detail.trim().length, kind).toBeGreaterThan(20)
      // And a `command` exit may only name a command panda actually ships. The
      // first version asserted `startsWith('panda ')`, which `panda frobnicate`
      // satisfies.
      //
      // The mechanical half is `packages/cli/test/printed-commands.test.ts`,
      // which now reads THIS RECORD and dispatches every `by: 'command'` exit
      // through `runPanda`. It used to only scan backtick-quoted strings out of
      // shipped source, and these are single-quoted — so a planted
      // `panda evict-retired --all` left that file green while doctor printed
      // it. This list stays because `@panda/environment` may not import the CLI
      // (its own guard test), so from here the set is pinned rather than run.
      if (exit.by === 'command') {
        // PER KIND, not set membership. As a set, adding one fabrication to the
        // list excused it for every kind at once; the binding names which kind
        // may say what, so a swapped or invented command is a deliberate lie in
        // a specific place rather than a value that happens to be listed.
        expect(COMMAND_EXITS[kind], kind).toBe(exit.command)
      }
    }
    // And the binding may not outlive the kinds: a `command` exit added without
    // an entry here, or an entry left behind by a kind that stopped being one,
    // both fail rather than pass silently.
    expect(Object.keys(COMMAND_EXITS).sort()).toEqual(
      DIAGNOSIS_FINDING_KINDS.filter((kind) => FINDING_EXITS[kind].by === 'command').sort(),
    )
  })

  it('prints the remediation`s NAME in the resolution `panda doctor` shows, for every state that has one', async () => {
    // The defect this closes: `FINDING_EXITS` existed, was exported, and was
    // consumed by nothing outside the tests — so doctor went on printing "panda
    // never overwrites an entry that changed since it wrote it; projecting again
    // leaves your edit exactly as it is" for four of the five remediable states.
    // The trap was closed in the code and left open on the only surface a user
    // reads. Derived from the exits, so a verb renamed upstream renames itself
    // here or this goes red.
    const { homeDir } = await fixture()
    const seen = new Map<DiagnosisFindingKind, string>()
    for (const kind of Object.keys(ENTERS) as (keyof typeof ENTERS)[]) {
      const scope = await fixture()
      await ENTERS[kind].enter(scope.homeDir)
      for (const found of (await diagnose({ homeDir: scope.homeDir })).findings) {
        seen.set(found.kind, found.resolution)
      }
    }
    expect(homeDir).toBeTruthy()
    for (const kind of DIAGNOSIS_FINDING_KINDS) {
      const exit = FINDING_EXITS[kind]
      if (exit.by !== 'remediation') continue
      const resolution = seen.get(kind)
      expect(resolution, `no ${kind} finding was produced, so its resolution is unchecked`).toBeDefined()
      for (const remediation of exit.remediations) {
        expect(resolution, kind).toContain(`panda remediate ${remediation}`)
      }
    }
  })

  it('names the existing command in the resolution for every state a command leaves', async () => {
    const { homeDir } = await fixture()
    const notInitialised = (await diagnose({ homeDir })).findings.find(
      (found) => found.kind === 'not-initialised',
    )
    expect(notInitialised?.resolution).toContain('`panda init`')
  })
})

// --- the totality proof, by execution ---------------------------------------

interface StateCase {
  /** Builds the state and returns the remediation to ask for and how to name it. */
  readonly enter: (homeDir: string) => Promise<{
    readonly remediation: RemediationKind
    readonly executorId?: string
    readonly entryId?: string
  }>
}

/**
 * One case per state panda both REPORTS and REMEDIATES. The keys are asserted
 * against the derived set below, so this table cannot fall behind the vocabulary.
 */
const ENTERS: Record<'edited' | 'removed-by-user' | 'foreign-collision' | 'ledger-damaged' | 'legacy-block', StateCase> = {
  edited: {
    enter: async (homeDir) => {
      const claudeJson = await withClaude(homeDir)
      await register(homeDir, { type: 'mcp-server', id: 'ctx', command: 'ctx-server', args: [] })
      await initMachine({ homeDir })
      await writeFile(
        claudeJson,
        (await readFile(claudeJson, 'utf8')).replace('"ctx-server"', '"mine"'),
        'utf8',
      )
      return { remediation: 'adopt', executorId: 'claude-code', entryId: 'ctx' }
    },
  },
  'removed-by-user': {
    enter: async (homeDir) => {
      const claudeJson = await withClaude(homeDir)
      await register(homeDir, { type: 'mcp-server', id: 'ctx', command: 'ctx-server', args: [] })
      await initMachine({ homeDir })
      await writeFile(claudeJson, '{}\n', 'utf8')
      return { remediation: 'release', executorId: 'claude-code', entryId: 'ctx' }
    },
  },
  'foreign-collision': {
    enter: async (homeDir) => {
      await withClaude(homeDir, '{\n  "mcpServers": {\n    "ctx": {\n      "type": "sse"\n    }\n  }\n}\n')
      await register(homeDir, { type: 'mcp-server', id: 'ctx', command: 'ctx-server', args: [] })
      await initMachine({ homeDir })
      return { remediation: 'adopt', executorId: 'claude-code', entryId: 'ctx' }
    },
  },
  'ledger-damaged': {
    enter: async (homeDir) => {
      await withClaude(homeDir)
      await register(homeDir, { type: 'mcp-server', id: 'ctx', command: 'ctx-server', args: [] })
      await initMachine({ homeDir })
      const ledgerPath = join(homeDir, '.panda', 'projection-ledger.json')
      const document = JSON.parse(await readFile(ledgerPath, 'utf8')) as { records: unknown[] }
      document.records.push({ targetId: 'x', filePath: 42 })
      await writeFile(ledgerPath, JSON.stringify({ version: 1, ...document }, null, 2), 'utf8')
      return { remediation: 'repair' }
    },
  },
  'legacy-block': {
    enter: async (homeDir) => {
      await withClaude(homeDir)
      await mkdir(join(homeDir, '.claude'), { recursive: true })
      // What a build from before correction-01 left in a file the corrected
      // build does not touch at all.
      await writeFile(
        join(homeDir, '.claude', 'settings.json'),
        '{\n  "model": "sonnet",\n  "panda": {\n    "version": 1\n  }\n}\n',
        'utf8',
      )
      await initMachine({ homeDir })
      return { remediation: 'discard', executorId: 'claude-code' }
    },
  },
}

describe('every state panda both reports and remediates can actually be left', () => {
  it('has a case for exactly the states whose exit is a remediation panda performs', () => {
    const remediable = DIAGNOSIS_FINDING_KINDS.filter((kind) => FINDING_EXITS[kind].by === 'remediation')
    expect(Object.keys(ENTERS).sort()).toEqual([...remediable].sort())
  })

  it.each(Object.keys(ENTERS) as (keyof typeof ENTERS)[])(
    'reports %s, remediates it by name, and stops reporting it',
    async (kind) => {
      const { homeDir } = await fixture()
      const selector = await ENTERS[kind].enter(homeDir)
      expect(await kindsReported(homeDir)).toContain(kind)

      const described = await remediate({ homeDir, ...selector })
      expect(described.refusal, JSON.stringify(described.refusal)).toBeUndefined()
      expect(described.outcome?.refusal).toBeUndefined()
      expect(described.outcome?.applied).toBe(false)
      expect(described.outcome?.changes.length).toBeGreaterThan(0)
      // Describing is not acting: the state is still there.
      expect(await kindsReported(homeDir)).toContain(kind)

      const applied = await remediate({ homeDir, ...selector, mode: 'apply' })
      expect(applied.outcome?.applied).toBe(true)
      expect(applied.outcome?.changes).toEqual(described.outcome?.changes)
      expect(await kindsReported(homeDir)).not.toContain(kind)
    },
  )
})

// --- nothing unnamed is touched ---------------------------------------------

describe('a remediation resolves what was named and leaves everything else alone', () => {
  it('leaves every other finding and every foreign neighbour byte for byte', async () => {
    const { root, homeDir } = await fixture()
    const claudeJson = await withClaude(homeDir)
    await mkdir(join(homeDir, '.codex'), { recursive: true })
    await writeFile(join(homeDir, '.codex', 'config.toml'), 'model = "gpt-5-codex"\n', 'utf8')
    await register(homeDir, { type: 'mcp-server', id: 'ctx', command: 'ctx-server', args: [] })
    await register(homeDir, { type: 'mcp-server', id: 'other', command: 'other-server', args: [] })
    await initMachine({ homeDir })
    // Two independent drifts, in one file, plus a foreign neighbour nobody named.
    const document = JSON.parse(await readFile(claudeJson, 'utf8')) as {
      mcpServers: Record<string, { command?: string }>
    }
    document.mcpServers['ctx']!.command = 'mine'
    document.mcpServers['linear'] = { command: 'not-pandas' }
    delete document.mcpServers['other']
    await writeFile(claudeJson, `${JSON.stringify(document, null, 2)}\n`, 'utf8')

    const before = await diagnose({ homeDir })
    expect(before.findings.filter((found) => found.kind === 'edited')).toHaveLength(1)
    expect(before.findings.filter((found) => found.kind === 'removed-by-user')).toHaveLength(1)
    const bytes = await snapshot(root)

    const applied = await remediate({
      homeDir,
      remediation: 'adopt',
      executorId: 'claude-code',
      entryId: 'ctx',
      mode: 'apply',
    })
    expect(applied.outcome?.applied).toBe(true)

    // ONLY panda's own ledger moved. Not the vendor file, not the registry, not
    // the codex config, not panda's own directory layout.
    expect(changedPaths(bytes, await snapshot(root))).toEqual(['home/.panda/projection-ledger.json'])
    const after = await diagnose({ homeDir })
    // Every OTHER finding is still exactly the finding it was.
    expect(after.findings.filter((found) => found.kind !== 'out-of-date')).toEqual(
      before.findings.filter((found) => found.kind !== 'out-of-date' && found.kind !== 'edited'),
    )
    // And the neighbour the user wrote is untouched.
    const reread = JSON.parse(await readFile(claudeJson, 'utf8')) as {
      mcpServers: Record<string, unknown>
    }
    expect(reread.mcpServers['linear']).toEqual({ command: 'not-pandas' })
    expect(reread.mcpServers['ctx']).toMatchObject({ command: 'mine' })
  })
})

// --- explicit, per finding --------------------------------------------------

describe('nothing is remediated that the user did not name', () => {
  it('refuses a state panda did not report in this very run', async () => {
    const { homeDir } = await fixture()
    await withClaude(homeDir)
    await register(homeDir, { type: 'mcp-server', id: 'ctx', command: 'ctx-server', args: [] })
    await initMachine({ homeDir })
    const report = await remediate({ homeDir, remediation: 'adopt', mode: 'apply' })
    expect(report.refusal?.code).toBe('PANDA_PROJECTION_REMEDIATION_REFUSED')
    expect(report.refusal?.message).toContain('never remediates a state it did not just report')
    expect(report.outcome).toBeUndefined()
  })

  it('refuses an ambiguous request and lists what the user could have named', async () => {
    const { homeDir } = await fixture()
    const claudeJson = await withClaude(homeDir)
    await register(homeDir, { type: 'mcp-server', id: 'ctx', command: 'ctx-server', args: [] })
    await register(homeDir, { type: 'mcp-server', id: 'other', command: 'other-server', args: [] })
    await initMachine({ homeDir })
    const document = JSON.parse(await readFile(claudeJson, 'utf8')) as {
      mcpServers: Record<string, { command?: string }>
    }
    document.mcpServers['ctx']!.command = 'mine'
    document.mcpServers['other']!.command = 'mine-too'
    await writeFile(claudeJson, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
    const bytes = await snapshot(homeDir)

    const report = await remediate({ homeDir, remediation: 'adopt', mode: 'apply' })
    expect(report.refusal?.message).toContain('one finding at a time')
    expect(report.candidates.map((found) => found.entryId).sort()).toEqual(['ctx', 'other'])
    expect(changedPaths(bytes, await snapshot(homeDir))).toEqual([])

    // Naming one of them resolves that one and only that one.
    const named = await remediate({
      homeDir,
      remediation: 'adopt',
      executorId: 'claude-code',
      entryId: 'ctx',
      mode: 'apply',
    })
    expect(named.outcome?.applied).toBe(true)
    expect((await diagnose({ homeDir })).findings.filter((found) => found.kind === 'edited')).toHaveLength(1)
  })

  it('describes and writes nothing by default, even when exactly one finding matches', async () => {
    const { root, homeDir } = await fixture()
    await ENTERS['foreign-collision'].enter(homeDir)
    const bytes = await snapshot(root)
    const report = await remediate({ homeDir, remediation: 'adopt', executorId: 'claude-code', entryId: 'ctx' })
    expect(report.mode).toBe('inspect')
    expect(report.outcome?.changes.length).toBeGreaterThan(0)
    expect(changedPaths(bytes, await snapshot(root))).toEqual([])
  })
})

// --- correction-01 C6, and the commands that must NOT remove it --------------

describe('panda`s own legacy output is reported and removed only when asked', () => {
  it('is reported by doctor, at the file no executor reads', async () => {
    const { homeDir } = await fixture()
    await ENTERS['legacy-block'].enter(homeDir)
    const diagnosis = await diagnose({ homeDir })
    const found = diagnosis.findings.find((finding) => finding.kind === 'legacy-block')
    expect(found?.filePath).toBe(join(homeDir, '.claude', 'settings.json'))
    expect(found?.severity).toBe('problem')
    expect(diagnosis.legacy).toHaveLength(1)
  })

  it('is NOT removed by panda init, and doctor writes nothing while reporting it', async () => {
    const { root, homeDir } = await fixture()
    await ENTERS['legacy-block'].enter(homeDir)
    const settings = join(homeDir, '.claude', 'settings.json')
    const original = await readFile(settings, 'utf8')

    const bytes = await snapshot(root)
    await diagnose({ homeDir })
    // Doctor reports the block through the discard remediation's own inspection
    // and still writes nothing at all — including panda's own directories.
    expect(changedPaths(bytes, await snapshot(root))).toEqual([])

    await initMachine({ homeDir })
    // `panda init` neither reports it nor removes it: removal is a decision, and
    // the whole rule of this story is that a decision is a user's.
    expect(await readFile(settings, 'utf8')).toBe(original)

    await remediate({ homeDir, remediation: 'discard', executorId: 'claude-code', mode: 'apply' })
    expect(JSON.parse(await readFile(settings, 'utf8'))).toEqual({ model: 'sonnet' })
  })
})

// --- the crash state, end to end through the capability ----------------------

describe('the crash state is resolvable without opening the ledger', () => {
  it('adopts panda`s own orphaned skill tree and removes it once the entry leaves the registry', async () => {
    const { homeDir } = await fixture()
    await withClaude(homeDir)
    await mkdir(join(homeDir, '.claude'), { recursive: true })
    const source = join(homeDir, 'alpha.md')
    await writeFile(source, '---\nname: alpha\ndescription: d\n---\n\nbody\n', 'utf8')
    await register(homeDir, { type: 'skill', id: 'alpha', entryPath: source })
    await initMachine({ homeDir })
    const tree = join(homeDir, '.claude', 'skills', 'alpha', 'SKILL.md')
    expect(await stat(tree)).toBeTruthy()
    // The M4.B window: the files landed, the ledger update never happened.
    await rm(join(homeDir, '.panda', 'projection-ledger.json'), { force: true })
    expect(await kindsReported(homeDir)).toContain('foreign-collision')

    const applied = await remediate({
      homeDir,
      remediation: 'adopt',
      executorId: 'claude-code',
      entryId: 'alpha',
      mode: 'apply',
    })
    expect(applied.outcome?.applied).toBe(true)
    expect(await kindsReported(homeDir)).not.toContain('foreign-collision')

    // Panda owns its litter again, so dropping the entry takes the tree with it.
    const store = new RegistryStore({ homeDir })
    await store.remove('skill', 'alpha', 'global')
    await store.dispose()
    await initMachine({ homeDir })
    await expect(stat(tree)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
