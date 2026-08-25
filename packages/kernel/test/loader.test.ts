import { describe, expect, it } from 'vitest'
import {
  CycleDetectedError,
  ManifestInvalidError,
  PandaKernelError,
  ServiceConflictError,
  ServiceNotProvidedError,
  createMemoryLogSink,
  loadPlugins,
} from '../src'
import { manifest } from './helpers'

// The load path takes a sink as a required argument (AD-4), so every call site
// here — test or production — has to construct one first. See log.test.ts for
// the mechanical proof that omitting it does not compile. One per call, never a
// shared module-level sink: that would accumulate across every case in the file
// and share one sequence counter between unrelated assertions.
const sink = createMemoryLogSink

describe('loadPlugins', () => {
  it('readies a hard consumer when its service is provided (I/O matrix: happy path)', () => {
    const result = loadPlugins([
      manifest({ id: 'provider', provides: ['svc.db'] }),
      manifest({ id: 'consumer', consumes: [{ service: 'svc.db', mode: 'hard' }] }),
    ], sink())

    expect(result.ready).toEqual(['provider', 'consumer'])
    expect(result.failures).toEqual([])
    const consumer = result.plugins.find((plugin) => plugin.manifest.id === 'consumer')
    expect(consumer?.ready).toBe(true)
    expect(consumer?.resolutions.get('svc.db')).toEqual({ kind: 'provided', providerId: 'provider' })
  })

  it('fails synchronously with a coded error and loads nothing when a manifest is invalid', () => {
    expect(() => loadPlugins([manifest(), manifest({ id: '' })], sink())).toThrow(ManifestInvalidError)
    try {
      loadPlugins([manifest({ version: 3 }), manifest()], sink())
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(PandaKernelError)
      expect((error as PandaKernelError).code).toBe('PANDA_KERNEL_MANIFEST_INVALID')
    }
  })

  it('rejects hard-consumption cycles naming both sides', () => {
    try {
      loadPlugins([
        manifest({
          id: 'alpha',
          provides: ['svc.a'],
          consumes: [{ service: 'svc.b', mode: 'hard' }],
        }),
        manifest({
          id: 'beta',
          provides: ['svc.b'],
          consumes: [{ service: 'svc.a', mode: 'hard' }],
        }),
      ], sink())
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(CycleDetectedError)
      const cycleError = error as CycleDetectedError
      expect(cycleError.code).toBe('PANDA_KERNEL_CYCLE_DETECTED')
      expect(cycleError.message).toContain('alpha')
      expect(cycleError.message).toContain('beta')
      expect(cycleError.sideA).toBe('alpha')
      expect(cycleError.sideB).toBe('beta')
      expect(cycleError.cycle).toEqual(['alpha', 'beta'])
    }
  })

  it('rejects a self-referencing hard consumption', () => {
    expect(() =>
      loadPlugins([manifest({ id: 'solo', provides: ['svc.self'], consumes: [{ service: 'svc.self', mode: 'hard' }] })], sink()),
    ).toThrow(CycleDetectedError)
  })

  it('does not report a cycle through soft consumption', () => {
    const result = loadPlugins([
      manifest({
        id: 'alpha',
        provides: ['svc.a'],
        consumes: [{ service: 'svc.b', mode: 'soft' }],
      }),
      manifest({
        id: 'beta',
        provides: ['svc.b'],
        consumes: [{ service: 'svc.a', mode: 'hard' }],
      }),
    ], sink())
    expect([...result.ready].sort()).toEqual(['alpha', 'beta'])
  })

  it('blocks readiness for a hard-consumed absent service and raises a typed error naming it', () => {
    const result = loadPlugins([
      manifest({ id: 'standalone', provides: ['svc.other'] }),
      manifest({ id: 'blocked', consumes: [{ service: 'svc.missing', mode: 'hard' }] }),
    ], sink())

    const blocked = result.plugins.find((plugin) => plugin.manifest.id === 'blocked')
    expect(blocked?.ready).toBe(false)
    expect(result.ready).toEqual(['standalone'])

    expect(result.failures).toHaveLength(1)
    const failure = result.failures[0]
    expect(failure?.pluginId).toBe('blocked')
    expect(failure?.error).toBeInstanceOf(ServiceNotProvidedError)
    expect(failure?.error.code).toBe('PANDA_KERNEL_SERVICE_NOT_PROVIDED')
    expect(failure?.error.message).toContain('svc.missing')

    const blockedPlugin = result.plugins.find((plugin) => plugin.manifest.id === 'blocked')
    expect(blockedPlugin?.missingHardServices).toEqual(['svc.missing'])
  })

  it('accepts a soft-consumed absent service and resolves a typed-absent value', () => {
    const result = loadPlugins([
      manifest({ id: 'optional', consumes: [{ service: 'svc.absent', mode: 'soft' }] }),
    ], sink())

    expect(result.ready).toEqual(['optional'])
    expect(result.failures).toEqual([])
    const resolution = result.plugins[0]?.resolutions.get('svc.absent')
    expect(resolution).toEqual({ kind: 'absent' })
    expect(resolution?.kind).toBe('absent')
  })

  it('names every missing hard service for a plugin', () => {
    const result = loadPlugins([
      manifest({ id: 'hungry', consumes: [{ service: 'svc.one', mode: 'hard' }, { service: 'svc.two', mode: 'hard' }] }),
    ], sink())
    const error = result.failures[0]?.error
    expect(error).toBeInstanceOf(ServiceNotProvidedError)
    expect((error as ServiceNotProvidedError).services).toEqual(['svc.one', 'svc.two'])
    expect(error?.message).toContain('svc.one')
    expect(error?.message).toContain('svc.two')
  })

  it('rejects duplicate providers of the same service', () => {
    try {
      loadPlugins([manifest({ id: 'first', provides: ['svc.dup'] }), manifest({ id: 'second', provides: ['svc.dup'] })], sink())
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceConflictError)
      expect((error as ServiceConflictError).code).toBe('PANDA_KERNEL_SERVICE_CONFLICT')
      expect((error as Error).message).toContain('first')
      expect((error as Error).message).toContain('second')
      expect((error as Error).message).toContain('svc.dup')
    }
  })

  it('readies a hard consumer based on provider presence only, even when the provider itself is not ready', () => {
    const result = loadPlugins([
      manifest({ id: 'flaky', provides: ['svc.db'], consumes: [{ service: 'svc.missing', mode: 'hard' }] }),
      manifest({ id: 'consumer', consumes: [{ service: 'svc.db', mode: 'hard' }] }),
    ], sink())

    const flaky = result.plugins.find((plugin) => plugin.manifest.id === 'flaky')
    const consumer = result.plugins.find((plugin) => plugin.manifest.id === 'consumer')
    expect(flaky?.ready).toBe(false)
    expect(consumer?.ready).toBe(true)
  })

  it('rejects two manifests sharing the same plugin id', () => {
    try {
      loadPlugins([manifest({ id: 'twin' }), manifest({ id: 'twin' })], sink())
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(ManifestInvalidError)
      expect((error as PandaKernelError).code).toBe('PANDA_KERNEL_MANIFEST_INVALID')
      expect((error as Error).message).toContain('twin')
    }
  })
})
