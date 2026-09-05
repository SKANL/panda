import { defineStandardSchema } from '@skanl/panda-contracts'
import type { StandardSchemaResult, WorkspaceProvider } from '@skanl/panda-contracts'
import { isNonEmptyString, isRecord, issue } from '@skanl/panda-contracts/validation'
import type { ActivationContext, PluginFactory, PluginManifest } from '@skanl/panda-kernel'
import { LocalWorkspaceProvider } from './local-workspace-provider.ts'

// The local-directory workspace provider, mounted as a kernel plugin (Story M3.B).
//
// Its service IS the port, where the executor plugin's deliberately is not, and
// the difference is what each one guards. An executor invocation is the thing
// AD-10 meters, so handing out an adapter would hand out a way around the
// budget. A workspace provider meters nothing: `create`/`acquire`/`release`/
// `dispose` ARE the contract, a wrapper would only rename them, and the contract
// test suite in `@skanl/panda-contracts` is written against the port itself. What
// mounting buys here is OWNERSHIP — the kernel disposes it at `stop()`, on every
// path, instead of each caller remembering to.

/** The service name this plugin provides. */
export const WORKSPACE_SERVICE = 'workspace'

/** The plugin id this plugin registers under. */
export const WORKSPACE_PLUGIN_ID = 'workspace'

/** The subtree of the kernel's composed configuration this plugin reads. */
export const WORKSPACE_CONFIG_KEY = 'workspace'

/** Bus event this plugin emits for a configuration key it read and cannot use. */
export const WORKSPACE_CONFIG_WARNING_EVENT = 'workspace.config.ignored'

export interface WorkspaceConfigWarning {
  /** Dotted key path inside the composed document, e.g. `workspace.retain`. */
  readonly key: string
  readonly detail: string
}

// `provider` is not read here — `selectWorkspaceProvider` in `@skanl/panda-session`
// decides WHICH workspace plugin gets mounted, and by the time this factory runs
// that decision is already made. It is listed anyway because the warning below
// fires on anything unlisted, and panda warning the user about panda's own
// vocabulary would be the plugin complaining about the key that chose it.
const KNOWN_CONFIG_KEYS: ReadonlySet<string> = new Set(['provider', 'rootDir'])

/**
 * The declared schema for this plugin's subtree.
 *
 * It rejects only what makes the plugin UNABLE TO SERVE — a `rootDir` that is
 * present and unusable. An unknown key is NOT an issue here, and that is a
 * correction rather than laxity: this document is user-authored, panda never
 * writes it, and it is read from the MACHINE scope too, so one forward-looking
 * key in `~/.panda/config.json` failed `panda run` in every project on the
 * machine. Measured against baseline: `{"workspace":{"retain":true}}` turned
 * exit 0 with an envelope into exit 2 with `PANDA_KERNEL_PLUGIN_START_FAILED`.
 * Unknown keys are reported on the kernel bus instead (see the factory), so a
 * typo is still visible without being fatal.
 *
 * NOTE, because the field's name promises more than the kernel delivers: the
 * kernel PROBES `manifest.configSchema` for shape (Standard Schema v1,
 * synchronous, non-throwing) at registration AND — since M7.C — applies it to
 * `composed[manifest.id]` before this factory runs. That sentence used to end at
 * "never applies it to the plugin's subtree", which M7.C made false and which
 * survived two milestones as prose nothing could contradict; the gate that now
 * makes it contradictable is `packages/session/test/plugin-config-key.test.ts`.
 *
 * The factory below STILL calls this schema, and that is not the old
 * hand-rolling: it merges `fallbackRootDir` into the namespace, so only the
 * MERGED value exists to be checked and only this plugin holds it — the same
 * reason `@skanl/panda-registry` states for its own second call. The kernel checks the
 * document; this checks the result.
 */
const WORKSPACE_CONFIG_SCHEMA = defineStandardSchema((value): StandardSchemaResult<unknown> => {
  if (value === undefined) return { value: {} }
  // A non-object subtree is IGNORED, not rejected — and saying so here is the
  // correction M7.C forced. This schema used to return an issue for it, and the
  // factory never let it: it warned on the bus and passed `{}` on instead, so the
  // strict branch was unreachable. Once the KERNEL applies this schema to the raw
  // subtree, an unreachable strict branch becomes a plugin that refuses to start
  // where it used to warn — and `run-session.ts` records that one forward-looking
  // key failing every run on the machine is the failure this leniency exists for.
  // The warning still happens, in the factory, off the raw document.
  if (!isRecord(value)) return { value: {} }
  const rootDir = value['rootDir']
  if (rootDir !== undefined && !isNonEmptyString(rootDir)) {
    return { issues: [issue("'rootDir' must be a non-empty string when present")] }
  }
  return { value }
})

export interface WorkspacePluginOptions {
  /**
   * Directory one subdirectory per workspace is created under.
   *
   * A LAST RESORT, not an override: the composed `workspace.rootDir` wins when
   * the document supplies one. `@skanl/panda-session` puts its own computed root into
   * a config LAYER instead of passing it here — `defaults` when the caller named
   * no `cwd`, `invocation` when it did — which is what makes a user's
   * `workspace.rootDir` decide anything at all. Passing it here shadows every
   * layer, so it is for a host that has no document.
   */
  readonly rootDir?: string
}

export interface WorkspacePlugin {
  readonly manifest: PluginManifest
  readonly factory: PluginFactory
}

/**
 * The local workspace provider as a kernel plugin: a manifest providing the
 * `workspace` service, a factory reading `workspace.rootDir` out of the kernel's
 * own layered configuration, and a disposer.
 *
 * OWNERSHIP: the kernel disposes this provider at `stop()`. Whoever mounted the
 * plugin therefore owns the provider's lifetime, and a session that obtained it
 * from a kernel must NOT dispose it — that is stated on `SessionOptions.kernel`
 * in `@skanl/panda-session` for the same reason it is stated on `createProvider`: the
 * obvious motive for reaching a provider is to share workspaces across runs, and
 * a shared provider disposed by the first run fails the second with
 * `PANDA_CONTRACT_PROVIDER_DISPOSED`.
 *
 * A missing `rootDir` REJECTS activation rather than defaulting to `cwd`: a
 * provider that silently writes into whatever directory the process happens to
 * be in is the failure this plugin could not report on afterwards. A key it does
 * not recognise is REPORTED and survived, which is the opposite call and the
 * right one — the schema above carries the measurement that separates them.
 */
export function createWorkspacePlugin(options: WorkspacePluginOptions = {}): WorkspacePlugin {
  // ONE read, at construction, for the reason `createActionPipeline` states: a
  // value a caller can change between construction and activation is not the
  // value that was agreed.
  const { rootDir: fallbackRootDir } = options

  const manifest: PluginManifest = {
    id: WORKSPACE_PLUGIN_ID,
    version: '0.0.0',
    provides: [WORKSPACE_SERVICE],
    consumes: [],
    configSchema: WORKSPACE_CONFIG_SCHEMA,
  }

  const factory: PluginFactory = (context: ActivationContext) => {
    const composed = context.config.resolve()
    const subtree = isRecord(composed) ? composed[WORKSPACE_CONFIG_KEY] : undefined

    // Reported, not swallowed and not fatal. The kernel's bus is the channel a
    // plugin has; `@skanl/panda-session` forwards these to its `onWarning` seam and
    // `panda run` prints them on stderr.
    const warn = (key: string, detail: string): void => {
      context.bus.emit<WorkspaceConfigWarning>(WORKSPACE_CONFIG_WARNING_EVENT, { key, detail })
    }

    let namespace: Record<string, unknown> = {}
    if (isRecord(subtree)) {
      namespace = subtree
      for (const key of Object.keys(subtree)) {
        if (KNOWN_CONFIG_KEYS.has(key)) continue
        warn(
          `${WORKSPACE_CONFIG_KEY}.${key}`,
          `not a workspace plugin config key (expected ${[...KNOWN_CONFIG_KEYS].join(', ')}); ignored`,
        )
      }
    } else if (subtree !== undefined) {
      // Previously ignored in silence, which made a wrong-typed subtree and a
      // correct one indistinguishable to the user who wrote it.
      warn(WORKSPACE_CONFIG_KEY, 'must be an object; the whole subtree was ignored')
    }

    const candidate: Record<string, unknown> = { ...namespace }
    if (fallbackRootDir !== undefined && candidate['rootDir'] === undefined) {
      candidate['rootDir'] = fallbackRootDir
    }
    const validated = WORKSPACE_CONFIG_SCHEMA['~standard'].validate(candidate)
    if (validated instanceof Promise) {
      return { status: 'rejected', issues: ['the workspace plugin config must validate synchronously'] }
    }
    if (validated.issues !== undefined) {
      return { status: 'rejected', issues: validated.issues.map((entry) => entry.message) }
    }
    const rootDir = (validated.value as Record<string, unknown>)['rootDir']
    if (!isNonEmptyString(rootDir)) {
      return {
        issues: [`'${WORKSPACE_CONFIG_KEY}.rootDir' is required: the workspace plugin will not guess a directory`],
        status: 'rejected',
      }
    }

    const provider: WorkspaceProvider = new LocalWorkspaceProvider({ rootDir })
    return {
      status: 'activated',
      services: { [WORKSPACE_SERVICE]: provider },
      // RETURNED, not voided. The previous note argued from what THIS provider's
      // `dispose()` happens to do — idempotent, leaves every workspace directory
      // in place — rather than from the contract, and
      // `WorkspaceProvider.dispose(): Promise<void>` lets a third party's
      // provider have teardown that genuinely must finish. Since M7.A the kernel
      // awaits this and contains a rejection as a `DisposalFailure`, so the
      // hand-rolled `.catch()` that existed only to stop a floating rejection is
      // gone with the reason for it.
      dispose: () => provider.dispose(),
    }
  }

  return { manifest, factory }
}
