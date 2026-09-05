# @skanl/panda-kernel

The plugin substrate panda composes itself out of: a registry of plugins, scoped
injection and disposal, a scoped event bus, layered configuration, and an
append-only observability log.

**It has ZERO runtime dependencies and never imports `@skanl/panda-contracts`** — that
is AD-1, and `test/guard.test.ts` in this package enforces it rather than stating
it. The kernel knows nothing about executors, registries or projection; those are
contracts a consumer supplies.

```bash
npm i @skanl/panda-kernel
```

## What it gives you

- **`createKernel()`** — a lifecycle with `register`, `start` and `stop`, where a
  plugin's disposer is guaranteed to run exactly once and a failed teardown never
  prevents its siblings from running.
- **A manifest every plugin declares** — `id`, `version`, `provides`, `consumes`,
  and a `configSchema` the kernel APPLIES rather than trusts. An author gets
  EVERY violation in one message, not the first.
- **Scoped configuration** — `LayeredConfig` reports which layer supplied every
  leaf, so "who decided this" is answerable per key.
- **An observability log** — records carry a sequence, and a record the kernel
  rejects is counted rather than dropped silently.

## Where it sits

Tier 0 of panda's topology: nothing in the workspace is below it, and
`packages/contracts/test/topology.test.ts` pins that by exact equality in both
directions. If you are implementing a panda PORT, you want `@skanl/panda-contracts`,
not this — the kernel is what mounts your plugin, not what your plugin talks to.
