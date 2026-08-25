import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createKernel } from '@panda/kernel'
import type { StaleLockBreak } from '../src'
import { createRegistryPlugin } from '../src'
import type { RegistryStore } from '../src'

const homeDir = await mkdtemp(join(tmpdir(), 'panda-registry-plugin-home-'))
const projectDir = await mkdtemp(join(tmpdir(), 'panda-registry-plugin-project-'))
afterAll(() => {
  void rm(homeDir, { recursive: true, force: true })
  void rm(projectDir, { recursive: true, force: true })
})

function mount(orderLog: string[] = []) {
  const kernel = createKernel({ orderLog })
  const plugin = createRegistryPlugin({ homeDir, projectDir })
  kernel.register(plugin.manifest, plugin.factory)
  return kernel
}

describe('registry as a real kernel plugin', () => {
  it('activates through the normal lifecycle, serves entries, and disposes in reverse order', async () => {
    const orderLog: string[] = []
    const kernel = mount(orderLog)

    const started = kernel.start()
    expect(started.started).toEqual(['registry'])
    expect(started.failures).toHaveLength(0)
    expect(orderLog).toEqual(['activate:registry'])

    const resolution = kernel.getService<RegistryStore>('registry')
    if (resolution.kind !== 'provided') throw new Error('registry service should be provided')
    await resolution.value.register({ type: 'tool', id: 'via-kernel' }, 'project')
    expect(await resolution.value.get('tool', 'via-kernel')).toEqual({ type: 'tool', id: 'via-kernel' })

    // Disposal is honored: stop() runs the disposer and drops the service.
    await kernel.stop()
    expect(orderLog).toEqual(['activate:registry', 'dispose:registry'])
    expect(() => kernel.getService('registry')).toThrow(/inactive/)
  })

  it('fails fast when an invalid manifest is registered', () => {
    const kernel = createKernel()
    expect(() =>
      kernel.register(
        { id: 'registry', version: '0.0.0', provides: ['registry'], consumes: [] },
        () => ({ status: 'activated' }),
      ),
    ).toThrow(/configSchema/)
  })

  it('feeds store options from the registry namespace of layered configuration', async () => {
    const kernel = createKernel()
    // Other plugins' subtrees coexist; only our own namespace is read.
    kernel.config.setLayer('invocation', {
      someOtherPlugin: { anything: true },
      registry: { homeDir, projectDir },
    })
    const plugin = createRegistryPlugin()
    kernel.register(plugin.manifest, plugin.factory)
    kernel.start()

    const resolution = kernel.getService<RegistryStore>('registry')
    if (resolution.kind !== 'provided') throw new Error('registry service should be provided')
    await resolution.value.register({ type: 'skill', id: 'configured' }, 'project')
    expect(await resolution.value.get('skill', 'configured')).toEqual({
      type: 'skill',
      id: 'configured',
    })
    await kernel.stop()
  })

  it('merges explicit options OVER layered config through schema validation', async () => {
    const kernel = createKernel()
    kernel.config.setLayer('invocation', { registry: { projectDir } })
    const plugin = createRegistryPlugin({ homeDir })
    kernel.register(plugin.manifest, plugin.factory)
    kernel.start()

    const resolution = kernel.getService<RegistryStore>('registry')
    if (resolution.kind !== 'provided') throw new Error('registry service should be provided')
    await resolution.value.register({ type: 'skill', id: 'merged' }, 'project')
    expect(await resolution.value.get('skill', 'merged')).toEqual({ type: 'skill', id: 'merged' })
    await kernel.stop()
  })

  it('rejects activation for misconfiguration inside its own namespace', () => {
    const kernel = createKernel()
    kernel.config.setLayer('invocation', { registry: { lockTimeoutMs: Number.NaN, bogusKey: true } })
    const plugin = createRegistryPlugin()
    kernel.register(plugin.manifest, plugin.factory)

    const result = kernel.start()
    expect(result.started).toEqual([])
    expect(result.failures).toHaveLength(1)
    const message = result.failures[0]!.error.message
    expect(message).toContain('lockTimeoutMs')
    expect(message).toContain('bogusKey')
  })

  it('emits a bus event when a mutation breaks a stale lock', async () => {
    const kernel = mount()
    kernel.start()

    const events: StaleLockBreak[] = []
    kernel.bus.subscribe<StaleLockBreak>('global', (event) => {
      if (event.type === 'registry.lock.stale-broken') events.push(event.payload)
    })

    const resolution = kernel.getService<RegistryStore>('registry')
    if (resolution.kind !== 'provided') throw new Error('registry service should be provided')

    // A lock stranded by a provably dead pid on this host.
    const deadChild = await new Promise<number>((resolve) => {
      const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
      child.on('exit', () => resolve(child.pid!))
    })
    await mkdir(join(homeDir, '.panda'), { recursive: true })
    await writeFile(
      join(homeDir, '.panda', 'registry.json.lock'),
      JSON.stringify({
        pid: deadChild,
        host: hostname(),
        acquiredAt: new Date().toISOString(),
        token: 'stranded',
      }),
      'utf8',
    )

    await resolution.value.register({ type: 'tool', id: 'breaker' }, 'global')
    expect(events).toHaveLength(1)
    expect(events[0]!.evidence).toContain(String(deadChild))
    expect(events[0]!.holder?.pid).toBe(deadChild)

    await kernel.stop()
  })
})
