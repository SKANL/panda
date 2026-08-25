import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createNodeChildSpawner } from '../src/index.ts'

// Real-spawner tree-kill proof (no network, no auth): the spawned child forks a
// grandchild of its own and idles. After killTree() BOTH pids must exit within a
// bounded wait — on win32 via taskkill /T /F, on posix via process-group SIGKILL.
// This is the exact code path the adapter's abort handler invokes.

const FORKER_SCRIPT = `
const { spawn } = require('child_process');
const fs = require('fs');
const gc = spawn(process.execPath, ['-e', 'setInterval(function(){}, 1000)'], { stdio: 'ignore' });
fs.writeFileSync(process.env.GC_PID_FILE, String(gc.pid));
setInterval(function(){}, 1000);
`

const PID_ALIVE_POLL_MS = 50
const EXIT_WAIT_BUDGET_MS = 15_000

async function pidAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(predicate: () => Promise<boolean>, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  for (;;) {
    if (await predicate()) return true
    if (Date.now() > deadline) return false
    await new Promise((resolve) => setTimeout(resolve, PID_ALIVE_POLL_MS))
  }
}

describe('real spawner tree-kill', () => {
  it(
    'terminates both child and grandchild within a bounded wait',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'panda-treekill-'))
      const gcPidFile = join(dir, 'gc.pid')

      const spawner = createNodeChildSpawner()
      const previousPidFile = process.env['GC_PID_FILE']
      process.env['GC_PID_FILE'] = gcPidFile
      let child
      try {
        child = spawner.spawn(process.execPath, ['-e', FORKER_SCRIPT], { cwd: dir })
        // Wait until the grandchild actually exists before terminating.
        const grandchildAppeared = await waitFor(async () => {
          try {
            return Number(await readFile(gcPidFile, 'utf8')) > 0
          } catch {
            return false
          }
        }, EXIT_WAIT_BUDGET_MS)
        expect(grandchildAppeared).toBe(true)
      } finally {
        if (previousPidFile === undefined) delete process.env['GC_PID_FILE']
        else process.env['GC_PID_FILE'] = previousPidFile
      }

      const parentPid = child.pid
      expect(typeof parentPid).toBe('number')
      const grandchildPid = Number(await readFile(gcPidFile, 'utf8'))
      expect(grandchildPid).toBeGreaterThan(0)
      expect(grandchildPid).not.toBe(parentPid)

      child.killTree()
      const outcome = await child.done

      const stillAlive = parentPid === undefined ? () => false : () => pidAlive(parentPid)
      expect(
        await waitFor(async () => !(await stillAlive()) && !(await pidAlive(grandchildPid)), EXIT_WAIT_BUDGET_MS),
      ).toBe(true)
      expect(outcome.spawnErrorMessage).toBeUndefined()
    },
    30_000,
  )
})

describe.skipIf(process.platform !== 'win32')('win32 .cmd shim support', () => {
  it(
    'reroutes EINVAL-class direct spawn through cmd.exe and completes the run',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'panda-cmd-'))
      // Node refuses to exec .cmd files without a shell (EINVAL); only the
      // cmd.exe reroute can make this spawn succeed.
      const shim = join(dir, 'echo-result.cmd')
      await writeFile(shim, '@echo off\r\necho {"result":"ok-from-cmd"}\r\n')

      const child = createNodeChildSpawner().spawn(shim, [], { cwd: dir })
      const outcome = await child.done

      expect(outcome.spawnErrorMessage).toBeUndefined()
      expect(outcome.stdout).toContain('"result":"ok-from-cmd"')
    },
    15_000,
  )

  it('tree-kills a .cmd shim tree after reroute', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'panda-cmd-kill-'))
    const shim = join(dir, 'sleep-then-die.cmd')
    await writeFile(shim, '@echo off\r\nping -n 30 127.0.0.1 > nul\r\n')

    const spawner = createNodeChildSpawner()
    const child = spawner.spawn(shim, [], { cwd: dir })
    expect(child.pid).toBeGreaterThan(0)
    child.killTree()

    const outcome = await Promise.race([
      child.done,
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), EXIT_WAIT_BUDGET_MS)),
    ])
    expect(outcome).toBeDefined()
  }, 20_000)
})
