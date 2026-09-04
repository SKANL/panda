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

## Not published, and that is a decision

Every package is `private` at version `0.0.0` and nothing has been pushed to a
registry. The source is public and MIT-licensed; publishing claims a name
permanently and has not been decided.

That does not mean it is unusable. `pnpm pack` produces real tarballs, and a CI
job on every push installs them into a project **outside** this repository,
offline, and runs a session there — so the packaged artifact is proven, not
assumed. To consume panda today, pack from source and install the tarball.

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
