import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PANDA_ERROR_CODES, PandaError } from '@skanl/panda-contracts'
import { describe, expect, it } from 'vitest'
import { assertMethodMayMount, resolveMethod, swapMethod } from '../src/methods.ts'

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
    await expect(resolveMethod('@skanl/panda-there-is-no-such-package')).rejects.toBeInstanceOf(PandaError)
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

describe('M25.A: a method that arrived with a clone is not a method you chose', () => {
  /**
   * `panda run` imported and EXECUTED a module named by the `.panda/config.json`
   * of the directory it was run in. Driven at `b6562ef` against a temp project
   * holding a `hostile.mjs` whose only statement is a `writeFileSync`:
   *
   *   panda run hi                       exit 2   module executed: YES
   *   CONTROL, same project, no method   exit 1   module executed: no
   *
   * A module cannot be inspected without being loaded, so validation cannot
   * prevent this and neither can reordering. The layer that decided the
   * selection is the only thing available before the import, and it is enough:
   * `global` is the machine owner's own file, `agent` is a document the host
   * handed over programmatically, and `project` is the one that travels with a
   * clone.
   */
  it('refuses a selection the PROJECT layer decided, and names the command that adopts it', () => {
    let raised: unknown
    try {
      assertMethodMayMount({ specifier: './hostile.mjs', layer: 'project' })
    } catch (error) {
      raised = error
    }
    expect(raised).toBeInstanceOf(PandaError)
    expect((raised as PandaError).code).toBe(PANDA_ERROR_CODES.configurationUnusable)
    // The refusal has to be actionable, not merely correct: the user who wants
    // that methodology gets the one command that adopts it into a document they
    // own, which is the consent a cloned file cannot give.
    expect((raised as PandaError).message).toContain('./hostile.mjs')
    expect((raised as PandaError).message).toContain('project')
    // THE ADVICE CHANGED, AND THIS CLAUSE PINNING THE OLD ONE IS THE FINDING.
    // It used to require the message to name `panda swap method <specifier>`.
    // Driven end to end, that command is a CLOSED LOOP: it exits 0, writes the
    // machine document, and changes nothing, because layer precedence keeps
    // `project` deciding and this very guard fires again — byte-identically.
    // The user could run the recommended command forever.
    //
    // Worse, when the machine selection DID take effect it was a relative
    // specifier resolved against the run's cwd, which is the wildcard the
    // clauses below now refuse. The old advice walked the user into a wider
    // hole than the one this guard closes.
    //
    // A test that asserts a message CONTAINS a command pins that panda gives
    // advice. Nothing here can pin that the advice works; only driving it can,
    // and `packages/cli/test/method-layer-trust.test.ts` is where that lives —
    // it RUNS both steps of this message and then asserts the module mounted.
    //
    // Driving it is also what caught the SECOND closed loop: an advice naming
    // only the swap is still a loop, because the project key keeps deciding.
    // Both steps, in this order, or the sentence is false again.
    expect((raised as PandaError).message).toContain('.panda/config.json')
    expect((raised as PandaError).message).toContain('panda swap method ./hostile.mjs')
  })

  /**
   * A RELATIVE SPECIFIER IN A MACHINE-WIDE DOCUMENT IS NOT A SELECTION.
   *
   * `run-session.ts` resolves the specifier against the RUN's cwd regardless of
   * which layer decided it, so `"method": "./mine.mjs"` in `~/.panda/config.json`
   * means "whatever ./mine.mjs is in whatever directory you are standing in" — a
   * wildcard over every repository on the machine.
   *
   * Driven at `081cf6e`, with a control: standing in a directory that carried
   * only a `mine.mjs` and NO `.panda` config at all, the module's top-level code
   * RAN; the same directory with an empty HOME did not run it. So the marker was
   * caused by the machine-scope selection and nothing else.
   *
   * That is WIDER than the hole M25.A closed — that one needed the hostile
   * repository to carry a `.panda/config.json`; this needs only a file with the
   * right name — and it is reachable by following M25.A's own printed advice.
   *
   * Refused rather than resolved against the home directory. Resolving would
   * silently change what an existing selection means; refusing says the true
   * thing, which is that the selection never named a file.
   */
  it('refuses a RELATIVE specifier the machine document named, and says to make it absolute', () => {
    let raised: unknown
    try {
      assertMethodMayMount({ specifier: './mine.mjs', layer: 'global' })
    } catch (error) {
      raised = error
    }
    expect(raised).toBeInstanceOf(PandaError)
    expect((raised as PandaError).code).toBe(PANDA_ERROR_CODES.configurationUnusable)
    expect((raised as PandaError).message).toContain('./mine.mjs')
    expect((raised as PandaError).message).toContain('ABSOLUTE')
  })

  it.each([['./a.mjs'], ['../b.mjs'], ['.\\c.mjs'], ['..\\d.mjs']] as readonly (readonly [string])[])(
    'refuses %s from the machine document whatever the separator',
    (specifier) => {
      expect(() => assertMethodMayMount({ specifier, layer: 'global' })).toThrow(PandaError)
    },
  )

  it.each([['/abs/m.mjs'], ['my-method-package'], ['@scope/method']] as readonly (readonly [string])[])(
    'still lets the machine document name %s',
    (specifier) => {
      // The CONTROL for the two clauses above. A guard that refused every machine
      // specifier would satisfy them and would have removed the feature.
      expect(() => assertMethodMayMount({ specifier, layer: 'global' })).not.toThrow()
    },
  )

  it.each([['global'], ['agent']] as readonly (readonly [string])[])(
    'lets the %s layer mount, because that document is already yours',
    (layer) => {
      // The CONTROL for the clause above. A guard that refused every layer would
      // satisfy it perfectly and would have removed the feature instead of the
      // hazard.
      //
      // The specifier is ABSOLUTE, and the change from './m.mjs' is the finding
      // rather than a fixture tidy-up: a relative specifier in a machine-wide
      // document resolves against the RUN's cwd, so it named no file and is now
      // refused by the clauses below. This clause's subject was always WHICH
      // LAYER may mount; it happened to be written with a specifier that could
      // not have meant anything.
      expect(() => assertMethodMayMount({ specifier: '/abs/m.mjs', layer })).not.toThrow()
    },
  )
})
