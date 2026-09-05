import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { PANDA_ERROR_CODES, PandaError } from '@skanl/panda-contracts'
import { acquireLock } from '../src'
import type { LockHolder } from '../src'

const rootDir = await mkdtemp(join(tmpdir(), 'panda-lock-'))
afterAll(() => rm(rootDir, { recursive: true, force: true }))

/**
 * The protocol's own suite did not move: it lives in
 * `packages/registry/test/lock.test.ts`, where it drives the SAME code through
 * the registry's translating façade and therefore pins both the algorithm and
 * the promise that no published registry error changed.
 *
 * What is pinned HERE is the one thing that suite structurally cannot see: the
 * codes this leaf raises on its own. They must be neutral. A leaf that raised
 * `PANDA_REGISTRY_*` would hand a `@skanl/panda-projection` caller a registry error
 * out of a projection API — the AD-7 breach that made borrowing the registry's
 * lock unacceptable in the first place, reintroduced by the very move that was
 * supposed to end it.
 */
describe('@skanl/panda-lock raises its own codes and nobody else\'s (AD-7)', () => {
  it('round-trips an acquisition, and the holder document is complete before anyone can read it', async () => {
    const path = join(rootDir, 'round-trip.lock')
    const lock = await acquireLock(path)
    const persisted = JSON.parse(await readFile(path, 'utf8')) as LockHolder
    expect(persisted.token).toBe(lock.holder.token)
    expect(persisted.pid).toBe(process.pid)
    expect(persisted.host).toBe(hostname())
    await lock.release()
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses a contended lock with PANDA_LOCK_CONTENTION, never a registry code', async () => {
    const path = join(rootDir, 'contended.lock')
    // FORCED, not raced: this process holds the lock for the whole clause, so
    // the contender's bounded wait can only end one way.
    const held = await acquireLock(path)
    try {
      await acquireLock(path, { timeoutMs: 40, pollMs: 10 })
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(PandaError)
      expect((error as PandaError).code).toBe(PANDA_ERROR_CODES.lockContention)
      expect((error as PandaError).message).toContain(`${process.pid}@${hostname()}`)
      expect((error as PandaError).message).not.toContain('registry')
    } finally {
      await held.release()
    }
  })

  it('refuses an unusable option set with PANDA_LOCK_UNAVAILABLE', async () => {
    const path = join(rootDir, 'options.lock')
    await expect(acquireLock(path, { timeoutMs: Number.NaN })).rejects.toMatchObject({
      code: PANDA_ERROR_CODES.lockUnavailable,
    })
  })

  it('publishes no PANDA_REGISTRY_ or PANDA_PROJECTION_ code anywhere in its source', () => {
    // The clauses above assert three situations. This one closes the other two
    // sites at once, and keeps closing them when a sixth is added: a leaf owned
    // by no domain may not spell a domain's code at all.
    const source = [
      new URL('../src/lock.ts', import.meta.url),
      new URL('../src/index.ts', import.meta.url),
    ]
    for (const file of source) {
      const text = readFileSync(file, 'utf8')
      expect(text.includes('PANDA_ERROR_CODES.registry'), `${file.pathname} raises a registry code`).toBe(false)
      expect(text.includes('PANDA_ERROR_CODES.projection'), `${file.pathname} raises a projection code`).toBe(false)
    }
  })
})

/**
 * The stale break is the one place this file did NOT apply its own rule.
 * `releaseAcquired` renames the lockfile away, re-reads it, and unlinks it only
 * if it still carries our token — otherwise it puts a successor's lock back.
 * `breakLock` used to `unlink(path)` outright, so it could delete a live
 * successor's lock and leave two processes holding one lock (M33.A).
 *
 * WHY THIS CLAUSE IS IN-PROCESS AND USES A SEAM, stated because the obvious
 * alternative was tried first and was WRONG: a process-level harness cannot
 * place this interleaving. The window between the break's read and its write is
 * a few statements wide. Two contenders released at a barrier reproduce nothing
 * — and the first version of that harness reported the defect five times out of
 * five while actually measuring a LEGITIMATE break, because its first acquirer
 * EXITED as soon as it held, which makes the second contender's break lawful.
 * A harness whose holder does not stay alive measures correct behaviour and
 * calls it a bug.
 *
 * So the successor is planted through `beforeBreakVerify`, which is AWAITED for
 * the same reason `beforeReleaseVerify` is: an un-awaited seam lets a clause BET
 * on the successor's write landing in the window instead of forcing it there.
 * `packages/registry/test/lock.test.ts` records what that costs — the sibling
 * clause once "lost on Node 24 in CI while passing on Node 26, and it would
 * equally have PASSED on a build where the restore was broken."
 */
describe('a lock you break is not a lock you may delete (M33.A)', () => {
  it("leaves a successor's live lock alone when it acquires inside the break window", async () => {
    const path = join(rootDir, 'break-window.lock')
    const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)'])
    await writeFile(
      path,
      JSON.stringify({ pid: dead.pid, host: hostname(), token: 'STALE', acquiredAt: new Date().toISOString() }),
      'utf8',
    )
    const successor = JSON.stringify({
      pid: process.pid,
      host: hostname(),
      token: 'SUCCESSOR',
      acquiredAt: new Date().toISOString(),
    })

    let seamFired = 0
    const attempt = acquireLock(path, {
      timeoutMs: 800,
      pollMs: 5,
      beforeBreakVerify: async () => {
        seamFired += 1
        await writeFile(path, successor, 'utf8')
      },
    })

    await expect(attempt).rejects.toBeInstanceOf(PandaError)
    // The CONTROL for the assertion below: a clause where the seam never ran
    // would pass while forcing nothing, which is how the first version of this
    // measurement lied.
    expect(seamFired).toBeGreaterThanOrEqual(1)
    const onDisk = JSON.parse(await readFile(path, 'utf8')) as LockHolder
    expect(onDisk.token).toBe('SUCCESSOR')
  })

  it('still breaks a lock whose holder is provably dead, and reports it', async () => {
    // The other direction, and it is not optional: a break path that refuses to
    // break passes the clause above while destroying the feature.
    const path = join(rootDir, 'still-breaks.lock')
    const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)'])
    await writeFile(
      path,
      JSON.stringify({ pid: dead.pid, host: hostname(), token: 'STALE', acquiredAt: new Date().toISOString() }),
      'utf8',
    )
    const breaks: string[] = []
    const lock = await acquireLock(path, { timeoutMs: 800, pollMs: 5, onStaleBreak: (b) => breaks.push(b.evidence) })
    expect(lock.holder.token).not.toBe('STALE')
    expect(breaks).toHaveLength(1)
    expect(breaks[0]).toContain('ESRCH')
  })
})
