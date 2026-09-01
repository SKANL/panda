import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PANDA_ERROR_CODES, PandaError } from '@panda/contracts'
import { describe, expect, it } from 'vitest'
import { resolveMethod, swapMethod } from '../src/methods.ts'

async function moduleDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'panda-method-'))
  await mkdir(root, { recursive: true })
  return root
}

/** Writes a real module to disk, because `resolveMethod` really imports one. */
async function writeModule(root: string, name: string, source: string): Promise<string> {
  const path = join(root, name)
  await writeFile(path, source, 'utf8')
  return pathToFileURL(path).href
}

const VALID = `export default {
  id: 'tdd',
  version: '1.0.0',
  phases: [{ id: 'red' }],
  artifacts: [{ id: 'plan', path: 'docs/plan.md', phase: 'red' }],
  commands: [{ id: 'tdd.start', phase: 'red' }],
}
`

describe('M5.D row 11: a module that is not a valid MethodPlugin', () => {
  it('accepts a valid one and hands back what the contract validated', async () => {
    const root = await moduleDir()
    const specifier = await writeModule(root, 'good.mjs', VALID)

    const method = await resolveMethod(specifier)

    expect(method.id).toBe('tdd')
    expect(method.phases.map((phase) => phase.id)).toEqual(['red'])
  })

  it('rejects one that breaks the contract, listing every violation', async () => {
    const root = await moduleDir()
    // Two violations at once: the pair rule and a path that escapes the root.
    // M5.B's guarantee is that BOTH are reported, and inheriting it is the point
    // of validating through the published contract rather than duplicating it.
    const specifier = await writeModule(
      root,
      'bad.mjs',
      `export default {
        id: 'bad', version: '1.0.0', phases: [], commands: [],
        artifacts: [{ id: 'a', path: '../../etc/passwd' }],
        onActivate: () => {},
      }
`,
    )

    try {
      await resolveMethod(specifier)
      expect.unreachable()
    } catch (error) {
      expect((error as PandaError).code).toBe(PANDA_ERROR_CODES.methodInvalidPlugin)
      expect((error as Error).message).toContain('onDeactivate')
      expect((error as Error).message).toContain('artifacts[0]')
    }
  })
})

describe('M5.D: a RELATIVE specifier resolves against the project, not against panda', () => {
  // FOUND BY DRIVING THE BINARY, with this whole file green. Every test above
  // hands `resolveMethod` a `file://` URL, which sidesteps module resolution
  // entirely — so `await import('./tdd.mjs')` resolved against
  // `packages/session/src/methods.ts` and NO relative specifier could ever work,
  // which is the ordinary way a user names a local method. A harness that
  // supplies what the real caller does not is testing a caller that does not
  // exist; this is the second time that sentence has cost this project a defect.
  it('imports a plain relative path from the directory panda was pointed at', async () => {
    const root = await moduleDir()
    await writeModule(root, 'local.mjs', VALID)

    const method = await resolveMethod('./local.mjs', root)

    expect(method.id).toBe('tdd')
  })

  it('names the base it searched when a relative specifier is not there', async () => {
    const root = await moduleDir()
    try {
      await resolveMethod('./absent.mjs', root)
      expect.unreachable()
    } catch (error) {
      expect((error as PandaError).code).toBe(PANDA_ERROR_CODES.configurationUnusable)
      expect((error as Error).message).toContain('./absent.mjs')
    }
  })
})

describe('M5.D row 10: a specifier that does not resolve', () => {
  // THE SILENT ONE. A broken selection that behaved like "no method selected"
  // would run a different methodology than the one configured, without saying
  // so — the exact failure story 2.7c exists to remove for `executor`.
  it('refuses coded, naming the specifier, rather than answering with no method', async () => {
    await expect(resolveMethod('./nothing-is-here.mjs')).rejects.toMatchObject({
      code: PANDA_ERROR_CODES.configurationUnusable,
    })
    await expect(resolveMethod('@panda/there-is-no-such-package')).rejects.toBeInstanceOf(PandaError)
  })

  it('names the specifier it could not load, so the message is actionable', async () => {
    try {
      await resolveMethod('./nothing-is-here.mjs')
      expect.unreachable()
    } catch (error) {
      expect((error as Error).message).toContain('./nothing-is-here.mjs')
    }
  })
})

describe('M5.D rows 14 and 15: the swap is ORDERED', () => {
  const trace: string[] = []
  // `void | Promise<void>` and not `unknown`: M5.B put the hook pair in the TYPE,
  // so a helper that widened the return here would be the test loosening the
  // contract it is testing against.
  const method = (id: string, deactivate?: () => void | Promise<void>) => ({
    id,
    version: '1.0.0',
    phases: [],
    artifacts: [],
    commands: [],
    onActivate: () => {
      trace.push(`${id}:activate`)
    },
    onDeactivate:
      deactivate ??
      (() => {
        trace.push(`${id}:deactivate`)
      }),
  })

  // FR-28's actual acceptance criterion, and the only place it is provable.
  //
  // The ordering is FORCED, never timed: the outgoing hook does not resolve
  // until a promise this test controls settles, so a `swapMethod` that started
  // the incoming activation concurrently would record `b:activate` BEFORE
  // `a:deactivate` and fail deterministically. A version that slept and hoped
  // would pass on a fast machine and flake on a slow one — the race lesson from
  // the session ledger, applied on purpose.
  it('runs the outgoing onDeactivate to completion before the incoming onActivate is called', async () => {
    trace.length = 0
    let releaseOutgoing!: () => void
    const outgoingGate = new Promise<void>((resolve) => {
      releaseOutgoing = resolve
    })

    const outgoing = await swapMethod(undefined, method('a', async () => {
      trace.push('a:deactivate-started')
      await outgoingGate
      trace.push('a:deactivate-finished')
    }))
    expect(trace).toEqual(['a:activate'])

    const pending = swapMethod(outgoing, method('b'))
    // The outgoing hook is deliberately still in flight here. If the incoming
    // activation were concurrent, this assertion is where it would show.
    await Promise.resolve()
    expect(trace).toEqual(['a:activate', 'a:deactivate-started'])

    releaseOutgoing()
    await pending

    expect(trace).toEqual(['a:activate', 'a:deactivate-started', 'a:deactivate-finished', 'b:activate'])
  })

  it('does NOT activate the incoming when the outgoing teardown fails, and names which half failed', async () => {
    trace.length = 0
    const outgoing = await swapMethod(undefined, method('a', () => {
      throw new Error('templates could not be removed')
    }))

    try {
      await swapMethod(outgoing, method('b'))
      expect.unreachable()
    } catch (error) {
      expect((error as PandaError).code).toBe(PANDA_ERROR_CODES.methodHookFailed)
      expect((error as Error).message).toContain("'onDeactivate'")
      expect((error as Error).message).toContain("method 'a'")
    }
    // The incoming never mounted: a half-swapped environment is worse than a
    // refused one, because nothing reports it.
    expect(trace).not.toContain('b:activate')
  })

  it('activates with no outgoing, which is what a session start is', async () => {
    trace.length = 0
    const handle = await swapMethod(undefined, method('a'))
    expect(trace).toEqual(['a:activate'])
    await handle.deactivate()
    expect(trace).toEqual(['a:activate', 'a:deactivate'])
  })
})
