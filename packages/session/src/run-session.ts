import { join } from 'node:path'
import { createClaudeCodeAdapter } from '@panda/adapter-cli'
import { PandaError, PANDA_ERROR_CODES } from '@panda/contracts'
import type { ExecutorAdapter, ResultEnvelope, WorkspaceHandle, WorkspaceProvider } from '@panda/contracts'
import { createActionPipeline, createMemoryLogSink, type ActionPolicy, type LogSink } from '@panda/kernel'
import { LocalWorkspaceProvider } from '@panda/workspace-local'

/**
 * The PREFIX every session invocation is recorded under. The registered id is
 * `${SESSION_ACTION_ID}#${workspace.id}`, not this constant: a pipeline rejects a
 * duplicate registration, so a constant id would make the second session on a
 * shared pipeline throw. Nothing shares a pipeline today — which is exactly why
 * this is cheap now and a breaking change later.
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
 * honest number exists to charge. The consequence is worth stating plainly: with
 * one action of cost 1 invoked once per pipeline, `maxInvocations`, `maxTotalCost`
 * and `maxConcurrent` all collapse into a single boolean — "may this session spawn
 * an executor at all". Upgrade path: an adapter-reported usage figure settled after
 * the run, which needs a pipeline that can adjust a cost post-hoc (deferred-work.md).
 */
export const SESSION_ACTION_COST = 1

export interface SessionOptions {
  /** Handed to the executor verbatim; rejected before anything is created if it is blank. */
  readonly prompt: string
  /** Root the default workspace provider builds `.panda/workspaces` under. Defaults to `process.cwd()`. */
  readonly cwd?: string
  /** Adapter seam; tests inject fakes, production defaults to Claude Code. */
  readonly createAdapter?: () => ExecutorAdapter
  /**
   * Workspace provider seam; production defaults to the local-dir provider.
   *
   * OWNERSHIP: the session disposes whatever this returns, on every path. Hand
   * back a FRESH provider per session — returning a pooled or long-lived one
   * leaves it disposed, and the next session against it fails with
   * `PANDA_CONTRACT_PROVIDER_DISPOSED` (pinned by a test, because the obvious
   * reason to inject a provider is to pool workspaces).
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
   * Where the interception pipeline's records go. Omitted, the session builds an
   * in-memory sink it then drops — the waterfall still runs, its trail is simply
   * unread.
   *
   * ponytail: the caller owns the sink they pass, draining included. A sink whose
   * write is async still has records in flight when this resolves; `await
   * sink.drain()` before reading `sink.records`.
   */
  readonly log?: LogSink
  /**
   * Declarative caps for this session's pipeline (AD-10). Omitted, nothing is
   * capped, which is what keeps `panda run` behaviour-neutral. A violation is
   * refused BEFORE the executor runs and surfaces as a coded `PandaKernelError`.
   *
   * See `SESSION_ACTION_COST`: with one action per pipeline the three caps are
   * currently one boolean, not three budgets.
   */
  readonly actionPolicy?: ActionPolicy
}

async function contained(action: () => Promise<void>): Promise<void> {
  try {
    await action()
  } catch {
    // Cleanup must never mask the primary envelope/error or crash the exit path.
  }
}

/**
 * One panda session: create a workspace, obtain an adapter, run the prompt under
 * a cancellation signal through the kernel's interception waterfall, then release
 * and dispose whatever happened.
 *
 * This is the composition `panda run` performs, and it lives here rather than in
 * `@panda/cli` so a third party gets it by importing packages (PRD §2, ROADMAP-01
 * Correction A). The CLI adds argv parsing, JSON formatting and exit codes on top
 * and nothing else.
 *
 * The executor invocation is an ACTION invoked through `createActionPipeline`,
 * never `adapter.run` called directly, so `@panda/cli` no longer reaches an
 * executor around the waterfall. The honest scope of that: it binds THIS path.
 * Any package may still import `@panda/adapter-cli` and drive an adapter itself,
 * and a caller that keeps a reference to the adapter it passed to `createAdapter`
 * can invoke it after a refusal — both are recorded as open in deferred-work.md.
 *
 * SIDE EFFECT: the default provider creates a directory per session under
 * `<cwd>/.panda/workspaces/<uuid>` and NOTHING removes it. `release()` ends a
 * lease and `dispose()` deliberately leaves the tree in place so work survives —
 * retention is the caller's problem (deferred-work.md).
 *
 * Failure surfaces as a throw (a coded `PandaError` from the workspace port, a
 * coded `PandaKernelError` from a refusal, or whatever the adapter threw),
 * because an envelope is what an executor RAN produces — returning a synthetic one
 * for a workspace that never existed would make the two indistinguishable.
 */
export async function runSession(options: SessionOptions): Promise<ResultEnvelope> {
  // Every field read ONCE, here, before the first await. `provider.create()` hands
  // control back to the caller's event loop, so a live read afterwards is a TOCTOU
  // hole: an accessor answering a benign prompt now and a hostile one later gets
  // the hostile one executed. The kernel closes exactly this hole at `register`
  // and says so; a session that read `options.prompt` inside the operation closure
  // would hand it straight back.
  const { prompt, cwd = process.cwd(), createAdapter, createProvider, onInterrupt, log, actionPolicy } = options

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

  const provider = createProvider?.() ?? new LocalWorkspaceProvider({ rootDir: join(cwd, '.panda', 'workspaces') })

  let handle: WorkspaceHandle
  try {
    handle = await provider.create()
  } catch (error) {
    // Nothing was leased, so there is nothing to release — but the provider was
    // constructed and owns whatever it allocated before it failed.
    await contained(() => provider.dispose())
    throw error
  }

  const controller = new AbortController()
  // Initialised to the noop and only then replaced, because everything from the
  // lease onwards has to unwind through the `finally`: registering OUTSIDE the
  // try meant a throwing `onInterrupt` leaked the handle and the provider whole.
  let removeSignalHandler: () => void = () => {}

  try {
    removeSignalHandler = onInterrupt?.(() => controller.abort()) ?? removeSignalHandler
    const adapter = createAdapter?.() ?? createClaudeCodeAdapter()
    const actions = createActionPipeline(log ?? createMemoryLogSink(), actionPolicy)
    const action = actions.register({
      // Scoped to the workspace so two sessions can share a pipeline the day one
      // is offered. A provider handing back an id a log record rejects fails
      // CLOSED here, at registration, before anything is charged.
      id: `${SESSION_ACTION_ID}#${handle.id}`,
      cost: SESSION_ACTION_COST,
      // `register` reads this closure once and holds it, handing back only a
      // handle — the pipeline is the only thing that can run it. Every value it
      // closes over was read above, before the first await.
      run: () => adapter.run({ prompt, workspace: handle, signal: controller.signal }),
    })
    return await action.invoke()
  } finally {
    // Order is load-bearing and matches what `panda run` has always done:
    // unregister first so a signal arriving during cleanup cannot abort a
    // controller nobody is watching, then release the lease, then dispose the
    // provider. ALL THREE are contained: a bare deregistration replaced a
    // successful envelope with its own rejection AND skipped the other two,
    // which is the failure this block exists to prevent.
    await contained(async () => removeSignalHandler())
    await contained(() => provider.release(handle))
    await contained(() => provider.dispose())
  }
}
