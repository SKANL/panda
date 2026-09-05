import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { PANDA_ERROR_CODES, PandaError } from '@skanl/panda-contracts'
import { RegistryStore } from '../src'

// Real cross-process contention: a child node process takes the registry lock
// and holds it while idling; the parent's mutation must fail with the typed
// CONTENTION error naming the child's pid. Deterministic — the only waits are
// small polls bounded by a deadline.

const CHILD_SCRIPT = `
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const lockPath = process.env.PANDA_TEST_LOCK_PATH;
const readyPath = process.env.PANDA_TEST_READY_PATH;
const fd = fs.openSync(lockPath, 'wx');
fs.writeFileSync(fd, JSON.stringify({
  pid: process.pid,
  host: os.hostname(),
  acquiredAt: new Date().toISOString(),
  token: crypto.randomUUID(),
}));
fs.closeSync(fd);
fs.writeFileSync(readyPath, String(process.pid));
setInterval(function () {}, 1000);
`

const POLL_MS = 20
const BUDGET_MS = 10_000

async function waitForHolderReady(readyPath: string): Promise<number> {
  const deadline = Date.now() + BUDGET_MS
  while (!existsSync(readyPath)) {
    if (Date.now() > deadline) throw new Error('holder process never became ready')
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
  return Number(await readFile(readyPath, 'utf8'))
}

const rootDir = await mkdtemp(join(tmpdir(), 'panda-registry-contention-'))
afterAll(() => rm(rootDir, { recursive: true, force: true }))

describe('cross-process contention', () => {
  it('fails a mutation held by another live PROCESS with CONTENTION naming that pid', { timeout: 30_000 }, async () => {
    const storePath = join(rootDir, '.panda', 'registry.json')
    await mkdir(join(rootDir, '.panda'), { recursive: true })
    const readyPath = join(rootDir, 'holder-ready.pid')

    const child = spawn(process.execPath, ['-e', CHILD_SCRIPT], {
      stdio: 'ignore',
      env: {
        ...process.env,
        PANDA_TEST_LOCK_PATH: `${storePath}.lock`,
        PANDA_TEST_READY_PATH: readyPath,
      },
    })
    try {
      const holderPid = await waitForHolderReady(readyPath)
      expect(holderPid).toBe(child.pid)

      const store = new RegistryStore({ homeDir: rootDir, lockTimeoutMs: 400 })
      try {
        await store.register({ type: 'mcp-server', id: 'loser' }, 'global')
        expect.unreachable()
      } catch (error) {
        expect(error).toBeInstanceOf(PandaError)
        expect((error as PandaError).code).toBe(PANDA_ERROR_CODES.registryContention)
        expect((error as PandaError).message).toContain(`${holderPid}@`)
      }

      // The loser never writes: no lost update, no silent merge.
      await expect(readFile(storePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      child.kill()
      await unlink(`${storePath}.lock`).catch(() => undefined)
    }
  })

  it('takes over a lock stranded by a killed foreign PROCESS (real cross-process stale break)', { timeout: 30_000 }, async () => {
    const storePath = join(rootDir, '.panda', 'registry.json')
    await mkdir(join(rootDir, '.panda'), { recursive: true })
    const readyPath = join(rootDir, 'handover-ready.pid')

    const child = spawn(process.execPath, ['-e', CHILD_SCRIPT], {
      stdio: 'ignore',
      env: {
        ...process.env,
        PANDA_TEST_LOCK_PATH: `${storePath}.lock`,
        PANDA_TEST_READY_PATH: readyPath,
      },
    })
    try {
      // The holder takes the lock and dies WITHOUT releasing; the parent proves
      // the pid is dead on this host and breaks the stale lock.
      await waitForHolderReady(readyPath)
      child.kill()
      // A signal-terminated child reports signalCode, never exitCode.
      const exited = () => child.exitCode !== null || child.signalCode !== null
      const deadline = Date.now() + BUDGET_MS
      while (!exited()) {
        if (Date.now() > deadline) throw new Error('holder process never exited')
        await new Promise((resolve) => setTimeout(resolve, POLL_MS))
      }

      const store = new RegistryStore({ homeDir: rootDir, lockTimeoutMs: 2_000 })
      await store.register({ type: 'mcp-server', id: 'winner' }, 'global')
      expect(await store.get('mcp-server', 'winner')).toEqual({ type: 'mcp-server', id: 'winner' })
    } finally {
      if (child.exitCode === null) child.kill()
      await unlink(`${storePath}.lock`).catch(() => undefined)
    }
  })
})
