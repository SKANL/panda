import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createKernel } from '@panda/kernel'
import type { ResultEnvelope, RunRequest, WorkspaceHandle } from '@panda/contracts'
import { createExecutorPlugin, EXECUTOR_SERVICE } from '../src/index.ts'
import type { ExecutorService } from '../src/index.ts'
import { FakeSpawner } from './fake-spawner.ts'

// The executor adapter as a real kernel plugin (Story M3.B): a manifest, a
// config schema over its own key of the kernel's layered configuration, a
// factory and a disposer — the shape `@panda/registry`'s plugin established.

const WORKSPACE: WorkspaceHandle = Object.freeze({
  id: 'ws-plugin',
  rootPath: join(tmpdir(), 'panda-executor-plugin'),
  capabilities: Object.freeze(['read', 'write'] as const),
})

function request(prompt = 'list files'): RunRequest {
  return { prompt, workspace: WORKSPACE }
}

// One stdout line every vendor's trait record parses as a successful result, so
// a test can swap WHICH executor is configured without swapping its fixture too.
const ANY_VENDOR_STDOUT = `${JSON.stringify({
  result: 'done',
  type: 'text',
  part: { type: 'text', text: 'done' },
  item: { type: 'agent_message', text: 'done' },
})}
`

function spawner(): FakeSpawner {
  return new FakeSpawner({ exitCode: 0, stdout: ANY_VENDOR_STDOUT, stderr: '' })
}

function service(kernel: ReturnType<typeof createKernel>): ExecutorService {
  const resolved = kernel.getService<ExecutorService>(EXECUTOR_SERVICE)
  if (resolved.kind !== 'provided') throw new Error(`the '${EXECUTOR_SERVICE}' service should be provided`)
  return resolved.value
}

describe('the executor adapter as a kernel plugin', () => {
  it('activates, drives the executor its OWN config key names, and disposes', async () => {
    const fake = spawner()
    const kernel = createKernel()
    // The plugin's subtree is the top-level `executor` key — the same one
    // `.panda/config.json` already spells — so one document configures both.
    kernel.config.setLayer('project', { executor: 'codex', someOtherPlugin: { anything: true } })
    const plugin = createExecutorPlugin({ adapterOptions: { spawner: fake } })
    kernel.register(plugin.manifest, plugin.factory)

    const started = kernel.start()
    expect(started.started).toEqual(['executor'])
    expect(started.failures).toHaveLength(0)
    expect(service(kernel).executorId).toBe('codex')

    const envelope = await service(kernel).run('executor-plugin#one', request())
    expect(envelope.status).toBe('ok')
    expect(fake.children.map((child) => child.command)).toEqual(['codex'])

    const stopped = await kernel.stop()
    expect(stopped.disposed).toEqual(['executor'])
    expect(stopped.disposalErrors).toEqual([])
  })

  it('runs panda default when its key is absent, and the LAYER decides when it is not', async () => {
    for (const [layerValue, expected] of [
      [undefined, 'claude-code'],
      ['opencode', 'opencode'],
    ] as const) {
      const fake = spawner()
      const kernel = createKernel()
      if (layerValue !== undefined) kernel.config.setLayer('global', { executor: layerValue })
      const plugin = createExecutorPlugin({ adapterOptions: { spawner: fake } })
      kernel.register(plugin.manifest, plugin.factory)
      kernel.start()
      expect(service(kernel).executorId).toBe(expected)
      await kernel.stop()
    }
  })

  it('rejects activation for an executor its catalogue does not hold, without taking the kernel down', () => {
    const kernel = createKernel()
    kernel.config.setLayer('project', { executor: 'aider' })
    const plugin = createExecutorPlugin()
    kernel.register(plugin.manifest, plugin.factory)

    const started = kernel.start()
    expect(started.started).toEqual([])
    expect(started.failures.map((failure) => failure.pluginId)).toEqual(['executor'])
    const message = started.failures[0]!.error.message
    expect(message).toContain("panda has no adapter named 'aider'")
    expect(message).toContain('available executors: claude-code, codex, opencode')
    // Absence stays TYPED, and since M7.B it carries WHY: the adapter plugin is
    // registered and its activation was rejected, which reads differently from a
    // service no plugin provides.
    expect(kernel.getService(EXECUTOR_SERVICE)).toEqual({ kind: 'absent', reason: 'provider-failed' })
  })

  it('rejects activation for a config key of the wrong type, naming what it wanted', () => {
    const kernel = createKernel()
    kernel.config.setLayer('project', { executor: 7 })
    const plugin = createExecutorPlugin()
    kernel.register(plugin.manifest, plugin.factory)
    const started = kernel.start()
    expect(started.failures[0]?.error.message).toContain(
      "'executor' must be a string naming one of: claude-code, codex, opencode",
    )
  })

  it('routes every run through the KERNEL pipeline, so a cap refuses before the executor spawns', async () => {
    const fake = spawner()
    // A cost cap, not a count: the code is what tells the two apart, and the
    // pipeline is the kernel's, so this cap covers everything mounted on it.
    const kernel = createKernel({ actionPolicy: { maxTotalCost: 1.5 } })
    const plugin = createExecutorPlugin({ adapterOptions: { spawner: fake }, cost: 1 })
    kernel.register(plugin.manifest, plugin.factory)
    kernel.start()

    await expect(service(kernel).run('executor-plugin#first', request())).resolves.toMatchObject({ status: 'ok' })
    await expect(service(kernel).run('executor-plugin#second', request())).rejects.toMatchObject({
      code: 'PANDA_KERNEL_COST_CAP_EXCEEDED',
    })
    // Refused BEFORE the executor ran: one child, not two.
    expect(fake.children).toHaveLength(1)
    await kernel.stop()
  })

  it('hands back a runner, never the adapter, so the container exposes no way around the waterfall', () => {
    const kernel = createKernel()
    const plugin = createExecutorPlugin({ adapterOptions: { spawner: spawner() } })
    kernel.register(plugin.manifest, plugin.factory)
    kernel.start()

    const resolved = service(kernel) as unknown as Record<string, unknown>
    // The service's whole surface, OWN and inherited, enumerable and not. An
    // `ExecutorAdapter` would carry `run(request)` and let any holder of the
    // kernel spawn with no budget, no guard and no record; a non-enumerable or
    // prototype-carried slot would hide one from `Object.keys` alone.
    expect(Object.getOwnPropertyNames(resolved).sort()).toEqual(['executorId', 'run'])
    expect(Object.getOwnPropertySymbols(resolved)).toEqual([])
    expect(Object.getPrototypeOf(resolved)).toBe(Object.prototype)
    expect(resolved['adapter']).toBeUndefined()
    // And its `run` is not the port's: it takes the action id the record stream
    // will carry, so an invocation cannot exist without a subject.
    expect((resolved['run'] as (...args: unknown[]) => unknown).length).toBe(2)
    void kernel.stop()
  })

  it('is FROZEN, so a kernel holder cannot take other callers off the waterfall', async () => {
    // Measured before the freeze: `getService` hands every caller the same
    // object, so overwriting `run` on it took three runs past a cap of 1 with an
    // empty record stream. The pipeline freezes its handle and its descriptor
    // for exactly this reason; the service guarding the executor now does too.
    const fake = spawner()
    const kernel = createKernel({ actionPolicy: { maxInvocations: 1 } })
    const plugin = createExecutorPlugin({ adapterOptions: { spawner: fake } })
    kernel.register(plugin.manifest, plugin.factory)
    kernel.start()

    const target = service(kernel) as unknown as Record<string, unknown>
    expect(Object.isFrozen(target)).toBe(true)
    expect(() => {
      'use strict'
      target['run'] = () => Promise.resolve({ status: 'ok', data: null, summary: 'bypassed', errors: [] })
    }).toThrow(TypeError)
    // And the cap still bites, because `run` is still the pipeline's.
    await expect(service(kernel).run('frozen#one', request())).resolves.toMatchObject({ status: 'ok' })
    await expect(service(kernel).run('frozen#two', request())).rejects.toMatchObject({
      code: 'PANDA_KERNEL_INVOCATION_CAP_EXCEEDED',
    })
    await kernel.stop()
  })

  it('reads its cost ONCE, at construction, so the options object cannot re-price a run', async () => {
    // `createActionPipeline` states the discipline verbatim — "a budget a caller
    // can raise after construction by mutating the object it handed in is not a
    // budget". Measured before the fix: mutating `cost` to 0 between
    // `createExecutorPlugin(...)` and `kernel.start()` priced the run at 0 and
    // walked through a 0.5 cap.
    const mutable = { adapterOptions: { spawner: spawner() }, cost: 1 }
    const plugin = createExecutorPlugin(mutable)
    mutable.cost = 0

    const kernel = createKernel({ actionPolicy: { maxTotalCost: 0.5 } })
    kernel.register(plugin.manifest, plugin.factory)
    kernel.start()
    await expect(service(kernel).run('priced#one', request())).rejects.toMatchObject({
      code: 'PANDA_KERNEL_COST_CAP_EXCEEDED',
    })
    await kernel.stop()
  })

  it('refuses to run through a handle kept past disposal, with a coded error naming the service', async () => {
    const kernel = createKernel()
    const plugin = createExecutorPlugin({ adapterOptions: { spawner: spawner() } })
    kernel.register(plugin.manifest, plugin.factory)
    kernel.start()
    const kept = service(kernel)
    await kernel.stop()

    await expect(kept.run('executor-plugin#after-stop', request())).rejects.toMatchObject({
      code: 'PANDA_KERNEL_PLUGIN_INACTIVE',
    })
  })

  it('contains a throwing adapter seam as a start failure instead of an exception out of start()', () => {
    const kernel = createKernel()
    const plugin = createExecutorPlugin({
      createAdapter: () => {
        throw new Error('adapter construction failed')
      },
    })
    kernel.register(plugin.manifest, plugin.factory)
    const started = kernel.start()
    expect(started.failures[0]?.error.message).toContain('adapter construction failed')
  })

  it('lets an injected adapter win over the configured id, and still meters it', async () => {
    const fake = spawner()
    const runs: RunRequest[] = []
    const injected: ResultEnvelope = { status: 'ok', data: null, summary: 'injected', errors: [] }
    const kernel = createKernel()
    kernel.config.setLayer('project', { executor: 'codex' })
    const plugin = createExecutorPlugin({
      adapterOptions: { spawner: fake },
      createAdapter: () => ({
        run: (received) => {
          runs.push(received)
          return Promise.resolve(injected)
        },
      }),
    })
    kernel.register(plugin.manifest, plugin.factory)
    kernel.start()

    await expect(service(kernel).run('executor-plugin#injected', request())).resolves.toEqual(injected)
    expect(runs).toHaveLength(1)
    // Nothing from the catalogue reached a command line.
    expect(fake.children).toEqual([])
    await kernel.stop()
  })
})
