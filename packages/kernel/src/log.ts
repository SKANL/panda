import { LogRecordInvalidError, isKernelErrorCode, type KernelErrorCode } from './errors.ts'

/**
 * Record-shape version. A reader of a persisted stream branches on this instead
 * of guessing; it is bumped only when the closed shape below changes.
 */
export const LOG_RECORD_VERSION = 1

/**
 * The complete vocabulary of transitions the kernel records. Closed on purpose:
 * a caller cannot invent an event, so a reader that knows only this list can
 * reconstruct any stream the kernel produces without a schema negotiation.
 *
 * Failure events are first-class here. An audit trail that records only what
 * worked is the one you cannot use when something did not.
 */
export const LOG_EVENTS = [
  'manifest.validated',
  'manifest.rejected',
  'load.rejected',
  'service.resolved',
  'service.unresolved',
  'plugin.unready',
  'plugin.activated',
  'plugin.start-failed',
  'plugin.swapped',
  'plugin.swap-rejected',
  'plugin.disposed',
  'plugin.disposal-failed',
  // The interception waterfall (Story 1.7). Six, where the Code Map anticipated
  // two, and every extra one exists because a reader could not otherwise tell two
  // different things apart — the same rule that made 1.6 stop recording
  // `plugin.disposed` for a disposer that had failed:
  //   invoked   — admitted, budget spent, operation about to run
  //   completed / failed — whether that spend actually succeeded
  //   refused   — the guard or a cap said no; nothing was spent
  //   stage-failed — a pre/guard/around interceptor threw; the action did not run
  //   post-failed  — the OBSERVER threw after the action already ran
  'action.invoked',
  'action.completed',
  'action.failed',
  'action.refused',
  'action.stage-failed',
  'action.post-failed',
  'kernel.stopped',
] as const

export type LogEvent = (typeof LOG_EVENTS)[number]

/**
 * What a caller hands the sink.
 *
 * Every field is either an enumeration (`event`, `code`) or an identifier the
 * kernel already holds (`subject`, `service`). There is deliberately NO
 * free-form payload slot: that is where a credential ends up, and a shape with
 * nowhere to put one is a stronger guarantee than a redaction pass someone has
 * to remember to run.
 */
export interface LogEntry {
  readonly event: LogEvent
  /** The plugin the transition happened to, or `'kernel'` for kernel-wide ones. */
  readonly subject: string
  /** The service a `service.*` event is about; rejected on any other event. */
  readonly service?: string
  /** The kernel error code that classifies a failure event. */
  readonly code?: KernelErrorCode
}

/**
 * An entry once the sink has sealed it. Frozen, not merely `readonly`: a type
 * annotation is erased at runtime, so it would let any holder of a record
 * rewrite history the stream is supposed to prove.
 */
export interface LogRecord extends LogEntry {
  readonly version: typeof LOG_RECORD_VERSION
  /**
   * Emission order, from 1. Two records can never share a seq, and a GAP is the
   * loss signal that survives the process: `dropped` lives only in memory, so if
   * the process dies the count dies with it and the missing seq is all a reader
   * of a persisted stream has left to detect the loss by.
   */
  readonly seq: number
  /** Wall clock at emission. Ordering comes from `seq`; this is for humans. */
  readonly at: number
}

export interface LogSinkState {
  /**
   * Current health. A sink that failed a write and later succeeded reads healthy
   * again. Authoritative only when `pending` is 0 — see below.
   */
  readonly status: 'healthy' | 'degraded'
  /**
   * Monotonic count of records the sink could not write. Recovery never resets
   * it. Authoritative only when `pending` is 0: a record handed to an async
   * write is neither written nor counted until that write settles, so read this
   * after `drain()` if you need a total.
   */
  readonly dropped: number
  /** True once any write has failed, so recovery cannot erase that it happened. */
  readonly everDegraded: boolean
  /** Writes handed to the sink but not yet settled. Zero means quiescent. */
  readonly pending: number
}

/**
 * Where records actually go. May be synchronous (the in-memory default) or
 * return a thenable (a file or socket); either way the sink serialises calls so
 * two writes can never interleave.
 */
export type LogWrite = (record: LogRecord) => void | Promise<void>

export interface LogSink {
  /**
   * Appends one record. Throws `PANDA_KERNEL_LOG_RECORD_INVALID` for an entry
   * outside the closed shape (a caller bug); a WRITE failure never throws — it
   * degrades the sink and counts the drop.
   */
  record(entry: LogEntry): void
  /** Resolves once no write is in flight. Never rejects: failures are counted, not thrown. */
  drain(): Promise<void>
  readonly state: LogSinkState
  /**
   * The records this sink retained, if it retains any. A sink that forwards to
   * durable storage returns undefined — retention is not part of being a sink.
   */
  readonly records?: readonly LogRecord[]
}

/**
 * A sink with the write end removed. The kernel hands this out so it stays the
 * only writer of kernel transitions: "the records alone reconstruct the order"
 * is worth nothing if a plugin holding the kernel can append a
 * `plugin.activated` for a plugin that never loaded.
 */
export type LogReader = Omit<LogSink, 'record'>

export interface MemoryLogSink extends LogSink {
  /** Everything successfully written, in emission order. Narrowed: always present. */
  readonly records: readonly LogRecord[]
}

const ENTRY_FIELDS = new Set(['event', 'subject', 'service', 'code'])

/**
 * Upstream `validateManifest` accepts ANY non-empty string as a plugin id, and
 * that id reaches `subject` verbatim while every reader of this stream joins
 * fields into one line. A newline in an id would forge a second record and an
 * unbounded id would let one plugin exhaust the sink. Both are closed here, once,
 * for every identifier field.
 */
const MAX_IDENTIFIER_LENGTH = 200

export function isRecordIdentifier(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > MAX_IDENTIFIER_LENGTH) return false
  // Written as escapes on purpose: a literal control character in this source
  // would be invisible in a diff and is exactly what scripts/check-source-bytes.mjs guards.
  if ([...trimmed].some((char) => char < '\u0020' || char === '\u007f')) {
    return false
  }
  return true
}

function identifier(field: string, value: string): string {
  if (!isRecordIdentifier(value)) {
    throw new LogRecordInvalidError(
      field,
      `must be a non-empty identifier of at most ${MAX_IDENTIFIER_LENGTH} characters and no control characters`,
    )
  }
  return value.trim()
}

/**
 * Validates and seals an entry into a frozen record. Runs on the caller's stack
 * so a malformed entry surfaces as a throw before anything is queued — the
 * opposite of a write failure, which is contained.
 *
 * The unknown-field check below is a diagnostic for the caller, not the
 * protection: what actually keeps a payload out of a record is that this
 * function BUILDS the record from named fields and copies nothing else.
 */
function seal(entry: LogEntry, seq: number): LogRecord {
  for (const field of Object.keys(entry)) {
    if (!ENTRY_FIELDS.has(field)) {
      throw new LogRecordInvalidError(field, 'is not part of the closed record shape')
    }
  }
  if (!LOG_EVENTS.includes(entry.event)) {
    throw new LogRecordInvalidError('event', `must be one of: ${LOG_EVENTS.join(', ')}`)
  }
  const subject = identifier('subject', entry.subject)
  // Without this, `service` becomes a general-purpose second string slot — which
  // is exactly the free-form hiding place the closed shape exists to deny.
  if (entry.service !== undefined && !entry.event.startsWith('service.')) {
    throw new LogRecordInvalidError('service', `is only meaningful on a service.* event (got '${entry.event}')`)
  }
  if (entry.code !== undefined && !isKernelErrorCode(entry.code)) {
    throw new LogRecordInvalidError('code', `must be one of the kernel error codes (got '${String(entry.code)}')`)
  }
  return Object.freeze({
    version: LOG_RECORD_VERSION,
    seq,
    at: Date.now(),
    event: entry.event,
    subject,
    ...(entry.service === undefined ? {} : { service: identifier('service', entry.service) }),
    ...(entry.code === undefined ? {} : { code: entry.code }),
  })
}

/**
 * Append-only record sink with serialised writes and a typed degraded state.
 *
 * Failure policy is fixed (AD-4) and matches AD-5's containment rule: a sink
 * that cannot write degrades, counts what it lost, and lets the kernel keep
 * running. A log that took the process down when a disk filled would be a worse
 * failure than the one it is reporting — but silence is not acceptable either,
 * which is why the drop count is part of the observable state.
 *
 * ponytail: no rotation, no retention, no levels, no formatters, no transports.
 * This is a record sink, not a logging framework; anyone with a real requirement
 * supplies a `write` that forwards wherever they need.
 */
export function createLogSink(write: LogWrite): LogSink {
  let seq = 0
  let dropped = 0
  let pending = 0
  let status: LogSinkState['status'] = 'healthy'
  let everDegraded = false
  // Tail of the write chain, or undefined when nothing is in flight. Queueing
  // behind it is what stops two writes interleaving: an async write settles
  // before the next one starts, so records land in emission order.
  let tail: Promise<void> | undefined

  function succeeded(): void {
    status = 'healthy'
  }

  function failed(): void {
    status = 'degraded'
    everDegraded = true
    dropped += 1
  }

  function settled(): void {
    pending -= 1
  }

  function dispatch(record: LogRecord): void | Promise<void> {
    let outcome: void | Promise<void>
    try {
      outcome = write(record)
    } catch {
      failed()
      return
    }
    // Duck-typed, never `instanceof`: `LogWrite` is structural, so a polyfilled,
    // bundled or cross-realm promise is a legal return value. Treating one as a
    // completed synchronous write would defeat serialisation, drop counting and
    // drain simultaneously — the three guarantees this sink exists for.
    if (typeof (outcome as PromiseLike<void> | undefined)?.then !== 'function') {
      succeeded()
      return
    }
    // Promise.resolve adopts any thenable, so a non-native one is chained,
    // counted and drained exactly like a native one.
    return Promise.resolve(outcome).then(succeeded, failed)
  }

  function track(inFlight: Promise<void>): void {
    pending += 1
    const settling = inFlight.finally(settled)
    tail = settling
    void settling.finally(() => {
      if (tail === settling) tail = undefined
    })
  }

  return {
    record(entry) {
      const sealed = seal(entry, seq + 1)
      // Sealing may throw; the sequence only advances for a record that exists,
      // so a gap always means a lost write and never a rejected entry.
      seq += 1
      if (tail === undefined) {
        const started = dispatch(sealed)
        if (started !== undefined) track(started)
        return
      }
      track(tail.then(() => dispatch(sealed)))
    },

    async drain() {
      // A write settling can schedule the next queued one, so loop to quiescence
      // rather than awaiting the tail once.
      while (tail !== undefined) await tail
    },

    get state() {
      return { status, dropped, everDegraded, pending }
    },
  }
}

/**
 * The kernel's default sink: records stay in memory and are readable back, which
 * is what makes a run reconstructable from the records alone.
 *
 * ponytail: unbounded retention, deliberately — rotation and retention are
 * Ask-First for this story. The upgrade path is `createLogSink` over a durable
 * writer, which this sink is already the one-line case of.
 */
export function createMemoryLogSink(): MemoryLogSink {
  const records: LogRecord[] = []
  const sink = createLogSink((record) => {
    records.push(record)
  })
  return {
    record: sink.record,
    drain: sink.drain,
    get state() {
      return sink.state
    },
    // A copy: handing out the live array makes "append-only" a type annotation
    // that erases at runtime, and a holder could truncate it or push a record
    // the kernel never wrote.
    get records() {
      return [...records]
    },
  }
}

/**
 * Records without letting a broken sink break the kernel that is observing
 * itself — the same rule the ordering log has always followed. A supplied sink
 * whose `record()` throws is a broken sink, not a reason to abort activation
 * with the runtime half-populated or to skip every disposer (AD-5).
 *
 * Kernel-internal call sites use this. A direct `sink.record()` caller still
 * gets the raw throw, because a malformed entry there IS a caller bug.
 */
const lostRecords = new WeakMap<LogSink, number>()

export function recordSafely(log: LogSink, entry: LogEntry): void {
  try {
    log.record(entry)
  } catch {
    // Contained by contract; a diagnostic never aborts the transition it
    // describes. Counted, though: an entry rejected here never reached the sink
    // at all, so NEITHER of this file's two loss signals fires — `seal` throws
    // before `seq += 1` and before dispatch, so there is no gap and no `dropped`.
    // Without this counter, containment is indistinguishable from success.
    lostRecords.set(log, (lostRecords.get(log) ?? 0) + 1)
  }
}

/**
 * Records the kernel could not hand to this sink at all — rejected by the closed
 * shape rather than lost by a failing write. Complements `state.dropped`, which
 * counts the other half.
 */
export function lostRecordCount(log: LogSink): number {
  return lostRecords.get(log) ?? 0
}

/** Classifies a thrown value for a failure record; unknown throwables carry no code. */
export function recordCodeOf(error: unknown): KernelErrorCode | undefined {
  const code = (error as { code?: unknown } | null | undefined)?.code
  return typeof code === 'string' && isKernelErrorCode(code) ? code : undefined
}
