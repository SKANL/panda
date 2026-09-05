---
title: 'Plugins mount for real'
type: 'refactor'
created: '2026-08-26'
status: 'done'
review_loop_iteration: 1
baseline_commit: 'b8505dc'
context:
  - '{project-root}/_bmad-output/planning-artifacts/ROADMAP-02-the-container-and-the-promise.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-2-0-session-composition-through-the-kernel.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-2-7c-executor-selection-for-panda-run.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** panda is a microkernel architecture whose microkernel is bypassed. `createKernel`, `loadPlugins` and `mount` have no caller anywhere in `src/` or `bin/` — only tests. The knowledge graph, reading the artifacts with no access to the code, independently finds AD-3 (the plugin trust model) to be the only one of the ten architecture decisions with no adjacent story. The session constructs its adapter and its workspace provider directly, so AD-4's ordering guarantee — the observability log initialised before any plugin loads — is described rather than exercised, and AD-10's waterfall is per-session rather than kernel-owned.

**And two layered configurations read the same document without knowing about each other.** `resolveExecutor` builds its own and reads `.panda/config.json`; `createKernel` builds another that no caller has ever seeded. The registry plugin — which already exists, complete, with a config schema written against its own subtree of the kernel's config — would read an empty document if mounted today.

**Approach:** compose what is already built. The container exists and the pattern is proven: `createRegistryPlugin` is a full manifest-plus-factory providing the `registry` service. Give the executor adapter and the workspace provider the same shape, seed the kernel's configuration from the documents panda already owns, and have the session obtain its collaborators from the kernel instead of constructing them.

**Why now, before Epic 3.** The memory provider and the methodology plugin are each, literally, a new plugin kind. If they land as more direct construction, *"everything is a plugin"* becomes a slogan the code contradicts in four places instead of two — and the methodology plugin is the piece the owner says gives panda its value.

**What this is not.** It is not dynamic loading. Nothing reads plugin code from disk, and AD-3's *"installing one is executing it"* surface is not built here; that needs a trust decision this story is not the place to make.

## Boundaries & Constraints

**Always:** `panda run` is behaviour-neutral — identical envelope, identical exit codes, identical cancellation, identical cleanup on every failure path, and every existing CLI assertion passes unmodified; the executor adapter and the workspace provider are obtained from the kernel, never constructed on the composed path; the kernel's layered configuration is seeded from the SAME documents executor selection reads, so one document configures both; a plugin that fails to activate is contained and reported, never a crash of the kernel or of its siblings (AD-5); absence is typed — a consumed service that is missing reads as `{ kind: 'absent' }` and its use site raises a named error, never `undefined`; the executor invocation is registered as an action on the KERNEL's pipeline, so caps are kernel-scoped rather than per-session; every capability stays reachable by importing packages without `@skanl/panda-cli` (FR-29).

**Ask First:** dynamic import of plugin code from disk, and any plugin discovery mechanism; a change to `ResultEnvelope`; making the registry, projection or doctor paths mount plugins (this story composes the RUN path); a semver rule for `PluginManifest.version`; exposing the kernel itself on `@skanl/panda-cli`'s public surface.

**Never:** no direct construction of an adapter or a workspace provider left on the composed path; no second layered configuration over the same document; no behaviour visible to a `panda run` user changes; no plugin reads or writes panda-owned state outside its own service (AD-4); no capability moves into `@skanl/panda-cli`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Behaviour neutrality | Every existing CLI and session assertion | Passes unmodified | N/A |
| Mounted, not constructed | A composed run | Adapter and provider come from the kernel; nothing constructs them directly | N/A |
| One configuration | A `.panda/config.json` with a plugin subtree | The mounted plugin reads it through the kernel's layered config, by layer | Coded on invalid |
| Config provenance | Global and project documents both present | The narrower layer wins, and which layer decided is reportable | N/A |
| Plugin rejects its config | An invalid plugin subtree | Contained activation failure naming the plugin; siblings still run | Reported, not thrown |
| A service is absent | A plugin that never activated | Consumers read `{ kind: 'absent' }` and raise a named error at the use site | Coded, never `undefined` |
| Ordering (AD-4) | Any mount | The log sink exists before any manifest is validated; the records show it | N/A |
| One pipeline | Two sessions on one kernel | Both invocations traverse the SAME pipeline and share its caps | Coded refusal |
| Cap refusal | A policy that forbids the invocation | Refused before the executor runs, exactly as today | Coded kernel error |
| Cleanup | Kernel stopped after a run | Every plugin disposed, disposal failures contained and reported | Contained |
| Executor selection still works | `--executor codex` over a mounted adapter | Codex runs; the selection and its deciding layer are still reported | N/A |
| SDK without the CLI | A consumer importing packages | Composes the same run and gets the same envelope | Coded errors surface |

</frozen-after-approval>

## Code Map

- `packages/adapter-cli/src/plugin.ts` -- NEW: manifest + factory providing the executor service, registering its action on the kernel's pipeline
- `packages/workspace-local/src/plugin.ts` -- NEW: manifest + factory providing the workspace service
- `packages/session/src/` -- the composition: build or accept a kernel, seed its config, mount, resolve services, run
- `packages/session/src/executors.ts` -- the layered read becomes the kernel's, not a second one
- `packages/cli/src/run.ts` -- unchanged in behaviour; whatever seam it passes stays a seam
- tests -- the matrix, the ordering proof from the record stream, and the existing suites unmodified

## Tasks & Acceptance

- [x] Executor-adapter and workspace-provider plugins with manifests, config schemas and disposers
- [x] The kernel's layered configuration seeded from panda's own documents; one config, not two
- [x] The session composes through the kernel; no direct construction on that path
- [x] The executor action registered on the kernel's pipeline, so caps are kernel-scoped
- [x] Contained activation failure, typed absence, and disposal proven by execution
- [x] Behaviour neutrality: every existing assertion passing unmodified

**Acceptance Criteria:**
- Given a composed run, when it executes, then the adapter and the provider were mounted as plugins and nothing constructed them directly
- And one `.panda/config.json` configures both the executor selection and the mounted plugins, by layer, with the deciding layer reportable
- And a plugin that fails to activate is contained and reported while its siblings still run
- And `panda run` behaves identically — envelope, exit codes, cancellation, cleanup

## Spec Change Log

One entry per decision the frozen block did not settle. Each states what was
MEASURED, not what was preferred.

### 1. The two service names are `executor` and `workspace` (AD-6)

AD-6 governs identity, and the Consistency Conventions row beside it fixes the
vocabulary: ports are named `XProvider`/`XAdapter`/`XTarget`/`XSource`. Neither
sentence names SERVICES, so the only evidence available is the one service panda
already has: `@skanl/panda-registry` provides `registry` — plugin id, service name and
config subtree all one word, and the word is the ROLE the consumer asks for, not
the class it gets back (the value is a `RegistryStore`).

Measured against that precedent, `executor` and `workspace` are the consistent
choice, and both spellings were already in the codebase for the same concepts
before this story: `.panda/config.json` spells its selection `{"executor": ...}`
and the session's directory is `.panda/workspaces`. Naming the services after
the ports instead — `executor-adapter`, `workspace-provider` — would have made
the executor service a lie the moment it stopped being an adapter (see #2), and
would have made the executor plugin's config subtree a second spelling of a key
the user's document already has. A name that has to change when the
implementation does is not identity.

The plugin ids match the service names, as the registry's do. Both are also the
names the methodology plugin will consume, so they are contract from here on.

### 2. The executor service is a RUNNER, not an adapter — and the honest answer to the no-bypass question

`kernel.getService('executor')` returns `{ executorId, run(actionId, request) }`.
The adapter is closed over by the factory and never leaves it. That was the
deciding measurement: a service that handed back an `ExecutorAdapter` would put
`.run(request)` on the surface of the container, so every holder of the kernel —
including every future plugin — could spawn an executor with no budget, no guard
and no record. Mounting would then have made AD-10 weaker than it was before,
because before this story an adapter at least had to be constructed by hand.

`run` takes the action id because the CALLER owns run identity: the session
scopes it to the workspace (`session.executor-run#<workspace.id>`) so two
sessions sharing one pipeline stay distinguishable in the record stream. It does
NOT take the cost. The cost is the plugin's configured one, because a caller who
could price its own run could price it at zero and walk through `maxTotalCost`.

**Can a caller still reach an executor without traversing the pipeline? Yes.**
The first version of this entry named two routes and called the entry
"NARROWED". Review refuted the count and the narrowing; both are corrected here
rather than patched beside. Five routes, every one measured:

- Any package that installs `@skanl/panda-adapter-cli` can build a runnable executor
  from **six** exported value factories, not one. The claim that closing this
  needs the *vendor* factories unexported was wrong: `createExecutorAdapter('codex', …)`
  is the catalogue's own factory, is not a vendor factory, and is equally
  sufficient on its own.
- `createExecutorPlugin(...).factory` is a `PluginFactory`, so a holder can
  invoke it with an `ActivationContext` of their own and get a real adapter wired
  to their own pipeline — reproduced against the emitted `dist/`. Inherent to the
  plugin shape.
- `kernel.swap(pluginId, factory)` runs a caller-supplied factory against the
  live registry, so a kernel holder replaces the service outright. Measured: a
  capped shared kernel at `maxInvocations: 0`, an honest `runSession`, a real
  vendor spawn, and an EMPTY record stream. This is a kernel-exported path around
  the waterfall and no wording of mine changes that.
- A host that passes `createAdapter` keeps its own reference and can invoke it
  after a refusal. Inherent to the seam.
- The frozen service itself: none. Extraction was attempted through
  `Object.keys`, own symbols, a non-enumerable prototype property and direct
  mutation of `run`; all failed, and the last one now throws.

**What this story genuinely closed**, stated at the size it is: for the
pnpm-strict consumer that installed only `@skanl/panda-session` — the consumer this
package's own comments describe and `consumer-install.proof.ts` exercises — the
bypass surface is **zero**, because that package now exports `createSessionKernel`
and no factory at all. It briefly exported `createKernel` and both plugin
factories, and for that consumer the surface went 0 → 1 *in this story*: calling
that "NARROWED" would have been the exact move Story 2.0 made and was refuted
for. It is withdrawn; the ledger entry now says five routes and no narrowing.

### 3. Actions are registered per invocation, and that has a ceiling

`ActionDefinition.run` takes no arguments and is read ONCE at registration
(deliberately — it is what stops a caller swapping the operation after the price
was agreed), so a per-request operation cannot reuse one handle. The plugin
therefore calls `context.actions.register(...)` per run.

Measured consequence: `createActionPipeline` keeps a `registeredIds` set and
never retires an entry, so a long-lived kernel running many sessions grows it
without bound. Collisions are not the risk — workspace ids are UUIDs on the
default provider — retention is. Named in a `ponytail:` comment on the service
and filed in `deferred-work.md`; the upgrade path is a pipeline that can retire a
handle, which is the same mechanism a post-hoc cost adjustment (M3.C) needs.

### 4. The executor catalogue moved to `@skanl/panda-adapter-cli`

`EXECUTOR_CATALOGUE`, `DEFAULT_EXECUTOR_ID`, `availableExecutorIds` and
`createExecutorAdapter` now live in `packages/adapter-cli/src/catalogue.ts`, and
`packages/session/src/executors.ts` re-exports every one of them unchanged.

The alternative was to hand the plugin a constructor from the session — which is
the direct construction this story exists to remove, one level up: a plugin that
cannot turn its own configured id into its own adapter is not configured by the
document, it is configured by whoever mounted it. The package that ships the
three trait records is the package that can perform the lookup.

Measured cost of the move: zero test changes. `packages/session/test/executors.test.ts`
imports all four names from `../src/executors.ts` and still does; the re-export
keeps identity, so `EXECUTOR_CATALOGUE.size === 3` and the
`createExecutorAdapter(id).executorId === id` pairing clause pass untouched.

### 5. ONE layered configuration, and it is the kernel's

`resolveExecutor` was split into three exported pieces:

- `readExecutorConfigLayers(options)` — the ONLY filesystem access in selection.
  It returns layer SNAPSHOTS, each carrying the path it came from.
- `seedExecutorConfig(config, layers)` — composes `defaults` → `global` →
  `project` → `invocation` into a `LayeredConfig` handed in, and wraps a
  `setLayer` rejection so it still names the offending FILE.
- `selectExecutor(config)` — pure; reads the value and its layer out of ONE
  `dump()` entry, so provenance and value cannot disagree.

`resolveExecutor` is the three in sequence and its signature, return shape and
behaviour are unchanged (`consumer.test.ts` compares the selection with
`toEqual`, so its shape is not negotiable).

`runSession` seeds `kernel.config` with those snapshots and calls
`selectExecutor` on it. That configuration — the kernel's own, the one every
mounted plugin resolves against — is the only one in the composed path.

**Why `panda run` stopped calling `resolveExecutor`.** The CLI now calls
`readExecutorConfigLayers` and hands the snapshots to `runSession`, which reports
the selection back through a new `onSelection` callback. Measured reason: the
CLI cannot hold a kernel (`packages/cli/test/run.test.ts` pins `@skanl/panda-kernel`
out of its imports, and exposing the kernel on the CLI surface is Ask-First in
this spec), and `ExecutorSelection` cannot grow a field (pinned by `toEqual`).
Keeping the old two-call shape would have meant reading `.panda/config.json`
twice per run, with a window in which the line printed on stderr and the document
the kernel composed could disagree — which is a second layered configuration over
the same document in everything but name, and this spec's Never list forbids it.
The stderr line, its layer names and every exit code are unchanged: 53/53 CLI
assertions pass with `git diff` empty on both CLI test files.

### 6. `SessionOptions.log` stays the WATERFALL's sink, not the kernel's

This was forced by measurement, and the measurement is worth recording because
the option's meaning looks like a free choice. Three existing suites assert the
exact record list a session-supplied sink receives:
`run-session.test.ts` (`toEqual([['action.invoked', ...], ['action.completed', ...]])`
and `toEqual(['action.refused'])`), `consumer.test.ts`
(`toEqual(['action.invoked', 'action.completed'])`), and the installed-tarball
proof (`expect(consumer.events).toEqual([...])`). A kernel constructed with that
sink writes `manifest.validated`, `plugin.activated`, `plugin.disposed` and
`kernel.stopped` into it too, so all four would have failed.

So a session-owned kernel records into its own memory sink and forwards only
`action.*` to the caller's — which is exactly what `SessionOptions.log` has
always been documented as ("where the interception pipeline's records go"). A
caller who wants the complete stream builds the kernel itself
(`createKernel({ log })`) and passes it as `kernel`; that is what the new
`kernel-composition.test.ts` does, and it is where the AD-4 ordering is proven.
The alternative — redefining the option to mean the kernel's whole stream —
would have been a breaking change to a published surface bought for nothing.

### 7. `SessionOptions.kernel`, and the ownership rule

A host running many sessions can pass a kernel it mounted and seeded itself.
Ownership is documented the way `createProvider` documents its own, because the
failure mode is the same one measured there: the caller owns the kernel, mounted
its plugins and must `stop()` it, and the session never does — a session that
stopped a shared kernel would dispose the next session's provider.

The corollary is that a provider obtained FROM a kernel is not disposed by the
session either (only one obtained from the `createProvider` seam is). Pinned by
"leaves a kernel-owned provider alone, so a second session on the same kernel
still runs", which was measured failing against the naive version.

The options a supplied kernel already owns are REFUSED with a coded error rather
than ignored. An `actionPolicy` that silently did nothing is a budget the caller
believes in and does not have.

The list grew on review from six to nine, and every addition was a measurement:

- `cwd` and `onSelection` were accepted and then silently ignored (`onSelection`
  calls counted at 0) — the exact behaviour this rule exists to forbid.
- `createProvider` is refused because the pair BREAKS. Its documented reason to
  exist is pooling; pooling gives a stable workspace id; a stable workspace id
  gives a stable action id; and a kernel-owned pipeline never retires one — so
  the second run against one kernel failed `PANDA_KERNEL_ACTION_INVALID: 'id' is
  already registered`. Making the action id unique per invocation was the other
  option and was rejected: three pre-existing clauses pin the subject exactly
  (`session.executor-run#w`, `#ws-one`, `#ws-two`), so it is not reachable
  without editing tests this story may not touch. A supplied kernel already
  carries a provider, which is the point of supplying one.

### 8. The workspace plugin refuses to guess a root directory

`workspace.rootDir` has no default: absent, the plugin rejects activation. A
provider that silently wrote into `process.cwd()` is the failure this plugin
could not report on afterwards. `runSession` supplies
`join(cwd, '.panda', 'workspaces')` as an explicit plugin option, merged over the
configured value exactly as `@skanl/panda-registry`'s plugin merges its own.

When `createProvider` IS supplied, the workspace plugin is not mounted at all.
The seam is a host/test injection, not the composed path, and mounting a provider
nobody would consume would construct one for nothing.

### 9. Implementation packages now depend on `@skanl/panda-kernel`

`@skanl/panda-adapter-cli` and `@skanl/panda-workspace-local` each gained
`"@skanl/panda-kernel": "workspace:*"`. AD-2's diagram draws implementations depending
on contracts alone, but `@skanl/panda-registry` has declared the kernel dependency
since Story 1.2 for exactly this reason — a plugin's manifest and factory are
kernel types — so this follows the established precedent rather than widening the
topology. `packages/session/test/guard.test.ts`, which pins @skanl/panda-session's
dependency set to four packages, is untouched: no new edge was added there.

The installed-tarball proof already installs the kernel as a direct `file:`
dependency of the consumer project, so both new requirements resolve; its
`0.0.0`-range clause passes unchanged.

### 10. How AD-4 is proven, and why the proof reads `seq`

`kernel-composition.test.ts` mounts both plugins on a kernel built with
`createMemoryLogSink()`, starts it, and then asserts from the RECORDS:
`records[0].seq === 1`, `records[0].event === 'manifest.validated'`,
`log.state.dropped === 0` and `lostRecordCount(log) === 0`.

`seq` is assigned by the SINK, starts at 1 and advances only for a record that
was actually sealed. A first record of seq 1 therefore says two things at once:
nothing preceded the first manifest validation, and nothing was lost before it. A
sink that came into existence after the load path ran could not produce that —
the load's own records would have had nowhere to go. The companion clause pins
every `manifest.validated` seq below the first `plugin.activated` seq, and a
second clause pins the whole run (load → activation → invocation → disposal →
`kernel.stopped`) as ONE ordered stream.

Corrected on review: that second clause spliced the ACTUAL action records into
its own expected array, which made it pass for any action events at all — or
none. It now pins the event sequence whole and the subjects separately, because
the action subject carries a UUID the test cannot know.

### 11. Mutation results (first round)

Every new guard was checked by weakening the production code in the smallest
realistic way and confirming the guard goes red. All nine were reverted.

| # | Weakening | Guard that failed |
|---|-----------|-------------------|
| 1 | `loadPlugins(..., createMemoryLogSink())` instead of the kernel's sink | AD-4: `records[0].event` was `plugin.activated`, and the one-stream clause lost both `manifest.validated` records |
| 2 | `runSession` stops checking `start().failures` | contained-failure clause: the run failed `SERVICE_NOT_PROVIDED` instead of `PLUGIN_START_FAILED` naming `executor` |
| 3 | `runSession` reads `resolved.value` without the `kind !== 'provided'` check | typed-absence clause: `undefined` flowed on and the wrong service was named |
| 4 | the executor plugin calls `adapter.run(request)` instead of registering the action | both cap clauses (plugin-level and shared-kernel) |
| 5 | `createActionPipeline(log)` — the kernel drops `actionPolicy` | both cap clauses; the two-kernel CONTROL still passed |
| 6 | the workspace plugin's disposer becomes a no-op | disposal clause: the provider still created directories after `stop()` |
| 7 | the session's sink forwards every record, not only `action.*` | behaviour neutrality — `run-session.test.ts` and `consumer.test.ts`, both unmodified |
| 8 | `seedExecutorConfig` composes only the `global` layer | `packages/cli/test/executor-selection.test.ts`, two clauses, unmodified |
| 9 | the executor service exposes `adapter` beside `run` | the service-surface clause |

### 12. Test counts (first round; superseded by #23)

New: 9 clauses in `packages/adapter-cli/test/plugin.test.ts`, 5 in
`packages/workspace-local/test/plugin.test.ts`, 12 in
`packages/session/test/kernel-composition.test.ts` — 26 in all.

Unchanged and passing with `git diff` empty on every existing test file:
`@skanl/panda-cli` 53, `@skanl/panda-session` 62 (74 with the new file), `@skanl/panda-adapter-cli`
92 + 6 skipped (101 + 6 with the new file), `@skanl/panda-workspace-local` 13 (18 with
the new file), `@skanl/panda-kernel`, `@skanl/panda-contracts`, `@skanl/panda-registry` 60,
`@skanl/panda-projection` 142 + 3 skipped, `@skanl/panda-environment` 61. `pnpm check` green
with every `dist/` deleted first; `pnpm proof:consumer-install` green, 8 passed.

### 13. What this story does NOT close

Stated here as well as in `deferred-work.md`, because a false close is worse than
an open entry:

- The waterfall is still reachable around, by FIVE routes and not two, and the
  word "NARROWED" is withdrawn — see #2 as corrected and #15. Zero of them are
  reachable from a `@skanl/panda-session`-only install; every one needs
  `@skanl/panda-adapter-cli`, `@skanl/panda-kernel`, or a reference the caller already held.
- `createActionPipeline` is still a public export, so a holder can build a
  second, uncapped pipeline. Untouched.
- `maxInvocations` and `maxTotalCost` still coincide while every action costs 1.
  The SHARED-pipeline half of that entry is now done; the adapter-reported-cost
  half is M3.C.
- The record sink still has no durable product consumer. The stream now covers a
  whole production run in one place, which is strictly more than before, and
  nothing keeps it.
- No dynamic loading, no plugin discovery, no AD-3 trust surface. Deliberate, and
  restated on the frozen block's own "What this is not".
- One executor per kernel: mounting a second `createExecutorPlugin()` is refused
  with `PANDA_KERNEL_MANIFEST_INVALID` (duplicate plugin id), so a host cannot
  mount two adapters side by side and pick per session. New entry.
- `manifest.configSchema` is decorative — the kernel probes it and never applies
  it (#19). Pre-existing, inherited from `@skanl/panda-registry`; proposed as a kernel
  fix in the ledger rather than made one here.
- Behaviour neutrality held only after the review round: the first version of
  this story broke `panda run` for any `.panda/config.json` carrying an unknown
  key under `workspace` (#16). The claim in the frozen block is true of what
  ships; it was not true of what was first submitted, and saying so is the point
  of this line.


### 14. The thin-binding pin is now structural, because a name scan is not

**Measured:** a complete working session composition was planted inside
`packages/cli/src/` — read the layers, build a kernel, `selectExecutor` deciding
the executor IN THE CLI, mount both plugins, start, `getService`, run, stop —
importing only `@skanl/panda-session`. It spawned `opencode`, and eslint, tsc and all
53 CLI assertions were green. The pin scanned for `@skanl/panda-kernel` by NAME, and
the kernel had arrived through a package the CLI is allowed to import.

That is the second time this pin has been routed around and neither time needed
a new idea: Story 2.0 used relative cross-package imports, M3.B used a
re-export. So the rule stopped naming packages and started naming CAPABILITIES:
`no-restricted-imports` on `packages/cli/src/**` and `bin/**` with a
`group: ['@skanl/panda-*']` pattern and an `importNames` list covering `createKernel`,
`createSessionKernel`, `createExecutorPlugin`, `createWorkspacePlugin`,
`createExecutorAdapter`, `seedExecutorConfig`, `selectExecutor`,
`EXECUTOR_CATALOGUE`, `EXECUTOR_SERVICE`, `WORKSPACE_SERVICE`. Which package
re-exports them stops mattering, which is the property both previous versions
lacked.

**Verified by execution:** with the planted file present, `pnpm lint` reports the
restriction and exits 1, for both the `createSessionKernel` form and the
`createKernel` + factories form. With the names removed from the rule, the same
planted file lints clean and exits 0. The probe was deleted afterwards; like the
`../..` clause beside it, this rule has no permanent fixture, because the gate
runs `eslint .` over the whole repository on every check.

The other half of the fix is the surface itself (#15), and it is the half that a
test can hold: a rule the CLI must obey is worth less than a capability the CLI
cannot reach.

### 15. `createSessionKernel` replaces five re-exports

**Measured:** `createExecutorPlugin(...).factory` takes a caller-supplied
`ActivationContext`. Hand it one carrying your own `ActionPipeline` and you get a
real vendor adapter running with no kernel, no policy and no record —
reproduced against the emitted `dist/`, which is the installed-consumer surface.
`@skanl/panda-session` had re-exported that factory, `createWorkspacePlugin`,
`createKernel`, `seedExecutorConfig` and `selectExecutor`. For the pnpm-strict
consumer that installed only `@skanl/panda-session`, the bypass surface went from
**zero to one in this story**.

All five are withdrawn. In their place `@skanl/panda-session` exports one named
surface, `createSessionKernel(options)`, which mounts both plugins, seeds the
configuration, starts the kernel and hands back the started kernel — the
capability without the factory. `runSession` calls the same function when no
kernel is passed, so there is ONE composition rather than two code paths.

`PandaKernel` stays exported as a TYPE, because it is what names
`SessionOptions.kernel`, and it erases at runtime. The surviving value surface is
pinned by a clause that asserts the whole export list, and the mutation that
re-exports the three factories turns it red.

### 16. Behaviour neutrality was broken; the fix is a layer, not a looser schema

**Measured, production path, no seams.** With
`.panda/config.json` = `{"executor":"codex","workspace":{"retain":true}}`:
baseline exits 0 with an envelope and an empty stderr; this story exited 2 with
`PANDA_KERNEL_PLUGIN_START_FAILED … 'retain' is not a workspace plugin config
key`. From the GLOBAL document that breaks `panda run` in every project on the
machine, and `packages/workspace-local/README.md` — added by this story — invites
users to write that object.

A reviewer measured all three treatments of the same subtree and the mirror was
worse than the headline: an unknown key was **fatal**; a valid `rootDir` was
validated and then **always overridden** by the session, so the configured root
was never created and the key was inert; a wrong-typed subtree was **silently
ignored**. "One document configures both" was half true, and the working half
did nothing.

Two fixes, both proven by execution and by mutation:

- **The session stopped shadowing the layers.** Its computed workspace root is
  now a config LAYER, not a plugin option: `invocation` when the caller named a
  `cwd` (this invocation's answer, and it wins), `defaults` when it did not (so a
  `workspace.rootDir` in the project document decides). The plugin's constructor
  option became a FALLBACK that applies only when no layer supplied one. Pinned
  by three clauses; the mutation that restores the override turns one red.
- **An unknown key is reported and survived.** The plugin emits
  `workspace.config.ignored` on the kernel bus per unrecognised key and per
  wrong-shaped subtree, `@skanl/panda-session` forwards them through a new
  `onWarning` seam, and `panda run` prints them on stderr. A `rootDir` that is
  present and unusable still REJECTS activation, because there is then nothing to
  serve — that is the one genuinely fatal case and it stays fatal.

The registry plugin's strict rejection was safe only while nothing seeded the
user's document into the kernel. This story changed that premise, so the strictness
had to change with it.

### 17. A caller can no longer forge the provenance panda prints

**Measured:** `runSession({ configLayers: { project: { filePath:
'C:/nowhere/.panda/config.json', document: { executor: 'codex' } } } })` reported
`{ executorId: 'codex', layer: 'project' }`, so `panda run` would print
`executor: codex (selected by the 'project' layer)` for a file that does not
exist. That line exists because "a swap you cannot see is not one you can trust",
and its layer half had become caller-assertable.

`readExecutorConfigLayers` now brands every document it actually read with a
module-private symbol. `seedExecutorConfig` composes a branded document into the
layer its file belongs to and an UNBRANDED one into `agent` — the layer that
means "the running host supplied this". Precedence is unchanged for `panda run`
(it passes only branded layers, and the four-layer provenance clauses in
`packages/cli/test/executor-selection.test.ts` pass unmodified) and a supplied
document is still narrower than a project file, which is correct: the host
supplied it deliberately. It simply cannot claim to be a file.

### 18. The config key is one constant now

**Measured:** `EXECUTOR_CONFIG_KEY` existed in `packages/session/src/executors.ts`,
a second unlinked one in `packages/adapter-cli/src/plugin.ts`, and a bare literal
in `run-session.ts`. The REPORTED selection and the MOUNTED adapter were derived
independently from the same document; renaming one produced
`executor: codex (selected by the 'project' layer)` on stderr while `claude` was
spawned, exit 0.

The constant now lives beside the catalogue in `@skanl/panda-adapter-cli` and is
imported everywhere else. This package's whole catalogue design exists because a
second spelling drifted from the thing it named; the key had no business being
the exception. The mutation that renames it turns two `panda run` clauses red.

### 19. What `manifest.configSchema` actually does

**Measured:** replacing BOTH new plugins' schemas with a no-op that accepts
anything leaves 103, 23, 84 and 53 tests green. The kernel only PROBES the field
for shape (Standard Schema v1, synchronous, non-throwing) and never applies it to
the plugin's subtree; all enforcement is the factory's own call to its own
schema. Inherited from `@skanl/panda-registry`'s plugin, not invented here.

Not fixed in this story, and deliberately: applying it is a kernel semantic
change that touches an existing plugin and it is not on this spec's Ask-First
list. What changed instead is honesty — the schema constant now says what the
kernel does and does not do, and a clause pins the real enforcement point (a
factory that stopped validating fails it while the manifest is untouched). The
kernel fix is proposed in `deferred-work.md` with this measurement as evidence.

### 20. Two smaller corrections

- **The dead `try/catch` is gone.** `runCandidate` in the kernel already converts
  a throwing plugin factory into `PANDA_KERNEL_PLUGIN_START_FAILED` naming the
  plugin AND preserves the original as `cause`; the local catch produced the same
  message while discarding the cause chain, and left one clause unable to tell
  plugin containment from kernel containment.
- **Mount-time options are read ONCE, at construction.** `options.cost` was read
  live inside the executor factory, so mutating the options object between
  `createExecutorPlugin(...)` and `kernel.start()` priced a run at 0 under a 0.5
  cap. `createActionPipeline`'s own documentation states the opposite discipline
  verbatim, and this was the fourth TOCTOU of that class in this repository.
  Both plugins now destructure at construction; both have a clause.

### 21. Recorded, not fixed

- **Deep nesting still overflows uncoded.** At ~3000 levels the
  `Maximum call stack size exceeded` comes from `dump()` inside `selectExecutor`,
  OUTSIDE the `setLayer` wrap, and names no file. At 4000 the wrap does fire.
  Pre-existing; #5 above implied the whole band was covered and did not say
  "`setLayer`". Filed.
- **`ARCHITECTURE-SPINE.md`'s AD-2 diagram disagrees with the code**, now three
  times over (`adapter-cli`, `workspace-local`, and `registry` since Story 1.2),
  on top of a larger pre-existing divergence (`@skanl/panda-environment` depends on
  both `@skanl/panda-projection` and `@skanl/panda-registry`). #9 argued around the diagram
  instead of proposing an amendment. Filed as documentation debt naming both.
- **A throwing `createAdapter` now reports a wrapped message.** It arrives as
  `PANDA_KERNEL_PLUGIN_START_FAILED … executor: <original>` rather than the bare
  error. SDK seam only, not argv-reachable, and the pre-existing clause survives
  on `toContain`. Filed.
- **The `executor` subtree is a bare string with no room to grow.** Per-executor
  options are reachable only through mount-time `adapterOptions`, so adding them
  later is a break to `.panda/config.json`. The no-second-spelling judgment stands;
  the ceiling is filed.
- **The SDK's two-call shape still builds two configurations.** `panda run` builds
  and seeds exactly ONE (verified with an instance counter). But
  `resolveExecutor(...)` → `runSession({ executorId })` — the shape in
  `consumer.test.ts` and in `consumer-install.proof.ts` — builds two, and the
  kernel's receives `[defaults, invocation]` only, so no mounted plugin sees the
  user's document. It is not fixable without either reading files inside
  `runSession` (pinned forbidden by "reads no configuration of its own") or
  changing `ExecutorSelection`'s shape (pinned by `toEqual`) or editing two
  pre-existing test files. What changed is the DOCUMENTED path: `@skanl/panda-session`'s
  README now shows `readExecutorConfigLayers` → `runSession({ configLayers })`,
  and a clause proves a document's `workspace.rootDir` reaches a mounted plugin
  through it. Filed.

### 22. Mutation results (second round)

Fourteen weakenings, one per fix, each the smallest realistic form. All fired;
all reverted.

| # | Weakening | Guard that failed |
|---|-----------|-------------------|
| 1 | the thin-binding pin stops naming the capabilities | `pnpm lint` over the planted CLI composition: 1 error → 0, exit 1 → 0 |
| 2 | `@skanl/panda-session` re-exports `createKernel` + both plugin factories | session surface clause |
| 3 | an unknown key in the `workspace` subtree is an issue again | "REPORTS an unknown key on the bus and keeps serving" |
| 4 | the mount-time `rootDir` overrides the document again | "lets the CONFIGURED rootDir win over the mount-time fallback" |
| 5 | the session passes its root as a plugin option again | *equivalent mutant* — the plugin-side fallback makes it a no-op, which is the point: the root cause was fixed where all callers route through, and #4 covers the class |
| 6 | the plugin stops emitting configuration warnings | "REPORTS a subtree of the wrong shape instead of ignoring it in silence" |
| 7 | the session stops forwarding them to `onWarning` | "reports an unknown key instead of failing the run, and says which key" |
| 8 | a host-supplied document is composed as the layer it claims | "reports a host-supplied document as the agent layer" |
| 9 | `createProvider` is allowed beside a supplied kernel | "refuses createProvider beside a kernel" |
| 10 | the executor service is not frozen | "is FROZEN, so a kernel holder cannot take other callers off the waterfall" |
| 11 | `cost` is read live at activation | "reads its cost ONCE, at construction" |
| 12 | `EXECUTOR_CONFIG_KEY` renamed in one of its two homes | two `packages/cli/test/executor-selection.test.ts` clauses, unmodified |
| 13 | the workspace plugin is not mounted on the session-owned path | "serves the workspace from the mounted plugin, under the cwd it was given" |
| 14 | `describeFailures` reports only `failures[0]` | "names EVERY plugin that failed, not just the first" |

### 23. Test counts after the review round

New in this story: 11 (`adapter-cli/test/plugin.test.ts`), 12
(`workspace-local/test/plugin.test.ts`), 22
(`session/test/kernel-composition.test.ts`) — 45 clauses.

Totals: kernel 187, contracts 58, workspace-local 23, registry 60, adapter-cli
103 + 6 skipped, session 84, projection 142 + 3 skipped, environment 61, cli 53.
`pnpm check` green with every `dist/` deleted first; `pnpm proof:consumer-install`
green, 8 passed. `git diff` empty on every pre-existing test file.

## Design Notes

**Why the container needs no building.** `createKernel` constructs its log sink in its first statements, and `loadPlugins(manifests, log)` takes the sink as a required positional parameter, so AD-4's ordering is a type error to violate rather than a comment someone must keep true. `kernel.config` is already exposed for seeding; nothing has ever seeded it. This story is composition, not construction — the same shape as ROADMAP-01's diagnosis, one level up.

**Why one pipeline matters beyond hygiene.** M3.C makes the token budget real. A budget cannot mean anything while every session builds its own pipeline and a public constructor can build another with no caps. Mounting is what gives a cap something to be a cap of.

**Deliberately not built.** No dynamic loading, no plugin discovery, no trust surface, no envelope change, no new command, no memory provider.

## Verification

**Commands:**
- `pnpm check` -- expected: fully green, existing CLI and session suites unmodified
- `pnpm proof:consumer-install` -- expected: still green, the composed path still reachable from an installed tarball
