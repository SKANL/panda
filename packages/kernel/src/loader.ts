import { CycleDetectedError, ManifestInvalidError, PandaKernelError, ServiceConflictError, ServiceNotProvidedError } from './errors'
import { validateManifest, type PluginManifest } from './manifest'

export type ServiceResolution =
  | { readonly kind: 'provided'; readonly providerId: string }
  | { readonly kind: 'absent' }

export interface LoadedPlugin {
  readonly manifest: PluginManifest
  readonly ready: boolean
  readonly missingHardServices: readonly string[]
  readonly resolutions: ReadonlyMap<string, ServiceResolution>
}

export interface PluginFailure {
  readonly pluginId: string
  readonly error: PandaKernelError
}

export interface PluginLoadResult {
  readonly plugins: readonly LoadedPlugin[]
  readonly ready: readonly string[]
  readonly failures: readonly PluginFailure[]
}

/**
 * Validates every manifest eagerly and synchronously, resolves the service graph, and gates readiness.
 *
 * Throws synchronously (nothing loads):
 * - an invalid manifest (`PANDA_KERNEL_MANIFEST_INVALID`)
 * - duplicate plugin ids (`PANDA_KERNEL_MANIFEST_INVALID`)
 * - two plugins providing the same service (`PANDA_KERNEL_SERVICE_CONFLICT`)
 * - a hard-consumption dependency cycle (`PANDA_KERNEL_CYCLE_DETECTED`, naming both sides)
 *
 * Collected in the returned `failures` instead of thrown: plugins with missing
 * hard-consumed services come back not-ready (`PANDA_KERNEL_SERVICE_NOT_PROVIDED`,
 * naming each missing service). Soft-consumed absent services resolve to a typed
 * absent value (`{ kind: 'absent' }`), never undefined.
 *
 * Readiness at this stage reflects provider PRESENCE only; propagating provider
 * readiness through the graph arrives with Story 1.2 lifecycle ordering.
 */
export function loadPlugins(manifests: readonly unknown[]): PluginLoadResult {
  const parsed = manifests.map((manifest) => validateManifest(manifest))

  const seenIds = new Set<string>()
  for (const manifest of parsed) {
    if (seenIds.has(manifest.id)) {
      throw new ManifestInvalidError(`invalid plugin manifest: 'id' must be unique across loaded plugins (duplicate '${manifest.id}')`)
    }
    seenIds.add(manifest.id)
  }

  const providers = new Map<string, string>()
  for (const manifest of parsed) {
    for (const service of manifest.provides) {
      const existingProviderId = providers.get(service)
      if (existingProviderId !== undefined) {
        throw new ServiceConflictError(service, existingProviderId, manifest.id)
      }
      providers.set(service, manifest.id)
    }
  }

  const hardDependencies = new Map<string, string[]>()
  for (const manifest of parsed) {
    hardDependencies.set(
      manifest.id,
      manifest.consumes.flatMap((consumption) => {
        if (consumption.mode !== 'hard') return []
        const providerId = providers.get(consumption.service)
        return providerId === undefined ? [] : [providerId]
      }),
    )
  }

  assertAcyclic(hardDependencies)

  const plugins = parsed.map((manifest): LoadedPlugin => {
    const resolutions = new Map<string, ServiceResolution>()
    const missingHardServices: string[] = []
    for (const consumption of manifest.consumes) {
      const providerId = providers.get(consumption.service)
      if (providerId === undefined) {
        resolutions.set(consumption.service, { kind: 'absent' })
        if (consumption.mode === 'hard') missingHardServices.push(consumption.service)
      } else {
        resolutions.set(consumption.service, { kind: 'provided', providerId })
      }
    }
    return {
      manifest,
      ready: missingHardServices.length === 0,
      missingHardServices,
      resolutions,
    }
  })

  return {
    plugins,
    ready: plugins.filter((plugin) => plugin.ready).map((plugin) => plugin.manifest.id),
    failures: plugins
      .filter((plugin) => !plugin.ready)
      .map((plugin) => ({ pluginId: plugin.manifest.id, error: new ServiceNotProvidedError(plugin.manifest.id, plugin.missingHardServices) })),
  }
}

function assertAcyclic(hardDependencies: ReadonlyMap<string, string[]>): void {
  const state = new Map<string, 1 | 2>()
  const stack: string[] = []

  const visit = (id: string): void => {
    state.set(id, 1)
    stack.push(id)
    for (const dependency of hardDependencies.get(id) ?? []) {
      if (state.get(dependency) === 1) {
        throw new CycleDetectedError(dependency, id, stack.slice(stack.indexOf(dependency)))
      }
      if (state.get(dependency) !== 2) visit(dependency)
    }
    stack.pop()
    state.set(id, 2)
  }

  for (const id of hardDependencies.keys()) visit(id)
}
