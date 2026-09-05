# Spec M37.A — panda is installable, or it is not

**Status:** FROZEN
**Created:** 2026-09-05
**Base commit:** `b2d374c` (M36.A, CI green on both jobs)
**Story:** none as a board row. **The owner decided panda is published.** This
spec is that decision made mechanical.

## Intent

`m3a-distribution-and-a-falsifiable-sdk-proof` is marked `done` on the board, and
CI spends a job on every push proving a packed tarball imports cleanly — **a
tarball nobody can obtain.** Measured: 13 of 13 packages carry `"private": true`
at `"version": "0.0.0"`, there are 0 git tags and 0 publish steps in
`.github/workflows/` (control: 4 `run:` steps in `ci.yml`, so the query sees).

`README.md:21` says *"Not published, and that is a decision"*. The owner has now
made the other decision. This spec makes the repo tell the truth about it.

## The decision, and the fork it closed

Two position papers argued the publish surface and **agreed on every measured
fact**, disagreeing only on shape.

**Decided: all 13 packages, one scope `@panda/*`, lockstep at `0.1.0`.**

### Why the "minimal surface" option does not exist

`@panda/cli`'s runtime closure is **11 of 13 packages** — measured by walking
`dependencies` across all thirteen manifests: `environment`, `session`,
`contracts`, `kernel`, `projection`, `registry`, `lock`, `adapter-cli`,
`workspace-git-worktree`, `workspace-local`, and itself. Only the two memory
providers sit outside it, and nothing in the workspace imports them (control:
`@panda/contracts` appears in 12 manifests).

A published `@panda/cli` whose dependencies are unpublished workspace packages
**cannot be installed.** So the minimal option requires bundling, and bundling
costs three things this repo has decided against:

1. **There is no bundler here.** Measured: `esbuild|rollup|webpack|ncc|tsup`
   across the root and all 13 manifests returns nothing; control, `typescript`
   returns a hit in each. Adding one is net-new toolchain.
2. **The built `dist` emits bare `@panda/*` specifiers** (measured in
   `packages/environment/dist/index.js`), so bundling is not a flag — it is a
   different build.
3. **A bundle has no tiers.** `packages/contracts/test/topology.test.ts` pins
   every package to a tier by exact equality in BOTH directions and calls itself
   the architecture's executable statement of itself. Bundling erases in the
   shipped artifact exactly what that test exists to assert.

So the real fork was **11 versus 13**, not 2 versus 13.

### Why 13 and not 11

The two packages in dispute have **one source commit each**, against
`contracts`' 35 of 118. The cost model that says "more packages, more semver
cost" runs opposite to the measured churn distribution. And they are the only
shipped `MemoryProvider` implementations, so `MEMORY_CLAUSES` would otherwise be
a published clause array with no published implementation to read beside it.

### Why `0.1.0`, lockstep

NFR-8 (`epics.md:58`) says *"Contracts semver together"*. One shared version is
the literal reading: **one semver decision per release, not thirteen.**
`pnpm publish -r` rewrites `workspace:*` to the exact version, and that rewrite
is already under test at `consumer-install.proof.ts` (the installed manifest is
asserted to carry `0.0.0` rather than `workspace:*`).

`0.x` is the honest channel. Semver permits breaking changes in a `0.x` minor,
which is the correct answer to a project that shipped seven commits in one
session — a smaller published surface is not.

## Boundaries & constraints

- **This spec does NOT publish.** `npm whoami` is empty on this machine, so the
  scope's ownership is unverified and no credential exists. The deliverable is a
  repo where the first publish is one command, run by the owner.
- **`panda` unscoped is TAKEN** (0.6.5, measured). The scope is `@panda/*`; the
  BIN stays `panda`, which is unaffected by the registry name.
- **`publishConfig.access: public` is required on every package.** Scoped
  packages default to `restricted`; without it every publish is a private
  package or a paid-org error. Measured: zero manifests have it today.
- **A `LICENSE` file must sit in each packed directory.** All 13 declare
  `"license": "MIT"` and **0 of 13 carry the file** (control: the root has one).
  npm only auto-includes a LICENSE from the packed directory.
- Do not change `files`, `exports`, `repository` or `engines` — measured correct
  in all 13.
- The `panda-source` export condition stays: development still runs from source.
- All code, comments and identifiers in English.

## I/O & edge-case matrix

| situation | expected |
|---|---|
| `npm i -g @panda/cli` | installs; `panda --version` runs |
| `npm i -D @panda/contracts` | one package arrives, no closure |
| a package published without `publishConfig` | would be restricted — prevented by the manifest gate below |
| a package published with `private: true` | npm refuses — prevented by the same gate |
| `workspace:*` reaching a published manifest | already asserted against by the consumer proof |
| a LICENSE missing from a tarball | caught by the pack arm |
| the release tag pushed on a red gate | the release job re-runs the full gate first |

## Code map

| file | change |
|---|---|
| all 13 `packages/*/package.json` | drop `private`, `version: 0.1.0`, add `publishConfig: {access: public}` |
| all 13 `packages/*/LICENSE` | new — copy of the root MIT text |
| `packages/environment/README.md`, `packages/kernel/README.md` | new; the only two without one (control: 11 have one) |
| `README.md` | the "Not published, and that is a decision" section becomes the install line |
| `packages/contracts/README.md` | same, for the SDK audience |
| `.github/workflows/release.yml` | new; on `v*` tag, re-run the full gate then `pnpm publish -r` |
| `packages/session/test/consumer-install.proof.ts` | a manifest gate over all 13, and the CLI-tarball arm below |

## Tasks & acceptance

1. **AC1 — a manifest gate, not a checklist.** One clause asserts, over every
   directory under `packages/`, that each manifest has no `private`, carries the
   SAME version as its siblings, and declares `publishConfig.access === 'public'`.
   Derived from `readdir`, never a hand-written roster — the proof's existing
   pack clause is the model, and its own comment records the regression that
   made it derived ("the list held nine of ten").
2. **AC2 — the CLI tarball is INSTALLED, not merely packed.** The proof names
   this gap itself: `@panda/cli` is packed and never installed, so it can be
   "proven well-formed and still be unreachable from the binary". Install the
   CLI tarball into a throwaway consumer and run the binary. **This is the
   product; nothing else proves a user can get it.**
3. **AC3 — every tarball carries its LICENSE.** Asserted from the pack arm, over
   all 13, derived.
4. **AC4 — falsified.** Restore `private: true` on one package and the manifest
   gate reddens naming that package; drop a `publishConfig` and it reddens
   naming that one. Run both reverts.
5. **AC5 — the docs stop lying.** No file says panda is unpublished. Measured
   with a grep plus a control.
6. **AC6 — the gate.** `pnpm check` on Node 24 and 26, `pnpm build`,
   `pnpm proof:consumer-install`.

## Ask First

- If `pnpm publish -r` needs a manifest field this spec did not name.
- If adding `LICENSE` to each package changes any existing pack assertion.
- If the CLI tarball cannot be installed standalone — that would mean the
  closure is not what the dependency walk measured, and the whole shape is wrong.
- If the release workflow needs a secret the repo cannot describe without holding
  it.

## Spec change log

- 2026-09-05 — frozen at `b2d374c`. Shape decided by two position papers that
  agreed on the facts; the minimal-surface option was refused because it does not
  exist without a bundler the repo deliberately lacks.

## Verification

**AC1 — GREEN, and it landed somewhere the spec did not name.** The gate went
into `packages/contracts/test/versions.test.ts`, not the consumer proof, because
a clause asserting the OPPOSITE already lived there: `keeps 'private' on every
package, because publishing is a decision nobody has taken` -- `spec-m3a`'s Ask
First clause, which did exactly its job and stopped the change until a human
decided. It now pins the new decision. **A guarantee that changes direction still
needs something that fails when it is violated**, so it was replaced rather than
deleted. It also fails in seconds under `pnpm check` instead of after a full
pack-and-install, and the duplicate this spec had put in the proof was removed --
asserting it twice is the duplication this repo's own review lens is named for.

**AC2 — GREEN, with its claim NARROWED by measurement.** The clause installs the
`@panda/cli` tarball WITH its runtime closure, derived by walking the manifests,
and runs the binary. Installing the CLI tarball ALONE is **not provable before
the first publish** and that was driven, not assumed: npm answers
`ENOTCACHED ... registry.npmjs.org/@panda%2fenvironment`, because the dependency
it declares exists in no registry yet. The clause says so in its own comment
rather than asserting a smaller thing quietly.

**AC3 — GREEN.** Every tarball carries its LICENSE, with the manifest-presence
control beside it so an empty `packed` map fails first.

**AC4 — GREEN, both halves falsified separately.** `private: true` restored on
`@panda/lock` reddens naming `lock`; `publishConfig` dropped from
`@panda/registry` reddens naming `registry`.

**AC5 — GREEN.** No file claims panda is unpublished (control: the word `panda`
is findable in the same files). `README.md`'s "Not published, and that is a
decision" section is now the install line, and `packages/contracts/README.md`'s
"Not on a registry" block is now `npm i -D @panda/contracts`.

**AC6 — the gate, stated honestly.** `pnpm check` exits 1 on ONE clause, and it
is not this change's: `stream-mode-live.test.ts` compares the envelopes of two
REAL claude invocations and one of the two failed while the other succeeded --
`errorCount: 1` against a successful run. Re-run standalone it passes 1/1. The
file was not touched by M37.A. It is the live-suite placement problem already
recorded in `deferred-work.md`: a gate that depends on a third party's afternoon.
Everything else: typecheck 0, lint 0, bytes 0, build 0,
`proof:consumer-install` 13 passed / 1 skipped, and 167 of 168 in
`@panda/adapter-cli` with 7 skipped.

### What the act of proving installability surfaced

- **`panda --version` did not exist.** It appeared the moment the proof INSTALLED
  the binary instead of only packing it: the run printed the usage block and
  exited non-zero. It is the first thing anyone types after `npm i -g @panda/cli`.
- **Its first implementation was wrong in the layout that matters.** A fixed
  `../package.json` resolves to the manifest from `src/` and to
  `dist/package.json` -- a file no tarball carries -- from the built module. The
  wrong one is the one a USER gets. It now walks up to the manifest that names
  `@panda/cli`, verified in BOTH layouts, and throws rather than inventing a
  plausible `0.0.0`.
- **A teardown hook was a bet.** `confinement-live`'s `afterAll` retries an `rm`
  five times and CATCHES the failure, but nothing caught the 10s hook timeout
  while it retried; it failed a run in which all 168 tests had passed. Given an
  explicit budget, same shape as M35.A's.

### What this does NOT do

It does not publish. `npm whoami` is empty on this machine, so the scope's
ownership is unverified and no credential exists here. The repo is now a place
where the first publish is one command, and the command is the owner's.
