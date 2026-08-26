import { join } from 'node:path'
import { createExecutorPlugin, EXECUTOR_CONFIG_KEY, EXECUTOR_SERVICE } from '@panda/adapter-cli'
import type { CliExecutorAdapterOptions, ExecutorService } from '@panda/adapter-cli'
import { PandaError, PANDA_ERROR_CODES } from '@panda/contracts'
import type { ExecutorAdapter, ResultEnvelope, WorkspaceHandle, WorkspaceProvider } from '@panda/contracts'
import {
  createKernel,
  createMemoryLogSink,
  type ActionPolicy,
  type BusEvent,
  type LogEntry,
  type LogSink,
  type PandaKernel,
} from '@panda/kernel'
import {
  createWorkspacePlugin,
  WORKSPACE_CONFIG_KEY,
  WORKSPACE_CONFIG_WARNING_EVENT,
  WORKSPACE_SERVICE,
  type WorkspaceConfigWarning,
} from '@panda/workspace-local'
import {
  seedExecutorConfig,
  selectExecutor,
  type ExecutorConfigLayers,
  type ExecutorSelection,
} from './executors.ts'

/**
 * The PREFIX every session invocation is recorded under. The registered id is
 * `${SESSION_ACTION_ID}#${workspace.id}`, not this constant: a pipeline rejects a
 * duplicate registration, and since Story M3.B the pipeline belongs to the
 * KERNEL rather than to the session, so two sessions sharing one kernel really
 * do register into the same set of ids. Scoping to the workspace is what keeps
 * them distinguishable — and workspace ids are UUIDs on the default provider.
 *
 * Exported because a reader of the record stream needs the same string the
 * pipeline wrote; match with `subject.startsWith(SESSION_ACTION_ID + '#')`.
 */
export const SESSION_ACTION_ID = 'session.executor-run'

/**
 * What one executor run costs the budget.
 *
 * ponytail: a flat 1, because nothing in the stack counts tokens — the envelope
 * carries no usage figure and the cost must be declared BEFORE the run, so no
 * honest number exists to charge. Story M3.B removed half of what made the three
 * caps collapse: a kernel-owned pipeline now sees EVERY session's invocation, so
 * `maxInvocations` and `maxTotalCost` finally differ across a host that runs
 * more than one. Within a single session they are still one boolean. Upgrade
 * path: an adapter-reported usage figure settled after the run, which needs a
 * pipeline that can adjust a cost post-hoc (deferred-work.md).
 */
export const SESSION_ACTION_COST = 1

export interface SessionOptions {
  /** Handed to the executor verbatim; rejected before anything is created if it is blank. */
  readonly prompt: string
  /** Root the mounted workspace plugin builds `.panda/workspaces` under. Defaults to `process.cwd()`. */
  readonly cwd?: string
  /**
   * Which shipped adapter runs the prompt, by catalogue id (`executors.ts`).
   * Omitted, the selection comes from `configLayers` and then from panda's
   * built-in default LAYER — the default is a lookup like every other id, so no
   * path here constructs a vendor adapter by name.
   *
   * Set as the `invocation` layer of the kernel's configuration, so it wins over
   * every document and is reported as having done so.
   */
  readonly executorId?: string
  /**
   * Panda's own configuration documents, ALREADY READ (`readExecutorConfigLayers`).
   *
   * This is what seeds the kernel's layered configuration, so the mounted
   * plugins and the executor selection read one composed document. It is DATA,
   * never a path: a session primitive that read files under the running user's
   * home would be unusable from a host that already knows what it wants, and it
   * would make every `panda run` test depend on whoever ran the suite. Omitted,
   * only panda's `defaults` layer and `executorId` apply.
   */
  readonly configLayers?: ExecutorConfigLayers
  /**
   * Options handed to the SELECTED adapter: a child-process spawner, or a binary
   * path that overrides the trait's command. Ignored when `createAdapter` is
   * supplied, because then the caller built the adapter itself.
   *
   * This is the seam that makes `executorId` provable end to end — a fake
   * spawner here exercises selection, catalogue lookup and vendor argv on the
   * PRODUCTION path, where injecting `createAdapter` bypasses the very wiring
   * under test. It is also what gives an embedding host a way to point panda at
   * a binary that is not on PATH.
   */
  readonly adapterOptions?: CliExecutorAdapterOptions
  /**
   * Adapter seam; tests and embedding hosts inject their own. When supplied it
   * WINS over `executorId` and `adapterOptions`: the caller handed panda the
   * executor, so panda did not select one. The invocation still travels the
   * kernel's waterfall — the seam decides WHICH executor runs, never WHETHER the
   * pipeline sees it.
   */
  readonly createAdapter?: () => ExecutorAdapter
  /**
   * Workspace provider seam. Omitted, the provider comes from the kernel's
   * mounted `workspace` plugin, which is what `panda run` uses.
   *
   * OWNERSHIP: the session disposes whatever this returns, on every path. Hand
   * back a FRESH provider per session — returning a pooled or long-lived one
   * leaves it disposed, and the next session against it fails with
   * `PANDA_CONTRACT_PROVIDER_DISPOSED` (pinned by a test, because the obvious
   * reason to inject a provider is to pool workspaces). A provider obtained from
   * the kernel is NOT disposed here: it belongs to the plugin, and the kernel
   * disposes it at `stop()`.
   */
  readonly createProvider?: () => WorkspaceProvider
  /**
   * Signal-registration seam: register a handler for interrupt/termination and
   * return its disposer. Deliberately has NO default — a library that installs
   * `process.on('SIGINT')` steals the signal from whatever host embedded it, so
   * the process owner supplies this. `@panda/cli` passes its SIGINT/SIGTERM
   * wiring here; an SDK caller with its own cancellation passes its own.
   */
  readonly onInterrupt?: (handler: () => void) => () => void
  /**
   * Told which executor was selected and which layer decided it, BEFORE anything
   * is constructed. `panda run` prints that line on stderr; a host that offers a
   * choice renders it however it likes.
   *
   * A throw here is contained: a reporter is an observer, and an observer must
   * not be able to fail a run it was only watching.
   */
  readonly onSelection?: (selection: ExecutorSelection) => void
  /**
   * Told about a configuration key panda READ and could not use — an unknown key
   * inside a mounted plugin's subtree, or a subtree of the wrong shape.
   *
   * These are reported and survived rather than fatal, and this is the seam that
   * keeps "reported" from meaning "emitted where nobody looks". `panda run`
   * prints them on stderr. Measured before it existed: a single forward-looking
   * key in `~/.panda/config.json` failed every run on the machine with
   * `PANDA_KERNEL_PLUGIN_START_FAILED`. Contained, like `onSelection`.
   */
  readonly onWarning?: (message: string) => void
  /**
   * Where the interception waterfall's records go. Omitted, the session builds
   * an in-memory sink it then drops — the waterfall still runs, its trail is
   * simply unread.
   *
   * The WATERFALL's, not the kernel's whole stream: the kernel this session owns
   * also records manifest validation, activation and disposal, and those stay in
   * the kernel's own sink. A caller who wants the complete stream builds the
   * kernel itself (`createKernel({ log })`) and passes it as `kernel`.
   *
   * ponytail: the caller owns the sink they pass, draining included. A sink whose
   * write is async still has records in flight when this resolves; `await
   * sink.drain()` before reading `sink.records`.
   */
  readonly log?: LogSink
  /**
   * Declarative caps for this session's kernel pipeline (AD-10). Omitted, nothing
   * is capped, which is what keeps `panda run` behaviour-neutral. A violation is
   * refused BEFORE the executor runs and surfaces as a coded `PandaKernelError`.
   *
   * Per KERNEL, so a host that shares one kernel across sessions caps all of
   * them together — which is the whole reason `kernel` exists as an option.
   */
  readonly actionPolicy?: ActionPolicy
  /**
   * A kernel this session should COMPOSE THROUGH instead of building its own.
   *
   * OWNERSHIP: the caller owns it — the caller mounted its plugins, seeded its
   * configuration and must `stop()` it; this session never does, so several
   * sessions can share one pipeline and one budget. That sharing is the point:
   * a cap only means something while every invocation it is supposed to bound
   * goes through the same pipeline.
   *
   * Every option that would configure a kernel, choose its executor, place its
   * workspaces or report on any of that is REFUSED alongside it rather than
   * ignored, because a budget or an executor selection that silently did nothing
   * is worse than one that was rejected. `createProvider` is refused too: it
   * exists for pooling, pooling gives a stable workspace id, a stable workspace
   * id gives a stable ACTION id, and a kernel-owned pipeline never retires one —
   * so the second run failed `PANDA_KERNEL_ACTION_INVALID` on a shared kernel.
   * A supplied kernel already carries a workspace provider; that is the point.
   */
  readonly kernel?: PandaKernel
}

/**
 * Options that only mean something for a kernel this session builds itself.
 *
 * `cwd` and `onSelection` joined the list on review: both were accepted and
 * silently ignored beside a supplied kernel (`onSelection` calls measured at 0),
 * which is the exact behaviour the refusal rule above exists to forbid.
 */
const KERNEL_OWNED_OPTIONS = [
  'configLayers',
  'cwd',
  'executorId',
  'adapterOptions',
  'createAdapter',
  'createProvider',
  'onSelection',
  'log',
  'actionPolicy',
] as const

async function contained(action: () => unknown): Promise<void> {
  try {
    await action()
  } catch {
    // Cleanup must never mask the primary envelope/error or crash the exit path.
  }
}

/**
 * The sink a session-owned kernel records into.
 *
 * `SessionOptions.log` is documented — and pinned by three suites — as the
 * WATERFALL's sink, and the kernel's stream carries lifecycle transitions too.
 * Forwarding the whole stream would redefine a published option; forwarding
 * nothing would delete the trail. So the caller's sink receives exactly the
 * waterfall, the kernel keeps its complete stream, and a caller who wants the
 * complete one supplies the kernel instead.
 */
function waterfallSink(caller: LogSink | undefined): LogSink {
  const own = createMemoryLogSink()
  if (caller === undefined) return own
  return {
    record(entry: LogEntry) {
      own.record(entry)
      if (entry.event.startsWith('action.')) caller.record(entry)
    },
    async drain() {
      await own.drain()
      await caller.drain()
    },
    get state() {
      return caller.state
    },
  }
}

function serviceMissing(service: string, detail: string): PandaError {
  // AD-5: a consumed service that never activated reads as `{ kind: 'absent' }`
  // and its USE SITE raises a named, coded error. `undefined` reaching a call
  // site is the failure the typed-absent value exists to make impossible, and a
  // bare "cannot read property of undefined" names neither the service nor the
  // plugin that owed it.
  return new PandaError(
    PANDA_ERROR_CODES.kernelServiceNotProvided,
    `panda's kernel provides no '${service}' service: ${detail}`,
  )
}

/** What a contained start failure has to say for itself, plugin by plugin. */
function describeFailures(failures: readonly { pluginId: string; error: Error }[]): string {
  return failures.map((failure) => `${failure.pluginId}: ${failure.error.message}`).join('; ')
}

export interface SessionKernelOptions {
  /**
   * Root the workspace plugin builds `.panda/workspaces` under. NAMED or not is
   * load-bearing: named, it is this invocation's answer and wins over every
   * document; omitted, `process.cwd()` supplies a DEFAULTS layer that a
   * `workspace.rootDir` in the user's document overrides. Anything else would
   * make the layered configuration decorative for the one object-namespaced
   * plugin panda mounts — measured: a valid configured `rootDir` was validated
   * and then always discarded.
   */
  readonly cwd?: string
  /** Explicit executor selection for this invocation; the `invocation` layer. */
  readonly executorId?: string
  /** Panda's own documents, already read (`readExecutorConfigLayers`). */
  readonly configLayers?: ExecutorConfigLayers
  /** Options handed to the selected adapter. */
  readonly adapterOptions?: CliExecutorAdapterOptions
  /** Adapter seam; wins over the selection, and still runs through the waterfall. */
  readonly createAdapter?: () => ExecutorAdapter
  /** Where the KERNEL's whole record stream goes — lifecycle transitions included. */
  readonly log?: LogSink
  /** Declarative caps for this kernel's pipeline, shared by every session on it. */
  readonly actionPolicy?: ActionPolicy
  /** See `SessionOptions.onSelection`; called before any plugin is registered. */
  readonly onSelection?: (selection: ExecutorSelection) => void
  /** See `SessionOptions.onWarning`. */
  readonly onWarning?: (message: string) => void
}

/**
 * A kernel with panda's two plugins mounted, its configuration seeded from
 * panda's own documents, and its plugins started.
 *
 * This is the ONE composition. `runSession` calls it when no kernel is passed,
 * and a host that wants several sessions to share one pipeline, one budget and
 * one record stream calls it directly and passes the result as
 * `SessionOptions.kernel`.
 *
 * It exists as a single named surface on purpose. `@panda/session` briefly
 * re-exported `createKernel` and both plugin FACTORIES so a host could assemble
 * this itself, and that was a hole rather than a convenience: a `PluginFactory`
 * invoked with an `ActivationContext` of the caller's own construction hands
 * back a real vendor adapter wired to the caller's own pipeline, so the bypass
 * surface of a session-only consumer went from nothing to one. Handing back a
 * started kernel gives a host the capability without the factory.
 *
 * Throws before anything is constructed for a selection panda has no adapter
 * for, and stops the kernel again if any plugin fails to activate.
 */
export function createSessionKernel(options: SessionKernelOptions = {}): PandaKernel {
  const {
    cwd,
    executorId,
    configLayers,
    adapterOptions,
    createAdapter,
    log,
    actionPolicy,
    onSelection,
    onWarning,
  } = options

  // The KERNEL's sink, unfiltered: a host that builds its own kernel is exactly
  // the caller who wants the lifecycle transitions too, and it is where the AD-4
  // ordering proof reads its stream. `runSession` hands this a sink already
  // narrowed to the waterfall, because `SessionOptions.log` means that and is
  // pinned to it by three suites.
  const kernel = createKernel({ log, actionPolicy })
  try {
    // Subscribed BEFORE anything activates: a plugin emits its configuration
    // warnings during activation, synchronously, and a listener attached after
    // `start()` would receive none of them.
    if (onWarning !== undefined) {
      kernel.bus.subscribe<WorkspaceConfigWarning>('global', (event: BusEvent<WorkspaceConfigWarning>) => {
        if (event.type !== WORKSPACE_CONFIG_WARNING_EVENT) return
        onWarning(`configuration ignored: '${event.payload.key}' ${event.payload.detail}`)
      })
    }

    // ONE layered configuration, and it is the kernel's: executor selection and
    // every mounted plugin read the same composed document, by layer. The
    // session's own workspace root enters as a LAYER rather than as a plugin
    // option — `invocation` when the caller named a cwd, `defaults` when it did
    // not — so a `workspace.rootDir` in the project document decides in exactly
    // the case a layered configuration says it should.
    const workspaceRoot = { [WORKSPACE_CONFIG_KEY]: { rootDir: join(cwd ?? process.cwd(), '.panda', 'workspaces') } }
    const invocation: Record<string, unknown> = { ...(configLayers?.invocation as object | undefined) }
    if (executorId !== undefined) invocation[EXECUTOR_CONFIG_KEY] = executorId.trim()
    if (cwd !== undefined) Object.assign(invocation, workspaceRoot)
    seedExecutorConfig(kernel.config, {
      ...configLayers,
      defaults: cwd === undefined ? workspaceRoot : configLayers?.defaults,
      ...(Object.keys(invocation).length === 0 ? {} : { invocation }),
    })

    // Resolved BEFORE anything is constructed, beside the prompt check and for
    // the same reason: an invalid request must cost no mkdir. An `executorId`
    // the catalogue does not hold used to be rejected AFTER `provider.create()`,
    // leaving a workspace directory on disk that nothing removes.
    const selection = selectExecutor(kernel.config)
    if (onSelection !== undefined) {
      try {
        onSelection(selection)
      } catch {
        // A reporter is an observer; an observer must not fail the run.
      }
    }

    const executor = createExecutorPlugin({ createAdapter, adapterOptions, cost: SESSION_ACTION_COST })
    const workspace = createWorkspacePlugin()
    kernel.register(executor.manifest, executor.factory)
    kernel.register(workspace.manifest, workspace.factory)

    const started = kernel.start()
    if (started.failures.length > 0) {
      // Contained by the kernel — every OTHER plugin still activated — and
      // surfaced here, naming each plugin that failed. Swallowing it would let a
      // `{ kind: 'absent' }` reach a use site with no explanation of why.
      throw new PandaError(
        PANDA_ERROR_CODES.kernelPluginStartFailed,
        `panda's kernel could not activate every plugin this session needs (${describeFailures(started.failures)})`,
      )
    }
    return kernel
  } catch (error) {
    // The one place a constructed kernel could have been abandoned. Nothing has
    // activated on most of these paths, so nothing leaks — but "most" is not a
    // guarantee, and `stop()` is idempotent.
    void kernel.stop().catch(() => {})
    throw error
  }
}

/**
 * One panda session: compose through a kernel, create a workspace, run the
 * prompt under a cancellation signal through the kernel's interception
 * waterfall, then release and dispose whatever happened.
 *
 * This is the composition `panda run` performs, and it lives here rather than in
 * `@panda/cli` so a third party gets it by importing packages (PRD §2, ROADMAP-01
 * Correction A). The CLI adds argv parsing, JSON formatting and exit codes on top
 * and nothing else.
 *
 * Since Story M3.B the adapter and the provider are MOUNTED, not constructed:
 * `createExecutorPlugin` and `createWorkspacePlugin` are registered on a kernel,
 * their configuration comes from one composed document, and their services are
 * consumed by name. What that buys beyond hygiene: the executor invocation is an
 * action on the KERNEL's pipeline, so a host that shares one kernel across
 * sessions shares one budget — and the observability log exists before any
 * plugin loads, which `loadPlugins`' required sink parameter makes a type error
 * to violate rather than a comment.
 *
 * The honest scope of the no-bypass claim: neither the kernel nor the `executor`
 * service exports a path around the waterfall. Any package may still import
 * `@panda/adapter-cli` and drive a vendor adapter itself, and a caller that keeps
 * a reference to the adapter it passed to `createAdapter` can invoke it after a
 * refusal. Both are recorded as open in deferred-work.md.
 *
 * SIDE EFFECT: the mounted provider creates a directory per session under
 * `<cwd>/.panda/workspaces/<uuid>` and NOTHING removes it. `release()` ends a
 * lease and `dispose()` deliberately leaves the tree in place so work survives —
 * retention is the caller's problem (deferred-work.md).
 *
 * Failure surfaces as a throw (a coded `PandaError` from the workspace port or
 * from a plugin that never activated, a coded `PandaKernelError` from a refusal,
 * or whatever the adapter threw), because an envelope is what an executor RAN
 * produces — returning a synthetic one for a workspace that never existed would
 * make the two indistinguishable.
 */
export async function runSession(options: SessionOptions): Promise<ResultEnvelope> {
  // Every field read ONCE, here, before the first await. `provider.create()` hands
  // control back to the caller's event loop, so a live read afterwards is a TOCTOU
  // hole: an accessor answering a benign prompt now and a hostile one later gets
  // the hostile one executed. The kernel closes exactly this hole at `register`
  // and says so; a session that read `options.prompt` inside the operation closure
  // would hand it straight back.
  const {
    prompt,
    cwd,
    executorId,
    configLayers,
    adapterOptions,
    createAdapter,
    createProvider,
    onInterrupt,
    onSelection,
    onWarning,
    log,
    actionPolicy,
    kernel: suppliedKernel,
  } = options

  // Before anything is constructed or written: an invalid request must cost no
  // mkdir. The predicate, the code and the message are the contracts package's
  // own (`runRequestIssues` + `throwSchemaViolation`), so this rejects exactly
  // what the adapter would have rejected — earlier, not differently.
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    throw new PandaError(
      PANDA_ERROR_CODES.contractEnvelopeInvalid,
      "schema violation: 'prompt' must be a non-empty string",
    )
  }

  const owned = {
    configLayers,
    cwd,
    executorId,
    adapterOptions,
    createAdapter,
    createProvider,
    onSelection,
    log,
    actionPolicy,
  }
  if (suppliedKernel !== undefined) {
    const conflicting = KERNEL_OWNED_OPTIONS.filter((name) => owned[name] !== undefined)
    if (conflicting.length > 0) {
      throw new PandaError(
        PANDA_ERROR_CODES.contractEnvelopeInvalid,
        `schema violation: a supplied 'kernel' owns its configuration, its plugins, its pipeline and its sink, so ${conflicting
          .map((name) => `'${name}'`)
          .join(', ')} cannot also be given here`,
      )
    }
  }

  const kernel =
    suppliedKernel ??
    createSessionKernel({
      cwd,
      executorId,
      configLayers,
      adapterOptions,
      createAdapter,
      log: waterfallSink(log),
      actionPolicy,
      onSelection,
      onWarning,
    })

  const stopKernel = suppliedKernel === undefined ? () => kernel.stop() : undefined

  let executor: ExecutorService
  let provider: WorkspaceProvider
  let disposeProvider = false
  try {
    const resolved = kernel.getService<ExecutorService>(EXECUTOR_SERVICE)
    if (resolved.kind !== 'provided') {
      throw serviceMissing(
        EXECUTOR_SERVICE,
        'mount an executor plugin (`createExecutorPlugin` from @panda/adapter-cli) before running a session on this kernel',
      )
    }
    executor = resolved.value

    if (createProvider === undefined) {
      const workspace = kernel.getService<WorkspaceProvider>(WORKSPACE_SERVICE)
      if (workspace.kind !== 'provided') {
        throw serviceMissing(
          WORKSPACE_SERVICE,
          'mount a workspace plugin (`createSessionKernel` mounts one) before running a session on this kernel',
        )
      }
      provider = workspace.value
    } else {
      // The seam, and with it the ownership: a provider this session created is
      // a provider this session disposes. Refused beside a supplied kernel (see
      // `SessionOptions.kernel`), so this only ever runs for a kernel the
      // session built and will stop.
      provider = createProvider()
      disposeProvider = true
    }
  } catch (error) {
    if (stopKernel !== undefined) await contained(stopKernel)
    throw error
  }

  let handle: WorkspaceHandle
  try {
    handle = await provider.create()
  } catch (error) {
    // Nothing was leased, so there is nothing to release — but the provider was
    // obtained and owns whatever it allocated before it failed.
    if (disposeProvider) await contained(() => provider.dispose())
    if (stopKernel !== undefined) await contained(stopKernel)
    throw error
  }

  const controller = new AbortController()
  // Initialised to the noop and only then replaced, because everything from the
  // lease onwards has to unwind through the `finally`: registering OUTSIDE the
  // try meant a throwing `onInterrupt` leaked the handle and the provider whole.
  let removeSignalHandler: () => void = () => {}

  try {
    removeSignalHandler = onInterrupt?.(() => controller.abort()) ?? removeSignalHandler
    // The ONLY way this package can reach an executor. The service closed over
    // the adapter and hands back no `run` of its own — what it registers is an
    // action on the KERNEL's pipeline, scoped to the workspace so two sessions
    // sharing one kernel stay distinguishable in the record stream. A provider
    // handing back an id a log record rejects fails CLOSED at registration,
    // before anything is charged.
    return await executor.run(`${SESSION_ACTION_ID}#${handle.id}`, {
      prompt,
      workspace: handle,
      signal: controller.signal,
    })
  } finally {
    // Order is load-bearing and matches what `panda run` has always done:
    // unregister first so a signal arriving during cleanup cannot abort a
    // controller nobody is watching, then release the lease, then dispose. ALL
    // of them are contained: a bare deregistration replaced a successful
    // envelope with its own rejection AND skipped the rest, which is the failure
    // this block exists to prevent.
    await contained(() => removeSignalHandler())
    await contained(() => provider.release(handle))
    if (disposeProvider) await contained(() => provider.dispose())
    // A kernel this session BUILT is a kernel this session stops, which is what
    // runs every mounted plugin's disposer — the mounted provider's included. A
    // kernel the caller supplied is the caller's to stop, or two sessions on one
    // kernel would leave the first one's cleanup disposing the second's provider.
    if (stopKernel !== undefined) await contained(stopKernel)
  }
}
