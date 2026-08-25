import { describe, expect, it } from 'vitest'
import {
  PANDA_ERROR_CODES,
  PandaError,
  PROJECTION_GRAMMAR_VERSION,
  PROJECTION_RESERVED_ROOT_KEY,
  classifyOwnedMarker,
} from '../src'

describe('projection sentinel grammar constants', () => {
  it('starts at grammar version 1 under the reserved "panda" root key', () => {
    expect(PROJECTION_GRAMMAR_VERSION).toBe(1)
    expect(PROJECTION_RESERVED_ROOT_KEY).toBe('panda')
  })
})

describe('projection error codes', () => {
  it('exposes PANDA_PROJECTION_NATIVE_MALFORMED canonically', () => {
    const error = new PandaError(PANDA_ERROR_CODES.projectionNativeMalformed, 'broken')
    // Dual assertion: canonical constant AND verbatim literal, so either side
    // drifting independently fails here before consumers see a renamed code.
    expect(error.code).toBe(PANDA_ERROR_CODES.projectionNativeMalformed)
    expect(error.code).toBe('PANDA_PROJECTION_NATIVE_MALFORMED')
  })

  it('exposes PANDA_PROJECTION_TARGET_FAILED canonically', () => {
    const error = new PandaError(PANDA_ERROR_CODES.projectionTargetFailed, 'failed')
    expect(error.code).toBe(PANDA_ERROR_CODES.projectionTargetFailed)
    expect(error.code).toBe('PANDA_PROJECTION_TARGET_FAILED')
  })
})

describe('classifyOwnedMarker', () => {
  it('reports no drift for an absent marker', () => {
    expect(classifyOwnedMarker(undefined)).toEqual([])
  })

  it('classifies a foreign-typed marker as unknown-shape', () => {
    const drift = classifyOwnedMarker('not an object')
    expect(drift).toEqual([
      { kind: 'unknown-shape', location: '$.panda', detail: 'reserved marker is not an object' },
    ])
  })

  it('classifies any other declared version as a legacy marker', () => {
    for (const version of [0, -1, 2, '1', null]) {
      const drift = classifyOwnedMarker({ version, tools: {} })
      expect(drift).toHaveLength(1)
      expect(drift[0]).toMatchObject({
        kind: 'legacy-marker',
        location: '$.panda.version',
        detail: expect.stringContaining('version'),
      })
    }
  })

  it('states the version key is MISSING when the marker declares none', () => {
    const drift = classifyOwnedMarker({ tools: {} })
    expect(drift[0]!.kind).toBe('legacy-marker')
    expect(drift[0]!.detail).toContain('missing')
    expect(drift[0]!.detail).not.toContain('undefined')
  })

  it('accepts an exact grammar v1 layout and rejects deviations as unknown-shape', () => {
    expect(classifyOwnedMarker({ version: 1, tools: {}, mcpServers: {}, skills: {} })).toEqual([])
    expect(
      classifyOwnedMarker({
        version: 1,
        tools: { demo: { command: 'rg' } },
        mcpServers: { srv: { command: 'npx', args: ['-y'] } },
        skills: { s: { entryPath: '~/x.ts' } },
      }),
    ).toEqual([])
    expect(
      classifyOwnedMarker({ version: 1 }).every((entry) => entry.kind === 'unknown-shape'),
    ).toBe(true)
    for (const marker of [
      { version: 1, tools: [] },
      { version: 1, tools: { x: 'no' } },
      { version: 1, tools: { x: { command: 123 } } },
      { version: 1, tools: { x: { model: 'opus' } } },
      { version: 1, skills: {}, extra: true },
      { version: 1, skills: { s: { entryPath: 7 } } },
      { version: 1, mcpServers: { s: { args: [1, 2] } } },
      { version: 1, tools: { '': {} } },
    ]) {
      const drift = classifyOwnedMarker(marker as unknown)
      expect(drift.length).toBeGreaterThan(0)
      expect(drift.every((entry) => entry.kind === 'unknown-shape')).toBe(true)
    }
  })
})
