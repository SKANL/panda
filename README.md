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

## Install

```bash
npm i -g @panda/cli      # the binary
npm i -D @panda/contracts # implementing a port
```

Thirteen packages ship under the `@panda` scope at one shared version. That is
NFR-8's "Contracts semver together" taken literally: one semver decision per
release rather than thirteen, so a breaking change is one number moving, not a
coordination problem.

`0.x` is deliberate. Semver permits breaking changes in a `0.x` minor, and panda
is still changing its contracts; the version says so rather than a paragraph
promising it.

**The packaged artifact is proven, not assumed.** A CI job on every push packs
all thirteen, installs them into a project **outside** this repository, offline,
runs a real session there, installs the `@panda/cli` tarball and runs the binary
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

Node >= 24. CI runs Node 24 and a Node 26 canary.

## Extend it

Third parties implement panda's ports installing only `@panda/contracts`, and each
port ships a public suite that tells an implementation whether it conforms. Start
at [`packages/contracts/README.md`](./packages/contracts/README.md).

## The directories

- **`packages/`** — the product. Twelve packages, topology strictly downward.
- **`_bmad/` and `_bmad-output/`** — the planning trail: roadmaps, epics, one frozen
  spec per shipped story, and an append-only ledger of deliberate simplifications.
  It is checked in on purpose, because the reasoning behind a decision outlives the
  commit that made it. It is not part of the product and you can ignore it.
- **`AGENTS.md`** — the rules an agent working in this repository must follow. Every
  mechanically checkable one names the gate that enforces it.

## License

MIT. See [LICENSE](./LICENSE).
