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

  it('accepts loose version strings pending future semver enforcement', () => {
    expect(validateManifest(manifest({ version: 'banana' })).version).toBe('banana')
    expect(validateManifest(manifest({ version: '1' })).version).toBe('1')
    expect(validateManifest(manifest({ version: 'not.a.semver-at.all' })).version).toBe('not.a.semver-at.all')
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
