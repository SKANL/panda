import {
  CycleDetectedError,
  KERNEL_ERROR_CODES,
  ManifestInvalidError,
  PandaKernelError,
  ServiceConflictError,
  ServiceNotProvidedError,
} from './errors.ts'
import { isRecordIdentifier, recordCodeOf, recordSafely, type LogSink } from './log.ts'
import { validateManifest, type PluginManifest } from './manifest.ts'

/**
 * WHY a service is absent, which the kernel branches on and used to discard.
 *
 * A consumer could not tell a misspelled service name from a provider that
 * crashed on startup — two problems with opposite fixes — so typed absence was
 * carrying less than the fact it was invented to carry (AD-5). The loader emits
 * only `no-provider`: it decides PRESENCE, and a provider's readiness is the
 * lifecycle's answer, not its own.
 */
export type AbsenceReason = 'no-provider' | 'provider-unready' | 'provider-failed'

export type ServiceResolution =
  | { readonly kind: 'provided'; readonly providerId: string }
  | { readonly kind: 'absent'; readonly reason: AbsenceReason }

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
 * `log` is a REQUIRED positional parameter, never an option and never defaulted:
 * that is the whole mechanism behind AD-4's "initialised before any plugin
 * loads". A caller physically cannot reach the load path without having already
 * constructed a sink, so the ordering is a type error to violate rather than a
 * comment someone has to keep true. There is deliberately no overload that omits
 * it — adding one would silently un-guarantee the story.
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
export function loadPlugins(manifests: readonly unknown[], log: LogSink): PluginLoadResult {
  // Every throwing path of the load is inside this try, so the `load.rejected`
  // companion below is unconditional — an invalid manifest rejects the load just
  // as a conflict does, and a stream that recorded only one of them would let a
  // reader conclude the other never happened.
  try {
    const parsed = manifests.map((manifest, index) => {
      try {
        const validated = validateManifest(manifest)
        recordSafely(log, { event: 'manifest.validated', subject: validated.id })
        return validated
      } catch (error) {
        // The code comes from what was actually thrown: hardcoding it would let a
        // RangeError from a throwing getter be recorded as a validation failure
        // that never happened.
        recordSafely(log, {
          event: 'manifest.rejected',
          subject: manifestSubject(manifest, `#${index}`),
          code: recordCodeOf(error),
        })
        throw error
      }
    })

    return resolveGraph(parsed, log)
  } catch (error) {
    // The subject is the kernel because a conflict or a cycle belongs to no
    // single plugin; the thrown error names the participants.
    recordSafely(log, { event: 'load.rejected', subject: 'kernel', code: recordCodeOf(error) })
    throw error
  }
}

/**
 * An id is only trustworthy once validation passed. It is also unbounded and
 * unfiltered upstream, and an id the sink would reject would make its own
 * rejection record vanish — so anything unusable is located by position instead.
 */
export function manifestSubject(candidate: unknown, fallback: string): string {
  let id: unknown
  try {
    id = (candidate as { id?: unknown } | null | undefined)?.id
  } catch {
    // Reading the id is itself untrusted work: a throwing getter would otherwise
    // escape and delete the very record that reports the rejection.
    return fallback
  }
  return isRecordIdentifier(id) ? id.trim() : fallback
}

function resolveGraph(parsed: readonly PluginManifest[], log: LogSink): PluginLoadResult {
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
        resolutions.set(consumption.service, { kind: 'absent', reason: 'no-provider' })
        recordSafely(log, { event: 'service.unresolved', subject: manifest.id, service: consumption.service })
        if (consumption.mode === 'hard') missingHardServices.push(consumption.service)
      } else {
        resolutions.set(consumption.service, { kind: 'provided', providerId })
        recordSafely(log, { event: 'service.resolved', subject: manifest.id, service: consumption.service })
      }
    }
    if (missingHardServices.length > 0) {
      recordSafely(log, { event: 'plugin.unready', subject: manifest.id, code: KERNEL_ERROR_CODES.serviceNotProvided })
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
