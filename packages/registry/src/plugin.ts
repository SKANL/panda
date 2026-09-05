import type { PluginFactory, PluginManifest } from '@skanl/panda-kernel'
import { defineStandardSchema } from '@skanl/panda-contracts'
import { isNonEmptyString, isRecord, issue } from '@skanl/panda-contracts/validation'
import type { StandardSchemaIssue, StandardSchemaResult } from '@skanl/panda-contracts'
import { RegistryStore } from './store.ts'
import type { RegistryStoreOptions } from './store.ts'

// The first REAL kernel plugin on the Story 1.2 lifecycle: a declarative
// manifest providing the 'registry' service, activation that wires the scoped
// store, and a disposer serialized with in-flight mutations.
//
// Configuration lives ONLY in the plugin's own 'registry' subtree of the
// kernel's layered configuration; other plugins' subtrees are ignored. Explicit
// factory options are merged over the configured values, and the MERGE — not
// either side alone — goes through schema validation. Misconfiguration rejects
// activation (a contained start failure), never a mid-call INVALID_ENTRY.

const KNOWN_CONFIG_KEYS: ReadonlySet<string> = new Set([
  'homeDir',
  'projectDir',
  'lockTimeoutMs',
  'lockPollMs',
])

function isFinitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

const REGISTRY_CONFIG_SCHEMA = defineStandardSchema((value): StandardSchemaResult<unknown> => {
  if (value === undefined) return { value: {} }
  if (!isRecord(value)) return { issues: [issue('registry plugin config must be an object')] }
  const issues: StandardSchemaIssue[] = []
  for (const key of Object.keys(value)) {
    if (!KNOWN_CONFIG_KEYS.has(key)) {
      issues.push(
        issue(`'${key}' is not a registry plugin config key (expected homeDir, projectDir, lockTimeoutMs or lockPollMs)`),
      )
    }
  }
  const homeDir = value['homeDir']
  const projectDir = value['projectDir']
  const lockTimeoutMs = value['lockTimeoutMs']
  const lockPollMs = value['lockPollMs']
  if (homeDir !== undefined && !isNonEmptyString(homeDir)) {
    issues.push(issue("'homeDir' must be a non-empty string when present"))
  }
  if (projectDir !== undefined && !isNonEmptyString(projectDir)) {
    issues.push(issue("'projectDir' must be a non-empty string when present"))
  }
  if (lockTimeoutMs !== undefined && !isFinitePositive(lockTimeoutMs)) {
    issues.push(issue("'lockTimeoutMs' must be a finite positive number when present"))
  }
  if (lockPollMs !== undefined && !isFinitePositive(lockPollMs)) {
    issues.push(issue("'lockPollMs' must be a finite positive number when present"))
  }
  return issues.length > 0 ? { issues } : { value }
})

export interface RegistryPluginOptions {
  readonly homeDir?: string
  readonly projectDir?: string
  readonly lockTimeoutMs?: number
  readonly lockPollMs?: number
  /** Extra observer alongside the default kernel-bus stale-break event. */
  readonly onStaleLockBreak?: RegistryStoreOptions['onStaleLockBreak']
}

export interface RegistryPlugin {
  readonly manifest: PluginManifest
  readonly factory: PluginFactory
}

export function createRegistryPlugin(options: RegistryPluginOptions = {}): RegistryPlugin {
  const manifest: PluginManifest = {
    id: 'registry',
    version: '0.0.0',
    provides: ['registry'],
    consumes: [],
    configSchema: REGISTRY_CONFIG_SCHEMA,
  }

  const factory: PluginFactory = (context) => {
    // The kernel has already resolved `config.resolve()['registry']` and checked
    // it against this plugin's own schema (M7.C), so the subtree arrives
    // validated. The merge below is still this plugin's own work and is still
    // validated here, because only the MERGED value can be checked once it
    // exists — the kernel checks the document, this checks the result.
    const namespace = isRecord(context.settings) ? context.settings : {}
    // Explicit factory options override layered config. The namespace subtree
    // is validated VERBATIM (unknown keys inside it are rejected); only the
    // explicit-options side is filtered to known keys, since it also carries
    // non-config fields like callbacks.
    const optionOverrides: Record<string, unknown> = {}
    const optionSource = options as Record<string, unknown>
    for (const key of KNOWN_CONFIG_KEYS) {
      const value = optionSource[key]
      if (value !== undefined) optionOverrides[key] = value
    }
    const candidate = { ...namespace, ...optionOverrides }
    const validated = REGISTRY_CONFIG_SCHEMA['~standard'].validate(candidate)
    if (validated instanceof Promise) {
      return { status: 'rejected', issues: ['registry plugin config must validate synchronously'] }
    }
    if (validated.issues !== undefined) {
      return { status: 'rejected', issues: validated.issues.map((entry) => entry.message) }
    }
    const config = validated.value as Record<string, unknown>

    const store = new RegistryStore({
      homeDir: config['homeDir'] as string | undefined,
      projectDir: config['projectDir'] as string | undefined,
      lockTimeoutMs: config['lockTimeoutMs'] as number | undefined,
      lockPollMs: config['lockPollMs'] as number | undefined,
      onStaleLockBreak: (broken) => {
        context.bus.emit('registry.lock.stale-broken', broken)
        options.onStaleLockBreak?.(broken)
      },
    })
    return {
      status: 'activated',
      services: { registry: store },
      // RETURNED, not voided. `RegistryStore.dispose()` waits for every in-flight
      // mutation, and `void`-ing it meant `kernel.stop()` could resolve while a
      // registry write was still landing — and a rejection there was an UNHANDLED
      // one, which terminates the process. The kernel awaits this and contains a
      // failure as a `DisposalFailure` (M7.A).
      dispose: () => store.dispose(),
    }
  }

  return { manifest, factory }
}
