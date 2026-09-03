# Spec M12.A — AD-2 is enforced where it says it is

**Status:** FROZEN
**Story:** not an epic story. Closes two claims this repository makes and does
not keep: `AGENTS.md` lists AD-2 under "Architecture — **enforced**" while it is
gated in 4 of 10 packages, and `ARCHITECTURE-SPINE.md` promises third parties
they can implement any port installing only `@panda/contracts`, which nothing
tests.
**Base commit:** `066bf3f`

---

## Intent

AD-2's own text names what it exists to prevent: **"dependency-rule-by-lint-discipline"**.
Six of ten packages are dependency-rule-by-discipline today.

This is not speculative hardening. AD-2 HOLDS at this commit — measured, all ten
packages, zero violations — and nothing would report the day it stopped. The
defect is not a broken topology; it is a rule listed as enforced that is not, in
a repository whose first rule is that a guarantee stated in prose instead of
enforced by something that fails is a defect.

## The measurement this rests on

Executed 2026-09-03 at `066bf3f`, every zero with a control.

| # | Claim | Evidence |
|---|---|---|
| M1 | AD-2 is gated in 4 of 10 packages | `test/guard.test.ts` exists in `environment`, `kernel`, `projection`, `session`. Absent from `adapter-cli`, `cli`, `contracts`, `registry`, `workspace-git-worktree`, `workspace-local`. **Control:** the same listing finds `packages/kernel/test/guard.test.ts` and correctly reports `packages/registry/test/guard.test.ts` missing. |
| M2 | `AGENTS.md` understates its own gap | It says "**4 of 10 packages**. `registry` and `cli` have none, which is a known gap, not a permission." The count is right and the naming is not: SIX have none. |
| M3 | AD-2 HOLDS today | A checker over all `@panda/*` imports in every `packages/*/src`, against the role order declared in `ARCHITECTURE-SPINE.md:53-64`, reports **zero violations across 75 source files**. `contracts` imports nothing; `kernel` imports nothing. |
| M4 | The checker is FALSIFIABLE, not just green | A planted `import { createKernel } from '@panda/kernel'` inside `packages/contracts/src` is reported as exactly one violation, naming only that package, with every other row still `ok`. Removed; tree clean. |
| M5 | The third-party promise has no gate | `ARCHITECTURE-SPINE.md:66` — "Third parties implement any port installing only `@panda/contracts`." `packages/session/test/consumer-install.proof.ts:64` installs `@panda/session` **plus the five packages it pulls in**. That proves the session bundle is installable; it says nothing about contracts alone. |
| M6 | Nothing is broken behind either claim | `contracts` has zero `@panda/*` imports, so an install of it alone would work today. Both halves gate a rule that currently holds — which is what a gate is for, and what the FR-29 proof already does for its own claim. |

---

## Boundaries & Constraints

### D1 — ONE derived gate for the universal rule, not six hand-written twins

The four existing `guard.test.ts` files are NOT duplicated by this and are not
replaced. They carry package-SPECIFIC clauses no generic checker can express —
`@panda/environment`'s permits only `access`, `constants`, `mkdir` and `stat`
from the filesystem and forbids the literal string `atomicWriteText`. Those stay
exactly where they are.

What this adds is the one clause that is the SAME for every package and is
therefore a fact about the graph rather than about any package: strictly-downward
imports. Writing it six more times would be six spellings of one rule, which is
how two answers come to disagree.

### D2 — the declared order lives in ONE place, and it is the architecture's

`ARCHITECTURE-SPINE.md:53-64` declares the roles. The gate restates that order in
code because a mermaid diagram is not executable, and the restatement is the
thing under test: a package added to `packages/` and NOT placed in the order must
FAIL the gate rather than pass unclassified. An unknown package silently treated
as "fine" is the hole this whole story is about.

### D3 — `contracts` installable ALONE gets its own scenario, in the existing proof

Not a new harness. `consumer-install.proof.ts` already packs tarballs, installs
into a scrubbed temp consumer outside the repo, and imports. This adds one
scenario to that machinery: pack `@panda/contracts` alone, install it alone,
import it, and use a port type from it. Its control is the existing session
scenario, which proves the harness runs.

### D4 — AD-1 is a stricter case of the same rule, and stays where it is

`kernel` depends on NOTHING, "not even contracts". That is AD-1 and it already
has its own gate (`packages/kernel/test/guard.test.ts`). The topology gate
expresses it as tier 0 with an empty allowlist, so the two agree; it does not
replace the kernel's guard, whose clauses are richer.

### D5 — correct AGENTS.md to what is measured

The line naming "`registry` and `cli`" is corrected to name all six, or to stop
naming a subset. A document that states its own gap and gets the gap wrong is
the same defect one level up.

### D6 — not in this story

- Adding the six missing package-specific `guard.test.ts` files. The universal
  rule is what this closes; a bespoke guard per package is a decision per
  package and has no measured hazard behind it today.
- Removing `private: true` or publishing anything. The third-party promise is
  tested here; whether to ship is the owner's call and is not this story's.
- Any change to the declared topology itself.

---

## I/O & Edge-Case Matrix

| # | Input / state | Expected |
|---|---|---|
| E1 | The repository as it is | Gate passes; zero violations. |
| E2 | A package imports one tier ABOVE itself | FAIL, naming the package, the import, and both tiers. |
| E3 | A package imports a SIBLING at its own tier | FAIL — "strictly downward" is strict. |
| E4 | `contracts` imports any `@panda/*` | FAIL. |
| E5 | `kernel` imports any `@panda/*`, contracts included | FAIL (AD-1). |
| E6 | A NEW package appears in `packages/` with no declared tier | FAIL, naming it — never silently passed. |
| E7 | A declared tier names a package that no longer exists | FAIL — the order must not rot. |
| E8 | An import inside `test/` rather than `src/` | Out of scope for the tier rule; `test` may reach anywhere. Stated so the boundary is deliberate. |
| E9 | `@panda/contracts` packed and installed ALONE, then imported | Succeeds, and a port type is usable from it. |
| E10 | `contracts` gains a runtime dependency | E9 fails at install or import. |

---

## Code Map

- `packages/contracts/test/topology.test.ts` — NEW. The one derived gate. Lives
  in `contracts` because that is the package every other one sits on, and
  because it is the package with no guard today.
- `packages/session/test/consumer-install.proof.ts` — one scenario: contracts
  packed, installed and imported alone.
- `AGENTS.md` — the AD-2 line corrected to what is measured.

---

## Tasks & Acceptance

- [ ] The topology gate, derived from ONE declared order
- [ ] Every failure mode of the matrix produces a FAILURE, not a pass
- [ ] The contracts-alone install scenario in the existing proof
- [ ] `AGENTS.md` names the real gap

**Acceptance Criteria:**

1. **The gate FAILS on a planted upward import** — a real one, in a real file,
   in `packages/contracts/src`, reported as exactly one violation naming only
   that package, with every other package still passing. Then removed.
2. **The gate FAILS on a package with no declared tier.** Add a directory under
   `packages/` with a `src/`, and the gate names it rather than skipping it.
3. **`@panda/contracts` installs and imports ALONE**, in the existing proof's
   scrubbed consumer, with the session scenario still passing as its control.
4. **`AGENTS.md`'s AD-2 line matches the measurement**, and the count and the
   names agree with each other.

---

## Ask First

- Any change to the declared topology in `ARCHITECTURE-SPINE.md`.
- Removing or weakening any of the four existing `guard.test.ts` files.
- Anything touching `private: true` or the publish set.

---

## Spec Change Log

0. Frozen at `066bf3f`.

---

## Verification

The implementer falsified its own gate with two plant shapes. The COORDINATOR
then planted a THIRD it had not tried, because a falsification that lands in the
shape the checker happens to catch is worth nothing -- the lesson M11.A shipped a
critical to learn, one story ago.

### The gate, falsified three independent ways

| plant | by | result |
|---|---|---|
| UPWARD, static: `@panda/session` (tier 2) inside `packages/contracts/src/errors.ts` (tier 0) | implementer | exactly one violation, naming only contracts |
| SIBLING, static: `@panda/kernel` (tier 0) in the same file -- a different comparison branch (`==` rather than `>`) | implementer | exactly one violation |
| **UPWARD, DYNAMIC, DIFFERENT PACKAGE**: `await import('@panda/environment')` (tier 2) appended to `packages/projection/src/index.ts` (tier 1) | **coordinator** | `@panda/projection (tier 1) imports @panda/environment (tier 2) -- imports must be strictly downward`, exactly one violation, correct tiers both sides |

The third shape matters twice over: it is a different package, and it is a
DYNAMIC import. The coordinator's own prototype used a `from '...'` regex that
would have missed it; the shipped gate reuses the repository's existing
`importsOf`, which sees dynamic and re-export forms. Every plant was removed and
the tree verified unmodified afterwards; the gate returns 4/4 green.

### The order cannot rot in either direction

- A package directory with a `src/` and no declared tier: TWO clauses go red,
  both naming it. Removed.
- A declared tier naming a package that does not exist: red, naming it in the
  diff. Reverted.

### AD-2 holds, and now something says so

Zero violations across every `@panda/*` import in all ten `packages/*/src`
trees. `contracts` imports nothing; `kernel` imports nothing, which is AD-1
expressed as tier 0 with nothing beneath it rather than as a special case.

### The third-party promise, gated for the first time

`ARCHITECTURE-SPINE.md` promises a port is implementable installing ONLY
`@panda/contracts`. The FR-29 proof went from 9 scenarios to 10. The new one
packs that single tarball, installs it into its OWN project rather than the
session consumer -- installing into a tree that already holds five packages
would prove nothing, which is the whole claim -- and then asserts ALONE **from
the installed tree, not from the manifest that asked**: `readdir` of
`node_modules/@panda` must equal exactly `['contracts']`. It then imports it,
exercises a coded `PandaError`, and typechecks a class `implements
WorkspaceProvider` against the shipped declarations, with a `@ts-expect-error`
that would itself fail if the import had degraded to `any`.

Falsified: pointed at a tarball that DOES have a runtime closure, that one
scenario goes red under `--offline` while the session control stays green.

### AGENTS.md now matches the measurement

Four named as having a guard test (`environment`, `kernel`, `projection`,
`session`) and six named as not (`adapter-cli`, `cli`, `contracts`, `registry`,
`workspace-git-worktree`, `workspace-local`). Verified against reality:
`ls packages/*/test/guard.test.ts` returns exactly those four, and there are ten
package directories, so 4 + 6 = 10 and the six are the complement. Before this,
the count was right and only two of the six were named.

### The gate

Bytes 0. Typecheck 0 across all ten packages. Lint 0. **1,442 tests green on
Node 24 AND on Node 26.8.1** (1,438 before; the gate is four clauses), live
suites excluded. `pnpm build` clean and `pnpm proof:consumer-install` **10
passed / 1 skipped**, where it was 9 before.

`pnpm check` still aborts in `adapter-cli` on `confinement-live.test.ts`, the
known-red live suite driving real vendor binaries, untouched by this story.

### What this does NOT do, deliberately

The six missing package-specific `guard.test.ts` files are still missing, and
AGENTS.md now says so accurately instead of naming two of them. The universal
clause covers all ten packages; what those four guards add is package-specific
and not derivable -- `@panda/environment`'s permits exactly four filesystem
functions and forbids a literal string. Adding four more bespoke guards is a
decision per package with no measured hazard behind it, and this story does not
make it.
