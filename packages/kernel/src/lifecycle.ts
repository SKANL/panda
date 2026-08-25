import { createLayeredConfig, type LayeredConfig } from './config.ts'
import {
  CycleDetectedError,
  KERNEL_ERROR_CODES,
  PluginInactiveError,
  PluginStartFailedError,
  ServiceNotProvidedError,
  SwapRejectedError,
} from './errors.ts'
import { createEventBus, type ScopedEventBus } from './events.ts'
import { createActionPipeline, type ActionPipeline, type ActionPolicy } from './intercept.ts'
import { loadPlugins, manifestSubject, type LoadedPlugin, type PluginFailure, type ServiceResolution } from './loader.ts'
import {
  createMemoryLogSink,
  recordCodeOf,
  recordSafely,
  type LogEntry,
  type LogReader,
  type LogSink,
} from './log.ts'
import { validateManifest, type PluginManifest } from './manifest.ts'

/**
 * Soft-consumption imposes no activation ordering by design: soft services resolve
 * against the live registry at call time, so consumers must tolerate absent-at-activation.
 */
export type ConsumedService<T = unknown> =
  | { readonly kind: 'provided'; readonly pluginId: string; readonly value: T }
  | Extract<ServiceResolution, { kind: 'absent' }>

export interface ActivationContext {
  readonly manifest: PluginManifest
  /**
   * Resolves a consumed service against the live registry at call time.
   * Absence is typed (`{ kind: 'absent' }`), never undefined: providers that
   * failed or never activated read as absent, and use sites decide what to do.
   */
  consume<T = unknown>(service: string): ConsumedService<T>
  /** The kernel's scoped event bus; plugins may subscribe and emit during activation. */
  readonly bus: ScopedEventBus
  /** The kernel's layered configuration; plugins read composed values via `resolve()`/`dump()`. */
  readonly config: LayeredConfig
  /**
   * The kernel's interception waterfall (AD-10). A plugin registers what it does
   * as an action and invokes it through the handle it gets back, which is the
   * only place a budget can legally be enforced — a budget rule in a prompt is a
   * preference.
   */
  readonly actions: ActionPipeline
}

export type PluginFactoryResult =
  | {
      readonly status: 'activated'
      readonly services?: Readonly<Record<string, unknown>>
      readonly dispose?: () => void
    }
  | { readonly status: 'rejected'; readonly issues: readonly string[] }

export type PluginFactory = (context: ActivationContext) => PluginFactoryResult

export interface KernelStartResult {
  readonly started: readonly string[]
  readonly failures: readonly PluginFailure[]
}

export interface DisposalFailure {
  readonly pluginId: string
  readonly error: unknown
}

export interface HandlerFailure {
  readonly listenerId?: string
  readonly error: unknown
}

export interface StopResult {
  readonly disposed: readonly string[]
  readonly disposalErrors: readonly DisposalFailure[]
  /** Continuation failures contained by the bus and surfaced by the pre-unwind drain. */
  readonly handlerFailures: readonly HandlerFailure[]
}

export interface SwapResult {
  readonly disposalError?: DisposalFailure
}

export interface PandaKernel {
  /** Queues a validated manifest paired with its activation factory. */
  register(input: unknown, factory: PluginFactory): void
  start(): KernelStartResult
  stop(): Promise<StopResult>
  getService<T = unknown>(service: string): ConsumedService<T>
  swap(pluginId: string, factory: PluginFactory): SwapResult
  /**
   * Drains pending bus continuations, then runs one plugin's disposer and drops
   * its services from the registry; repeats are no-ops.
   */
  dispose(pluginId: string): Promise<void>
  /** Scoped synchronous event bus (`global | project | agent`) owned by this kernel. */
  readonly bus: ScopedEventBus
  /** Layered configuration (defaults → global → project → agent → invocation) owned by this kernel. */
  readonly config: LayeredConfig
  /**
   * The kernel's append-only record stream, WITHOUT its write end. The kernel is
   * the only writer of kernel transitions: "the records alone reconstruct the
   * order" is worth nothing if a plugin holding the kernel can append a
   * `plugin.activated` for a plugin that never loaded.
   */
  readonly log: LogReader
}

export interface KernelOptions {
  /**
   * Where the kernel's records go. Omitted, the kernel builds its own in-memory
   * sink — it never runs without one. Supply a `createMemoryLogSink()` to read
   * the stream back, or a `createLogSink(write)` to forward it somewhere durable.
   *
   * This replaced a separate `orderLog: string[]` option: two overlapping record
   * mechanisms meant the ordering tests watched one of them while the audit
   * stream went unchecked.
   */
  readonly log?: LogSink
  /**
   * Declarative caps for the kernel's interception waterfall. Omitted, nothing is
   * capped: an unset budget is honest about being unset, where a default one
   * would silently refuse work nobody asked it to refuse.
   */
  readonly actionPolicy?: ActionPolicy
}

type PluginState = 'unready' | 'active' | 'failed' | 'disposed'

interface RuntimePlugin {
  readonly manifest: PluginManifest
  state: PluginState
  services: Readonly<Record<string, unknown>>
  disposer?: () => void
}

interface ActivationAssessment {
  readonly services: Readonly<Record<string, unknown>>
  readonly disposer?: () => void
}

type ActivationRejection = {
  readonly reason: 'rejected' | 'coverage' | 'pairing'
  readonly issues: readonly string[]
  readonly cause?: unknown
}

/**
 * Kernel container over the Story 1.1 loader: dependency-ordered synchronous
 * activation with per-plugin failure containment, exact reverse-order disposal,
 * idempotent stop, typed-absent/inactive service lookup, and validate-then-commit swaps.
 *
 * - `start` loads every registration through `loadPlugins` (which still throws on
 *   invalid manifests, conflicts, and cycles) and activates not-yet-activated plugins
 *   in hard-dependency topological order. One plugin's failed activation is contained:
 *   it lands in the result's `failures` (`PANDA_KERNEL_PLUGIN_START_FAILED`) and every
 *   other plugin still activates. Plugins whose hard-consumed services are absent never
 *   activate (`unready`, reusing the loader's `PANDA_KERNEL_SERVICE_NOT_PROVIDED`
 *   failure). Readiness stays presence-based, as decided in 1.1. Each plugin activates
 *   at most once and its failure is reported once across repeated starts.
 * - `stop` drains pending event-handler continuations BEFORE unwinding (their contained
 *   failures land in the result's `handlerFailures`), then runs
 *   EVERY disposer in exact reverse activation order even if some throw, collecting
 *   per-plugin disposal errors in the result; it is idempotent, and concurrent calls
 *   share one in-flight result. Once it completes the bus is closed: further emit or
 *   subscribe raises `PANDA_KERNEL_PLUGIN_INACTIVE` naming `'kernel'`. Disposers of
 *   failed/unready plugins never run because those plugins never activated.
 * - `swap` activates the candidate fully against the live registry before commit; a
 *   rejection (thrown, returned issues, or service-coverage violation) leaves the
 *   previous implementation serving and raises `PANDA_KERNEL_SWAP_REJECTED` naming each
 *   issue. On success the new implementation serves immediately and only then does the
 *   old disposer run — a throw there is contained in the result's `disposalError`.
 * - The kernel is single-cycle: after `stop`, `start` and `register` raise
 *   `PANDA_KERNEL_PLUGIN_INACTIVE` naming `'kernel'`; restart is unsupported in this story.
 */
export function createKernel(options: KernelOptions = {}): PandaKernel {
  // Constructed here, in the kernel's first statements: `register` and `start`
  // only exist on the object this function returns, so no manifest can be
  // validated and no plugin can load before the sink is in place (AD-4). The
  // load path then takes it as a required argument, which is what makes the
  // ordering a type error rather than a convention.
  const log = options.log ?? createMemoryLogSink()
  const bus = createEventBus()
  const config = createLayeredConfig()
  // Built with the sink above, not with one of its own: every invocation and
  // every violation lands in the same stream as the lifecycle transitions, so one
  // reader reconstructs both.
  const actions = createActionPipeline(log, options.actionPolicy)
  const registrations: { manifest: PluginManifest; factory: PluginFactory }[] = []
  const runtime = new Map<string, RuntimePlugin>()
  const activationOrder: string[] = []
  const serviceIndex = new Map<string, string>()
  let stopped = false
  let stopPromise: Promise<StopResult> | undefined

  // A throwing diagnostic must never abort activation or teardown, so every
  // kernel-internal record goes through the containing helper. A hostile sink is
  // a broken sink, not a reason to leave `runtime` half-populated (AD-5).
  function record(entry: LogEntry): void {
    recordSafely(log, entry)
  }

  // Same rule for the drain: a sink whose drain() rejects must not make stop()
  // reject, which would skip every disposer and leave the kernel stopped without
  // having stopped.
  function drainLog(): Promise<void> {
    return log.drain().catch(() => {})
  }

  // An actual object without `record`, not a `LogReader` annotation over the sink:
  // the type is erased at runtime, which is exactly the documentation-only
  // guarantee this story exists to stop shipping.
  const logReader: LogReader = {
    drain: () => log.drain(),
    get state() {
      return log.state
    },
    get records() {
      return log.records
    },
  }

  function lookup<T>(service: string): ConsumedService<T> {
    const providerId = serviceIndex.get(service)
    if (providerId === undefined) return { kind: 'absent' }
    const plugin = runtime.get(providerId)
    if (plugin === undefined || plugin.state === 'disposed') {
      throw new PluginInactiveError(providerId, `service '${service}' was disposed with its plugin`)
    }
    if (plugin.state !== 'active') return { kind: 'absent' }
    return { kind: 'provided', pluginId: providerId, value: plugin.services[service] as T }
  }

  function dropFromIndex(pluginId: string): void {
    for (const [service, providerId] of [...serviceIndex]) {
      if (providerId === pluginId) serviceIndex.delete(service)
    }
  }

  /**
   * Activates a candidate and enforces the structural invariants: the returned
   * services must cover exactly `manifest.provides` (no missing, extra, or
   * undefined-valued entries), and a plugin providing any service must pair a disposer.
   */
  function runCandidate(
    manifest: PluginManifest,
    factory: PluginFactory,
  ): ActivationAssessment | ActivationRejection {
    let result: PluginFactoryResult
    try {
      result = factory({ manifest, consume: (service) => lookup(service), bus, config, actions })
    } catch (error) {
      return {
        reason: 'rejected',
        issues: [error instanceof Error ? error.message : String(error)],
        cause: error,
      }
    }
    if (result.status === 'rejected') return { reason: 'rejected', issues: result.issues }

    const services = result.services ?? {}
    const issues: string[] = []
    let pairing = false
    if (manifest.provides.length > 0 && result.dispose === undefined) {
      pairing = true
      issues.push(
        `plugin '${manifest.id}' provides services but pairs no disposer (every service registration must pair with a disposer)`,
      )
    }
    for (const service of manifest.provides) {
      if (services[service] === undefined) issues.push(`provided service '${service}' missing from activated services`)
    }
    for (const key of Object.keys(services)) {
      if (!manifest.provides.includes(key)) issues.push(`service '${key}' is not declared in provides`)
    }
    if (issues.length > 0) return { reason: pairing ? 'pairing' : 'coverage', issues }
    return { services, disposer: result.dispose }
  }

  function startFailed(id: string, rejection: ActivationRejection): PluginStartFailedError {
    return new PluginStartFailedError(id, rejection.issues.join('; '), { cause: rejection.cause })
  }

  return {
    register(input, factory) {
      if (stopped) {
        throw new PluginInactiveError('kernel', 'cannot register into a stopped kernel (restart is unsupported)')
      }
      let manifest: PluginManifest
      try {
        manifest = validateManifest(input)
      } catch (error) {
        // This manifest never reaches loadPlugins, so nothing downstream would
        // record it. A successful registration needs no record of its own: the
        // `manifest.validated` the load path emits already proves it happened.
        record({ event: 'manifest.rejected', subject: manifestSubject(input, '#unregistered'), code: recordCodeOf(error) })
        throw error
      }
      registrations.push({ manifest, factory })
    },

    start() {
      if (stopped) {
        throw new PluginInactiveError('kernel', 'cannot start a stopped kernel (restart is unsupported)')
      }

      // start() is legally callable more than once and the load path re-runs every
      // time (the service graph needs every manifest), but a plugin already in
      // `runtime` was loaded by an earlier start. Recording it again would make a
      // reader see the same manifest validated twice.
      const loadLog: LogSink = {
        record: (entry) => {
          if (runtime.has(entry.subject)) return
          record(entry)
        },
        drain: () => log.drain(),
        get state() {
          return log.state
        },
      }
      const loaded = loadPlugins(registrations.map((registration) => registration.manifest), loadLog)
      const factoriesById = new Map(registrations.map((registration) => [registration.manifest.id, registration.factory]))
      // Providers are unique per service (conflicts are rejected at load), so indexing
      // by provides alone covers every resolvable service.
      for (const plugin of loaded.plugins) {
        for (const service of plugin.manifest.provides) serviceIndex.set(service, plugin.manifest.id)
      }

      const failures: PluginFailure[] = []
      const started: string[] = []
      for (const plugin of topologicalOrder(loaded.plugins)) {
        const id = plugin.manifest.id
        // A plugin activates at most once; its failure (if any) is reported once ever.
        if (runtime.has(id)) continue
        const factory = factoriesById.get(id)
        if (factory === undefined) throw new PluginStartFailedError(id, 'loader resolved a plugin with no paired factory')

        if (!plugin.ready) {
          const known = loaded.failures.find((candidate) => candidate.pluginId === id)
          failures.push(known ?? { pluginId: id, error: new ServiceNotProvidedError(id, plugin.missingHardServices) })
          runtime.set(id, { manifest: plugin.manifest, state: 'unready', services: {} })
          // The unready record is the loader's: it decided readiness, and recording
          // it twice would make the stream claim the plugin failed twice.
          continue
        }

        const outcome = runCandidate(plugin.manifest, factory)
        if ('reason' in outcome) {
          failures.push({ pluginId: id, error: startFailed(id, outcome) })
          runtime.set(id, { manifest: plugin.manifest, state: 'failed', services: {} })
          record({ event: 'plugin.start-failed', subject: id, code: KERNEL_ERROR_CODES.pluginStartFailed })
          continue
        }

        runtime.set(id, {
          manifest: plugin.manifest,
          state: 'active',
          services: outcome.services,
          disposer: outcome.disposer,
        })
        activationOrder.push(id)
        record({ event: 'plugin.activated', subject: id })
        started.push(id)
      }
      return { started, failures }
    },

    stop(): Promise<StopResult> {
      // Concurrent calls share one in-flight stop; once it settles, later calls are
      // idempotent no-ops again.
      if (stopPromise) return stopPromise
      if (stopped) return Promise.resolve({ disposed: [], disposalErrors: [], handlerFailures: [] })
      stopped = true

      const performStop = async (): Promise<StopResult> => {
        // Handler continuations may still mutate state a disposer could observe;
        // they settle (and their contained failures surface) before unwinding.
        const handlerFailures = await bus.drain()
        // AD-8's drain-before-disposers rule, applied to the record stream too: a
        // disposer must not run while a pre-teardown record is still in flight, or
        // the stream would show disposal ahead of the transition it followed.
        await drainLog()

        const disposed: string[] = []
        const disposalErrors: DisposalFailure[] = []
        for (const id of [...activationOrder].reverse()) {
          const plugin = runtime.get(id)
          if (plugin === undefined || plugin.state !== 'active') continue
          let disposerThrew = false
          try {
            plugin.disposer?.()
          } catch (error) {
            disposalErrors.push({ pluginId: id, error })
            disposerThrew = true
          }
          plugin.state = 'disposed'
          plugin.services = {}
          // A disposer that threw did not dispose cleanly; recording
          // `plugin.disposed` for it would make the stream assert something the
          // result object contradicts.
          record({ event: disposerThrew ? 'plugin.disposal-failed' : 'plugin.disposed', subject: id })
          disposed.push(id)
        }

        record({ event: 'kernel.stopped', subject: 'kernel' })
        bus.close()
        // stop() resolves quiescent: nothing teardown recorded is still pending.
        await drainLog()
        return { disposed, disposalErrors, handlerFailures }
      }

      const inFlight = performStop()
      stopPromise = inFlight
      // The rejection handler is mandatory: `.finally()` re-raises, and this
      // promise has no other consumer, so an unhandled rejection would terminate
      // the process by default. The caller awaiting stop() still sees it.
      void inFlight
        .finally(() => {
          if (stopPromise === inFlight) stopPromise = undefined
        })
        .catch(() => {})
      return inFlight
    },

    getService(service) {
      return lookup(service)
    },

    swap(pluginId, factory) {
      const plugin = runtime.get(pluginId)
      if (plugin === undefined || plugin.state !== 'active') {
        record({ event: 'plugin.swap-rejected', subject: pluginId, code: KERNEL_ERROR_CODES.pluginInactive })
        throw new PluginInactiveError(pluginId, 'swap requires an active plugin')
      }
      const outcome = runCandidate(plugin.manifest, factory)
      if ('reason' in outcome) {
        const rejection = outcome.reason === 'pairing' ? startFailed(pluginId, outcome) : new SwapRejectedError(pluginId, outcome.issues, { cause: outcome.cause })
        // A rejected swap is the transition most worth auditing: the previous
        // implementation is still serving and nothing else in the stream says why.
        record({ event: 'plugin.swap-rejected', subject: pluginId, code: recordCodeOf(rejection) })
        throw rejection
      }

      const previousDisposer = plugin.disposer
      dropFromIndex(pluginId)
      for (const service of Object.keys(outcome.services)) serviceIndex.set(service, pluginId)
      plugin.services = outcome.services
      plugin.disposer = outcome.disposer
      record({ event: 'plugin.swapped', subject: pluginId })

      try {
        previousDisposer?.()
      } catch (error) {
        // The swap itself committed; only the superseded implementation's
        // teardown failed, and that is the half the result object reports.
        record({ event: 'plugin.disposal-failed', subject: pluginId })
        return { disposalError: { pluginId, error } }
      }
      return {}
    },

    async dispose(pluginId) {
      const plugin = runtime.get(pluginId)
      if (plugin === undefined || plugin.state === 'disposed') return
      // Same invariant as stop: a disposer must never observe a half-drained bus
      // or an in-flight record.
      await bus.drain()
      await drainLog()
      // Contained exactly as stop() contains it. Letting the throw escape here
      // left the plugin 'active', so a later stop() would run its disposer a
      // second time, and lost the record entirely.
      let disposerThrew = false
      try {
        plugin.disposer?.()
      } catch {
        disposerThrew = true
      }
      plugin.state = 'disposed'
      plugin.services = {}
      record({ event: disposerThrew ? 'plugin.disposal-failed' : 'plugin.disposed', subject: pluginId })
      // Mirrors stop(): the record has landed by the time dispose() resolves.
      await drainLog()
    },

    bus,
    config,
    log: logReader,
  }
}

/**
 * Stable topological order over hard-dependency edges: providers activate before their
 * consumers, ties broken by registration order. Soft consumption deliberately imposes no
 * ordering (see ConsumedService). The loader rejects cycles; an incomplete order here
 * would mean loader drift, so it raises CycleDetectedError as a defensive invariant.
 */
function topologicalOrder(plugins: readonly LoadedPlugin[]): readonly LoadedPlugin[] {
  const dependsOn = new Map<string, readonly string[]>(
    plugins.map((plugin) => [
      plugin.manifest.id,
      plugin.manifest.consumes.flatMap((consumption) => {
        if (consumption.mode !== 'hard') return []
        const resolution = plugin.resolutions.get(consumption.service)
        return resolution?.kind === 'provided' ? [resolution.providerId] : []
      }),
    ]),
  )

  const ordered: LoadedPlugin[] = []
  const settled = new Set<string>()
  let progress = true
  while (ordered.length < plugins.length && progress) {
    progress = false
    for (const plugin of plugins) {
      const id = plugin.manifest.id
      if (settled.has(id)) continue
      if (!dependsOn.get(id)!.every((dependency) => settled.has(dependency))) continue
      ordered.push(plugin)
      settled.add(id)
      progress = true
    }
  }
  if (ordered.length < plugins.length) {
    const unresolved = plugins.filter((plugin) => !settled.has(plugin.manifest.id)).map((plugin) => plugin.manifest.id)
    throw new CycleDetectedError(unresolved[0]!, unresolved[unresolved.length - 1]!, unresolved)
  }
  return ordered
}
