import { PANDA_ERROR_CODES, PandaError, defineStandardSchema } from '@panda/contracts'
import type { ExecutorAdapter, ResultEnvelope, RunRequest, StandardSchemaResult } from '@panda/contracts'
import { isNonEmptyString, isRecord, issue } from '@panda/contracts/validation'
import type { ActivationContext, PluginFactory, PluginManifest } from '@panda/kernel'
import {
  DEFAULT_EXECUTOR_ID,
  EXECUTOR_CATALOGUE,
  availableExecutorIds,
  createExecutorAdapter,
  unknownExecutor,
} from './catalogue.ts'
import { USAGE_DATA_KEY, type CliExecutorAdapterOptions } from './traits.ts'

// The executor adapter, mounted as a kernel plugin (Story M3.B).
//
// It is the interesting one of the two this story adds, because of what its
// SERVICE is. A service that handed back an `ExecutorAdapter` would put `.run()`
// on the surface of the container, and every consumer of the kernel could then
// spawn an executor with no budget, no guard and no record — which is exactly
// the hole AD-10 exists to close. So the service is a RUNNER: the adapter is
// closed over and never handed out, and the only exported way to reach it
// registers the invocation on the kernel's own pipeline and invokes it there.
//
// Configuration comes from the plugin's own key of the kernel's layered config —
// `executor`, the same key panda's `.panda/config.json` already spells, so one
// composed document decides both what `panda run` reports and what this mounts.

/** The service name this plugin provides. */
export const EXECUTOR_SERVICE = 'executor'

/** The plugin id this plugin registers under. */
export const EXECUTOR_PLUGIN_ID = 'executor'

/** The key this plugin reads out of the kernel's composed configuration. */
export const EXECUTOR_CONFIG_KEY = 'executor'

/**
 * What one executor run is ADMITTED at when nothing configures otherwise, before
 * the vendor says what it actually spent.
 *
 * ponytail: still a flat 1. Panda may not invent a token figure — estimating or
 * tokenizing is the exact thing this story removes — so the only honest pre-run
 * number is a placeholder in whatever unit the caller's caps are denominated in.
 * A host budgeting tokens passes its own `cost`; the settlement then replaces it
 * with the vendor's own figure either way. Upgrade path: a per-executor estimate,
 * which is per-model weighting and Ask-First (deferred-work.md).
 */
export const DEFAULT_EXECUTOR_ACTION_COST = 1

/**
 * The vendor's own usage figure, as the adapter put it on the envelope.
 *
 * Forwarded whatever it is, never sanitised here: an absent key means "nothing
 * observed this run" and charges the estimate, while a PRESENT but broken value
 * is a coded rejection the pipeline owns and records. Quietly turning the second
 * into the first would hide a lying adapter behind a normal-looking run.
 */
function reportedUsage(envelope: ResultEnvelope): number | undefined {
  const data = envelope.data
  if (!isRecord(data) || !Object.hasOwn(data, USAGE_DATA_KEY)) return undefined
  return data[USAGE_DATA_KEY] as number | undefined
}

/**
 * What `kernel.getService('executor')` hands back.
 *
 * Deliberately NOT an `ExecutorAdapter`. The honest limit is stated on
 * `createExecutorPlugin` and in `deferred-work.md`: this closes the CONTAINER's
 * surface, not the process — any package may still import a vendor factory from
 * this one and drive an adapter itself.
 */
export interface ExecutorService {
  /** Which shipped executor this is driving; a host-supplied adapter reports `'(injected)'`. */
  readonly executorId: string
  /**
   * Runs one request through the KERNEL's interception waterfall.
   *
   * `actionId` names this invocation in the record stream, and the caller owns
   * it because the caller owns run identity — the session scopes it to the
   * workspace so two sessions on one pipeline stay distinguishable. The COST is
   * the plugin's, never the caller's: a caller that could price its own run
   * could price it at zero and walk through a cost cap. So is the SETTLEMENT —
   * the plugin observed the vendor, the caller did not, and a caller that could
   * reconcile its own run to zero has defeated the budget just as thoroughly.
   */
  run(actionId: string, request: RunRequest): Promise<ResultEnvelope>
}

export interface ExecutorPluginOptions {
  /**
   * Adapter seam; a host that built its own executor passes it here and the
   * catalogue is never consulted. It still runs through the waterfall — the
   * seam replaces WHICH executor runs, never WHETHER the pipeline sees it.
   */
  readonly createAdapter?: () => ExecutorAdapter
  /**
   * Options handed to the SELECTED adapter: a child-process spawner, or a binary
   * path that overrides the trait's command. Ignored when `createAdapter` is
   * supplied, because then the caller built the adapter itself.
   */
  readonly adapterOptions?: CliExecutorAdapterOptions
  /** What one run costs this kernel's budget. Defaults to `DEFAULT_EXECUTOR_ACTION_COST`. */
  readonly cost?: number
}

export interface ExecutorPlugin {
  readonly manifest: PluginManifest
  readonly factory: PluginFactory
}

/**
 * The plugin's own subtree of the kernel's layered configuration.
 *
 * That subtree is a STRING, not an object, and that is the point: panda's
 * `.panda/config.json` already spells its executor selection as
 * `{"executor": "codex"}`, so the plugin reads the document the user already
 * writes rather than a parallel one invented for the container.
 */
const EXECUTOR_CONFIG_SCHEMA = defineStandardSchema((value): StandardSchemaResult<unknown> => {
  if (value === undefined) return { value: undefined }
  if (!isNonEmptyString(value)) {
    return {
      issues: [
        issue(
          `'${EXECUTOR_CONFIG_KEY}' must be a string naming one of: ${availableExecutorIds().join(', ')}`,
        ),
      ],
    }
  }
  const executorId = value.trim()
  if (!EXECUTOR_CATALOGUE.has(executorId)) {
    return { issues: [issue(unknownExecutor(executorId).message)] }
  }
  return { value: executorId }
})

/**
 * The executor adapter as a kernel plugin: a manifest providing the `executor`
 * service, a factory that resolves WHICH adapter from the kernel's own composed
 * configuration, and a disposer that drops it.
 *
 * Misconfiguration REJECTS activation (a contained start failure naming this
 * plugin), never a mid-run surprise — the same rule `@panda/registry`'s plugin
 * follows, and the reason a bad `executor` key cannot take the kernel down.
 *
 * The honest scope of the no-bypass claim, corrected on review: this SERVICE
 * exports no path around the waterfall, and the object it hands back is frozen
 * so no other caller can be taken off it either. Three routes remain open and
 * are named in `deferred-work.md` rather than narrated away:
 *   - anyone who installs THIS package can call `createExecutorAdapter(id)` or
 *     any of the three vendor factories and drive an adapter directly;
 *   - this `factory` is a `PluginFactory`, so a holder can invoke it with an
 *     `ActivationContext` of their own and get a real adapter wired to their own
 *     pipeline — inherent to the plugin shape, and the reason `@panda/session`
 *     does not re-export it;
 *   - `kernel.swap` runs a caller-supplied factory against the live registry, so
 *     a kernel holder can replace this service outright.
 */
export function createExecutorPlugin(options: ExecutorPluginOptions = {}): ExecutorPlugin {
  // ONE read of every caller-supplied field, at CONSTRUCTION. `createActionPipeline`
  // states the discipline verbatim — "a budget a caller can raise after
  // construction by mutating the object it handed in is not a budget" — and
  // reading `cost` inside the factory reopened exactly that: mutating the
  // options object between here and `kernel.start()` priced a run at 0 under a
  // 0.5 cap. Measured, then closed.
  const { createAdapter, adapterOptions, cost = DEFAULT_EXECUTOR_ACTION_COST } = options

  const manifest: PluginManifest = {
    id: EXECUTOR_PLUGIN_ID,
    version: '0.0.0',
    provides: [EXECUTOR_SERVICE],
    consumes: [],
    configSchema: EXECUTOR_CONFIG_SCHEMA,
  }

  const factory: PluginFactory = (context: ActivationContext) => {
    const composed = context.config.resolve()
    const configured = isRecord(composed) ? composed[EXECUTOR_CONFIG_KEY] : undefined
    const validated = EXECUTOR_CONFIG_SCHEMA['~standard'].validate(configured)
    if (validated instanceof Promise) {
      return { status: 'rejected', issues: ['the executor plugin config must validate synchronously'] }
    }
    if (validated.issues !== undefined) {
      return { status: 'rejected', issues: validated.issues.map((entry) => entry.message) }
    }
    // A throw from either branch is NOT caught here. `runCandidate` in the
    // kernel already converts it into `PANDA_KERNEL_PLUGIN_START_FAILED` naming
    // this plugin AND preserves the original as `cause`; catching it locally
    // produced the same message while discarding the cause chain, and made a
    // clause unable to tell plugin containment from kernel containment.
    const selected = validated.value as string | undefined
    const adapter: ExecutorAdapter =
      createAdapter === undefined ? createExecutorAdapter(selected, adapterOptions) : createAdapter()
    const executorId = createAdapter === undefined ? selected ?? DEFAULT_EXECUTOR_ID : '(injected)'

    let disposed = false
    // FROZEN, and not merely `readonly`: `getService` hands every caller the
    // same object, so an un-frozen one let a kernel holder who never had the
    // adapter overwrite `run` and take every OTHER caller off the waterfall —
    // measured at three runs past a cap of 1 with an empty record stream. The
    // pipeline freezes its handle and its descriptor for the same reason.
    const service: ExecutorService = Object.freeze<ExecutorService>({
      executorId,
      async run(actionId, request) {
        if (disposed) {
          // Coded, and it names the plugin: a handle kept past `kernel.stop()`
          // reaching a live adapter is the disposal leak this pairing exists to
          // prevent, and `undefined` is what it would otherwise look like.
          throw new PandaError(
            PANDA_ERROR_CODES.kernelPluginInactive,
            `plugin '${EXECUTOR_PLUGIN_ID}' is inactive: the '${EXECUTOR_SERVICE}' service was disposed with its plugin`,
          )
        }
        // Registered per invocation, because `ActionDefinition.run` takes no
        // arguments: the pipeline reads the operation ONCE at registration and
        // holds it, which is what stops a caller swapping the operation after
        // the price was agreed. A per-request handle is the only shape that
        // survives that rule.
        //
        // ponytail: a pipeline remembers every id it ever registered, so a
        // long-lived kernel running many sessions grows that set. Workspace ids
        // are UUIDs, so collisions are not the concern — retention is. Upgrade
        // path: a pipeline that can retire a handle, which is the same mechanism
        // a post-hoc cost adjustment needs (deferred-work.md).
        const handle = context.actions.register<ResultEnvelope>({
          id: actionId,
          cost,
          run: () => adapter.run(request),
          // Admitted at the estimate, reconciled to what the vendor reported.
          // Declared HERE, beside `cost` and `run`, because the pipeline reads
          // all three once at registration and the caller supplies none of them.
          //
          // A failed or cancelled run still resolves an envelope, and the adapter
          // now reads the vendor's figure off EVERY outcome — a killed child
          // settles carrying what it had already printed — so whatever it spent
          // before it gave up is charged. A run that produced no figure keeps its
          // estimate, and the pipeline floors a settlement at that estimate, so
          // there is no path on which failing, cancelling or under-reporting is
          // cheaper than reporting honestly.
          settle: reportedUsage,
        })
        return await handle.invoke()
      },
    })

    return {
      status: 'activated',
      services: { [EXECUTOR_SERVICE]: service },
      dispose: () => {
        // The adapter itself owns no resource between runs (each run spawns and
        // reaps its own child), so disposal is about the SERVICE: a handle kept
        // past `kernel.stop()` must not still be able to spawn.
        disposed = true
      },
    }
  }

  return { manifest, factory }
}
