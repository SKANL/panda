import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createKernel } from '@skanl/panda-kernel'
import type { WorkspaceProvider } from '@skanl/panda-contracts'
import {
  createWorkspacePlugin,
  WORKSPACE_CONFIG_WARNING_EVENT,
  WORKSPACE_SERVICE,
  type WorkspaceConfigWarning,
} from '../src/index.ts'

// The local workspace provider as a real kernel plugin (Story M3.B): a manifest,
// a config schema over its own `workspace` subtree, a factory and a disposer.

const roots: string[] = []
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'panda-workspace-plugin-'))
  roots.push(root)
  return root
}

function provider(kernel: ReturnType<typeof createKernel>): WorkspaceProvider {
  const resolved = kernel.getService<WorkspaceProvider>(WORKSPACE_SERVICE)
  if (resolved.kind !== 'provided') throw new Error(`the '${WORKSPACE_SERVICE}' service should be provided`)
  return resolved.value
}

/** Collects the configuration warnings the plugin emits during activation. */
function watch(kernel: ReturnType<typeof createKernel>): WorkspaceConfigWarning[] {
  const seen: WorkspaceConfigWarning[] = []
  kernel.bus.subscribe<WorkspaceConfigWarning>('global', (event) => {
    if (event.type === WORKSPACE_CONFIG_WARNING_EVENT) seen.push(event.payload)
  })
  return seen
}

describe('the local workspace provider as a kernel plugin', () => {
  it('activates from its own config subtree and serves workspaces under the configured root', async () => {
    const rootDir = await tempRoot()
    const kernel = createKernel()
    // Other plugins' subtrees coexist; only this plugin's namespace is read.
    kernel.config.setLayer('project', { executor: 'codex', workspace: { rootDir } })
    const plugin = createWorkspacePlugin()
    kernel.register(plugin.manifest, plugin.factory)

    expect(kernel.start()).toMatchObject({ started: ['workspace'], failures: [] })
    const handle = await provider(kernel).create()
    expect(handle.rootPath.startsWith(rootDir + sep)).toBe(true)
    expect((await stat(handle.rootPath)).isDirectory()).toBe(true)
    await provider(kernel).release(handle)
    await kernel.stop()
  })

  it('lets the CONFIGURED rootDir win over the mount-time fallback', async () => {
    // Corrected on review, and it is the whole point of "one composed document
    // configures the plugins": the option used to override the document
    // unconditionally, so a valid `workspace.rootDir` was validated and then
    // always discarded — a layered configuration that decided nothing.
    const configured = await tempRoot()
    const fallback = await tempRoot()
    const kernel = createKernel()
    kernel.config.setLayer('project', { workspace: { rootDir: configured } })
    const plugin = createWorkspacePlugin({ rootDir: fallback })
    kernel.register(plugin.manifest, plugin.factory)
    kernel.start()

    const handle = await provider(kernel).create()
    expect(handle.rootPath.startsWith(configured + sep)).toBe(true)
    await kernel.stop()
  })

  it('falls back to the mount-time rootDir when no layer supplies one', async () => {
    const fallback = await tempRoot()
    const kernel = createKernel()
    const plugin = createWorkspacePlugin({ rootDir: fallback })
    kernel.register(plugin.manifest, plugin.factory)
    kernel.start()

    const handle = await provider(kernel).create()
    expect(handle.rootPath.startsWith(fallback + sep)).toBe(true)
    await kernel.stop()
  })

  it('rejects activation rather than guessing a directory when nothing supplies one', () => {
    const kernel = createKernel()
    const plugin = createWorkspacePlugin()
    kernel.register(plugin.manifest, plugin.factory)

    const started = kernel.start()
    expect(started.started).toEqual([])
    expect(started.failures.map((failure) => failure.pluginId)).toEqual(['workspace'])
    expect(started.failures[0]!.error.message).toContain("'workspace.rootDir' is required")
    // Typed absence, never undefined — and since M7.B it says WHICH absence.
    // This is the scenario the discriminant exists for: the provider is
    // registered and its activation was rejected, which a consumer must be able
    // to tell apart from a service nothing provides at all.
    expect(kernel.getService(WORKSPACE_SERVICE)).toEqual({ kind: 'absent', reason: 'provider-failed' })
  })

  it('REPORTS an unknown key on the bus and keeps serving', async () => {
    // The measured regression this closes: `{"workspace":{"retain":true}}` in
    // the MACHINE document turned `panda run` from exit 0 with an envelope into
    // exit 2 with PANDA_KERNEL_PLUGIN_START_FAILED, in every project on the
    // machine. The document is user-authored and panda never writes it, so one
    // forward-looking key must not be fatal — but silence would hide a typo.
    const rootDir = await tempRoot()
    const kernel = createKernel()
    kernel.config.setLayer('global', { workspace: { rootDir, retain: true, rootDr: 'typo' } })
    const warnings = watch(kernel)
    const plugin = createWorkspacePlugin()
    kernel.register(plugin.manifest, plugin.factory)

    expect(kernel.start()).toMatchObject({ started: ['workspace'], failures: [] })
    expect(warnings.map((warning) => warning.key).sort()).toEqual(['workspace.retain', 'workspace.rootDr'])
    expect(warnings[0]!.detail).toContain('not a workspace plugin config key')
    // And it still serves, from the key it DID understand.
    const handle = await provider(kernel).create()
    expect(handle.rootPath.startsWith(rootDir + sep)).toBe(true)
    await kernel.stop()
  })

  it('REPORTS a subtree of the wrong shape instead of ignoring it in silence', async () => {
    const fallback = await tempRoot()
    for (const subtree of ['nope', [1], null]) {
      const kernel = createKernel()
      kernel.config.setLayer('project', { workspace: subtree })
      const warnings = watch(kernel)
      const plugin = createWorkspacePlugin({ rootDir: fallback })
      kernel.register(plugin.manifest, plugin.factory)

      expect(kernel.start().started, JSON.stringify(subtree)).toEqual(['workspace'])
      expect(warnings.map((warning) => warning.key)).toEqual(['workspace'])
      expect(warnings[0]!.detail).toContain('must be an object')
      await kernel.stop()
    }
  })

  it('still REJECTS a rootDir it cannot use, because there is then nothing to serve', () => {
    const kernel = createKernel()
    kernel.config.setLayer('project', { workspace: { rootDir: 42 } })
    const plugin = createWorkspacePlugin()
    kernel.register(plugin.manifest, plugin.factory)
    expect(kernel.start().failures[0]!.error.message).toContain("'rootDir' must be a non-empty string")
  })

  it('reads its mount-time options ONCE, at construction', async () => {
    // The discipline `createActionPipeline` states verbatim. A live read let a
    // caller change the directory between `createWorkspacePlugin(...)` and
    // `kernel.start()`.
    const agreed = await tempRoot()
    const swapped = await tempRoot()
    const mutable = { rootDir: agreed }
    const plugin = createWorkspacePlugin(mutable)
    mutable.rootDir = swapped

    const kernel = createKernel()
    kernel.register(plugin.manifest, plugin.factory)
    kernel.start()
    const handle = await provider(kernel).create()
    expect(handle.rootPath.startsWith(agreed + sep)).toBe(true)
    await kernel.stop()
  })

  it('is disposed BY THE KERNEL at stop, so its lifetime belongs to whoever mounted it', async () => {
    const rootDir = await tempRoot()
    const kernel = createKernel()
    kernel.config.setLayer('project', { workspace: { rootDir } })
    const plugin = createWorkspacePlugin()
    kernel.register(plugin.manifest, plugin.factory)
    kernel.start()
    const kept = provider(kernel)

    const stopped = await kernel.stop()
    expect(stopped.disposed).toEqual(['workspace'])
    expect(stopped.disposalErrors).toEqual([])
    // The provider itself is disposed, not merely dropped from the registry: a
    // handle kept past stop() cannot still create directories.
    await expect(kept.create()).rejects.toMatchObject({ code: 'PANDA_CONTRACT_PROVIDER_DISPOSED' })
    expect(() => kernel.getService(WORKSPACE_SERVICE)).toThrow(/inactive/)
  })

  it('pins WHERE the config schema is enforced, because the manifest field does not enforce it', () => {
    // The kernel only PROBES `manifest.configSchema` for shape and never applies
    // it to the plugin's subtree — replacing it with a no-op that accepts
    // anything leaves every suite green. The enforcement point is the factory,
    // which calls the schema itself, and this is the clause that says so: a
    // factory that stopped validating fails here even though the manifest is
    // untouched. Filed in deferred-work.md as a proposed kernel fix.
    const kernel = createKernel()
    kernel.config.setLayer('project', { workspace: { rootDir: '' } })
    const plugin = createWorkspacePlugin()
    // The manifest's schema is present and well-formed...
    expect(typeof plugin.manifest.configSchema['~standard'].validate).toBe('function')
    kernel.register(plugin.manifest, plugin.factory)
    // ...and it is the FACTORY that turns a bad subtree into a contained failure.
    expect(kernel.start().failures[0]!.error.message).toContain("'rootDir' must be a non-empty string")
  })
})
