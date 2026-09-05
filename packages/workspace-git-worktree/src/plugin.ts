import { defineStandardSchema } from '@skanl/panda-contracts'
import type { StandardSchemaResult, WorkspaceProvider } from '@skanl/panda-contracts'
import { isNonEmptyString, isRecord, issue } from '@skanl/panda-contracts/validation'
import type { ActivationContext, PluginFactory, PluginManifest } from '@skanl/panda-kernel'
import { GitWorktreeWorkspaceProvider } from './git-worktree-provider.ts'

// The git-worktree workspace provider, mounted as a kernel plugin (Story 4.2).
//
// It mirrors `@skanl/panda-workspace-local`'s plugin deliberately: same service, same
// config subtree, same warning event, same "will not guess a directory" refusal.
// Two plugins providing the service `workspace` would be
// `PANDA_KERNEL_SERVICE_CONFLICT`, so exactly one of the two is ever registered
// and `selectWorkspaceProvider` in `@skanl/panda-session` decides which.
//
// The three constants below are RESTATED rather than imported from
// `@skanl/panda-workspace-local`. They are kernel-service vocabulary, not that
// package's property — `workspace` is the name the session consumes by, and
// `workspace.config.ignored` is the event `createSessionKernel` already
// subscribes to — and a sibling import would be an AD-2 edge between two
// implementations that have no business knowing about each other.

/** The service name this plugin provides. */
export const WORKSPACE_SERVICE = 'workspace'

/**
 * The subtree of the kernel's composed configuration this plugin reads.
 *
 * Declared BEFORE the plugin id because the id is derived from it: since M7.C
 * the kernel validates `composed[manifest.id]` against the manifest's own
 * `configSchema` (`@skanl/panda-kernel`'s `lifecycle.ts`), so a plugin that registers
 * under anything other than the key it reads is handed `undefined` and its
 * schema is never applied to a single real value.
 */
export const WORKSPACE_CONFIG_KEY = 'workspace'

/**
 * The plugin id this plugin registers under: its config key, and nothing else.
 *
 * It used to be `workspace-git-worktree`, which read as the honest name for the
 * implementation and made the kernel's M7.C validation a silent no-op for this
 * plugin alone — measured against `@skanl/panda-workspace-local` as its control, which
 * received the real subtree because its id and its key already matched. Two
 * providers of one capability SHARE the config namespace on purpose, so the
 * implementation is named by `workspace.provider` and by this plugin's own
 * rejection messages, never by the id the kernel keys configuration on.
 *
 * Colliding with `@skanl/panda-workspace-local`'s id is not a hazard: both provide the
 * service `workspace`, so registering the two together is already
 * `PANDA_KERNEL_SERVICE_CONFLICT` and the selection mounts exactly one.
 */
export const WORKSPACE_PLUGIN_ID = WORKSPACE_CONFIG_KEY

/** Bus event this plugin emits for a configuration key it read and cannot use. */
export const WORKSPACE_CONFIG_WARNING_EVENT = 'workspace.config.ignored'

export interface WorkspaceConfigWarning {
  /** Dotted key path inside the composed document, e.g. `workspace.retain`. */
  readonly key: string
  readonly detail: string
}

// `provider` is here because the SELECTION lives at `workspace.provider`: a key
// panda's own mount writes and this plugin then warned about would be panda
// complaining about its own vocabulary (`@skanl/panda-workspace-local` carries the
// same entry for the same reason).
const KNOWN_CONFIG_KEYS: ReadonlySet<string> = new Set(['provider', 'rootDir'])

/**
 * The declared schema for this plugin's subtree.
 *
 * Same shape and same leniency as `@skanl/panda-workspace-local`'s, and for the same
 * measured reason: this document is user-authored, panda never writes it, it is
 * read from the MACHINE scope too, and one forward-looking key in
 * `~/.panda/config.json` must not fail `panda run` in every project on the
 * machine. Unknown keys are reported on the kernel bus by the factory instead.
 *
 * Since M7.C the KERNEL applies this to `composed[manifest.id]` before the
 * factory runs, and this plugin's id IS its config key, so what the factory
 * receives as `context.settings` is this schema's own validated value. The
 * factory still reads the RAW subtree, for the warnings only: a non-record
 * subtree is passed through as `{}` here, so a factory that warned off the
 * validated value could not tell "no workspace configuration" from "a workspace
 * key holding a string", which is the distinction the warning exists to make.
 */
const WORKSPACE_CONFIG_SCHEMA = defineStandardSchema((value): StandardSchemaResult<unknown> => {
  if (value === undefined) return { value: {} }
  if (!isRecord(value)) return { value: {} }
  const rootDir = value['rootDir']
  if (rootDir !== undefined && !isNonEmptyString(rootDir)) {
    return { issues: [issue("'rootDir' must be a non-empty string when present")] }
  }
  return { value }
})

export interface GitWorktreeWorkspacePluginOptions {
  /**
   * The repository worktrees are cut from.
   *
   * NOT a config key, and that is the difference from `rootDir`. `rootDir` names
   * a directory panda CREATES and a user may legitimately relocate; the repo is
   * the thing the host is already working in, and `createSessionKernel` computes
   * it from the same `cwd` it computes the workspace root from. Adding a
   * `workspace.repoPath` key would put a second, silently-divergent answer to
   * "which repository is this" into a user-authored document — and
   * `@skanl/panda-workspace-local` would then warn about a key panda itself defined.
   */
  readonly repoPath?: string
}

export interface WorkspacePlugin {
  readonly manifest: PluginManifest
  readonly factory: PluginFactory
}

/**
 * The git-worktree provider as a kernel plugin: a manifest providing the
 * `workspace` service, a factory reading `workspace.rootDir` out of the kernel's
 * own layered configuration as its STATE directory, and a disposer.
 *
 * `workspace.rootDir` is the ledger, the ownership records and the trees — the
 * same "directory panda puts workspaces under" the key already means, answered
 * by a different provider. Reusing it is what lets a user switch providers by
 * editing one key instead of two, and what keeps both plugins knowing the same
 * vocabulary (row 10 of this story's matrix).
 *
 * OWNERSHIP: the kernel disposes this provider at `stop()`. A session that
 * obtained it from a kernel must NOT dispose it.
 *
 * WHAT IS NOT CHECKED HERE: whether `repoPath` is inside a git repository. The
 * kernel's `PluginFactory` is SYNCHRONOUS (`@skanl/panda-kernel`'s `lifecycle.ts`) and
 * asking git is not, so the answer arrives from git itself on the first
 * `create()` — as a coded `PANDA_CONTRACT_WORKSPACE_UNAVAILABLE` carrying git's
 * own sentence ("not a git repository"). That is the honest message: a
 * synchronous `.git` probe here would have to reimplement repository discovery
 * (worktree files, submodules, `GIT_DIR`, parent directories) and would blame
 * the configuration for something the environment decides.
 */
export function createGitWorktreeWorkspacePlugin(
  options: GitWorktreeWorkspacePluginOptions = {},
): WorkspacePlugin {
  // ONE read, at construction: a value a caller can change between construction
  // and activation is not the value that was agreed.
  const { repoPath } = options

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

    const warn = (key: string, detail: string): void => {
      context.bus.emit<WorkspaceConfigWarning>(WORKSPACE_CONFIG_WARNING_EVENT, { key, detail })
    }

    if (isRecord(subtree)) {
      for (const key of Object.keys(subtree)) {
        if (KNOWN_CONFIG_KEYS.has(key)) continue
        warn(
          `${WORKSPACE_CONFIG_KEY}.${key}`,
          `not a workspace plugin config key (expected ${[...KNOWN_CONFIG_KEYS].join(', ')}); ignored`,
        )
      }
    } else if (subtree !== undefined) {
      warn(WORKSPACE_CONFIG_KEY, 'must be an object; the whole subtree was ignored')
    }

    // The KERNEL already validated this exact subtree against the schema above
    // and rejected the plugin if it had issues, so what arrives here is that
    // schema's own value. Re-validating it would be this plugin checking the
    // kernel's work — and unlike `@skanl/panda-registry`, which merges factory options
    // into the namespace and therefore has a MERGED value only it can check,
    // this plugin merges nothing: `repoPath` is a mount input, not a config key.
    const stateDir = isRecord(context.settings) ? context.settings['rootDir'] : undefined
    if (!isNonEmptyString(stateDir)) {
      return {
        issues: [
          `'${WORKSPACE_CONFIG_KEY}.rootDir' is required: the git-worktree workspace plugin will not guess a directory`,
        ],
        status: 'rejected',
      }
    }
    if (!isNonEmptyString(repoPath)) {
      // Rejected rather than defaulted to `process.cwd()`, for the reason the
      // local plugin refuses to guess a `rootDir`: a provider that cut worktrees
      // out of whatever repository the process happened to be standing in is a
      // failure it could not report on afterwards.
      return {
        issues: [
          'the git-worktree workspace plugin requires a non-empty repoPath naming the repository worktrees are cut from',
        ],
        status: 'rejected',
      }
    }

    const provider: WorkspaceProvider = new GitWorktreeWorkspaceProvider({ repoPath, stateDir })
    return {
      status: 'activated',
      services: { [WORKSPACE_SERVICE]: provider },
      dispose: () => provider.dispose(),
    }
  }

  return { manifest, factory }
}
