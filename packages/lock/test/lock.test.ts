import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { PANDA_ERROR_CODES, PandaError } from '@panda/contracts'
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
 * `PANDA_REGISTRY_*` would hand a `@panda/projection` caller a registry error
 * out of a projection API — the AD-7 breach that made borrowing the registry's
 * lock unacceptable in the first place, reintroduced by the very move that was
 * supposed to end it.
 */
describe('@panda/lock raises its own codes and nobody else\'s (AD-7)', () => {
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
