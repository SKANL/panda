---
title: 'technical research: cordis, and what panda should take from it'
type: 'technical'
topic: 'Cordis (spatiotemporal composability) as a possible foundation for panda'
decision: 'Whether panda adopts cordis as a dependency, and what it takes from it instead'
source: 'the cordis repository at 0027892, its paper, and the DeepSeek Harness reference'
status: complete
preset: 'standard'
validation: 'measured'
created: '2026-09-01'
updated: '2026-09-01'
claims_verified: 14
claims_unverified: 0
---

# Cordis, and what panda should take from it

## Executive summary

**Panda's kernel is a hand-rolled implementation of a paradigm somebody else
formalised, published and hardened.** Cordis is a meta-framework of
*spatiotemporal composability* — revertible effects (temporal) and reactive
coeffects (spatial) — with an arXiv paper behind it, 26,813 weekly npm
downloads, and an agent framework (DeepSeek Harness) built on top whose own
docs describe it in panda's exact words: *"plugins contribute services, typed
events, and reversible effects to a shared context."*

That overlap is real and it is not flattering, so it deserved a measured answer
rather than a proud one.

**The owner's decision, taken on the evidence below: take the ideas, do not take
the dependency.**

Three measurements decided it, and each is a fact rather than a preference:

1. **Cordis's power comes from a god Context that panda's topology forbids.**
   Measured on the knowledge graph built for this note: `Context` has degree
   **78** and bridges **19** communities — every service, every plugin and every
   effect hangs off one ambient object mutated through Proxies. AD-2's strictly
   downward package topology is the deliberate opposite. Adopting cordis is not
   adding a library; it is inverting panda's shape.
2. **The one thing panda actually lacks — module loading — is three lines, and
   cordis's version of it needs a Node flag.** See §4.
3. **`cordis@4.0.0-rc.9` is the `latest` dist-tag.** There is no stable 4.x, the
   README says the API "may change without notice", and `@cordisjs/plugin-loader`
   is `1.0.0-rc.6`. NFR-8 versions every panda Contract together under one semver
   major, so an unstable upstream is a contract risk, not a code risk.

What panda takes instead is in §5, and the largest payoff is not a library: it is
that **cordis answers Story 5.4's blocking question**, and answers it in a way
that needs none of cordis. See §6.

## 1. What was measured, and how

Cordis cloned to `C:\code\cordis` at `0027892` and indexed three ways:

| tool | result |
|---|---|
| codegraph | 73 files, 991 nodes, 3,431 edges |
| gitnexus | 1,045 nodes, 2,622 edges, 70 clusters, 86 flows |
| graphify | 1,222 nodes, 1,657 edges, 90 communities (`graphify-out/graph.html`) |

Sizes, for the comparison that follows: **cordis core is 1,866 lines across 9
files; panda's kernel is 2,682 across 9.** They are the same order of magnitude,
and panda's carries the action pipeline and budget machinery cordis has no
equivalent of.

## 2. What cordis is

- **`Context`** — the ambient object. `extend()`, `isolate(name)`,
  `intercept(name, config)`. Proxy-backed, symbol-keyed, prototype-chained.
- **`Fiber`** — the unit of lifecycle: a state machine with `effect()`,
  `dispose()`, `restart()`, `update(config)`.
- **`ctx.effect(execute, label)`** — the paper's central primitive. Accepts a
  disposer, a promise of one, an iterable or an async iterable of them; collects
  them; disposes in **reverse order**; guards double-dispose with an epoch flag;
  builds a nested `EffectMeta` tree so effects are introspectable.
- **`RegistryService`** — `plugin(plugin, config)` and `inject(deps, callback)`.
  A plugin is `{ name?, Config?, inject?, provide?, intercept? }` plus
  `apply(ctx, config)`.
- **`EventsService`** — five dispatch modes: `emit`, `parallel`, `serial`,
  `bail`, **`waterfall`**.
- **`@cordisjs/plugin-loader`** — declarative entries in YAML, imported at runtime.
- **`@cordisjs/plugin-hmr`** — hot module replacement.

`Config` is **Standard Schema v1**, the same interface panda's contracts use.

## 3. The overlap with panda's kernel, concretely

| panda | cordis | verdict |
|---|---|---|
| `PluginManifest{id,version,provides,consumes,configSchema}` | `Plugin{name,Config,provide,inject}` | the same idea; **both Standard Schema v1** |
| register-with-disposer; reverse-order disposal; double-dispose is a no-op; a throwing disposer is contained | `Fiber.effect()` + epoch guard | cordis is strictly more general |
| `intercept.ts` — the tool-call interception waterfall (616 lines) | `waterfall` / `bail` dispatch modes | cordis has it as an event mode |
| layered configuration (`defaults→global→project→agent→invocation`) | `Context.intercept` + `Service[resolveConfig]` prototype chain | equivalent in effect |
| `PandaError` / `PANDA_ERROR_CODES` | `CordisError.Code` | equivalent |
| `createEventBus` with scopes | `EventsService` | equivalent |

**What panda has that cordis does not:** the action pipeline with budget caps
(M3.C's token budget), the projection engine and its ownership ledger, the
registry store, the executor adapters, the workspace providers. That is the
product; none of it is in question here.

**What cordis has that panda does not:** the loader and HMR.

## 4. The loader and HMR, measured rather than assumed

This is where the "don't reinvent the wheel" argument had to be tested, because
it is the only place cordis offers something panda genuinely lacks.

- **Panda has zero dynamic imports.** Measured across `packages/*/src`:
  `await import(`, `import(`, `createRequire`, `require(` → **0**. Control:
  `export function` over the same glob → **81 occurrences in 38 files**, so the
  query works. This is not an oversight. `packages/kernel/src/manifest.ts` opens
  with *"Validation performs no I/O in kernel-owned code: no fs, network, env
  reads, **or dynamic imports**."* The kernel refuses module loading by design,
  which means a loader belongs OUTSIDE it in consumer tier — a peer, never a
  kernel replacement.

- **Cordis's HMR reaches into Node's private ESM loader.**
  `packages/loader/src/internal.ts` requires `internal/modules/esm/loader` and
  calls `getOrInitializeCascadedLoader()`, gated on `--expose-internals` with a
  native addon (`node-addon-require-builtin`) as the fallback.

- **Those internals still exist on both of panda's CI versions.** Measured, and
  it contradicts the obvious worry: the cascaded loader is **PRESENT** on Node
  24.14.1 and on 26.8.1, with the v2 shape (`getOrCreateModuleJob`,
  `resolveSync`, `loadCache`). Reported as a negative result — the fear was
  wrong.

- **But it needs the flag.** Control, without `--expose-internals`:
  `Cannot find module 'internal/modules/esm/loader'`. Panda's binary would have
  to be launched with a Node flag for HMR to work, which is precisely the §10
  principle inverted: *panda would be handing the problem back.*

- **And that interface already broke once.** `internal.ts` carries
  `ModuleLoaderV1` and `ModuleLoaderV2` side by side because Node 24 removed
  `getModuleJobForImport`, made `resolve` private and reversed `resolveSync`'s
  parameter order. It will break again.

- **The loader itself does not need any of it.** `Loader.internal` is assigned
  at `packages/loader/src/index.ts:55` and **never read inside the loader** —
  only `hmr` consumes it. `packages/loader/src/config/tree.ts` shows the real
  mechanism, and the fallback branch is the whole story:

  ```ts
  if (this.ctx.loader.internal) {
    return await this.ctx.loader.internal.import(name, this.ctx.baseUrl!, {})
  } else if (name.startsWith('.')) {
    return await import(new URL(name, this.ctx.baseUrl).href)
  } else {
    return await import(name)
  }
  ```

  **Loading a plugin from disk, without HMR, is `await import()`.** Everything
  cordis adds around it — entry trees, groups, isolation — is machinery panda
  has no requirement for yet.

## 5. What panda takes

1. **The vocabulary, with a citation.** `ARCHITECTURE-SPINE.md` describes
   revertible effects and dependency-driven activation without naming them.
   *Temporal composability* (every effect carries its inverse) and *spatial
   composability* (components react to the availability of what they consume)
   name what AD-5, AD-7 and the register-with-disposer rule already are. A
   published paradigm is a better citation than a house rule.
2. **The shape of `ctx.effect()`.** Panda re-derives collect-and-dispose at
   every call site. One primitive — takes a function returning a disposer,
   collects, disposes in reverse, epoch-guards, contains throws — would be
   *fewer* lines than what exists, not more. Panda already has every one of
   those guarantees separately; what it lacks is one name for them.
3. **The five dispatch modes as names.** `emit` / `parallel` / `serial` / `bail`
   / `waterfall`. Panda's `intercept.ts` IS a waterfall and does not say so.
4. **The loader's entry shape.** `{ id, name, config }` — an id, a module
   specifier, and that module's configuration. Structurally the registry entry
   panda already stores, with one field added.
5. **A negative result worth recording: the god Context is a warning, not a
   model.** Degree 78 across 19 communities is what a single ambient mutable
   context costs. Panda's guard tests (`packages/*/test/guard.test.ts`) exist to
   make that impossible. This research validates that choice rather than
   questioning it.

## 6. What this settles for Story 5.4

Story 5.4 is blocked because "given two installed methods" is unreachable:
panda cannot load a method from anywhere. This research answers the question
5.4 must answer first, and the answer needs none of cordis.

- **Where a method comes from:** a declarative entry naming a module specifier —
  cordis's `{ id, name, config }` — mounted with plain `await import()`, in a
  consumer-tier package, never in the kernel (the kernel forbids it in writing).
- **What "hot swap" can honestly mean in v1:** mounting and unmounting an
  already-loaded method, plus the selection M5.C now persists. **Not** live
  reloading of changed module code: that is what HMR is, and the only shipped
  implementation of it needs a Node flag panda must not require. Story 5.4
  should say so rather than promise it.
- **The ordering guarantee stays where ROADMAP-01 Correction A puts it:** the
  capability package runs outgoing `onDeactivate` fully before incoming
  `onActivate`; the CLI verb persists a selection and reports honestly which
  layer decides — the shape M5.C already shipped for `executor`.

## 7. What was NOT concluded

Whether panda would be *better* built on cordis is not answered here, and cannot
be from reading. The honest form of that question is a spike — mounting panda's
two plugins on `Context`/`Fiber` in a branch and measuring what deletes and what
breaks — which the owner considered and did not choose. It stays available: the
argument for it is real, because cordis carries years of hardening panda's
kernel does not, and panda has found kernel defects story after story.

The reasons it was not chosen are recorded in §2's summary rather than argued
here: the god Context against AD-2, the RC dist-tag against NFR-8, and a runtime
dependency (`cosmokit`) against AD-1's zero.

## Sources

- Repository: `https://github.com/cordiverse/cordis` at `0027892`, cloned to `C:\code\cordis`.
- Paper: *A Programming Paradigm for Spatiotemporal Composability*, arXiv 2608.25512.
- Consumer: DeepSeek Harness architecture reference,
  `https://deepseek-harness.github.io/deepseek-harness/en/reference/`.
- Every measurement above was executed on 2026-09-01, with a control where a
  zero was involved.

## 8. Update, 2026-09-01 — what the ideas actually bought, once implemented

The owner asked for the ideas to be IMPLEMENTED, not only recorded. Four
context-free lenses were run over cordis (lifecycle/effects, events/coeffects,
testing of guarantees, author ergonomics), each required to give file:line
evidence, a control for every zero, and a verdict on whether panda already had
the thing. Twenty findings came back. **Four did not survive the author
re-reading the cited lines**, and that ratio is the useful number here.

**Shipped as M7.A (`7d13d58`)** — three places where panda's own stated rule was
not enforced, none of them a cordis feature panda lacks:

- a candidate rejected for service coverage had its disposer discarded, after the
  factory had already run to completion and allocated;
- disposal was typed synchronous, which forced `@panda/registry`'s plugin into
  `void store.dispose()` with no catch — a live unhandled-rejection hazard, since
  that store waits for every in-flight mutation;
- the bus stayed open across the disposer loop and was never drained again.

**Discarded after verification, recorded so they are not re-derived:**
unready-plugin re-activation (deliberate, with the reason on the line above it
and a test pinning it); the "stop() resolves quiescent" comment (accurate — it is
scoped to the record stream, which is drained); multi-party interception (panda's
single-owner pipeline is a stated security posture, not an oversight);
`DisposableList` (equal semantics at panda's scale, a pure refactor).

**Queued with their measurements, in `SESSION-HANDOFF.md` §9:** the kernel
reporting every manifest violation rather than the first — it throws on the first
while `@panda/contracts` accumulates and the published document promises all of
them; carrying the Standard Schema issue `path` that panda declares away in both
copies; the kernel APPLYING `configSchema`, a required field it only probes and
that three first-party plugins hand-roll around; and `{kind: 'absent'}` carrying
which of three causes it means.

**The honest headline, from the testing lens:** on ordering, once-only disposal
and error containment, **panda's tests are stronger than cordis's**, and most
cordis techniques bought nothing. The one technique panda's four review lenses do
not name is TEMPORAL — assert the invariant from inside the window where the
object is half-torn-down, rather than before it opens or after it closes. That is
what found the open-bus window, and it is worth adding as a review question
independent of whether any test is adopted.
