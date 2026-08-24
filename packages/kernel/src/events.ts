import { InvalidScopeError, PluginInactiveError, ReemitDuringFanoutError } from './errors.ts'

export const BUS_SCOPES = ['global', 'project', 'agent'] as const

export type BusScope = (typeof BUS_SCOPES)[number]

/**
 * Where an event comes from. Delivery rule for partial origins: an event whose
 * origin carries `agentId` but no `projectId` reaches global listeners and the
 * matching agent's listeners only — project listeners never match an event
 * without a projectId. Global listeners always see every event.
 */
export interface EventOrigin {
  readonly projectId?: string
  readonly agentId?: string
}

export interface BusEvent<T = unknown> {
  readonly type: string
  readonly payload: T
  readonly origin: EventOrigin
}

/**
 * Relay discipline: a handler that needs to emit a follow-up event MUST first
 * yield (await a microtask/timer/promise) so fan-out completes; synchronous
 * forwarding is forbidden by design (`PANDA_KERNEL_REEMIT_DURING_FANOUT`).
 * The same rule forbids subscribing during fan-out.
 */
export type EventHandler<T = unknown> = (event: BusEvent<T>) => void | Promise<void>

export interface DispatchFailure {
  readonly event: BusEvent
  readonly listenerId?: string
  readonly error: unknown
}

export interface EmitResult {
  readonly delivered: number
  /** Errors thrown synchronously by individual listeners; siblings are never affected. */
  readonly failures: readonly DispatchFailure[]
}

export type Unsubscribe = () => void

export interface ScopedEventBus {
  subscribe<T = unknown>(scope: 'global', handler: EventHandler<T>): Unsubscribe
  subscribe<T = unknown>(scope: 'project', projectId: string, handler: EventHandler<T>): Unsubscribe
  subscribe<T = unknown>(scope: 'agent', agentId: string, handler: EventHandler<T>): Unsubscribe
  emit<T = unknown>(type: string, payload?: T, origin?: EventOrigin): EmitResult
  /**
   * Awaits every pending handler continuation to a fixed point and returns the
   * rejections they contained. Concurrent calls share one in-flight drain.
   *
   * Continuation failures accumulate from the moment they reject and are cleared
   * by the next drain() — long-lived kernels should drain periodically, not only
   * at shutdown, or failed continuations pile up unbounded.
   */
  drain(): Promise<readonly DispatchFailure[]>
  /** Number of handler continuations not yet settled; zero means quiescent. */
  readonly pendingCount: number
  /**
   * Terminal transition owned by the kernel: once stop() completes, the bus is
   * closed and further emit()/subscribe() raise `PANDA_KERNEL_PLUGIN_INACTIVE`
   * naming `'kernel'`. Idempotent.
   */
  close(): void
}

interface Listener {
  readonly id: string
  readonly scope: BusScope
  readonly scopeId: string | undefined
  readonly handle: EventHandler
}

/**
 * Synchronous scoped event bus (`global | project | agent`): ordered fan-out in
 * subscription order, per-listener error containment, typed guards against
 * synchronous re-emission/subscription during fan-out, and drain support for shutdown.
 */
export function createEventBus(): ScopedEventBus {
  const listeners: Listener[] = []
  const pending = new Set<Promise<void>>()
  let continuationFailures: DispatchFailure[] = []
  let emitting = false
  let nextListenerId = 0
  let inFlightDrain: Promise<readonly DispatchFailure[]> | undefined
  let closed = false

  function observe(continuation: Promise<void>, event: BusEvent, listenerId: string): void {
    const tracked = continuation.then(
      () => {},
      (error) => {
        continuationFailures.push({ event, listenerId, error })
      },
    )
    pending.add(tracked)
    void tracked.finally(() => pending.delete(tracked))
  }

  function delivers(listener: Listener, event: BusEvent<unknown>): boolean {
    if (listener.scope === 'global') return true
    if (listener.scope === 'project') return event.origin.projectId === listener.scopeId
    return event.origin.agentId === listener.scopeId
  }

  async function settle(): Promise<readonly DispatchFailure[]> {
    while (pending.size > 0) {
      await Promise.allSettled([...pending])
    }
    // A settled continuation's final microtasks may still schedule more work;
    // one extra tick lets those land before declaring quiescence.
    await Promise.resolve()
    if (pending.size > 0) return settle()
    const failures = continuationFailures
    continuationFailures = []
    return failures
  }

  function drain(): Promise<readonly DispatchFailure[]> {
    if (inFlightDrain === undefined) {
      inFlightDrain = settle().finally(() => {
        inFlightDrain = undefined
      })
    }
    return inFlightDrain
  }

  function subscribe<T = unknown>(
    scope: BusScope,
    scopeIdOrHandler: string | EventHandler<T>,
    maybeHandler?: EventHandler<T>,
  ): Unsubscribe {
    if (closed) throw new PluginInactiveError('kernel', 'the event bus is closed once the kernel has stopped')
    if (emitting) throw new ReemitDuringFanoutError()
    if (!BUS_SCOPES.includes(scope)) {
      throw new InvalidScopeError(String(scope), `expected one of: ${BUS_SCOPES.join(', ')}`)
    }
    if (scope === 'global' && typeof scopeIdOrHandler !== 'function') {
      throw new InvalidScopeError('global', 'a global listener takes no scope id')
    }
    const scopeId = typeof scopeIdOrHandler === 'string' ? scopeIdOrHandler : undefined
    if (scope !== 'global' && (scopeId === undefined || scopeId === '')) {
      throw new InvalidScopeError(
        String(scopeId ?? scope),
        `${scope}-scoped listeners bind to exactly one ${scope} id (no wildcards)`,
      )
    }
    const handle = (maybeHandler ?? scopeIdOrHandler) as EventHandler
    const listener: Listener = { id: `listener-${nextListenerId++}`, scope, scopeId, handle }
    listeners.push(listener)
    // Unsubscribes during an in-flight fan-out take effect after it: the loop
    // iterates a snapshot, so already-delivering listeners finish this event.
    return () => {
      const at = listeners.indexOf(listener)
      if (at !== -1) listeners.splice(at, 1)
    }
  }

  function emit<T = unknown>(type: string, payload?: T, origin: EventOrigin = {}): EmitResult {
    if (closed) throw new PluginInactiveError('kernel', 'the event bus is closed once the kernel has stopped')
    // Scope identifiers are validated eagerly: a wrong-typed type/origin would
    // otherwise be silently unmatched instead of rejected.
    if (typeof type !== 'string') {
      throw new InvalidScopeError(String(type), 'event type must be a non-empty string')
    }
    if (origin.projectId !== undefined && typeof origin.projectId !== 'string') {
      throw new InvalidScopeError(String(origin.projectId), 'origin projectId must be a string when present')
    }
    if (origin.agentId !== undefined && typeof origin.agentId !== 'string') {
      throw new InvalidScopeError(String(origin.agentId), 'origin agentId must be a string when present')
    }
    if (emitting) throw new ReemitDuringFanoutError()
    const event: BusEvent<unknown> = { type, payload, origin }
    const failures: DispatchFailure[] = []
    let delivered = 0
    emitting = true
    try {
      // Snapshot: adding listeners mid-fan-out is forbidden above; unsubscribes
      // take effect after it.
      for (const listener of [...listeners]) {
        if (!delivers(listener, event)) continue
        delivered += 1
        try {
          const returned = listener.handle(event)
          if (returned instanceof Promise) observe(returned, event, listener.id)
        } catch (error) {
          failures.push({ event, listenerId: listener.id, error })
        }
      }
    } finally {
      emitting = false
    }
    return { delivered, failures }
  }

  return {
    subscribe: subscribe as ScopedEventBus['subscribe'],
    emit,
    drain,
    get pendingCount() {
      return pending.size
    },
    close() {
      closed = true
    },
  }
}
