import { describe, expect, it } from 'vitest'
import {
  CycleDetectedError,
  ManifestInvalidError,
  ServiceConflictError,
  ServiceNotProvidedError,
  loadPlugins,
  validateManifest,
} from '@panda/kernel'
import { PANDA_ERROR_CODES } from '../src'

const passthroughSchema = {
  '~standard': { version: 1 as const, validate: (value: unknown) => ({ value }) },
}

function manifest(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: 'plugin-a',
    version: '1.0.0',
    provides: [],
    consumes: [],
    configSchema: passthroughSchema,
    ...overrides,
  }
}

describe('kernel error-code parity with canonical contracts constants', () => {
  it('emits PANDA_KERNEL_MANIFEST_INVALID for invalid manifests', () => {
    expect(() => validateManifest({})).toThrow(ManifestInvalidError)
    try {
      validateManifest({})
      expect.unreachable()
    } catch (error) {
      expect((error as { code: string }).code).toBe(PANDA_ERROR_CODES.kernelManifestInvalid)
      expect((error as { code: string }).code).toBe('PANDA_KERNEL_MANIFEST_INVALID')
    }
  })

  it('emits PANDA_KERNEL_CYCLE_DETECTED for dependency cycles', () => {
    expect(() =>
      loadPlugins([
        manifest({ id: 'a', provides: ['svc.a'], consumes: [{ service: 'svc.b', mode: 'hard' }] }),
        manifest({ id: 'b', provides: ['svc.b'], consumes: [{ service: 'svc.a', mode: 'hard' }] }),
      ]),
    ).toThrow(CycleDetectedError)
    try {
      loadPlugins([
        manifest({ id: 'a', provides: ['svc.a'], consumes: [{ service: 'svc.b', mode: 'hard' }] }),
        manifest({ id: 'b', provides: ['svc.b'], consumes: [{ service: 'svc.a', mode: 'hard' }] }),
      ])
      expect.unreachable()
    } catch (error) {
      expect((error as { code: string }).code).toBe(PANDA_ERROR_CODES.kernelCycleDetected)
      expect((error as { code: string }).code).toBe('PANDA_KERNEL_CYCLE_DETECTED')
    }
  })

  it('emits PANDA_KERNEL_SERVICE_NOT_PROVIDED when a hard-consumed service has no provider', () => {
    const result = loadPlugins([manifest({ id: 'b', consumes: [{ service: 'svc.gone', mode: 'hard' }] })])
    expect(result.failures[0]?.error).toBeInstanceOf(ServiceNotProvidedError)
    expect(result.failures[0]?.error.code).toBe(PANDA_ERROR_CODES.kernelServiceNotProvided)
    expect(result.failures[0]?.error.code).toBe('PANDA_KERNEL_SERVICE_NOT_PROVIDED')
  })

  it('emits PANDA_KERNEL_SERVICE_CONFLICT when two plugins provide the same service', () => {
    expect(() =>
      loadPlugins([
        manifest({ id: 'first', provides: ['svc.dup'] }),
        manifest({ id: 'second', provides: ['svc.dup'] }),
      ]),
    ).toThrow(ServiceConflictError)
    try {
      loadPlugins([
        manifest({ id: 'first', provides: ['svc.dup'] }),
        manifest({ id: 'second', provides: ['svc.dup'] }),
      ])
      expect.unreachable()
    } catch (error) {
      expect((error as { code: string }).code).toBe(PANDA_ERROR_CODES.kernelServiceConflict)
      expect((error as { code: string }).code).toBe('PANDA_KERNEL_SERVICE_CONFLICT')
    }
  })
})
