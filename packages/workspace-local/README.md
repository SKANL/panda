# @panda/workspace-local

The local-directory `WorkspaceProvider`: a workspace is a subdirectory of `rootDir`, so state
written into one survives release, re-acquire and provider restarts alike.

```ts
import { LocalWorkspaceProvider } from '@panda/workspace-local'

const provider = new LocalWorkspaceProvider({ rootDir: '/tmp/panda-workspaces' })
const handle = await provider.create()
await provider.release(handle)
await provider.dispose()
```

Every handle is an independent single-use lease. Releasing the SAME handle twice raises
`PANDA_CONTRACT_WORKSPACE_DOUBLE_RELEASE`; after `dispose()` every operation raises
`PANDA_CONTRACT_PROVIDER_DISPOSED`. `dispose()` deliberately leaves every workspace directory in
place — the work inside them outlives the provider, and cleaning up is the caller's.

## As a kernel plugin

`createWorkspacePlugin({ rootDir })` mounts the provider on a `@panda/kernel` container and
provides the `workspace` service. `rootDir` comes from the kernel's composed configuration under
`workspace.rootDir`; the constructor option is a **fallback** for a host with no document, not an
override. Absent from both, activation is **rejected** rather than defaulted, because a provider
that silently wrote into `process.cwd()` is a failure it could not report on afterwards.

A key inside the subtree that this plugin does not recognise — or a subtree of the wrong shape — is
**reported and survived**, on the kernel bus as `workspace.config.ignored`. It is not fatal, and
that is measured rather than preferred: this document is user-authored, panda never writes it, and
it is read from the machine scope too, so one forward-looking key in `~/.panda/config.json` failed
`panda run` in every project on the machine. `@panda/session` forwards these to its `onWarning`
seam and `panda run` prints them on stderr.

The service IS the port, where `@panda/adapter-cli`'s deliberately is not: `create`/`acquire`/
`release`/`dispose` are the contract, and there is no budget here for a wrapper to guard. What
mounting buys is ownership — the kernel disposes the provider at `stop()`, on every path, instead
of every caller remembering to.
