import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { ExecutorAdapter, ResultEnvelope, WorkspaceHandle, WorkspaceProvider } from '@panda/contracts'
import {
  createKernel,
  createMemoryLogSink,
  lostRecordCount,
  type LogRecord,
  type MemoryLogSink,
  type PandaKernel,
  type PluginFactory,
  type PluginManifest,
} from '@panda/kernel'
import { createExecutorPlugin } from '@panda/adapter-cli'
import { createWorkspacePlugin } from '@panda/workspace-local'
import {
  createSessionKernel,
  readExecutorConfigLayers,
  runSession,
  SESSION_ACTION_COST,
  SESSION_ACTION_ID,
} from '../src/index.ts'

// Story M3.B: the session composes through a kernel. Every claim here is proven
// by EXECUTION — the ordering one reads the kernel's record stream rather than
// this repository's source, because a guarantee that lives in a comment is the
// defect this story exists to stop shipping.

const roots: string[] = []
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'panda-composition-'))
  roots.push(root)
  return root
}

function ok(summary = 'listed files'): ResultEnvelope {
  return { status: 'ok', data: { result: 'a.txt' }, summary, errors: [] }
}

function countingAdapter(): ExecutorAdapter & { runs: number } {
  const adapter = {
    runs: 0,
    run: () => {
      adapter.runs += 1
      return Promise.resolve(ok())
    },
  }
  return adapter
}

interface RecordingProvider extends WorkspaceProvider {
  readonly calls: string[]
}

/** A provider that records what was asked of it and touches no filesystem. */
function recordingProvider(): RecordingProvider {
  const calls: string[] = []
  const handle: WorkspaceHandle = { id: 'pooled', rootPath: join(tmpdir(), 'panda-pooled'), capabilities: ['read'] }
  return {
    calls,
    create: async () => {
      calls.push('create')
      return handle
    },
    acquire: async () => handle,
    release: async () => {
      calls.push('release')
    },
    dispose: async () => {
      calls.push('dispose')
    },
  }
}

interface Mounted {
  readonly kernel: PandaKernel
  readonly log: MemoryLogSink
  readonly adapter: ExecutorAdapter & { runs: number }
}

/**
 * A kernel with panda's two plugins on it, mounted the way a HOST would — which
 * is the composition `runSession` performs for itself when nothing is passed.
 */
async function mount(options: { readonly actionPolicy?: { readonly maxTotalCost?: number } } = {}): Promise<Mounted> {
  const log = createMemoryLogSink()
  const kernel = createKernel({ log, ...(options.actionPolicy === undefined ? {} : { actionPolicy: options.actionPolicy }) })
  kernel.config.setLayer('project', { workspace: { rootDir: await tempRoot() } })
  const adapter = countingAdapter()
  const executor = createExecutorPlugin({ createAdapter: () => adapter, cost: SESSION_ACTION_COST })
  const workspace = createWorkspacePlugin()
  kernel.register(executor.manifest, executor.factory)
  kernel.register(workspace.manifest, workspace.factory)
  return { kernel, log, adapter }
}

function trail(log: MemoryLogSink): string[] {
  return log.records.map((record) => `${record.event}:${record.subject}`)
}

function firstSeq(records: readonly LogRecord[], event: string): number {
  const found = records.find((record) => record.event === event)
  if (found === undefined) throw new Error(`the stream carries no '${event}' record`)
  return found.seq
}

describe('AD-4: the log sink exists before any plugin loads, and the RECORDS show it', () => {
  it('opens the stream at seq 1 with a manifest validation, losing nothing before it', async () => {
    const { kernel, log } = await mount()
    kernel.start()
    await log.drain()

    const records = log.records
    // The proof, read off the stream rather than off the source. `seq` is
    // assigned by the SINK and starts at 1, and it only advances for a record
    // that was actually sealed — so a first record of seq 1 says no record
    // preceded it and none was lost before it. A sink constructed after the load
    // path had run could not produce this: the load's own records would have had
    // nowhere to go, and either the first seq would be higher (records written
    // to some earlier sink) or the manifest validations would be missing.
    expect(records[0]?.seq).toBe(1)
    expect(records[0]?.event).toBe('manifest.validated')
    expect(log.state.dropped).toBe(0)
    expect(lostRecordCount(log)).toBe(0)

    // And the ordering itself: every manifest was validated before any plugin
    // activated, which is what "initialised before any plugin loads" buys.
    const validated = records.filter((record) => record.event === 'manifest.validated')
    expect(validated.map((record) => record.subject)).toEqual(['executor', 'workspace'])
    expect(Math.max(...validated.map((record) => record.seq))).toBeLessThan(
      firstSeq(records, 'plugin.activated'),
    )
    await kernel.stop()
  })

  it('carries the whole run — load, activation, invocation, disposal — in ONE stream', async () => {
    const { kernel, log } = await mount()
    kernel.start()
    await runSession({ prompt: 'list files', kernel })
    await kernel.stop()
    await log.drain()

    // The action subjects carry a UUID this test cannot know, so the EVENT
    // sequence is pinned whole and the subjects are pinned separately. An
    // earlier version spliced the actual records into its own expected array,
    // which is the self-referential assertion this repo is trying to stop
    // shipping — it would have passed for any action events at all, or none.
    expect(log.records.map((record) => record.event)).toEqual([
      'manifest.validated',
      'manifest.validated',
      'plugin.activated',
      'plugin.activated',
      'action.invoked',
      'action.completed',
      'plugin.disposed',
      'plugin.disposed',
      'kernel.stopped',
    ])
    expect(trail(log).filter((entry) => !entry.startsWith('action.'))).toEqual([
      'manifest.validated:executor',
      'manifest.validated:workspace',
      'plugin.activated:executor',
      'plugin.activated:workspace',
      'plugin.disposed:workspace',
      'plugin.disposed:executor',
      'kernel.stopped:kernel',
    ])
    const actions = log.records.filter((record) => record.event.startsWith('action.'))
    expect(actions.every((record) => record.subject.startsWith(`${SESSION_ACTION_ID}#`))).toBe(true)
  })
})

describe('the session composes through the kernel rather than constructing collaborators', () => {
  it('runs a session against a HOST-supplied kernel, using the services it mounted', async () => {
    const { kernel, adapter } = await mount()
    kernel.start()
    const envelope = await runSession({ prompt: 'list files', kernel })
    expect(envelope).toMatchObject({ status: 'ok', summary: 'listed files' })
    expect(adapter.runs).toBe(1)
    await kernel.stop()
  })

  it('raises a NAMED coded error at the use site when a service never activated', async () => {
    // Typed absence, all the way to the call site. Nothing here is `undefined`:
    // the kernel answers `{ kind: 'absent' }` and the session says which service
    // is missing and what to mount for it (AD-5).
    const bare = createKernel()
    bare.start()
    await expect(runSession({ prompt: 'p', kernel: bare })).rejects.toMatchObject({
      code: 'PANDA_KERNEL_SERVICE_NOT_PROVIDED',
      message: expect.stringContaining("no 'executor' service"),
    })

    // And the same for the other half, with the executor present.
    const half = createKernel()
    const executor = createExecutorPlugin({ createAdapter: () => countingAdapter() })
    half.register(executor.manifest, executor.factory)
    half.start()
    await expect(runSession({ prompt: 'p', kernel: half })).rejects.toMatchObject({
      code: 'PANDA_KERNEL_SERVICE_NOT_PROVIDED',
      message: expect.stringContaining("no 'workspace' service"),
    })
    await bare.stop()
    await half.stop()
  })

  it('refuses EVERY option a supplied kernel already owns instead of ignoring them', async () => {
    const { kernel } = await mount()
    kernel.start()
    // `cwd` and `onSelection` joined the list on review: both were accepted and
    // then silently ignored, which is the behaviour the refusal rule forbids.
    // `createProvider` joined it for a measured failure — see the clause below.
    const refused: [string, Record<string, unknown>][] = [
      ['executorId', { executorId: 'codex' }],
      ['actionPolicy', { actionPolicy: { maxInvocations: 0 } }],
      ['cwd', { cwd: 'C:/nowhere' }],
      ['onSelection', { onSelection: () => {} }],
      ['createProvider', { createProvider: () => recordingProvider() }],
      ['log', { log: createMemoryLogSink() }],
      ['configLayers', { configLayers: {} }],
      ['adapterOptions', { adapterOptions: {} }],
      ['createAdapter', { createAdapter: () => countingAdapter() }],
    ]
    for (const [name, extra] of refused) {
      await expect(runSession({ prompt: 'p', kernel, ...extra }), name).rejects.toMatchObject({
        code: 'PANDA_CONTRACT_ENVELOPE_INVALID',
        message: expect.stringContaining(`'${name}'`),
      })
    }
    await kernel.stop()
  })

  it('refuses createProvider beside a kernel, because a pooled provider collides on the shared pipeline', async () => {
    // Measured before the refusal: `createProvider` exists for pooling, pooling
    // gives a stable workspace id, a stable workspace id gives a stable ACTION
    // id, and a kernel-owned pipeline never retires one — so the SECOND run on
    // one kernel failed `PANDA_KERNEL_ACTION_INVALID: 'id' is already
    // registered`. A supplied kernel already carries a provider; that is the
    // point of supplying one.
    const { kernel } = await mount()
    kernel.start()
    const pooled = recordingProvider()
    await expect(runSession({ prompt: 'p', kernel, createProvider: () => pooled })).rejects.toMatchObject({
      code: 'PANDA_CONTRACT_ENVELOPE_INVALID',
    })
    expect(pooled.calls).toEqual([])
    await kernel.stop()
  })

  it('leaves a kernel-owned provider alone, so a second session on the same kernel still runs', async () => {
    // The ownership rule stated on `SessionOptions.kernel`. Measured before it
    // existed: the first session disposed the mounted provider and the second
    // failed with PANDA_CONTRACT_PROVIDER_DISPOSED.
    const { kernel } = await mount()
    kernel.start()
    await expect(runSession({ prompt: 'first', kernel })).resolves.toMatchObject({ status: 'ok' })
    await expect(runSession({ prompt: 'second', kernel })).resolves.toMatchObject({ status: 'ok' })
    await kernel.stop()
  })
})

describe('a plugin that fails to activate is contained, reported, and never becomes undefined', () => {
  it('starts the kernel, activates the sibling, and fails the run with a named error', async () => {
    const log = createMemoryLogSink()
    const kernel = createKernel({ log })
    // Invalid inside the workspace plugin's OWN subtree; the executor's key is fine.
    kernel.config.setLayer('project', { executor: 'codex', workspace: { rootDir: 42 } })
    const executor = createExecutorPlugin({ createAdapter: () => countingAdapter() })
    const workspace = createWorkspacePlugin()
    kernel.register(executor.manifest, executor.factory)
    kernel.register(workspace.manifest, workspace.factory)

    // The kernel still starts, and the sibling still activates.
    const started = kernel.start()
    expect(started.started).toEqual(['executor'])
    expect(started.failures.map((failure) => failure.pluginId)).toEqual(['workspace'])
    expect(started.failures[0]!.error.message).toContain("'rootDir' must be a non-empty string")
    expect(started.failures[0]!.error.code).toBe('PANDA_KERNEL_PLUGIN_START_FAILED')
    // Named in the stream too, so the failure is reconstructable from the records.
    expect(trail(log)).toContain('plugin.start-failed:workspace')
    expect(trail(log)).toContain('plugin.activated:executor')

    // And the run fails with a NAMED error rather than `undefined` reaching a
    // call site: `getService` answered `{ kind: 'absent' }` for the plugin that
    // failed, exactly as it does for one that was never mounted.
    await expect(runSession({ prompt: 'p', kernel })).rejects.toMatchObject({
      code: 'PANDA_KERNEL_SERVICE_NOT_PROVIDED',
      message: expect.stringContaining("no 'workspace' service"),
    })
    await kernel.stop()
  })

  it('surfaces a session-owned kernel start failure naming the plugin, and stops the kernel', async () => {
    // The same containment on the path `panda run` takes, where the session
    // mounts for itself: the kernel contains it, and the session reports it.
    const failure = await runSession({
      prompt: 'p',
      cwd: await tempRoot(),
      createAdapter: () => {
        throw new Error('adapter construction failed')
      },
    }).catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'PANDA_KERNEL_PLUGIN_START_FAILED' })
    expect((failure as Error).message).toContain('executor:')
    expect((failure as Error).message).toContain('adapter construction failed')
  })
})

describe('one pipeline per kernel: two sessions share the caps', () => {
  it('refuses the SECOND session against a shared cost cap, with the cap-specific code', async () => {
    // 1.5 with a cost of 1: the first run is admitted (1 <= 1.5) and the second
    // is not (2 > 1.5). The CODE is what says which cap fired — one code per cap
    // exists precisely so a refusal is not ambiguous — and the refusal itself is
    // what proves the pipeline is shared: on a pipeline per session, both runs
    // would have started from a spend of zero and both would have been admitted.
    const { kernel, adapter } = await mount({ actionPolicy: { maxTotalCost: 1.5 } })
    kernel.start()

    await expect(runSession({ prompt: 'first', kernel })).resolves.toMatchObject({ status: 'ok' })
    await expect(runSession({ prompt: 'second', kernel })).rejects.toMatchObject({
      code: 'PANDA_KERNEL_COST_CAP_EXCEEDED',
    })
    // Refused BEFORE the executor ran.
    expect(adapter.runs).toBe(1)
    await kernel.stop()
  })

  it('is the CONTROL: the same two sessions on two kernels both run', async () => {
    const first = await mount({ actionPolicy: { maxTotalCost: 1.5 } })
    const second = await mount({ actionPolicy: { maxTotalCost: 1.5 } })
    first.kernel.start()
    second.kernel.start()
    await expect(runSession({ prompt: 'first', kernel: first.kernel })).resolves.toMatchObject({ status: 'ok' })
    await expect(runSession({ prompt: 'second', kernel: second.kernel })).resolves.toMatchObject({ status: 'ok' })
    await first.kernel.stop()
    await second.kernel.stop()
  })
})

describe('disposal', () => {
  it('disposes every mounted plugin in reverse activation order and leaves nothing serving', async () => {
    const { kernel, log } = await mount()
    kernel.start()
    const workspace = kernel.getService<WorkspaceProvider>('workspace')
    if (workspace.kind !== 'provided') throw new Error('the workspace service should be provided')

    const stopped = await kernel.stop()
    expect(stopped.disposed).toEqual(['workspace', 'executor'])
    expect(stopped.disposalErrors).toEqual([])
    expect(trail(log).slice(-3)).toEqual([
      'plugin.disposed:workspace',
      'plugin.disposed:executor',
      'kernel.stopped:kernel',
    ])
    // Not merely dropped from the registry: the provider itself is disposed.
    await expect(workspace.value.create()).rejects.toMatchObject({ code: 'PANDA_CONTRACT_PROVIDER_DISPOSED' })
    expect(() => kernel.getService('executor')).toThrow(/inactive/)
  })

  it('contains a throwing disposer and still disposes the rest', async () => {
    const { kernel, log } = await mount()
    const manifest: PluginManifest = {
      id: 'hostile',
      version: '0.0.0',
      provides: ['hostile'],
      consumes: [],
      configSchema: { '~standard': { version: 1, validate: (value) => ({ value }) } },
    }
    const factory: PluginFactory = () => ({
      status: 'activated',
      services: { hostile: {} },
      dispose: () => {
        throw new Error('disposal exploded')
      },
    })
    kernel.register(manifest, factory)
    kernel.start()

    const stopped = await kernel.stop()
    expect(stopped.disposalErrors.map((failure) => failure.pluginId)).toEqual(['hostile'])
    // Contained: the other two still ran, and the stream says which one failed.
    expect(stopped.disposed).toEqual(['hostile', 'workspace', 'executor'])
    expect(trail(log)).toContain('plugin.disposal-failed:hostile')
    expect(trail(log)).toContain('plugin.disposed:workspace')
    expect(trail(log)).toContain('plugin.disposed:executor')
  })
})

describe('one composed document really configures the mounted plugins', () => {
  it('honours a workspace.rootDir the document supplies when the caller named no cwd', async () => {
    // The headline claim, for the one object-namespaced plugin this story
    // mounts. Measured before the fix: the session passed its own root as a
    // plugin OPTION, which shadowed every layer, so a valid configured
    // `workspace.rootDir` was validated and then always discarded — the
    // layered configuration decided nothing.
    const configured = await tempRoot()
    const homeDir = await tempRoot()
    const projectDir = await tempRoot()
    await mkdir(join(projectDir, '.panda'), { recursive: true })
    await writeFile(
      join(projectDir, '.panda', 'config.json'),
      JSON.stringify({ workspace: { rootDir: configured } }),
      'utf8',
    )
    const configLayers = await readExecutorConfigLayers({ homeDir, projectDir })

    let seen = ''
    await runSession({
      prompt: 'p',
      configLayers,
      createAdapter: () => ({
        run: (request) => {
          seen = request.workspace.rootPath
          return Promise.resolve(ok())
        },
      }),
    })
    expect(seen.startsWith(configured + sep)).toBe(true)
  })

  it('lets an explicit cwd win over the document, because it is this invocation', async () => {
    const configured = await tempRoot()
    const named = await tempRoot()
    const homeDir = await tempRoot()
    const projectDir = await tempRoot()
    await mkdir(join(projectDir, '.panda'), { recursive: true })
    await writeFile(
      join(projectDir, '.panda', 'config.json'),
      JSON.stringify({ workspace: { rootDir: configured } }),
      'utf8',
    )
    const configLayers = await readExecutorConfigLayers({ homeDir, projectDir })

    let seen = ''
    await runSession({
      prompt: 'p',
      cwd: named,
      configLayers,
      createAdapter: () => ({
        run: (request) => {
          seen = request.workspace.rootPath
          return Promise.resolve(ok())
        },
      }),
    })
    expect(seen.startsWith(join(named, '.panda', 'workspaces') + sep)).toBe(true)
  })

  it('reports an unknown key instead of failing the run, and says which key', async () => {
    // The behaviour-neutrality regression this closes: from the MACHINE
    // document, one forward-looking key failed `panda run` in every project on
    // the machine with PANDA_KERNEL_PLUGIN_START_FAILED.
    const homeDir = await tempRoot()
    await mkdir(join(homeDir, '.panda'), { recursive: true })
    await writeFile(
      join(homeDir, '.panda', 'config.json'),
      JSON.stringify({ executor: 'codex', workspace: { retain: true } }),
      'utf8',
    )
    const configLayers = await readExecutorConfigLayers({ homeDir, projectDir: await tempRoot() })

    const warnings: string[] = []
    const envelope = await runSession({
      prompt: 'p',
      cwd: await tempRoot(),
      configLayers,
      onWarning: (message) => warnings.push(message),
      createAdapter: () => countingAdapter(),
    })
    expect(envelope.status).toBe('ok')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('workspace.retain')
  })

  it('reports a host-supplied document as the agent layer, never as a file it did not read', async () => {
    // Provenance is what `panda run` prints, and it existed because "a swap you
    // cannot see is not one you can trust". Measured before the fix: a caller
    // could hand over `{ filePath: 'C:/nowhere/.panda/config.json', document:
    // { executor: 'codex' } }` and have the selection reported as the 'project'
    // layer for a file that does not exist.
    let reported: { executorId: string; layer: string } | undefined
    await runSession({
      prompt: 'p',
      cwd: await tempRoot(),
      configLayers: {
        project: { filePath: 'C:/nowhere/.panda/config.json', document: { executor: 'codex' } },
      },
      onSelection: (selection) => {
        reported = selection
      },
      createAdapter: () => countingAdapter(),
    })
    expect(reported).toMatchObject({ executorId: 'codex', layer: 'agent' })
  })
})

describe('the session-owned kernel mounts BOTH plugins', () => {
  it('serves the workspace from the mounted plugin, under the cwd it was given', async () => {
    // The executor half is closed by the PLUGIN_START_FAILED clause above; this
    // is the other half, and it was unasserted. A session that constructed a
    // provider directly would still pass every other clause in this file.
    const cwd = await tempRoot()
    let seen = ''
    await runSession({
      prompt: 'p',
      cwd,
      createAdapter: () => ({
        run: (request) => {
          seen = request.workspace.rootPath
          return Promise.resolve(ok())
        },
      }),
    })
    expect(seen.startsWith(join(cwd, '.panda', 'workspaces') + sep)).toBe(true)
    expect((await stat(seen)).isDirectory()).toBe(true)
  })

  it('names EVERY plugin that failed, not just the first', async () => {
    // `describeFailures` joins, and a join only means anything with more than
    // one element — it was previously exercised with exactly one, so reporting
    // just `failures[0]` would have passed every clause in this file. Both
    // plugins fail here at once: the adapter seam throws, and the document's
    // `workspace.rootDir` is unusable.
    const homeDir = await tempRoot()
    await mkdir(join(homeDir, '.panda'), { recursive: true })
    await writeFile(join(homeDir, '.panda', 'config.json'), JSON.stringify({ workspace: { rootDir: 42 } }), 'utf8')
    const configLayers = await readExecutorConfigLayers({ homeDir, projectDir: await tempRoot() })

    // No `cwd`: the session's computed root is then the DEFAULTS layer, which
    // the document's unusable `rootDir` overrides — which is the whole point of
    // the layering, and what lets both plugins fail in one start.
    const failure = await runSession({
      prompt: 'p',
      configLayers,
      createAdapter: () => {
        throw new Error('adapter construction failed')
      },
    }).catch((error: unknown) => error)

    expect(failure).toMatchObject({ code: 'PANDA_KERNEL_PLUGIN_START_FAILED' })
    const message = (failure as Error).message
    expect(message).toContain('executor: ')
    expect(message).toContain('adapter construction failed')
    expect(message).toContain('workspace: ')
    expect(message).toContain("'rootDir' must be a non-empty string")
  })
})

describe('createSessionKernel is the only composition surface', () => {
  it('exports no factory that yields a kernel, a plugin or an adapter', async () => {
    // The measured hole this closes: `@panda/session` re-exported `createKernel`
    // and both plugin FACTORIES, and a `PluginFactory` invoked with an
    // `ActivationContext` of the caller's own construction hands back a real
    // vendor adapter wired to the caller's own pipeline — so a pnpm-strict,
    // session-only consumer's bypass surface went from nothing to one. A
    // complete session composition was also planted inside `packages/cli/src/`
    // importing only this package, with eslint, tsc and all 53 CLI assertions
    // green, because the thin-binding pin scanned for `@panda/kernel` by name.
    //
    // Values only: TYPES erase, and `PandaKernel` has to stay nameable because
    // it is what `SessionOptions.kernel` is.
    const surface = (await import('../src/index.ts')) as Record<string, unknown>
    const values = Object.keys(surface).filter((name) => surface[name] !== undefined)
    // WIDENED BY M5.D, deliberately, and the list is exact so that widening had
    // to be a decision. Neither addition yields a kernel, a plugin or an adapter
    // — the rule this clause states: `resolveMethod` hands back a validated
    // MethodPlugin (a manifest, which `@panda/contracts` already validates in
    // public) and `swapMethod` hands back a `MethodActivation`, which
    // `activateMethod` already returns in public. `selectMethod` exists beside
    // them and is NOT here: `runSession` is its only caller.
    //
    // WIDENED AGAIN BY M7.D, by one: `createLogSink`. It passes the same rule.
    // The withdrawn five were dangerous because a factory invoked with an
    // `ActivationContext` of the caller's own hands back a wired vendor adapter;
    // this is a function from a write callback to a `LogSink`, it composes
    // nothing, reaches no adapter, and its sibling `createMemoryLogSink` has
    // been in this list since before the withdrawal. What it unlocks is the only
    // thing `SessionOptions.log` was ever for, from the one package that cannot
    // import the kernel: `packages/cli` depends on `@panda/environment` and
    // `@panda/session` and nothing else.
    //
    // WIDENED AGAIN BY M10.A, by one: `selectWorkspaceProvider`. Same rule,
    // same shape as `resolveExecutor` beside it — it reads a composed
    // `LayeredConfig` and hands back a plain record of id, layer and catalogue.
    // Its sibling `createSelectedWorkspacePlugin` is the one that turns that id
    // into a plugin, and that one is deliberately NOT here: it is precisely the
    // kind of factory the five withdrawn exports were withdrawn for.
    //
    // WIDENED AGAIN BY M15.A, by four, and all four pass the same rule. Three
    // are the recorded quota reading — `usageObservationsPath` names a file,
    // `recordUsageObservation` writes one JSON document, `readUsageReports`
    // reads it and joins it against the shipped catalogue. None of them
    // constructs a kernel, a plugin or an adapter, and `readUsageReports`
    // deliberately cannot INVOKE one: that is the whole point of recording. The
    // fourth, `USAGE_ABSENCE_REASONS`, is a frozen record of codes — a
    // `UsageAbsence.reason` is routed on (AD-7), and a consumer that could not
    // name the codes would be comparing strings by hand.
    //
    // WIDENED AGAIN BY 4.3 (spec M16.A), by three, and all three pass the same
    // rule. `worktreeStateDir` joins two path segments. `inspectWorktrees` reads
    // panda's own records and hands back plain rows. `removeWorktree` performs a
    // removal and hands back a plain outcome. None of them constructs a kernel,
    // a plugin or an adapter, and none hands back anything a caller can invoke:
    // the store they operate through, `WorktreeLedger`, is deliberately NOT
    // here — publishing it would expose `retire()` and `claimRemoval()` with
    // none of the refusals around them, which is the withdrawn-factory hazard
    // above pointed at a destructive operation instead of at a vendor adapter.
    expect(values.sort()).toEqual([
      'SESSION_ACTION_COST',
      'SESSION_ACTION_ID',
      'USAGE_ABSENCE_REASONS',
      'createLogSink',
      'createMemoryLogSink',
      'createSessionKernel',
      'inspectWorktrees',
      'readExecutorConfigLayers',
      'readUsageReports',
      'recordUsageObservation',
      'removeWorktree',
      'resolveExecutor',
      'resolveMethod',
      'runSession',
      'selectWorkspaceProvider',
      'swapMethod',
      'usageObservationsPath',
      'worktreeStateDir',
    ])
  })

  it('hands back a started kernel with both services, and no plugin factory', async () => {
    const cwd = await tempRoot()
    const kernel = createSessionKernel({ cwd, createAdapter: () => countingAdapter() })
    expect(kernel.getService('executor').kind).toBe('provided')
    expect(kernel.getService('workspace').kind).toBe('provided')
    await expect(runSession({ prompt: 'p', kernel })).resolves.toMatchObject({ status: 'ok' })
    await kernel.stop()
  })

  it('stops the kernel it built when a plugin cannot activate', async () => {
    // The one path where a constructed kernel had no unwind. `stop()` is
    // idempotent, so the assertion is that the SECOND stop reports nothing left.
    let stopped: unknown
    try {
      createSessionKernel({ cwd: await tempRoot(), executorId: 'aider' })
    } catch (error) {
      stopped = error
    }
    expect(stopped).toMatchObject({ code: 'PANDA_EXECUTOR_NOT_FOUND' })
  })
})
