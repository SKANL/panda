import { join } from 'node:path'
import { PANDA_ERROR_CODES, PandaError } from '@panda/contracts'
import type { ConfigLayer, LayeredConfig } from '@panda/kernel'
import { createGitWorktreeWorkspacePlugin } from '@panda/workspace-git-worktree'
import { WORKSPACE_CONFIG_KEY, createWorkspacePlugin } from '@panda/workspace-local'
import type { WorkspacePlugin } from '@panda/workspace-local'

// Workspace provider SELECTION: which shipped `WorkspaceProvider` this run
// mounts, decided through the layered configuration panda already owns.
//
// It is the executor selection's twin on purpose (`executors.ts`), down to
// taking the value and its layer from ONE `dump()` entry. What differs is only
// the key path: `workspace` is ALREADY an object-namespaced subtree — the
// session seeds `workspace.rootDir` into it as a layer — so the selection
// belongs at `workspace.provider` rather than at a second root key that would
// split one plugin's configuration across two places.
//
// Two plugins providing the service `workspace` would be
// `PANDA_KERNEL_SERVICE_CONFLICT`, so this does not compose providers: it
// CHOOSES one, and the chosen one is the only one registered.

/** The key inside the `workspace` subtree that names the provider. */
export const WORKSPACE_PROVIDER_CONFIG_KEY = 'provider'

/**
 * Where a project's workspaces live: the `workspace.rootDir` `runSession` seeds,
 * as ONE function rather than two `join` calls.
 *
 * It exists because a second caller arrived. `panda workspace remove` has to
 * find the ledger and the trees a run created, and a CLI that spelled
 * `.panda/workspaces` for itself would be a second answer to where panda's
 * worktrees are — right until a run wrote them somewhere else. The session
 * decides this path; everyone else asks.
 */
export function worktreeStateDir(projectRoot: string): string {
  return join(projectRoot, '.panda', 'workspaces')
}

/** What panda mounts when nothing selects otherwise. */
export const DEFAULT_WORKSPACE_PROVIDER_ID = 'local'

/** The `git worktree`-backed provider (`@panda/workspace-git-worktree`). */
export const GIT_WORKTREE_PROVIDER_ID = 'git-worktree'

/**
 * What the mount needs that no configuration document supplies.
 *
 * `repoPath` is the repository worktrees are cut from. It is a MOUNT input
 * rather than a config key because it is not a choice a user makes in a
 * document — it is the project the host is already running in, the same `cwd`
 * `workspace.rootDir` is computed from. See the plugin's own note.
 */
export interface WorkspaceMountContext {
  readonly repoPath: string
}

type WorkspacePluginFactory = (context: WorkspaceMountContext) => WorkspacePlugin

/**
 * Every workspace provider panda ships, keyed by the id a document may name.
 *
 * A MAP from id to plugin factory, not a set of ids beside a `switch`. That
 * shape is the one `EXECUTOR_CATALOGUE` arrived at after a parallel name list
 * drifted from the thing it named and shipped an executor nothing ever
 * exercised: here the id list, the closed-catalogue check and the mount are all
 * read out of this one object, so an id cannot exist without a factory and a
 * factory cannot be unreachable by name.
 */
const WORKSPACE_PROVIDER_CATALOGUE: ReadonlyMap<string, WorkspacePluginFactory> = new Map<
  string,
  WorkspacePluginFactory
>([
  // The local plugin takes its `rootDir` from the composed document and needs
  // nothing from the mount, which is why it ignores the context rather than
  // being handed a narrower one.
  [DEFAULT_WORKSPACE_PROVIDER_ID, () => createWorkspacePlugin()],
  [GIT_WORKTREE_PROVIDER_ID, ({ repoPath }) => createGitWorktreeWorkspacePlugin({ repoPath })],
])

/** Every provider id a selection may name, in catalogue order. */
export function availableWorkspaceProviderIds(): readonly string[] {
  return [...WORKSPACE_PROVIDER_CATALOGUE.keys()]
}

export interface WorkspaceProviderSelection {
  /** The id that won; always a key of the catalogue. */
  readonly providerId: string
  /**
   * The layer that supplied it, taken from the layered config's OWN `dump()`.
   * Never recomputed: provenance derived a second time is how a report starts
   * disagreeing with the thing it reports on.
   */
  readonly layer: ConfigLayer
  /** Every id a selection may name, for a host that has to render a choice. */
  readonly available: readonly string[]
}

const DOTTED_KEY = `${WORKSPACE_CONFIG_KEY}.${WORKSPACE_PROVIDER_CONFIG_KEY}`

function unusableSelection(detail: string): PandaError {
  // `configurationUnusable` rather than a new code: panda's own document exists
  // and holds a value panda cannot use, which is exactly what that code is for
  // (see its note in `@panda/contracts`). There is no workspace twin of
  // `PANDA_EXECUTOR_NOT_FOUND` and this story does not invent one — the message
  // carries the closed catalogue, which is the half a user acts on.
  return new PandaError(
    PANDA_ERROR_CODES.configurationUnusable,
    `panda's '${DOTTED_KEY}' configuration cannot be used: ${detail}`,
  )
}

/**
 * The catalogue's refusal for a name panda ships no provider under.
 *
 * ONE spelling, called from the selection and from the mount, because the two
 * would otherwise drift — the failure `EXECUTOR_CATALOGUE`'s own note records.
 */
function unknownWorkspaceProvider(providerId: string): PandaError {
  return unusableSelection(
    `panda has no workspace provider named '${providerId}'; available providers: ${availableWorkspaceProviderIds().join(', ')}`,
  )
}

/**
 * The workspace provider an already-seeded configuration decides, with the layer
 * that decided it. Pure: it reads the composed view and touches no file.
 *
 * Reading the filesystem here is the thing this must not do. `executors.ts`
 * states the rule for its twin: a session primitive whose behaviour depends on
 * files under the running user's home is not usable from a host that already
 * knows what it wants. The caller seeds layers; this reads the composed view.
 */
export function selectWorkspaceProvider(config: LayeredConfig): WorkspaceProviderSelection {
  // The value AND its provenance from ONE dump entry, so the two cannot disagree.
  const decided = config
    .dump()
    .find(
      (entry) =>
        entry.path.length === 2 &&
        entry.path[0] === WORKSPACE_CONFIG_KEY &&
        entry.path[1] === WORKSPACE_PROVIDER_CONFIG_KEY,
    )
  if (decided === undefined) {
    // Reachable, unlike its executor twin: `dump()` reports LEAVES, so a
    // document writing an OBJECT at this path leaves no entry here at all. A
    // default taken on this path would mount `local` for a user whose document
    // says something else — silently running somewhere other than where they
    // asked, which is the failure the whole selection exists to remove.
    throw unusableSelection(
      `no provider is resolvable at this path (a '${DOTTED_KEY}' that is an object rather than one of: ${availableWorkspaceProviderIds().join(', ')} does this)`,
    )
  }
  if (typeof decided.value !== 'string') {
    // Type-checked, never coerced: `String(42)` would turn a typo into the
    // catalogue lookup's problem and report it as an unknown provider name.
    throw unusableSelection(
      `it must be a string naming one of: ${availableWorkspaceProviderIds().join(', ')}, but the '${decided.layer}' layer supplies ${typeof decided.value}`,
    )
  }
  if (!WORKSPACE_PROVIDER_CATALOGUE.has(decided.value)) throw unknownWorkspaceProvider(decided.value)
  return {
    providerId: decided.value,
    layer: decided.layer,
    available: availableWorkspaceProviderIds(),
  }
}

/**
 * The plugin for one catalogue id.
 *
 * Separate from the selection so the selection stays a pure value a host can
 * report on without constructing anything — and so there is exactly one place a
 * provider id turns into a plugin. An id the catalogue does not hold is a coded
 * failure, never a fallback.
 */
export function createSelectedWorkspacePlugin(
  providerId: string,
  context: WorkspaceMountContext,
): WorkspacePlugin {
  const factory = WORKSPACE_PROVIDER_CATALOGUE.get(providerId)
  if (factory === undefined) throw unknownWorkspaceProvider(providerId)
  return factory(context)
}
