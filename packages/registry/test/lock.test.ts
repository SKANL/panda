import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, unlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { PANDA_ERROR_CODES, PandaError } from '@panda/contracts'
import { acquireLock } from '../src'
import type { LockHolder, StaleLockBreak } from '../src'

const rootDir = await mkdtemp(join(tmpdir(), 'panda-registry-lock-'))
afterAll(() => rm(rootDir, { recursive: true, force: true }))

function holderFor(overrides: Partial<LockHolder> = {}): LockHolder {
  return {
    pid: process.pid,
    host: hostname(),
    acquiredAt: new Date().toISOString(),
    token: 'holder-token',
    ...overrides,
  }
}

async function writeHolder(path: string, holder: LockHolder | string): Promise<void> {
  await writeFile(path, typeof holder === 'string' ? holder : JSON.stringify(holder), 'utf8')
}

async function ageFile(path: string, ageMs: number): Promise<void> {
  const past = new Date(Date.now() - ageMs)
  await utimes(path, past, past)
}

// A short-lived child whose pid is PROVABLY dead once the process exits.
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  await new Promise((resolve) => child.on('exit', resolve))
  return child.pid!
}

describe('lockfile protocol', () => {
  it('acquires exclusively, persists full holder metadata, and releases for the next contender', async () => {
    const path = join(rootDir, 'basic.lock')

    const lock = await acquireLock(path)
    expect(lock.holder.pid).toBe(process.pid)
    expect(lock.holder.host).toBe(hostname())
    expect(typeof lock.holder.token).toBe('string')
    // Orphan-proofing: by the time we can read it, the document is complete.
    const persisted = JSON.parse(await readFile(path, 'utf8')) as LockHolder
    expect(persisted.token).toBe(lock.holder.token)

    // O_EXCL semantics: the file exists while we hold it, so a second contender fails fast.
    await expect(acquireLock(path, { timeoutMs: 50 })).rejects.toThrow(PandaError)

    await lock.release()
    const reacquired = await acquireLock(path)
    await reacquired.release()
    expect(reacquired.holder.acquiredAt).not.toBe(lock.holder.acquiredAt)
  })

  it('fails a bounded wait with CONTENTION naming the live holder pid@host', async () => {
    const path = join(rootDir, 'contended.lock')
    const lock = await acquireLock(path)
    try {
      try {
        await acquireLock(path, { timeoutMs: 80, pollMs: 10 })
        expect.unreachable()
      } catch (error) {
        expect(error).toBeInstanceOf(PandaError)
        expect((error as PandaError).code).toBe(PANDA_ERROR_CODES.registryContention)
        expect((error as PandaError).message).toContain(`${process.pid}@${hostname()}`)
      }
    } finally {
      await lock.release()
    }
  })

  it('breaks a stale SAME-HOST lock whose pid is provably dead, recording the evidence', async () => {
    const path = join(rootDir, 'stale-dead-pid.lock')
    const pid = await deadPid()
    await writeHolder(path, holderFor({ pid }))

    const breaks: StaleLockBreak[] = []
    const lock = await acquireLock(path, {
      timeoutMs: 200,
      pollMs: 10,
      onStaleBreak: (broken) => breaks.push(broken),
    })
    expect(lock.holder.pid).toBe(process.pid)
    expect(breaks).toHaveLength(1)
    expect(breaks[0]!.evidence).toContain(String(pid))
    expect(breaks[0]!.evidence).toContain('ESRCH')
    await lock.release()
  })

  it('breaks a same-host lock older than maxAgeMs even when its pid looks alive (pid-reuse defense)', async () => {
    const path = join(rootDir, 'stale-age.lock')
    // Our OWN pid: alive, so only the age fallback may break this.
    await writeHolder(
      path,
      holderFor({ acquiredAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() }),
    )

    const breaks: StaleLockBreak[] = []
    const lock = await acquireLock(path, {
      timeoutMs: 200,
      pollMs: 10,
      maxAgeMs: 60 * 1000,
      onStaleBreak: (broken) => breaks.push(broken),
    })
    expect(lock.holder.pid).toBe(process.pid)
    expect(breaks).toHaveLength(1)
    expect(breaks[0]!.evidence).toContain('maxAgeMs')
    await lock.release()
  })

  it('never breaks a CROSS-HOST lock on age alone', async () => {
    const path = join(rootDir, 'foreign-aged.lock')
    await writeHolder(
      path,
      holderFor({
        host: 'some-other-machine',
        acquiredAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      }),
    )
    try {
      await acquireLock(path, { timeoutMs: 80, pollMs: 10, maxAgeMs: 60 * 1000 })
      expect.unreachable()
    } catch (error) {
      expect((error as PandaError).code).toBe(PANDA_ERROR_CODES.registryContention)
      expect((error as PandaError).message).toContain('@some-other-machine')
    }
  })

  it('yields CONTENTION with an unreadable-lockfile detail for a FRESH corrupt lock', async () => {
    const path = join(rootDir, 'corrupt-fresh.lock')
    await writeHolder(path, '{"pid": 123, "hos')
    try {
      await acquireLock(path, { timeoutMs: 80, pollMs: 10 })
      expect.unreachable()
    } catch (error) {
      expect((error as PandaError).code).toBe(PANDA_ERROR_CODES.registryContention)
      expect((error as PandaError).message).toContain('unreadable lockfile')
    }
  })

  it('breaks a corrupt lock after its file age exceeds the grace period, regardless of host', async () => {
    const path = join(rootDir, 'corrupt-aged.lock')
    await writeHolder(path, '{"pid": "not-a-number"')
    // Simulate a lockfile abandoned long ago.
    await ageFile(path, 5 * 60 * 1000)

    const breaks: StaleLockBreak[] = []
    const lock = await acquireLock(path, {
      timeoutMs: 200,
      pollMs: 10,
      corruptGraceMs: 60 * 1000,
      onStaleBreak: (broken) => breaks.push(broken),
    })
    expect(lock.holder.pid).toBe(process.pid)
    expect(breaks).toHaveLength(1)
    expect(breaks[0]!.holder).toBeUndefined()
    expect(breaks[0]!.evidence).toContain('corrupt')
    await lock.release()
  })

  it('release never deletes a successor\'s lock: rename, verify token, restore on mismatch', async () => {
    const path = join(rootDir, 'successor-race.lock')
    // Simulates a successor acquiring between release's rename and its
    // ownership re-read: once the file is renamed away, it carries THEIR token.
    const successor = holderFor({ token: 'successor-token' })
    let hookRan = false
    const lock = await acquireLock(path, {
      // AWAITED, not fired and forgotten. The seam is declared
      // `=> void | Promise<void>` and release AWAITS it, so returning the
      // promise FORCES the successor's write to land before release re-reads
      // the renamed file. `void`-ing it instead made this test BET on that
      // write winning a race against release's own read: it lost on Node 24
      // in CI while passing on Node 26, and it would equally have PASSED on a
      // build where the restore was broken. A test that bets fails when it
      // should not and passes when it should not.
      beforeReleaseVerify: async (renamedPath) => {
        await writeHolder(renamedPath, successor)
        hookRan = true
      },
    })
    await lock.release()
    expect(hookRan).toBe(true)

    // Our token did not match, so the successor's lock must be back at the path.
    const restored = JSON.parse(await readFile(path, 'utf8')) as LockHolder
    expect(restored.token).toBe('successor-token')

    // And the store stays protected: acquisition still contends...
    try {
      await acquireLock(path, { timeoutMs: 50, pollMs: 10 })
      expect.unreachable()
    } catch (error) {
      expect((error as PandaError).code).toBe(PANDA_ERROR_CODES.registryContention)
    }
    await unlink(path)
  })

  it('validates options and clamps pollMs', async () => {
    const path = join(rootDir, 'options.lock')
    await expect(
      acquireLock(path, { timeoutMs: Number.NaN }),
    ).rejects.toMatchObject({ code: PANDA_ERROR_CODES.registryStoreUnavailable })
    await expect(
      acquireLock(path, { timeoutMs: -1 }),
    ).rejects.toMatchObject({ code: PANDA_ERROR_CODES.registryStoreUnavailable })

    // pollMs is clamped to >= 1 instead of being rejected or spinning.
    const lock = await acquireLock(path, { pollMs: 0 })
    await lock.release()
    expect(lock.holder.pid).toBe(process.pid)
  })
})
