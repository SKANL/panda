import { InvalidLayerError } from './errors'

/** Resolution order, widest to narrowest: earlier layers are overridden by later ones. */
export const CONFIG_LAYERS = ['defaults', 'global', 'project', 'agent', 'invocation'] as const

export type ConfigLayer = (typeof CONFIG_LAYERS)[number]

export interface ConfigEntry {
  /** Key path of this leaf, as segments (no joining), so `['a.b']` and `['a', 'b']` never collide. */
  readonly path: readonly string[]
  readonly value: unknown
  /** Layer whose snapshot supplied this leaf in the composed view. */
  readonly layer: ConfigLayer
}

type Branch = Record<string, unknown>

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function isBranch(value: unknown): value is Branch {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}

/**
 * Pure deep merge: plain objects merge recursively key by key; every other value
 * (scalars, arrays, null) overrides wholesale.
 */
export function deepMerge<Value>(base: Value, overlay: Value): Value {
  if (isBranch(base) && isBranch(overlay)) {
    const merged: Branch = { ...base }
    for (const [key, value] of Object.entries(overlay)) {
      merged[key] = key in base ? deepMerge(base[key], value) : value
    }
    return merged as Value
  }
  return overlay
}

function kindOf(value: object): string {
  return (value as { constructor?: { name?: string } }).constructor?.name ?? 'object'
}

/**
 * Structural validation for a snapshot before it becomes a layer: only plain
 * objects, arrays, and primitives are allowed; hostile keys and cyclic or
 * exotic-object values are rejected with a coded error naming the offender.
 */
function validateNode(value: unknown, seen: WeakSet<object>): void {
  if (Array.isArray(value)) {
    for (const item of value) validateNode(item, seen)
    return
  }
  if (typeof value !== 'object' || value === null) return
  if (!isBranch(value)) {
    throw new InvalidLayerError(kindOf(value), `${kindOf(value)} values are not allowed in configuration layers (only plain objects, arrays, and primitives)`)
  }
  if (seen.has(value)) {
    throw new InvalidLayerError('(cyclic)', 'cyclic references are not allowed in configuration layers')
  }
  seen.add(value)
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new InvalidLayerError(key, `'${key}' is a forbidden object key (prototype-pollution guard)`)
    }
    validateNode(child, seen)
  }
}

function clone<Value>(value: Value): Value {
  if (Array.isArray(value)) return value.map(clone) as Value
  if (isBranch(value)) {
    const copy: Branch = {}
    for (const [key, item] of Object.entries(value)) copy[key] = clone(item)
    return copy as Value
  }
  return value
}

function deepFreeze<Value>(value: Value): Value {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item)
    Object.freeze(value)
  } else if (isBranch(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key])
    Object.freeze(value)
  }
  return value
}

export interface LayeredConfig {
  /**
   * Replaces one layer's snapshot; the input is validated (plain objects/arrays/
   * primitives only, no cycles, no prototype-polluting keys), then cloned and
   * deep-frozen.
   */
  setLayer(layer: ConfigLayer, values: unknown): void
  snapshot(layer: ConfigLayer): unknown
  /**
   * Composed view over immutable layer snapshots (defaults → global → project →
   * agent → invocation, deep-merged). Pure: layers are never mutated.
   */
  resolve(): unknown
  /** Composed leaves with their originating layer, ordered by key path. */
  dump(): readonly ConfigEntry[]
}

/**
 * Layered configuration: each layer holds an immutable deep-frozen snapshot;
 * resolution composes them widest-to-narrowest and tracks which layer supplied
 * every composed leaf, so a diagnostic dump shows provenance per key.
 */
export function createLayeredConfig(): LayeredConfig {
  const layers = new Map<ConfigLayer, unknown>()

  function requireLayer(layer: ConfigLayer): void {
    if (!CONFIG_LAYERS.includes(layer)) {
      throw new InvalidLayerError(String(layer), `expected one of: ${CONFIG_LAYERS.join(', ')}`)
    }
  }

  function ordered(): { layer: ConfigLayer; value: unknown }[] {
    return CONFIG_LAYERS.filter((layer) => layers.has(layer)).map((layer) => ({
      layer,
      value: layers.get(layer),
    }))
  }

  function visit(
    entries: Map<string, ConfigEntry>,
    path: string[],
    node: unknown,
    candidates: { layer: ConfigLayer; value: unknown }[],
  ): void {
    if (!isBranch(node)) {
      // A composed leaf is decided by the narrowest candidate present at its path:
      // a branch overlay always merges below the node, never turns it back into a leaf.
      const winner = candidates[candidates.length - 1]
      if (winner === undefined) return
      entries.set(JSON.stringify(path), { path: [...path], value: node, layer: winner.layer })
      return
    }
    for (const [key, child] of Object.entries(node)) {
      // Only candidates that carry a branch AT this path contribute below it;
      // narrower leaf values replaced the whole subtree during composition.
      const next: { layer: ConfigLayer; value: unknown }[] = []
      for (const candidate of candidates) {
        if (isBranch(candidate.value) && key in candidate.value) {
          next.push({ layer: candidate.layer, value: candidate.value[key] })
        }
      }
      visit(entries, [...path, key], child, next)
    }
  }

  function resolve(): unknown {
    let composed: unknown
    for (const { value } of ordered()) {
      composed = composed === undefined ? value : deepMerge(composed, value)
    }
    return composed
  }

  return {
    setLayer(layer, values) {
      requireLayer(layer)
      validateNode(values, new WeakSet())
      layers.set(layer, deepFreeze(clone(values)))
    },

    snapshot(layer) {
      requireLayer(layer)
      return layers.get(layer)
    },

    resolve,

    dump() {
      const entries = new Map<string, ConfigEntry>()
      visit(entries, [], resolve(), ordered())
      return [...entries.values()].sort((a, b) => {
        const joinedA = JSON.stringify(a.path)
        const joinedB = JSON.stringify(b.path)
        return joinedA < joinedB ? -1 : joinedA > joinedB ? 1 : 0
      })
    },
  }
}
