import { createKernel } from '@panda/kernel'
import type { PluginManifest, StandardSchemaResult } from '@panda/kernel'
import { EXECUTOR_CONFIG_KEY, createExecutorPlugin } from '@panda/adapter-cli'
import { describe, expect, it } from 'vitest'
import { WORKSPACE_CONFIG_KEY } from '@panda/workspace-local'
import { availableWorkspaceProviderIds, createSelectedWorkspacePlugin } from '../src/workspaces.ts'

// THE GATE for a rule that had lived only in a comment: a plugin's `manifest.id`
// IS the key its configuration lives under.
//
// Since M7.C the kernel validates `composed[manifest.id]` against the manifest's
// own `configSchema` and hands the result to the factory as `context.settings`.
// A plugin that registers under anything else is therefore handed `undefined`
// forever: its schema is never applied to one real value, and nothing fails.
// `@panda/workspace-git-worktree` did exactly that for two milestones —
// `manifest.id` `workspace-git-worktree`, config key `workspace` — while its
// sibling `@panda/workspace-local` (id and key both `workspace`) received the
// real subtree. No test saw it, because both factories happened to re-validate
// the subtree themselves and so no user-visible behaviour differed.
//
// This asserts the guarantee BEHAVIOURALLY rather than by string equality: it
// seeds a marked value at each plugin's config key, drives a real kernel, and
// reads what the kernel actually handed that plugin's schema. A gate comparing
// two constants would pass for a plugin whose factory read a third key.

/** Seeded at each plugin's config key; nothing else in the document has it. */
const MARKER = 'panda-config-key-gate'

interface Probe {
  readonly manifest: PluginManifest
  /** Every value the KERNEL passed to this manifest's schema, in order. */
  readonly kernelSaw: unknown[]
}

/**
 * The same manifest with its `configSchema` wrapped so the values the KERNEL
 * validates are recorded.
 *
 * The wrapper replaces the schema on the MANIFEST only. A factory that reaches
 * its schema constant directly — both workspace factories read the raw document
 * for their warnings — bypasses this, which is the point: the recording must be
 * of the kernel's calls and no one else's.
 */
function probe(manifest: PluginManifest): Probe {
  const kernelSaw: unknown[] = []
  const inner = manifest.configSchema['~standard'].validate
  return {
    kernelSaw,
    manifest: {
      ...manifest,
      configSchema: {
        '~standard': {
          version: 1,
          validate: (value: unknown): StandardSchemaResult => {
            kernelSaw.push(value)
            return inner(value) as StandardSchemaResult
          },
        },
      },
    },
  }
}

/**
 * What the kernel handed this plugin's schema for the composed DOCUMENT, as
 * opposed to for the registration probe.
 *
 * `validateManifest` calls the schema with a private symbol at registration to
 * check its shape, so the recorded calls always open with symbols. Filtering
 * them by type rather than by position keeps this readable if the number of
 * registration probes ever changes.
 */
function documentValue(kernelSaw: readonly unknown[]): unknown {
  const fromDocument = kernelSaw.filter((value) => typeof value !== 'symbol')
  expect(
    fromDocument,
    'the kernel validates the composed subtree exactly once per activation',
  ).toHaveLength(1)
  return fromDocument[0]
}

function activate(manifest: PluginManifest, factory: Parameters<ReturnType<typeof createKernel>['register']>[1], document: unknown): void {
  const kernel = createKernel()
  kernel.config.setLayer('project', document)
  kernel.register(manifest, factory)
  kernel.start()
}

/**
 * Every plugin `run-session` mounts, paired with the config key its factory
 * reads.
 *
 * Built out of `WORKSPACE_PROVIDER_CATALOGUE`'s own accessors rather than a hand
 * list, for the reason that catalogue states about itself: an id cannot exist
 * without a factory here either, so a provider added later is covered without
 * anyone remembering to add it.
 */
const MOUNTED: readonly { readonly label: string; readonly configKey: string; readonly build: () => { manifest: PluginManifest; factory: Parameters<ReturnType<typeof createKernel>['register']>[1] } }[] = [
  {
    label: 'adapter-cli executor',
    configKey: EXECUTOR_CONFIG_KEY,
    build: () => createExecutorPlugin(),
  },
  ...availableWorkspaceProviderIds().map((providerId) => ({
    label: `workspace provider '${providerId}'`,
    configKey: WORKSPACE_CONFIG_KEY,
    build: () => createSelectedWorkspacePlugin(providerId, { repoPath: process.cwd() }),
  })),
]

describe('every mounted plugin registers under the config key it reads', () => {
  it.each(MOUNTED)('$label', ({ configKey, build }) => {
    const built = build()
    const probed = probe(built.manifest)
    // The marker lives at the plugin's own key and nowhere else, so a plugin
    // registered under a different id cannot reach it by accident.
    activate(probed.manifest, built.factory, { [configKey]: MARKER })
    expect(
      documentValue(probed.kernelSaw),
      `the kernel validated 'composed.${built.manifest.id}' but this plugin reads '${configKey}'; a plugin whose id is not its config key is handed undefined forever and its configSchema is never applied to a real value`,
    ).toBe(MARKER)
  })

  it('would catch a plugin whose id is not its config key', () => {
    // THE CONTROL. Without it a green row above could mean "the probe never
    // fires" rather than "the id matches the key" — and this exact defect
    // shipped twice while every suite stayed green.
    const built = createExecutorPlugin()
    const misKeyed = probe({ ...built.manifest, id: 'not-the-config-key' })
    activate(misKeyed.manifest, built.factory, { [EXECUTOR_CONFIG_KEY]: MARKER })
    expect(documentValue(misKeyed.kernelSaw)).toBeUndefined()
  })
})
