import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { runPanda } from '../src/run.ts'
import type { RunCommandOptions } from '../src/run.ts'
import type { ChildProcessSpawner, SpawnedChild, SpawnOutcome, UsageReport } from '@panda/session'

// `panda status` (Story M15.A): the report of what each executor last said about
// its own quota.
//
// THE SPY, and why it is `node:child_process` rather than an injected seam. The
// claim AC-4 makes is "status invokes no executor" — a claim about the real
// spawn path, not about a seam a test controls. `adapterOptions.spawner` cannot
// prove it: `panda status` never reads `adapterOptions`, so injecting a fake
// there and finding it unused would prove only that an unread option went
// unread. Patching the module the production spawner actually calls is the one
// place a run has to pass through, and the control below drives a real run
// through it so the zero has something to be measured against.
const spy = vi.hoisted(() => ({ commands: [] as string[] }))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: (command: string, ...rest: unknown[]) => {
      spy.commands.push(command)
      return (actual.spawn as unknown as (...args: unknown[]) => unknown)(command, ...rest)
    },
  }
})

const roots: string[] = []
afterAll(async () => {
  await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})))
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'panda-cli-status-'))
  roots.push(dir)
  return dir
}

function capture(): RunCommandOptions & { out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  return { stdout: (line) => out.push(line), stderr: (line) => err.push(line), out, err }
}

// One real line of `claude --print --output-format stream-json --verbose`
// stdout, copied byte for byte from a 2.1.260 run on 2026-09-03. The same bytes
// `packages/adapter-cli/test/usage-windows.test.ts` drives its parser with.
const RATE_LIMIT_LINE =
  '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1788491400,"rateLimitType":"five_hour","overageStatus":"rejected","overageDisabledReason":"org_level_disabled","isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":0.13,"resetsAt":1788491400},"seven_day":{"utilization":0.22,"resetsAt":1788728400}}},"uuid":"b295ba9b-fd19-475a-8940-e556b380ba33","session_id":"19cad68a-e422-4907-a11b-75638899e5ac"}'

const RESULT_LINE = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok' })

/** A spawner that answers with a claude stream and records nothing else. */
function streamingSpawner(stdout: string): ChildProcessSpawner {
  return {
    spawn(): SpawnedChild {
      let settle: (outcome: SpawnOutcome) => void = () => {}
      const done = new Promise<SpawnOutcome>((resolve) => {
        settle = resolve
      })
      const state = { settled: false }
      return {
        pid: 1,
        get settled() {
          return state.settled
        },
        writeStdin() {},
        endStdin() {
          state.settled = true
          settle({ exitCode: 0, stdout, stderr: '' })
        },
        killTree() {},
        done,
      }
    },
  }
}

/** Every path under a directory, so "wrote nothing" can be measured. */
async function tree(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => [])
  return entries.map((entry) => join(entry.parentPath, entry.name)).sort()
}

describe('panda run records the reading, and panda status reports it', () => {
  it('carries the vendor\'s window names and numbers from a run to the report', async () => {
    const homeDir = await tempDir()
    const cwd = await tempDir()
    const runIo = capture()
    expect(
      await runPanda(['run', 'say ok'], {
        ...runIo,
        cwd,
        homeDir,
        adapterOptions: { spawner: streamingSpawner(`${RATE_LIMIT_LINE}\n${RESULT_LINE}\n`) },
      }),
    ).toBe(0)

    const io = capture()
    expect(await runPanda(['status'], { ...io, cwd, homeDir })).toBe(0)

    const reports = JSON.parse(io.out.join('\n')) as UsageReport[]
    const claude = reports.find((report) => report.executorId === 'claude-code')
    expect(claude?.kind).toBe('observed')
    if (claude?.kind !== 'observed') throw new Error('unreachable')
    expect(claude.windows).toEqual([
      { name: 'five_hour', utilization: 0.13, resetsAt: 1788491400 },
      { name: 'seven_day', utilization: 0.22, resetsAt: 1788728400 },
    ])
    // The human line carries the vendor's OWN window names, unconverted.
    const printed = io.err.join('\n')
    expect(printed).toContain('five_hour utilization=0.13')
    expect(printed).toContain('seven_day utilization=0.22')
    expect(printed).toContain(claude.observedAt)
    // No derived figure the vendor did not state (D5).
    expect(printed).not.toContain('13%')
    expect(printed).not.toContain('remaining')
  })

  it('reports codex and opencode as stated absence, not zero, blank or error', async () => {
    const io = capture()
    const code = await runPanda(['status'], { ...io, cwd: await tempDir(), homeDir: await tempDir() })

    // ERROR would have been a non-zero exit; absence is an answer, so 0.
    expect(code).toBe(0)
    const printed = io.err.join('\n')
    for (const executorId of ['codex', 'opencode']) {
      expect(printed).toContain(`${executorId}: PANDA_USAGE_NO_SURFACE`)
      expect(printed).toContain('publishes no usage surface')
    }
    // BLANK and ZERO, both refused: no row anywhere carries a utilisation.
    expect(printed).not.toMatch(/utilization=0(\D|$)/)
    expect(io.out.join('\n')).not.toContain('utilization')
    // And claude, which HAS a surface but has not been run here, gets its own
    // reason and the command that would produce a reading (E4).
    expect(printed).toContain('claude-code: PANDA_USAGE_NOT_OBSERVED')
    expect(printed).toContain('panda run')
  })
})

describe('panda status spends nothing to report on spending', () => {
  it('invokes no executor — and a real run through the same spy proves the spy sees one', async () => {
    const homeDir = await tempDir()
    const cwd = await tempDir()

    spy.commands.length = 0
    expect(await runPanda(['status'], { ...capture(), cwd, homeDir })).toBe(0)
    // The claim. On its own it would be worth nothing: a spy nobody proved is
    // wired reports zero for the same reason a broken one does.
    expect(spy.commands, 'panda status must reach no child process at all').toEqual([])

    // THE CONTROL. A real `panda run` on the production path — no injected
    // spawner — pointed at this process's own node binary instead of a vendor,
    // so it costs no quota and still travels the exact code path a billed run
    // travels. If the spy could not see this, the zero above would mean "I did
    // not look".
    const runIo = capture()
    await runPanda(['run', '--executor', 'codex', 'say ok'], {
      ...runIo,
      cwd,
      homeDir,
      adapterOptions: { command: process.execPath },
    })
    expect(spy.commands).toEqual([process.execPath])
  })

  it('writes nothing, anywhere, in either scope (D6)', async () => {
    const homeDir = await tempDir()
    const cwd = await tempDir()
    const before = [await tree(homeDir), await tree(cwd)]

    expect(await runPanda(['status'], { ...capture(), cwd, homeDir })).toBe(0)

    expect([await tree(homeDir), await tree(cwd)]).toEqual(before)
  })
})

describe('panda status argv', () => {
  it('prints usage for --help and exits 0', async () => {
    const io = capture()
    expect(await runPanda(['status', '--help'], { ...io, cwd: await tempDir(), homeDir: await tempDir() })).toBe(0)
    expect(io.out.join('\n')).toContain('panda status')
  })

  it('refuses a positional and an unknown flag', async () => {
    for (const argv of [['status', 'somewhere'], ['status', '--all']]) {
      const io = capture()
      expect(await runPanda(argv, { ...io, cwd: await tempDir(), homeDir: await tempDir() })).toBe(2)
    }
  })

  it('still answers 0 when its own document cannot be read', async () => {
    // MEASURED rather than assumed, and it is the reason this command has no
    // reachable exit 2 today: a home directory panda cannot read at all still
    // produces a complete report, because every row in it is derivable from the
    // shipped catalogue. The stored readings are a CACHE of numbers a run can
    // take again, so losing them is absence and absence is an answer.
    //
    // The `catch` in `runStatus` is therefore the uncaught-throw guard every
    // other binding in `run.ts` carries, not a branch this suite can drive. Said
    // out loud here rather than asserted with a fabricated input: a clause that
    // pretended to reach it would be pinning a fiction.
    const io = capture()
    expect(await runPanda(['status'], { ...io, cwd: await tempDir(), homeDir: `${await tempDir()}\0` })).toBe(0)
    expect(io.err.join('\n')).toContain('PANDA_USAGE_NOT_OBSERVED')
  })
})
