# panda

A microkernel that manages the environment of AI coding executors.

You keep one canonical Registry of what you want available — skills, MCP servers.
Panda projects it into each executor's **native** configuration, at the location
that vendor already reads, in that vendor's own vocabulary. It tracks what it
wrote, so it can take back exactly that and nothing else.

It never invents a location a vendor does not read, and it never asks you to hand-
edit a vendor's config to finish a job it started.

```bash
panda init                 # project the Registry into every executor found
panda doctor               # what drifted, and the command that fixes each finding
panda add / remove / list  # the Registry's own door
panda export / import      # move an environment between machines, secrets left behind
panda status               # what is installed, and how much quota is left where a vendor publishes it
```

That binary is a thin argv binding — it reads no files at all, and `eslint` forbids
it from importing `node:fs`. Every capability behind it is a package, so a host
composes the same session directly and brings its own executor:

```ts
import { readExecutorConfigLayers, runSession } from '@skanl/panda-session'

// TWO CALLS, and the first one is what makes this the same session `panda run`
// composes. `runSession` reads no files — a session primitive that reached into
// the running user's home would be unusable from a host that already knows what
// it wants — so the documents are read separately and handed in. Omit them and
// only panda's own defaults apply, which runs a different executor than the one
// `panda swap executor` selected, and bills a different account.
const configLayers = await readExecutorConfigLayers({ projectDir: process.cwd() })
const envelope = await runSession({ prompt: 'list files in this workspace', configLayers })

// or hand panda an executor of your own, which wins over any configured selection:
// await runSession({ prompt: '…', createAdapter: () => myAdapter })
```

The return value is the same `ResultEnvelope` `panda run` prints, and every port —
executor, workspace, memory — ships a public clause suite that tells your
implementation whether it conforms. Start at
[`packages/contracts/README.md`](./packages/contracts/README.md), whose examples CI
extracts and runs against the packed tarball; the block above is illustrative and
nothing executes it.

## Install

```bash
npm i -g @skanl/panda-cli      # the binary
npm i -D @skanl/panda-contracts # implementing a port
```

Thirteen packages ship under the `@skanl` scope at one shared version. That is
NFR-8's "Contracts semver together" taken literally: one semver decision per
release rather than thirteen, so a breaking change is one number moving, not a
coordination problem.

`0.x` is deliberate. Semver permits breaking changes in a `0.x` minor, and panda
is still changing its contracts; the version says so rather than a paragraph
promising it.

**The packaged artifact is proven, not assumed.** A CI job on every push to
`main` and on every pull request packs
all thirteen, installs them into a project **outside** this repository, offline,
runs a real session there, installs the `@skanl/panda-cli` tarball and runs the binary
a user would get. It also refuses to let a package stop being publishable — a
manifest that regains `private`, drifts off the shared version, or loses
`publishConfig.access` fails the build by name.

Building from source still works and needs no registry: `pnpm pack` produces the
same tarballs the release publishes.

## Build it

```bash
pnpm install
pnpm check                     # bytes + typecheck + test + lint
pnpm build && pnpm proof:consumer-install   # the other half — CI runs it separately
```

Node >= 22.18.0. CI runs that exact floor plus the 22 LTS head, 24, and a 26 canary.
The floor was `>= 24` and nothing in the source needed it; it came down only after a
CI leg pinned to `22.18.0` went green. Two lower attempts failed for reasons that are
not panda's code -- pnpm needs >= 22.13, and two `memory-sqlite` clauses spawn a child
Node that imports `.ts` before native stripping was unflagged at 22.18 -- so this is a
DEVELOPER floor. A consumer runs `dist` and needs neither, so their real floor is lower
and is not yet proven.

## Extend it

Third parties implement panda's ports installing only `@skanl/panda-contracts`, and each
port ships a public suite that tells an implementation whether it conforms. Start
at [`packages/contracts/README.md`](./packages/contracts/README.md).

## The directories

- **`packages/`** — the product. Thirteen packages, topology strictly downward.
- **`_bmad/` and `_bmad-output/`** — the planning trail: roadmaps, epics, one frozen
  spec per shipped story, and an append-only ledger of deliberate simplifications.
  It is checked in on purpose, because the reasoning behind a decision outlives the
  commit that made it. It is not part of the product and you can ignore it.
- **`AGENTS.md`** — the rules an agent working in this repository must follow. Every
  mechanically checkable one names the gate that enforces it.

## License

MIT. See [LICENSE](./LICENSE).
