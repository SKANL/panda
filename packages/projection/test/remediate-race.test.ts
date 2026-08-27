import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { runRemediation } from '../src/remediate.ts'

// HIGH-5: `discard` refuses to overwrite a change that landed while it was reading.
//
// WHY THIS FILE EXISTS SEPARATELY FROM `remediate.test.ts`, and why the test in
// it was rewritten.
//
// The guarantee is real and was established the hard way: the argument that the
// failing case could not be BUILT was accepted, a reviewer built it, and the
// guard went in. What was wrong was the TEST. It started the remediation without
// awaiting it, issued a competing write from its own turn of the loop, and
// repeated the whole thing up to 25 times — betting that one of those attempts
// would land inside the protected window. Its own comment claimed "the loop is
// what makes the assertion deterministic rather than the interleaving", and that
// is false: a loop makes winning likelier, never certain.
//
// It was never a fair bet. Between the snapshot and the guard,
// `discardLegacy` performs NO await at all — the scan, the removal span, the
// JSONC re-parse and the change record are every one of them synchronous. So the
// window a competing write has to hit is a single microtask boundary, while the
// competing write itself costs two filesystem round-trips. Node 24 on Windows
// happened to win it; Linux on Node 26 stopped, and M4.D's two new tests in
// `materialise.test.ts` were enough to shift the scheduling that far. A test that
// must win a race to pass will fail on some machine one day. This one did.
//
// SO THE PRECONDITION IS FORCED INSTEAD OF WAGERED. The competing write is fired
// BY the remediation's own snapshot `stat`, through a wrapper around
// `node:fs/promises` that lives in this file: the first `stat` of the target path
// is `statSnapshot`, and the hook runs after that call resolves and before
// anything else can. There is no window to miss, on any platform.
//
// WHAT IT DOES NOT DO, deliberately:
//   - it adds NO production seam. `runRemediation` is called exactly as the CLI
//     calls it, with the same request shape and no injected clock, filesystem or
//     callback. A seam that let a test skip the guard would be worse than the
//     flake, and this repository has shipped that defect before.
//   - it does not weaken the assertion to "pass if the race was not won". The
//     refusal, its message, and the SURVIVAL of the competing bytes are all
//     required, every run.
//   - it does not mock the guard, the stat it performs, or its verdict. The
//     wrapper only decides WHEN the competing write happens; everything the
//     guard then reads is the real file on the real disk. Delete
//     `hasFileChangedSince` from the apply path and this test fails, which is
//     the only reason to trust it.

/**
 * One-shot hooks, keyed by the path whose `stat` fires them. Declared through
 * `vi.hoisted` because `vi.mock`'s factory is hoisted above the imports.
 */
const race = vi.hoisted(() => ({ afterFirstStat: new Map<string, () => Promise<void>>() }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    // AFTER the real call resolves, never before: firing first would put the
    // competing write ahead of the snapshot, the snapshot would already describe
    // the new bytes, and the guard would correctly NOT fire — which would prove
    // nothing. The ordering this preserves is the whole construction.
    stat: (async (path: Parameters<typeof actual.stat>[0], ...rest: unknown[]) => {
      const result = await (actual.stat as (...args: unknown[]) => Promise<unknown>)(path, ...rest)
      const hook = race.afterFirstStat.get(String(path))
      if (hook !== undefined) {
        race.afterFirstStat.delete(String(path))
        await hook()
      }
      return result
    }) as typeof actual.stat,
  }
})

const LEGACY_JSON = `{
  "theme": "vercel",
  "panda": {
    "version": 1,
    "mcpServers": {
      "ctx": {
        "command": "ctx-server"
      }
    }
  }
}
`

const COMPETING = `{
  "theme": "someone else was here"
}
`

let sandbox: string

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'panda-remediate-race-'))
})

afterAll(async () => {
  await rm(sandbox, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
})

describe('discard refuses to overwrite a change that landed while it was reading', () => {
  it('loses no competing write', async () => {
    const path = join(sandbox, 'race.json')
    await writeFile(path, LEGACY_JSON, 'utf8')
    // Fired by `statSnapshot`'s own stat, so it lands inside the protected
    // window on every platform and every run.
    race.afterFirstStat.set(path, async () => {
      await writeFile(path, COMPETING, 'utf8')
    })

    const outcome = await runRemediation({
      remediation: 'discard',
      legacy: { targetId: 't', filePath: path, fileFormat: 'jsonc', rootPath: sandbox },
      mode: 'apply',
    })

    // The hook must have fired; a test whose precondition silently did not hold
    // is the failure mode this file was written to remove.
    expect(race.afterFirstStat.has(path), 'the competing write never fired').toBe(false)
    // The SURVIVAL first, because it is the whole point and because it is what a
    // failure should name: with the guard deleted, this is the assertion that
    // reports the lost write rather than a missing refusal.
    expect(await readFile(path, 'utf8'), 'the competing write was clobbered').toBe(COMPETING)
    expect(outcome.applied).toBe(false)
    expect(outcome.refusal?.message).toContain('modified while panda was reading it')
  })

  it('still discards normally when nothing competes, so the refusal is not the only outcome', async () => {
    // The other half of the same claim. Without it, a guard that refused
    // unconditionally would satisfy the row above.
    const path = join(sandbox, 'quiet.json')
    await writeFile(path, LEGACY_JSON, 'utf8')

    const outcome = await runRemediation({
      remediation: 'discard',
      legacy: { targetId: 't', filePath: path, fileFormat: 'jsonc', rootPath: sandbox },
      mode: 'apply',
    })

    expect(outcome.refusal).toBeUndefined()
    expect(outcome.applied).toBe(true)
    expect(await readFile(path, 'utf8')).not.toContain('panda')
  })
})
