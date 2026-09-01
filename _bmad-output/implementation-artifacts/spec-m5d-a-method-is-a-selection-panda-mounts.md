# Spec M5.D — a method is a selection panda MOUNTS, not an entry panda projects

**Status:** FROZEN
**Implements:** Story 5.4 / FR-28 / UJ-3, on the answer measured in `planning-artifacts/research/cordis-spatiotemporal-composability-2026-09-01/research.md`
**Created:** 2026-09-01

---

## Intent

`@panda/contracts` publishes the MethodPlugin contract (M5.A) and enforces every
rule it states (M5.B). Panda the PRODUCT has no method vocabulary at all: no
verb, no key, no mount point. UJ-3 — *"Gaspar swaps methodology mid-project"* —
is one of three user journeys and nothing in the binary touches it.

This story gives panda a method: `panda swap method <specifier>` persists the
selection, and a session mounts it. It is deliberately the SMALLEST shape that
makes the published contract usable from the product, and the shape fell out of
a measurement rather than a preference — see D1, which reversed this author's
first decision.

## The measurement this rests on

Executed on 2026-09-01 at `88a5333`, never inferred.

1. **A method is not registry vocabulary, and the registry says so in its own
   words.** `packages/contracts/src/registry.ts` opens: *"The vocabulary panda
   DECLARES: **every word here reaches an executor**, `skill` through a
   materialise target and `mcp-server` through a config target. Both, and only
   both — exactly the two kinds the projection layer renders."* A method reaches
   no executor: panda mounts it in its own process. Adding `method` to
   `REGISTRY_ENTRY_TYPES` would break M4.E's rule as WRITTEN, not as paraphrased.

2. **The kernel refuses to be the loader, in writing.**
   `packages/kernel/src/manifest.ts` line 3: *"Validation performs no I/O in
   kernel-owned code: no fs, network, env reads, **or dynamic imports**."*
   Measured across `packages/*/src`: dynamic imports = **0**. Control:
   `export function` over the same glob = **81 in 38 files**.

3. **Loading a plugin from disk is `await import()`.** Measured on cordis, the
   only shipped implementation of declarative plugin loading:
   `packages/loader/src/config/tree.ts` falls back to plain `await import()`
   whenever Node's private ESM internals are absent, and `Loader.internal` is
   assigned at `index.ts:55` and never read outside `hmr`. The research note
   carries the full measurement.

4. **Live module reloading is out of reach honestly.** cordis's HMR needs
   `internal/modules/esm/loader`, gated on `--expose-internals`. Control: without
   the flag, `Cannot find module`. Requiring a Node flag is the §10 principle
   inverted. (Negative result, recorded because the obvious worry was wrong: the
   internals ARE present on Node 24.14.1 and 26.8.1 alike.)

5. **M5.C already built everything this needs except the mount.**
   `WRITABLE_CONFIG_KEYS` is `['executor']` in
   `packages/projection/src/config-write.ts`; `SWAP_NOUNS` is `['executor']` in
   `packages/cli/src/swap-command.ts`; both are one-element allowlists written to
   gain a second member. The scopes, the atomic symlink-safe write, and the
   effective-selection report come with them.

6. **`@panda/session` can host the mount with no new edge and no guard change.**
   Measured from the manifests and from `packages/session/test/guard.test.ts`:
   session declares `@panda/adapter-cli`, `@panda/contracts`, `@panda/kernel`,
   `@panda/workspace-local` — `@panda/contracts` already exports
   `activateMethod` and `validateMethodPlugin`. Session's guard pins that exact
   dependency list and forbids `@panda/cli`; unlike `@panda/environment`'s, it
   carries **no** filesystem-verb clause, so a dynamic import there breaks
   nothing. Read before deciding, which is M5.C's lesson applied.

7. **A forward-looking configuration key warns rather than fails.**
   `packages/workspace-local/src/plugin.ts` and `run-session.ts:148` record that
   one unknown key used to fail every run on the machine and now surfaces as a
   warning. So a `method` key written by this build is safe in an older one.

## Boundaries & Constraints

- **AD-1** — the kernel is not touched. Measurement 2 is the reason, in the
  kernel's own words.
- **AD-2** — **no new package and no new dependency.** The work lands in
  `@panda/session` (mount), `@panda/projection` (the allowlist M5.C published)
  and `@panda/cli` (the noun). Every guard test stays green unmodified; if one
  goes red, that is a finding, not a file to edit.
- **AD-5** — a method that cannot be loaded is REPORTED, never silently skipped.
  A run with a broken method selection must not quietly behave like a run with
  none.
- **AD-7** — coded errors. `PANDA_METHOD_INVALID_PLUGIN` and
  `PANDA_METHOD_HOOK_FAILED` already exist (M5.A); `PANDA_CONFIGURATION_UNUSABLE`
  covers a specifier that will not load. **No new error code.**
- All artifacts in English; relative imports carry `.ts`.

### D1 — a method is CONFIGURATION, and this reverses the author's first decision

The first decision was "`method` becomes a registry entry type", reasoned from
M4.F's precedent that a Profile is a selection *over* entries while a method is a
thing with an id and a location. Measurement 1 refused it: the registry's
declared vocabulary is defined as *what reaches an executor through projection*,
and a method reaches none.

So the method selection lives where the executor selection lives —
`<scope>/.panda/config.json`, under the allowlisted key `method`. That is:

- consistent with the registry's own rule rather than an exception to it,
- consistent with M4.F, which put selections in selection space,
- **smaller**: no new store, no envelope change, no NFR-6 path-field decision,
  no per-type field fit, no retirement machinery.

Recorded as a reversal rather than quietly corrected, because the reasoning that
produced the wrong answer — arguing from a precedent instead of reading the
definition — is the failure worth remembering.

### D2 — the value is a MODULE SPECIFIER, not an id into a store

There is no store, so there is no id. `panda swap method ./methods/tdd.ts` and
`panda swap method @acme/tdd-method` are both legal; the string is what
`await import()` receives.

**It is NOT normalised as a path.** A bare package name is not a path, and NFR-6
home-directory normalisation applies to registry path fields, which this is not.
Panda stores the specifier verbatim, exactly as M5.C stores the executor id.

### D3 — the mount point is the session; the ordering lives in the capability

`createSessionKernel` resolves the selection, imports the specifier, validates it
with `validateMethodPlugin`, and activates it with `activateMethod` — the
contract's own functions, unchanged. The handle is disposed when the session
stops, in the same unwind that stops the kernel.

The ordered guarantee FR-28 names — *outgoing `onDeactivate` runs fully before
incoming `onActivate`* — is a property of the CAPABILITY, not of a CLI process:
a fresh `panda swap method` process has nothing mounted to unmount. So the
capability exposes it and proves it, and the CLI persists a selection. That split
is ROADMAP-01 Correction A, and M5.C shipped the same shape for `executor`.

### D4 — v1 hot swap is mount/unmount, explicitly not live module reload

Measurement 4. The spec says so, the help text says so, and Story 5.4's
"hot-swap" wording is renegotiated here rather than delivered as a promise panda
cannot keep. A method changed on disk takes effect on the next session, not
inside the running one.

### D5 — FR-28's "listing available methods" CANNOT be met in v1, and this says so

FR-28's acceptance reads *"an invalid id exits non-zero listing available
methods"*. There is no installed-methods list in v1 and there cannot be: PRD §6.2
places official methodology plugins post-v1, and D1 removes the store that would
have held them.

**The renegotiation:** an unloadable specifier exits non-zero naming the
specifier and the reason it could not be loaded or validated. For an author
writing a method, "your module threw / is not a valid MethodPlugin, here is
which rule it broke" is strictly more actionable than a list of ids. Filed as a
deliberate deviation with its reason, not silently narrowed.

### D6 — not in this story

No `--for <id>` flag (it names an outgoing method id, which D1 removes). No
methods store. No `panda list` entry for methods. No built-in methodology —
PRD §6.2 places those post-v1, and shipping one here would decide what panda's
own methodology is inside a story about mechanism.

## I/O & Edge-Case Matrix

| # | Input / state | Expected behaviour |
|---|---|---|
| 1 | `swap method ./m/tdd.ts`, no config | document created holding exactly `{"method":"./m/tdd.ts"}`; exit 0 |
| 2 | `swap method X` where config already holds `executor` | `executor` preserved; both keys present |
| 3 | `swap method X` twice | second reports already selected; exit 0 |
| 4 | `swap method` with no specifier | exit 2, usage; nothing written |
| 5 | `swap method '   '` | exit 2, blank; nothing written |
| 6 | `project swap method X` | writes the project document; machine document untouched |
| 7 | machine written while project names another method | exit 0 **and** the effective-selection report names the overriding layer (M5.C's D3, inherited) |
| 8 | a session runs with a valid method selected | `onActivate` runs before the prompt; `onDeactivate` runs on stop |
| 9 | a session runs with **no** method selected | runs exactly as today; no warning, no failure |
| 10 | the specifier does not resolve | coded refusal naming the specifier and the resolution error; the run does **not** silently proceed |
| 11 | the module loads but is not a valid MethodPlugin | `PANDA_METHOD_INVALID_PLUGIN` listing **every** violation (M5.B's guarantee, inherited) |
| 12 | the module's `onActivate` throws | `PANDA_METHOD_HOOK_FAILED`; no handle exists, so `onDeactivate` never runs for an activation that did not happen |
| 13 | `onDeactivate` throws at session stop | coded, and the session still stops — a failed teardown is not retried |
| 14 | the capability swaps method A for B | A's `onDeactivate` **settles** before B's `onActivate` is called; proved by ordering, not by timing |
| 15 | that swap, where A's `onDeactivate` throws | B is **not** activated; the failure names which half failed |
| 16 | a config document holding `method` read by a build that does not know the key | warns, does not fail (measurement 7) |

Row 9 is the one that would be silent in the wrong direction: no method selected
is the ordinary state in v1, and it must cost nothing. Row 10 is the one that
would be silent in the other: a broken selection behaving like no selection is
panda running a different methodology than the one configured, which is the
`executor` failure 2.7c exists to prevent, repeated.

Row 14 is FR-28's actual acceptance criterion and the only place the ordering is
provable.

## Code Map

```
packages/contracts/src/method.ts    (unchanged — activateMethod already does this)
packages/projection/src/config-write.ts   ~ WRITABLE_CONFIG_KEYS gains 'method'
packages/session/src/
  methods.ts            resolveMethod(specifier) -> MethodPlugin  (await import + validate)
                        swapMethod(outgoing, incoming)            (D3's ordering)
  executors.ts          ~ read and type-check the `method` key beside `executor`
  run-session.ts        ~ activate on start, dispose on stop
  index.ts              + the two functions and their types
packages/cli/src/
  swap-command.ts       ~ SWAP_NOUNS gains 'method'; the id check branches by noun
  run.ts                ~ USAGE
packages/session/test/methods.test.ts     rows 8-15
packages/cli/test/swap-command.test.ts    ~ rows 1-7
_bmad-output/implementation-artifacts/
  deferred-work.md      + D5's renegotiation, + D4's ceiling, + the effect() refusal
  sprint-status.yaml    + m5d; 5-4 -> superseded
```

## Tasks & Acceptance

- [x] T1 — `resolveMethod(specifier)`: `await import()`, unwrap a default export, `validateMethodPlugin`, coded refusal on either failure (rows 10, 11).
- [x] T2 — `swapMethod(outgoing, incoming)`: outgoing's deactivate SETTLES before incoming's activate is called; a failed outgoing does not activate the incoming (rows 14, 15).
- [x] T3 — the `method` key: allowlist in `config-write.ts`, read and type-check in `executors.ts`.
- [x] T4 — mount in `createSessionKernel` / dispose on stop (rows 8, 9, 12, 13).
- [x] T5 — `SWAP_NOUNS` gains `method`; the noun decides which validator runs; USAGE lines.
- [x] T6 — tests for every matrix row; **row 14 must force the ordering, never time it** (the session ledger's race lesson).
- [x] T7 — `deferred-work.md` (D5, D4, and the `effect()` refusal); `sprint-status.yaml`.
- [x] T8 — gate green on Node 24 **and** Node 26; every existing `guard.test.ts` green **unmodified**.

**Done means:** `pnpm check` green on both Node versions (modulo the known
projection live red); every matrix row has a test; rows 10, 14 and 15 each fail
when their guard is removed; and no `guard.test.ts` was edited.

### The falsification must be per rule

Rows 10, 11, 12, 14 and 15 are five independent guards and three of them are
invisible when they fail: a broken specifier behaving like no method, an
activation ordering that is actually concurrent, and a failed outgoing hook that
still mounts the incoming all exit 0 today. Remove each alone and name the test
that dies.

## Ask First

Stop and ask rather than deciding:

- Any **new** `PANDA_*` error code (the Boundaries say none is needed).
- Any new package or new package dependency (AD-2, measurement 6).
- **Editing any `guard.test.ts`.** A red guard is a finding about this design,
  not a file to adjust — the M5.C lesson, made a frozen clause.
- Adding `method` to `REGISTRY_ENTRY_TYPES` after all (D1 says no, on the
  registry's own stated rule).
- Shipping a built-in methodology, or a methods store, or `--for` (D6).
- Attempting live module reloading (D4, measurement 4).

## Spec Change Log

- 2026-09-01 — frozen at `88a5333`. D1 **reverses** this author's first decision
  (`method` as a registry entry type), which was reasoned from M4.F's precedent
  instead of from the registry's written rule. Measurement 1 caught it before any
  code was written.

## Verification

Everything below was executed on 2026-09-01, not inferred.

### The gate

- `check-source-bytes` clean; `pnpm typecheck` — **10/10 Done**; `pnpm lint` — no issues.
- Suites, live files excluded (the known local red is `skills-discovery.live`):

  | package | result |
  |---|---|
  | session | **98 passed** (was 89, +9) |
  | cli | **122 passed** |
  | projection | 256 passed / 3 skipped |
  | contracts 142 · kernel 229 · registry 68 · environment 100 · workspace-local 23 · workspace-git-worktree 13 · adapter-cli 148 | unchanged |

- **Node 26.8.1 canary** — contracts 142, projection 256, session 98, cli 122.
- **No `guard.test.ts` was edited.** The one pinned-surface assertion that went
  red (`kernel-composition.test.ts`, the exact export list) was widened
  deliberately with its reasoning recorded in the test — see below.

### Be a user — which found the defect the suite could not

Driving the binary against a sandboxed `HOME`, with a real method module on disk:

```
$ panda swap method ./nope.mjs
PANDA_CONFIGURATION_UNUSABLE: panda could not load the method './nope.mjs': Cannot find module …\proj\nope.mjs   (exit 2)
$ panda swap method ./broken.mjs
PANDA_METHOD_INVALID_PLUGIN: invalid method plugin: 'version' must be a semver version …; 'onActivate' is declared without 'onDeactivate'   (exit 2)
$ panda swap method ./tdd.mjs
selected: './tdd.mjs' in '…\home\.panda\config.json'                                                             (exit 0)
$ panda swap executor codex
{ "method": "./tdd.mjs", "executor": "codex" }
$ panda run "say ok"
executor: codex (selected by the 'global' layer)  →  { "status": "ok", "data": { "result": "ok", … } }
marker: activate / deactivate
```

The second line is M5.B's "every violation, not the first" reaching a real
author. The marker is row 8 proved against the real binary and the real codex
adapter: the method mounted before the run and unmounted after.

**The first run of that pass failed completely, and the whole suite was green.**
`await import('./tdd.mjs')` inside `methods.ts` resolved against
`packages/session/src/`, so **no relative specifier could ever work** — which is
the ordinary way a local method is named. The tests missed it because every one
of them passed a `file://` URL, which sidesteps module resolution entirely: a
harness supplying what the real caller does not, for the second time in three
stories. Fixed with `resolveFrom(specifier, baseDir)` and pinned by a test that
passes a plain relative path.

### Falsification — six guards, six killed, per rule

| Mutation | Killed |
|---|---|
| the outgoing teardown is not awaited | 2, incl. `runs the outgoing onDeactivate to completion before the incoming onActivate is called` |
| a failed teardown no longer refuses the swap | 1: `does NOT activate the incoming when the outgoing teardown fails…` |
| the unresolvable specifier is rethrown raw | 3, incl. both `names the …` rows |
| the module is not validated against the contract | 1: `rejects one that breaks the contract, listing every violation` |
| the default-export unwrap removed | 3 |
| the relative specifier is not resolved against `baseDir` | 1: `imports a plain relative path from the directory panda was pointed at` |

No survivors. The ordering row is the one worth naming: it is **forced**, not
timed — the outgoing hook blocks on a promise the test controls, so a concurrent
implementation records `b:activate` in the wrong position and fails
deterministically rather than flaking on a slow machine.

### The pinned export surface, widened deliberately

`kernel-composition.test.ts` asserts `@panda/session`'s exact value exports so
that any widening is a decision. It went red, and the widening was made after
checking the rule it states — *"exports no factory that yields a kernel, a plugin
or an adapter"*. Neither addition does: `resolveMethod` returns a validated
MethodPlugin (a manifest `@panda/contracts` already validates in public) and
`swapMethod` returns a `MethodActivation` (what the public `activateMethod`
already returns). `selectMethod` was deliberately NOT exported — `runSession` is
its only caller, and publishing a surface nothing consumes is the defect the
handoff records for four kernel exports that nothing reads.

### What is NOT verified here

No live module reloading (D4). No installed-methods list (D5). A bare package
specifier resolves through `createRequire(baseDir)` and falls back to a plain
`import()` for an ESM-only package with no CJS-resolvable entry — measured as a
limitation, recorded in `deferred-work.md`, and not exercised by a test because
no methodology is published as a package in v1.
