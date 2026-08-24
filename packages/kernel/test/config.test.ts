import { describe, expect, it } from 'vitest'
import {
  CONFIG_LAYERS,
  InvalidLayerError,
  PandaKernelError,
  createLayeredConfig,
  deepMerge,
} from '../src'

describe('config: layer vocabulary', () => {
  it('resolves through defaults → global → project → agent → invocation', () => {
    expect(CONFIG_LAYERS).toEqual(['defaults', 'global', 'project', 'agent', 'invocation'])
  })
})

describe('config: override trace', () => {
  it('composes the narrowest value and shows the originating layer per key', () => {
    const config = createLayeredConfig()
    config.setLayer('defaults', { log: { level: 'info' }, retries: 3 })
    config.setLayer('global', { log: { level: 'warn' }, region: 'mx-central' })
    config.setLayer('agent', { log: { level: 'debug' } })

    expect(config.resolve()).toEqual({
      log: { level: 'debug' },
      retries: 3,
      region: 'mx-central',
    })

    const dump = new Map(config.dump().map((entry) => [entry.path.join('|'), entry]))
    expect(dump.get('log|level')).toMatchObject({ value: 'debug', layer: 'agent' })
    expect(dump.get('retries')).toMatchObject({ value: 3, layer: 'defaults' })
    expect(dump.get('region')).toMatchObject({ value: 'mx-central', layer: 'global' })
  })

  it('lets the invocation overlay win over every other layer', () => {
    const config = createLayeredConfig()
    config.setLayer('defaults', { timeout: 30 })
    config.setLayer('agent', { timeout: 60 })
    config.setLayer('invocation', { timeout: 5 })

    expect(config.resolve()).toEqual({ timeout: 5 })
    expect(config.dump()[0]).toMatchObject({ path: ['timeout'], value: 5, layer: 'invocation' })
  })

  it('deep-merges nested branches across layers instead of replacing them', () => {
    const config = createLayeredConfig()
    config.setLayer('defaults', { a: { b: { c: 1, d: 2 } } })
    config.setLayer('project', { a: { b: { d: 3 }, e: 4 } })

    expect(config.resolve()).toEqual({ a: { b: { c: 1, d: 3 }, e: 4 } })
    const byPath = new Map(config.dump().map((entry) => [entry.path.join('.'), entry.layer]))
    expect(byPath.get('a.b.c')).toBe('defaults')
    expect(byPath.get('a.b.d')).toBe('project')
    expect(byPath.get('a.e')).toBe('project')
  })

  it('treats arrays and scalars as atomic overrides and re-attributes replaced subtrees', () => {
    const config = createLayeredConfig()
    config.setLayer('defaults', { tags: ['a'], nested: { deep: { x: 1, y: 2 } } })
    config.setLayer('agent', { tags: ['b'], nested: { deep: { y: 9 } } })

    expect(config.resolve()).toEqual({ tags: ['b'], nested: { deep: { x: 1, y: 9 } } })
    const byPath = new Map(config.dump().map((entry) => [entry.path.join('.'), entry.layer]))
    expect(byPath.get('tags')).toBe('agent')
    expect(byPath.get('nested.deep.x')).toBe('defaults')
    expect(byPath.get('nested.deep.y')).toBe('agent')
  })

  it('keeps dotted key names distinct from nesting in dump paths', () => {
    const config = createLayeredConfig()
    config.setLayer('global', { 'a.b': 1, a: { b: 2 } })

    const paths = config.dump().map((entry) => entry.path)
    expect(paths).toContainEqual(['a.b'])
    expect(paths).toContainEqual(['a', 'b'])
  })
})

describe('config: cross-scope safety', () => {
  it('never mutates wider layers when a narrower scope sets values', () => {
    const config = createLayeredConfig()
    config.setLayer('defaults', { keep: 'me' })
    config.setLayer('global', { shared: { level: 'info', color: 'blue' } })
    config.setLayer('project', { projectOnly: true })

    const beforeDefaults = JSON.stringify(config.snapshot('defaults'))
    const beforeGlobal = JSON.stringify(config.snapshot('global'))
    const beforeProject = JSON.stringify(config.snapshot('project'))

    config.setLayer('agent', { shared: { color: 'red' }, extra: 1 })

    expect(JSON.stringify(config.snapshot('defaults'))).toBe(beforeDefaults)
    expect(JSON.stringify(config.snapshot('global'))).toBe(beforeGlobal)
    expect(JSON.stringify(config.snapshot('project'))).toBe(beforeProject)
    expect(config.resolve()).toEqual({
      keep: 'me',
      shared: { level: 'info', color: 'red' },
      projectOnly: true,
      extra: 1,
    })
  })

  it('clones and freezes snapshots so later caller mutation cannot leak in', () => {
    const config = createLayeredConfig()
    const input = { a: { b: 1 }, list: [{ c: 2 }] }
    config.setLayer('global', input)
    input.a.b = 999
    input.list[0]!.c = 999

    expect(config.resolve()).toEqual({ a: { b: 1 }, list: [{ c: 2 }] })
    const snapshot = config.snapshot('global') as Record<string, unknown>
    expect(() => {
      ;(snapshot.a as Record<string, unknown>).b = 5
    }).toThrow(TypeError)
  })

  it('is pure across repeated resolutions', () => {
    const config = createLayeredConfig()
    config.setLayer('defaults', { x: { y: 1 } })
    config.setLayer('agent', { x: { z: 2 } })

    const first = config.resolve()
    const second = config.resolve()
    expect(first).toEqual(second)
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
  })
})

describe('config: invalid layers', () => {
  it('rejects unknown layer names with a typed coded error', () => {
    const config = createLayeredConfig()
    expect(() => config.setLayer('tenant' as never, {})).toThrow(InvalidLayerError)
    try {
      config.setLayer('workspace' as never, {})
      expect.unreachable()
    } catch (error) {
      expect((error as PandaKernelError).code).toBe('PANDA_KERNEL_INVALID_LAYER')
      expect((error as Error).message).toContain('workspace')
    }
    expect(() => (config.snapshot as (layer: string) => unknown)('nope')).toThrow(InvalidLayerError)
  })

  it('rejects prototype-polluting keys anywhere in the snapshot, naming the key', () => {
    const config = createLayeredConfig()
    // Built via JSON.parse: a literal `{ __proto__: x }` would set the prototype instead.
    const hostiles: unknown[] = [
      JSON.parse('{"safe": {"__proto__": {"polluted": true}}}'),
      JSON.parse('{"constructor": 1}'),
      { nested: { prototype: [] } },
    ]

    for (const values of hostiles) {
      expect(() => config.setLayer('agent', values)).toThrow(InvalidLayerError)
    }
    try {
      config.setLayer('agent', hostiles[0])
      expect.unreachable()
    } catch (error) {
      expect((error as InvalidLayerError).code).toBe('PANDA_KERNEL_INVALID_LAYER')
      expect((error as InvalidLayerError).message).toContain('__proto__')
    }
    expect(config.resolve()).toBeUndefined()
  })

  it('rejects cyclic snapshots with a coded error', () => {
    const config = createLayeredConfig()
    const cyclic: Record<string, unknown> = { a: { b: 1 } }
    cyclic.self = cyclic

    expect(() => config.setLayer('global', cyclic)).toThrow(InvalidLayerError)
    try {
      config.setLayer('global', cyclic)
      expect.unreachable()
    } catch (error) {
      expect((error as PandaKernelError).code).toBe('PANDA_KERNEL_INVALID_LAYER')
      expect((error as Error).message).toContain('cyclic')
    }
  })

  it('rejects non-plain objects at object positions, naming the value kind', () => {
    const config = createLayeredConfig()

    expect(() => config.setLayer('global', { when: new Date() })).toThrow(/Date/)
    expect(() => config.setLayer('global', { ids: new Set([1]) })).toThrow(/Set/)
    expect(() => config.setLayer('global', { byId: new Map() })).toThrow(/Map/)

    class Opaque {
      tag = 'x'
    }
    try {
      config.setLayer('global', { payload: new Opaque() })
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidLayerError)
      expect((error as Error).message).toContain('Opaque')
    }

    // Arrays of plain values remain allowed.
    expect(() => config.setLayer('global', { tags: ['a', { ok: true }] })).not.toThrow()
  })
})

describe('config: empty composition edge cases', () => {
  it('resolves to undefined and dumps nothing when no layers are set', () => {
    const config = createLayeredConfig()
    expect(config.resolve()).toBeUndefined()
    expect(config.dump()).toEqual([])
  })

  it('replaces a whole layer snapshot on re-set instead of merging with itself', () => {
    const config = createLayeredConfig()
    config.setLayer('global', { a: 1, b: 2 })
    config.setLayer('global', { b: 3 })
    expect(config.resolve()).toEqual({ b: 3 })
  })
})

describe('config: deepMerge primitive', () => {
  it('merges plain objects recursively and overrides anything else wholesale', () => {
    expect(deepMerge({ a: { b: 1, c: 2 }, d: [1] }, { a: { c: 3 }, d: [9], e: null })).toEqual({
      a: { b: 1, c: 3 },
      d: [9],
      e: null,
    })
  })

  it('lets a narrower branch replace an wider scalar at the same path', () => {
    expect(deepMerge(5 as unknown, { x: 1 })).toEqual({ x: 1 })
  })
})
