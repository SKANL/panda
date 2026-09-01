import { describe, expect, it } from 'vitest'
import { validateManifest } from '@panda/kernel'
import {
  METHOD_PLUGIN_ROOT_KEYS,
  METHOD_PLUGIN_SCHEMA,
  PANDA_ERROR_CODES,
  PandaError,
  activateMethod,
  isProjectRelativePath,
  isSemver,
  methodPluginIssues,
  validateMethodPlugin,
  type MethodPlugin,
} from '../src'

// The minimal manifest of the spine: identity, phases, artifacts, commands.
function methodPlugin(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: 'tdd',
    version: '1.0.0',
    phases: [{ id: 'red' }, { id: 'green', description: 'make it pass' }],
    artifacts: [{ id: 'plan', path: 'docs/plan.md', phase: 'red' }],
    commands: [{ id: 'tdd.start', summary: 'begin a cycle', phase: 'red' }],
    ...overrides,
  }
}

function messagesFor(value: unknown): string {
  return methodPluginIssues(value)
    .map((entry) => entry.message)
    .join(' | ')
}

describe('MethodPlugin contract — matrix row 1: a minimal valid manifest round-trips', () => {
  it('accepts it and returns identity, phases, artifacts and commands unchanged', () => {
    const input = methodPlugin()
    const result = validateMethodPlugin(input)
    expect(result).toEqual(input)
    expect(result.id).toBe('tdd')
    expect(result.version).toBe('1.0.0')
    expect(result.phases.map((phase) => phase.id)).toEqual(['red', 'green'])
    expect(result.artifacts).toEqual([{ id: 'plan', path: 'docs/plan.md', phase: 'red' }])
    expect(result.commands).toEqual([{ id: 'tdd.start', summary: 'begin a cycle', phase: 'red' }])
  })

  it('accepts empty collections, and a description and extensions when offered', () => {
    expect(() =>
      validateMethodPlugin({
        id: 'empty',
        version: '0.1.0',
        description: 'a method that declares nothing yet',
        phases: [],
        artifacts: [],
        commands: [],
        extensions: { vendor: { anything: true } },
      }),
    ).not.toThrow()
  })

  it('exposes the same verdict through the Standard Schema v1 surface', () => {
    const passing = METHOD_PLUGIN_SCHEMA['~standard'].validate(methodPlugin()) as { value?: MethodPlugin }
    expect(passing.value).toEqual(methodPlugin())
    const failing = METHOD_PLUGIN_SCHEMA['~standard'].validate(methodPlugin({ version: '1.2' })) as {
      issues?: readonly { message: string }[]
    }
    expect(failing.issues?.[0]?.message).toContain('semver')
  })
})

describe('MethodPlugin contract — matrix row 2: a missing required field is rejected, naming the field', () => {
  it.each([['id'], ['version'], ['phases'], ['artifacts'], ['commands']])('names %s when it is absent', (field) => {
    const input = methodPlugin() as Record<string, unknown>
    delete input[field]
    try {
      validateMethodPlugin(input)
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(PandaError)
      expect((error as PandaError).code).toBe(PANDA_ERROR_CODES.methodInvalidPlugin)
      expect((error as PandaError).code).toBe('PANDA_METHOD_INVALID_PLUGIN')
      expect((error as Error).message).toContain(field)
    }
  })

  it.each([
    ['a phase with no id', { phases: [{ description: 'nameless' }] }],
    ['an artifact with no id', { artifacts: [{ path: 'docs/x.md' }] }],
    ['an artifact with no path', { artifacts: [{ id: 'x' }] }],
  ])('rejects %s', (_label, overrides) => {
    expect(() => validateMethodPlugin(methodPlugin(overrides))).toThrow(PandaError)
  })

  it('rejects a non-object outright', () => {
    expect(messagesFor('a method')).toContain('must be an object')
    expect(messagesFor(null)).toContain('must be an object')
    expect(messagesFor([])).toContain('must be an object')
  })
})

describe('MethodPlugin contract — matrix row 3: unknown keys, and the reserved extensions namespace', () => {
  it('rejects an unknown key at the root and points at extensions', () => {
    const message = messagesFor(methodPlugin({ templates: ['x'] }))
    expect(message).toContain("'templates' is not allowed on the method plugin root")
    expect(message).toContain("'extensions'")
  })

  it('rejects an unknown key on a collection item, where there is no escape hatch', () => {
    expect(messagesFor(methodPlugin({ phases: [{ id: 'red', descripton: 'typo' }] }))).toContain(
      "'descripton' is not allowed on phases[0]",
    )
    expect(messagesFor(methodPlugin({ commands: [{ id: 'c', prompt: 'x' }] }))).toContain(
      "'prompt' is not allowed on commands[0]",
    )
  })

  it('rejects extensions that is not an object', () => {
    expect(messagesFor(methodPlugin({ extensions: 'nope' }))).toContain("'extensions' must be an object")
  })

  it('publishes the root key set, so an author can enumerate the envelope', () => {
    expect([...METHOD_PLUGIN_ROOT_KEYS].sort()).toEqual([
      'artifacts',
      'commands',
      'description',
      'extensions',
      'id',
      'onActivate',
      'onDeactivate',
      'phases',
      'version',
    ])
  })
})

// Rows 4 and 5. The corpus is shared with the kernel parity clause below: the
// two packages carry two copies of the pattern because AD-1 forbids the kernel a
// dependency on this one, and this is what stops them drifting.
const VERSION_CORPUS: readonly [label: string, version: string, semver: boolean][] = [
  ['a release', '1.0.0', true],
  ['a zero release', '0.0.0', true],
  ['a large release', '10.20.30', true],
  ['a prerelease', '1.0.0-rc.1', true],
  ['an alpha prerelease', '1.0.0-alpha', true],
  ['build metadata', '1.0.0+build.5', true],
  ['prerelease and build', '1.0.0-rc.1+build.5', true],
  ['a two-part version', '1.2', false],
  ['a bare major', '1', false],
  ['a v-prefixed version', 'v1.0.0', false],
  ['a dist-tag', 'latest', false],
  ['a leading zero', '01.0.0', false],
  ['a caret range', '^1.0.0', false],
  ['a four-part version', '1.0.0.0', false],
  ['an empty prerelease', '1.0.0-', false],
  ['prose', 'banana', false],
  ['dotted prose', 'not.a.semver-at.all', false],
  ['an empty string', '', false],
]

describe('MethodPlugin contract — matrix rows 4 and 5: version is semver', () => {
  it.each(VERSION_CORPUS.filter(([, , semver]) => !semver))('rejects %s as non-semver', (_label, version) => {
    const message = messagesFor(methodPlugin({ version }))
    expect(message).toContain("'version'")
    expect(message).toContain('semver')
  })

  it.each(VERSION_CORPUS.filter(([, , semver]) => semver))('accepts %s', (_label, version) => {
    expect(methodPluginIssues(methodPlugin({ version }))).toEqual([])
  })

  it('rejects a non-string version', () => {
    expect(messagesFor(methodPlugin({ version: 1 }))).toContain('semver')
  })

  // The whole point of the duplication comment in both files. A copy that drifts
  // would let a plugin manifest and a method manifest disagree about what a
  // version is, in a repository whose NFR-8 versions every Contract together.
  it('agrees with the kernel copy of the pattern on every string in the corpus', () => {
    const kernelManifest = (version: string): unknown => ({
      id: 'p',
      version,
      provides: [],
      consumes: [],
      configSchema: { '~standard': { version: 1 as const, validate: (value: unknown) => ({ value }) } },
    })
    for (const [label, version, semver] of VERSION_CORPUS) {
      expect(isSemver(version), `${label}: contracts`).toBe(semver)
      let kernelAccepted = true
      try {
        validateManifest(kernelManifest(version))
      } catch {
        kernelAccepted = false
      }
      expect(kernelAccepted, `${label}: kernel`).toBe(semver)
    }
  })
})

describe('MethodPlugin contract — matrix row 6: command identity is required and unique', () => {
  it('rejects a command with no identity', () => {
    expect(messagesFor(methodPlugin({ commands: [{ summary: 'nameless' }] }))).toContain(
      "'id' must be a non-empty string on commands[0]",
    )
  })

  it('rejects two commands sharing an id, naming the id', () => {
    const message = messagesFor(methodPlugin({ commands: [{ id: 'dup' }, { id: 'dup' }] }))
    expect(message).toContain("commands declares 'dup' more than once")
  })

  it('applies the same uniqueness rule to phases and artifacts', () => {
    expect(messagesFor(methodPlugin({ phases: [{ id: 'red' }, { id: 'red' }] }))).toContain(
      "phases declares 'red' more than once",
    )
    expect(
      messagesFor(methodPlugin({ artifacts: [{ id: 'a', path: 'x' }, { id: 'a', path: 'y' }] })),
    ).toContain("artifacts declares 'a' more than once")
  })

  it('rejects a phase reference no declared phase answers for', () => {
    const message = messagesFor(methodPlugin({ commands: [{ id: 'c', phase: 'blue' }] }))
    expect(message).toContain("names phase 'blue'")
    expect(message).toContain('red, green')
  })
})

describe('MethodPlugin contract — matrix row 7: the hooks are a pair or neither', () => {
  const noop = (): void => {}

  it('accepts neither', () => {
    expect(methodPluginIssues(methodPlugin())).toEqual([])
  })

  it('accepts both', () => {
    expect(methodPluginIssues(methodPlugin({ onActivate: noop, onDeactivate: noop }))).toEqual([])
  })

  it('rejects onActivate without onDeactivate', () => {
    expect(messagesFor(methodPlugin({ onActivate: noop }))).toContain(
      "'onActivate' is declared without 'onDeactivate'",
    )
  })

  it('rejects onDeactivate without onActivate — the same half-pair from the other side', () => {
    expect(messagesFor(methodPlugin({ onDeactivate: noop }))).toContain(
      "'onDeactivate' is declared without 'onActivate'",
    )
  })

  it('rejects a hook that is not a function', () => {
    expect(messagesFor(methodPlugin({ onActivate: 'go', onDeactivate: noop }))).toContain(
      "'onActivate' must be a function",
    )
  })
})

describe('MethodPlugin contract — matrix row 8: activate, then deactivate', () => {
  it('runs onActivate once, then onDeactivate once, and a second deactivate is a no-op', async () => {
    const calls: string[] = []
    const activation = await activateMethod(
      methodPlugin({
        onActivate: () => {
          calls.push('activate')
        },
        onDeactivate: async () => {
          await Promise.resolve()
          calls.push('deactivate')
        },
      }),
    )
    expect(activation.id).toBe('tdd')
    expect(calls).toEqual(['activate'])

    await activation.deactivate()
    expect(calls).toEqual(['activate', 'deactivate'])

    await activation.deactivate()
    await activation.deactivate()
    expect(calls).toEqual(['activate', 'deactivate'])
  })

  it('collapses concurrent deactivations into one run', async () => {
    let runs = 0
    const activation = await activateMethod(
      methodPlugin({
        onActivate: () => {},
        onDeactivate: async () => {
          runs += 1
          await Promise.resolve()
        },
      }),
    )
    await Promise.all([activation.deactivate(), activation.deactivate()])
    expect(runs).toBe(1)
  })

  it('activates a method with no hooks at all, and deactivating it is inert', async () => {
    const activation = await activateMethod(methodPlugin())
    await expect(activation.deactivate()).resolves.toBeUndefined()
  })

  it('validates before mounting, so an invalid method never activates', async () => {
    let activated = false
    await expect(
      activateMethod(
        methodPlugin({
          version: '1.2',
          onActivate: () => {
            activated = true
          },
          onDeactivate: () => {},
        }),
      ),
    ).rejects.toMatchObject({ code: PANDA_ERROR_CODES.methodInvalidPlugin })
    expect(activated).toBe(false)
  })

  it('reports a throwing onDeactivate coded, and does not retry it', async () => {
    let runs = 0
    const activation = await activateMethod(
      methodPlugin({
        onActivate: () => {},
        onDeactivate: () => {
          runs += 1
          throw new Error('teardown broke')
        },
      }),
    )
    await expect(activation.deactivate()).rejects.toMatchObject({
      code: 'PANDA_METHOD_HOOK_FAILED',
      message: expect.stringContaining("method 'tdd' failed in 'onDeactivate'"),
    })
    await expect(activation.deactivate()).resolves.toBeUndefined()
    expect(runs).toBe(1)
  })
})

describe('MethodPlugin contract — matrix row 9: onActivate throws', () => {
  it('raises a coded error naming the method and the hook, and leaves nothing mounted', async () => {
    let deactivateRan = false
    const failing = methodPlugin({
      onActivate: () => {
        throw new Error('template directory missing')
      },
      onDeactivate: () => {
        deactivateRan = true
      },
    })

    await expect(activateMethod(failing)).rejects.toBeInstanceOf(PandaError)
    try {
      await activateMethod(failing)
      expect.unreachable()
    } catch (error) {
      expect((error as PandaError).code).toBe(PANDA_ERROR_CODES.methodHookFailed)
      expect((error as PandaError).code).toBe('PANDA_METHOD_HOOK_FAILED')
      expect((error as Error).message).toContain("method 'tdd'")
      expect((error as Error).message).toContain("'onActivate'")
      expect((error as Error).message).toContain('template directory missing')
      expect((error as Error).cause).toBeInstanceOf(Error)
    }
    // No handle was returned, so nothing in the product can deactivate a method
    // that never activated.
    expect(deactivateRan).toBe(false)
  })

  it('reports a rejected async onActivate the same way', async () => {
    await expect(
      activateMethod(
        methodPlugin({
          onActivate: () => Promise.reject(new Error('async boom')),
          onDeactivate: () => {},
        }),
      ),
    ).rejects.toMatchObject({ code: 'PANDA_METHOD_HOOK_FAILED', message: expect.stringContaining('async boom') })
  })
})

// --- M5.B: the rules the document stated and nothing enforced ----------------

// Every entry is one of D1's eight rejection reasons or one of the accepted
// forms. The ACCEPTED half is as load-bearing as the rejected half: a predicate
// that rejects `a/b/../../c` blocks a legitimate manifest, which is its own
// defect. Each rejected row names the SINGLE rule it is here to kill, so a
// mutation that removes one rule cannot hide behind another row's coverage.
const PATH_CORPUS: readonly [label: string, path: string, accepted: boolean][] = [
  ['a plain relative path', 'docs/plan.md', true],
  ['an explicitly-relative path', './docs/plan.md', true],
  ['a path that walks up inside its own base', 'a/b/../../c', true],
  ['a directory convention', 'docs/', true],
  ['a traversal that escapes the root', '../../etc/passwd', false],
  ['a backslash traversal', '..\\..\\etc', false],
  ['a POSIX-absolute path', '/etc/passwd', false],
  ['a UNC path', '//server/share', false],
  ['a drive-absolute path', 'C:/Windows', false],
  ['a drive-relative path', 'C:x', false],
  ['a home-marked path', '~/secrets', false],
  ['a path carrying a NUL byte', 'a\u0000b', false],
  ['a path that resolves to the project root', 'a/..', false],
  ['a backslash separator that escapes nothing', 'docs\\plan.md', false],
  ['a blank path', '   ', false],
]

describe('MethodPlugin contract — M5.B rows 1-12: an artifact path is project-relative', () => {
  it.each(PATH_CORPUS.filter(([, , accepted]) => accepted))('accepts %s', (_label, path) => {
    expect(methodPluginIssues(methodPlugin({ artifacts: [{ id: 'a', path }] }))).toEqual([])
  })

  it.each(PATH_CORPUS.filter(([, , accepted]) => !accepted))('rejects %s', (_label, path) => {
    expect(messagesFor(methodPlugin({ artifacts: [{ id: 'a', path }] }))).toContain('artifacts[0]')
  })

  it('publishes the predicate, so an author can check a path before shipping', () => {
    for (const [label, path, accepted] of PATH_CORPUS) {
      expect(isProjectRelativePath(path), label).toBe(accepted)
    }
  })

  // Row 15. The predicate is published, so a JavaScript caller can hand it
  // anything; it answers rather than throwing.
  it('answers false for a non-string instead of throwing', () => {
    expect(isProjectRelativePath(undefined)).toBe(false)
    expect(isProjectRelativePath(42)).toBe(false)
    expect(isProjectRelativePath(['docs/plan.md'])).toBe(false)
  })
})

describe('MethodPlugin contract — M5.B rows 13 and 14: the path rule composes', () => {
  // Row 13, the one that would be silent: a per-field early return would report
  // the first bad path and hide the second, and the document promises EVERY
  // violation, not the first.
  it('reports every bad path, not the first', () => {
    const message = messagesFor(
      methodPlugin({
        artifacts: [
          { id: 'one', path: '/etc/passwd' },
          { id: 'two', path: '../escape' },
        ],
      }),
    )
    expect(message).toContain('artifacts[0]')
    expect(message).toContain('artifacts[1]')
  })

  it('lists a bad path alongside violations of the other rules', () => {
    const message = messagesFor(
      methodPlugin({ version: 'latest', artifacts: [{ id: 'a', path: '/etc/passwd' }] }),
    )
    expect(message).toContain('semver')
    expect(message).toContain('artifacts[0]')
  })
})

// Rows 16-20 are COMPILE-TIME assertions. `@ts-expect-error` is a failing guard
// here: an unused directive is TS2578, `packages/contracts/tsconfig.json`
// includes `test`, and this package's `typecheck` script is `tsc --noEmit`
// inside `pnpm check`. So the moment the type stops rejecting one of these, the
// gate goes red — which is the whole point of moving the pair rule out of prose.
//
// Each literal is also fed to the runtime validator, so one fixture pins both
// halves and they cannot drift apart.
describe('MethodPlugin contract — M5.B rows 16-20: the type carries the pair rule', () => {
  const noop = (): void => {}
  const manifest = {
    id: 'tdd',
    version: '1.0.0',
    phases: [],
    artifacts: [],
    commands: [],
  }

  it('row 16 — rejects onActivate without onDeactivate, at compile time AND at runtime', () => {
    // @ts-expect-error — the pair rule: a mount with no unmount.
    const halfPair: MethodPlugin = { ...manifest, onActivate: noop }
    expect(messagesFor(halfPair)).toContain("'onActivate' is declared without 'onDeactivate'")
  })

  it('row 16b — rejects onDeactivate without onActivate, the same half-pair from the other side', () => {
    // @ts-expect-error — an unmount for something that was never registered.
    const halfPair: MethodPlugin = { ...manifest, onDeactivate: noop }
    expect(messagesFor(halfPair)).toContain("'onDeactivate' is declared without 'onActivate'")
  })

  it('row 17 — accepts both hooks', () => {
    const paired: MethodPlugin = { ...manifest, onActivate: noop, onDeactivate: noop }
    expect(methodPluginIssues(paired)).toEqual([])
  })

  it('row 18 — accepts neither hook', () => {
    const bare: MethodPlugin = manifest
    expect(methodPluginIssues(bare)).toEqual([])
  })

  it('row 19 — accepts an explicit undefined, because the type agrees with the validator', () => {
    // The runtime rule is `value['onActivate'] !== undefined`. The type says
    // `?: undefined`, not `?: never`, so the two answer identically here.
    const explicit: MethodPlugin = { ...manifest, onActivate: undefined }
    expect(methodPluginIssues(explicit)).toEqual([])
  })

  it('row 20 — still rejects a misspelled root key', () => {
    // The guard D3 could have traded away: excess-property checking has to keep
    // working against an intersection-with-a-union.
    // @ts-expect-error — TS2561, the check that survived the type change.
    const typo: MethodPlugin = { ...manifest, descripton: 'typo' }
    expect(messagesFor(typo)).toContain("'descripton' is not allowed on the method plugin root")
  })
})
