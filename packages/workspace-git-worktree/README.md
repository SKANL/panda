# @panda/workspace-git-worktree

A `WorkspaceProvider` over real `git worktree` checkouts: every workspace is a detached checkout of
a repository, so several sessions work on the same project at once without sharing a working tree.

```ts
import { GitWorktreeWorkspaceProvider } from '@panda/workspace-git-worktree'

const provider = new GitWorktreeWorkspaceProvider({
  repoPath: '/src/my-project',
  stateDir: '/src/my-project/.panda/workspaces',
})
const handle = await provider.create() // a real `git worktree add --detach`
await provider.release(handle)
await provider.dispose()
```

**What makes a worktree panda's is the RECORD, not the directory.** Every tree gets a durable
ownership record under `stateDir`, and `acquire()` answers from that record alone — before it
touches the disk. A directory sitting in the trees folder with no record is classified external and
is never read, never modified and never handed out (FR-18, AD-6).

**Names are retired permanently.** Ids come from a monotonic ordinal persisted *before* the tree is
created, so a name that once identified a tree is never issued again — not after removal, not after
a crash, not after a restart. The reservation is serialized per state directory, so two providers
constructed over one directory cannot reserve the same ordinal. Two panda **processes** over one
directory still can: both read the same ordinal, both compute the same path, and the second
`git worktree add` fails on an existing directory — a coded `PANDA_CONTRACT_WORKSPACE_UNAVAILABLE`
rather than two trees sharing a name. That boundary is recorded in `deferred-work.md`; git is the
backstop until a cross-process lock exists.

Every handle is an independent single-use lease. Releasing the SAME handle twice raises
`PANDA_CONTRACT_WORKSPACE_DOUBLE_RELEASE`; after `dispose()` every operation raises
`PANDA_CONTRACT_PROVIDER_DISPOSED`. `dispose()` removes **nothing** — a worktree outliving its
provider is what makes parallel work resumable, and tree removal, branch lifecycle and the recovery
sweep are Story 4.3.

## As a kernel plugin

`createGitWorktreeWorkspacePlugin({ repoPath })` mounts the provider on a `@panda/kernel` container
and provides the `workspace` service — the same service `@panda/workspace-local` provides. Two
plugins providing it would be `PANDA_KERNEL_SERVICE_CONFLICT`, so the two are **alternatives** and
something has to choose. `@panda/session` chooses, from the layered configuration:

```jsonc
// <project>/.panda/config.json
{ "workspace": { "provider": "git-worktree" } }
```

`selectWorkspaceProvider` reads that one entry — value and layer together, so the two cannot
disagree — and `createSessionKernel` registers the plugin it names. Absent, the selection is `local`
at layer `defaults`, so nothing changes for an existing user. A provider name panda does not ship,
or a non-string where a name belongs, is a coded `PANDA_CONFIGURATION_UNUSABLE` naming the closed
catalogue; it is never coerced and never quietly defaulted.

`stateDir` comes from the composed configuration under `workspace.rootDir` — the same key the local
provider uses for the same idea, "the directory panda puts workspaces under", so switching providers
is one key rather than two. `repoPath` is a **mount input**, not a config key: it is not a choice a
user makes in a document but the project the host is already running in, and `createSessionKernel`
computes it from the same `cwd` it computes `workspace.rootDir` from. Absent either one, activation
is **rejected** rather than defaulted, for the reason the local plugin refuses to guess a `rootDir`:
a provider that cut worktrees out of whatever repository the process happened to be standing in is a
failure it could not report on afterwards.

A key inside the subtree this plugin does not recognise — or a subtree of the wrong shape — is
**reported and survived**, on the kernel bus as `workspace.config.ignored`, exactly as
`@panda/workspace-local` does. `@panda/session` forwards these to its `onWarning` seam and
`panda run` prints them on stderr.

**Whether `repoPath` is inside a repository is not checked at activation.** The kernel's
`PluginFactory` is synchronous and asking git is not, so the answer arrives from git itself on the
first `create()`:

```
PANDA_CONTRACT_WORKSPACE_UNAVAILABLE: git worktree add --detach <path> failed:
fatal: not a git repository (or any of the parent directories): .git
```

That is deliberate. A synchronous `.git` probe would have to reimplement repository discovery —
worktree files, submodules, `GIT_DIR`, parent directories — and would blame the configuration for
something the environment decides. git's own sentence is the useful half of a git failure.
