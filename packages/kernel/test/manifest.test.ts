import { describe, expect, it } from 'vitest'
import { ManifestInvalidError, PandaKernelError, validateManifest } from '../src'
import { manifest, passthroughSchema } from './helpers'

describe('validateManifest', () => {
  it('accepts a fully declared manifest', () => {
    const result = validateManifest(
      manifest({
        id: 'plugin-a',
        version: '2.1.3',
        provides: ['svc.one'],
        consumes: [{ service: 'svc.two', mode: 'hard' }, { service: 'svc.three', mode: 'soft' }],
      }),
    )
    expect(result).toEqual({
      id: 'plugin-a',
      version: '2.1.3',
      provides: ['svc.one'],
      consumes: [{ service: 'svc.two', mode: 'hard' }, { service: 'svc.three', mode: 'soft' }],
      configSchema: passthroughSchema,
    })
  })

  it('is synchronous and never returns a promise', () => {
    const result = validateManifest(manifest())
    expect(result).not.toBeInstanceOf(Promise)
  })

  it.each(['id', 'version', 'provides', 'consumes', 'configSchema'] as const)('rejects a manifest missing %s', (field) => {
    const input = manifest() as Record<string, unknown>
    delete input[field]
    expect(() => validateManifest(input)).toThrow(ManifestInvalidError)
    try {
      validateManifest(input)
      expect.unreachable()
    } catch (error) {
      expect((error as PandaKernelError).code).toBe('PANDA_KERNEL_MANIFEST_INVALID')
      expect((error as Error).message).toContain(field)
    }
  })

  it('rejects a non-object manifest', () => {
    expect(() => validateManifest('nope')).toThrow(ManifestInvalidError)
    expect(() => validateManifest(null)).toThrow(ManifestInvalidError)
    expect(() => validateManifest([])).toThrow(ManifestInvalidError)
  })

  it.each([
    ['empty id', { id: '' }],
    ['non-string id', { id: 42 }],
    ['empty version', { version: '' }],
  ])('rejects a manifest with %s', (_label, overrides) => {
    expect(() => validateManifest(manifest(overrides))).toThrow(ManifestInvalidError)
  })

  it('rejects malformed provides entries', () => {
    expect(() => validateManifest(manifest({ provides: ['ok', ''] }))).toThrow(/'provides'/)
    expect(() => validateManifest(manifest({ provides: [7] }))).toThrow(ManifestInvalidError)
  })

  it('rejects malformed consumes entries', () => {
    expect(() => validateManifest(manifest({ consumes: [{ service: '', mode: 'hard' }] }))).toThrow(/'consumes'/)
    expect(() => validateManifest(manifest({ consumes: [{ service: 'svc', mode: 'maybe' }] }))).toThrow(ManifestInvalidError)
    expect(() => validateManifest(manifest({ consumes: [{ mode: 'hard' }] }))).toThrow(ManifestInvalidError)
    expect(() => validateManifest(manifest({ consumes: ['svc'] }))).toThrow(ManifestInvalidError)
  })

  it('rejects a configSchema that is not a Standard Schema v1 object', () => {
    expect(() => validateManifest(manifest({ configSchema: {} }))).toThrow(/'configSchema'/)
    expect(() => validateManifest(manifest({ configSchema: { '~standard': { version: 2, validate: () => ({}) } } }))).toThrow(
      ManifestInvalidError,
    )
    expect(() =>
      validateManifest(manifest({ configSchema: { '~standard': { version: 1 } } })),
    ).toThrow(ManifestInvalidError)
  })

  it.each([
    ['whitespace-only id', { id: '   ' }],
    ['whitespace-only version', { version: '\t' }],
    ['whitespace-only provides entry', { provides: ['svc.ok', ' '] }],
    ['whitespace-only consumes service', { consumes: [{ service: ' ', mode: 'hard' }] }],
  ])('rejects a manifest with a %s', (_label, overrides) => {
    expect(() => validateManifest(manifest(overrides))).toThrow(ManifestInvalidError)
  })

  it('rejects a configSchema whose validate is asynchronous', () => {
    const asyncSchema = { '~standard': { version: 1 as const, validate: () => Promise.resolve({ value: undefined }) } }
    expect(() => validateManifest(manifest({ configSchema: asyncSchema }))).toThrow(ManifestInvalidError)
    try {
      validateManifest(manifest({ configSchema: asyncSchema }))
      expect.unreachable()
    } catch (error) {
      expect((error as PandaKernelError).code).toBe('PANDA_KERNEL_MANIFEST_INVALID')
      expect((error as Error).message).toContain('configSchema')
      expect((error as Error).message).toContain('synchronously')
    }
  })

  it.each([
    ['a two-part version', '1.2'],
    ['a v-prefixed version', 'v1.0.0'],
    ['a dist-tag', 'latest'],
    ['a bare major', '1'],
    ['a leading zero', '01.0.0'],
    ['a range', '^1.0.0'],
    ['prose', 'banana'],
    ['dotted prose', 'not.a.semver-at.all'],
  ])('rejects %s as a version, naming the field and the value', (_label, version) => {
    try {
      validateManifest(manifest({ version }))
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(ManifestInvalidError)
      expect((error as PandaKernelError).code).toBe('PANDA_KERNEL_MANIFEST_INVALID')
      expect((error as Error).message).toContain("'version'")
      expect((error as Error).message).toContain('semver')
      expect((error as Error).message).toContain(version)
    }
  })

  it.each([
    ['a release', '1.0.0'],
    ['a zero release', '0.0.0'],
    ['a prerelease', '1.0.0-rc.1'],
    ['build metadata', '1.0.0+build.5'],
    ['both', '1.0.0-rc.1+build.5'],
  ])('accepts %s', (_label, version) => {
    expect(validateManifest(manifest({ version })).version).toBe(version)
  })

  it('normalizes whitespace-padded values to trimmed stored values', () => {
    const result = validateManifest(
      manifest({
        id: ' plugin-a ',
        version: '\t1.0.0 ',
        provides: [' svc.one '],
        consumes: [{ service: ' svc.two ', mode: 'hard' }],
      }),
    )
    expect(result.id).toBe('plugin-a')
    expect(result.version).toBe('1.0.0')
    expect(result.provides).toEqual(['svc.one'])
    expect(result.consumes).toEqual([{ service: 'svc.two', mode: 'hard' }])
  })

  it('rejects a configSchema whose validate throws synchronously', () => {
    const throwingSchema = {
      '~standard': {
        version: 1 as const,
        validate: () => {
          throw new Error('schema exploded')
        },
      },
    }
    expect(() => validateManifest(manifest({ configSchema: throwingSchema }))).toThrow(ManifestInvalidError)
    try {
      validateManifest(manifest({ configSchema: throwingSchema }))
      expect.unreachable()
    } catch (error) {
      expect((error as PandaKernelError).code).toBe('PANDA_KERNEL_MANIFEST_INVALID')
      expect((error as Error).message).toContain('configSchema')
    }
  })

  it('rejects duplicate entries in provides', () => {
    expect(() => validateManifest(manifest({ provides: ['svc.one', 'svc.one'] }))).toThrow(ManifestInvalidError)
    try {
      validateManifest(manifest({ provides: ['svc.one', 'svc.one'] }))
      expect.unreachable()
    } catch (error) {
      expect((error as Error).message).toContain("'provides'")
      expect((error as Error).message).toContain('svc.one')
    }
  })

  it('rejects duplicate entries in consumes even across modes', () => {
    const sameMode = [{ service: 'svc.dup', mode: 'hard' }, { service: 'svc.dup', mode: 'hard' }]
    const mixedModes = [{ service: 'svc.dup', mode: 'hard' }, { service: 'svc.dup', mode: 'soft' }]
    for (const consumes of [sameMode, mixedModes]) {
      expect(() => validateManifest(manifest({ consumes }))).toThrow(ManifestInvalidError)
      try {
        validateManifest(manifest({ consumes }))
        expect.unreachable()
      } catch (error) {
        expect((error as Error).message).toContain("'consumes'")
        expect((error as Error).message).toContain('svc.dup')
      }
    }
  })
})

// --- M7.B: the kernel tells an author everything it found --------------------

describe('M7.B rows 1-2: every violation, not the first', () => {
  it('reports a bad id, a bad version and a bad provides entry in ONE throw', () => {
    try {
      validateManifest({
        id: '   ',
        version: 'latest',
        provides: [''],
        consumes: [],
        configSchema: passthroughSchema,
      })
      expect.unreachable()
    } catch (error) {
      const issues = (error as ManifestInvalidError).issues
      expect(issues).toHaveLength(3)
      expect(issues.join(' | ')).toContain("'id'")
      expect(issues.join(' | ')).toContain("'version'")
      expect(issues.join(' | ')).toContain("'provides'")
    }
  })

  // The regression guard. Nine existing assertions read the MESSAGE of a
  // single-violation rejection, and a story about better messages that breaks
  // every message assertion has traded one problem for another.
  it('leaves the single-violation message exactly as it reads today', () => {
    try {
      validateManifest({ id: 'ok', version: '1.2', provides: [], consumes: [], configSchema: passthroughSchema })
      expect.unreachable()
    } catch (error) {
      expect((error as Error).message).toContain("invalid plugin manifest: 'version'")
      expect((error as ManifestInvalidError).issues).toHaveLength(1)
    }
  })
})

describe('M7.B rows 3-7: structural failures stop, and carry what was already found', () => {
  it('throws immediately when the manifest is not an object', () => {
    expect(() => validateManifest('nope')).toThrow(ManifestInvalidError)
    expect(() => validateManifest(null)).toThrow(ManifestInvalidError)
  })

  // ROW 4, the one a naive implementation gets wrong. Collecting correctly and
  // then throwing the structural failure BARE passes every other row here: the
  // author fixes the fatal problem, re-runs, and only then learns the kernel had
  // already seen the others.
  it('carries the issues collected BEFORE a structural failure', () => {
    try {
      validateManifest({
        id: '',
        version: 'nope',
        provides: [],
        consumes: 'not-an-array',
        configSchema: passthroughSchema,
      })
      expect.unreachable()
    } catch (error) {
      const issues = (error as ManifestInvalidError).issues
      expect(issues.join(' | ')).toContain("'id'")
      expect(issues.join(' | ')).toContain("'version'")
      expect(issues.join(' | ')).toContain("'consumes'")
    }
  })

  it('never dereferences a consumes entry it just rejected', () => {
    expect(() =>
      validateManifest({
        id: 'a',
        version: '1.0.0',
        provides: [],
        consumes: ['not-an-object'],
        configSchema: passthroughSchema,
      }),
    ).toThrow(ManifestInvalidError)
  })

  // Without the structural guard this reaches `configSchema['~standard']` on
  // undefined and raises a raw TypeError, which is not a coded PandaError (AD-7).
  it('refuses an absent configSchema coded, carrying what came before it', () => {
    try {
      validateManifest({ id: 'a', version: 'bad', provides: [], consumes: [] })
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(ManifestInvalidError)
      expect((error as ManifestInvalidError).issues.join(' | ')).toContain("'version'")
      expect((error as ManifestInvalidError).issues.join(' | ')).toContain("'configSchema'")
    }
  })

  it('collects an async configSchema rather than treating it as structural', () => {
    try {
      validateManifest({
        id: '',
        version: '1.0.0',
        provides: [],
        consumes: [],
        configSchema: { '~standard': { version: 1, validate: () => Promise.resolve({ value: 1 }) } },
      })
      expect.unreachable()
    } catch (error) {
      // The probe already ran, so this is a field-level fact and the blank id
      // beside it must survive.
      const issues = (error as ManifestInvalidError).issues
      expect(issues.join(' | ')).toContain("'configSchema'")
      expect(issues.join(' | ')).toContain("'id'")
    }
  })
})

describe('M7.B rows 8-9: duplicates, and the untouched happy path', () => {
  it('reports a duplicate in provides and a duplicate in consumes together', () => {
    try {
      validateManifest({
        id: 'a',
        version: '1.0.0',
        provides: ['svc.a', 'svc.a'],
        consumes: [
          { service: 'svc.b', mode: 'hard' },
          { service: 'svc.b', mode: 'soft' },
        ],
        configSchema: passthroughSchema,
      })
      expect.unreachable()
    } catch (error) {
      const issues = (error as ManifestInvalidError).issues
      expect(issues).toHaveLength(2)
      expect(issues.join(' | ')).toContain("'provides'")
      expect(issues.join(' | ')).toContain("'consumes'")
    }
  })

  it('leaves a valid manifest untouched, object and all', () => {
    const input = {
      id: 'fine',
      version: '1.0.0',
      provides: ['svc.fine'],
      consumes: [{ service: 'svc.dep', mode: 'hard' as const }],
      configSchema: passthroughSchema,
    }
    const result = validateManifest(input)
    expect(result.id).toBe('fine')
    expect(result.provides).toEqual(['svc.fine'])
    expect(result.consumes).toEqual([{ service: 'svc.dep', mode: 'hard' }])
  })
})
