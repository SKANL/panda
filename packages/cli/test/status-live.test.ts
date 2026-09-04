import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { runPanda } from '../src/run.ts'
import type { RunCommandOptions } from '../src/run.ts'
import type { UsageReport } from '@panda/session'

// Story M15.A's acceptance criterion 1: `panda status` prints a REAL utilisation
// from a REAL claude run, in the vendor's own window names — driven, not
// fixtured.
//
// One live invocation, through the binary the way a user runs it: `panda run`
// with no injected adapter and no injected spawner, then `panda status`. Nothing
// between the two but the file the run wrote, which is the whole of D7.
//
// It costs quota, so it is a `*live.test.ts`, and it SKIPS with its reason
// whenever claude is missing, broken, unauthenticated or refusing —
// PANDA_LIVE_STATUS=0 forces the skip. A provider outage never fails it.

const PROBE_TIMEOUT_MS = 20_000
const RUN_TIMEOUT_MS = 240_000

const PROMPT = 'Reply with exactly the word ok and nothing else. Do not create or modify any file.'

// THE CREDENTIALS, and why this file is the one place that undoes the suite's
// home isolation.
//
// `test/isolate-home.ts` repoints HOME and USERPROFILE at an empty temp
// directory for the WHOLE CLI suite, so no test reads whoever ran it. That is
// right for every other file here and fatal for this one: claude reads its own
// credentials out of the real home, and under the isolated one it answers "Not
// logged in · Please run /login" in about a second — MEASURED, which is how this
// was found, and it would have made a live check that skips forever look like a
// live check that passes.
//
// `os.userInfo().homedir` is the way back: it comes from the OS account rather
// than from the environment, so it survives the override — verified by running
// it with both variables repointed. Panda's OWN scope is unaffected, because
// every `runPanda` call below is handed an explicit `homeDir`; the only thing
// this restores is what the CHILD reads.
const isolated = { home: process.env['HOME'], userProfile: process.env['USERPROFILE'] }
beforeAll(() => {
  const real = userInfo().homedir
  process.env['HOME'] = real
  process.env['USERPROFILE'] = real
})
afterAll(() => {
  process.env['HOME'] = isolated.home
  process.env['USERPROFILE'] = isolated.userProfile
})

const roots: string[] = []
afterAll(async () => {
  await Promise.all(
    roots.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {})),
  )
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'panda-status-live-'))
  roots.push(dir)
  return dir
}

function capture(): RunCommandOptions & { out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  return { stdout: (line) => out.push(line), stderr: (line) => err.push(line), out, err }
}

/**
 * Whether `claude` is here and answers. Keyed on the BINARY's exit status, not
 * on "a process started": a present-but-broken binary answers non-zero, and a
 * live check proves nothing against one that cannot answer.
 */
async function probe(): Promise<{ available: boolean; reason: string }> {
  if (process.env['PANDA_LIVE_STATUS'] === '0') {
    return { available: false, reason: 'PANDA_LIVE_STATUS=0 explicitly disables the live status check' }
  }
  return await new Promise((resolve) => {
    // One string, no argv array: on win32 `claude` is a `.cmd` shim and only a
    // shell can start it, and passing args ALONGSIDE `shell: true` is deprecated
    // in Node 24 (DEP0190) because they are concatenated rather than escaped.
    // There is no caller input here to escape — the whole command is this
    // literal — so the single-string form is both correct and warning-free.
    const child = spawn('claude --version', { stdio: 'ignore', shell: true })
    const timer = setTimeout(() => {
      child.kill()
      resolve({ available: false, reason: `claude --version exceeded ${PROBE_TIMEOUT_MS}ms` })
    }, PROBE_TIMEOUT_MS)
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ available: false, reason: `claude not detected: ${error.message}` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve(
        code === 0
          ? { available: true, reason: 'claude --version exited 0' }
          : { available: false, reason: `claude --version exited ${code}` },
      )
    })
  })
}

describe('live: panda status reports a real reading a real run produced', () => {
  it(
    'runs claude for real, then reports its own windows without invoking anything',
    async (ctx) => {
      const availability = await probe()
      if (!availability.available) ctx.skip(`live status check skipped: ${availability.reason}`)

      const homeDir = await tempDir()
      const cwd = await tempDir()

      // BEFORE the run: typed absence with the exit named (E4). Asserted first,
      // so the observation below cannot be something that was already there.
      const before = capture()
      expect(await runPanda(['status'], { ...before, cwd, homeDir })).toBe(0)
      expect(before.err.join('\n')).toContain('claude-code: PANDA_USAGE_NOT_OBSERVED')

      // THE live invocation. No `createAdapter`, no `adapterOptions`: the
      // production path, exactly what a user's shell runs.
      const runIo = capture()
      const runCode = await runPanda(['run', PROMPT], { ...runIo, cwd, homeDir })
      if (runCode !== 0) {
        // Never a failure of this suite: a refusal, an outage or an expired
        // credential is the provider's state, not panda's defect.
        ctx.skip(
          `claude ran and did not succeed, so there is no reading to report: ${runIo.err.join(' ')} ${runIo.out.join(' ')}`,
        )
      }

      const io = capture()
      expect(await runPanda(['status'], { ...io, cwd, homeDir })).toBe(0)

      const reports = JSON.parse(io.out.join('\n')) as UsageReport[]
      const claude = reports.find((report) => report.executorId === 'claude-code')
      expect(claude?.kind, `panda status reported ${JSON.stringify(claude)}`).toBe('observed')
      if (claude?.kind !== 'observed') throw new Error('unreachable')

      // A REAL utilisation, in the vendor's OWN window names.
      expect(claude.windows.length).toBeGreaterThan(0)
      for (const window of claude.windows) {
        expect(window.name.length).toBeGreaterThan(0)
        expect(Number.isFinite(window.utilization)).toBe(true)
        expect(Number.isFinite(window.resetsAt)).toBe(true)
        // Printed as the vendor stated it — the number itself reaches stderr.
        expect(io.err.join('\n')).toContain(`${window.name} utilization=${window.utilization}`)
      }
      // The vendor's vocabulary as MEASURED on 2.1.260: a rename is a real
      // change to what panda reports and must fail here rather than quietly
      // reporting one window fewer.
      expect(claude.windows.map((window) => window.name)).toContain('five_hour')

      // D7's other half: the reading knows WHEN it was taken, and it is this
      // run's, not a stale one.
      expect(Date.parse(claude.observedAt)).toBeGreaterThan(Date.now() - RUN_TIMEOUT_MS)

      // The two executors with no surface, in the same report, still stated
      // rather than zeroed (E3) — on a machine where a real reading exists
      // beside them, which is the case a zero would be easiest to overlook in.
      for (const executorId of ['codex', 'opencode']) {
        expect(io.err.join('\n')).toContain(`${executorId}: PANDA_USAGE_NO_SURFACE`)
      }
    },
    RUN_TIMEOUT_MS + PROBE_TIMEOUT_MS + 30_000,
  )
})
