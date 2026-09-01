# Spec M5.B — Every rule METHOD-PLUGIN.md states is enforced by something that fails

**Status:** FROZEN
**Implements:** the two contract defects left open by M5.A — SESSION-HANDOFF §9 items 1 and 2
**Created:** 2026-09-01

---

## Intent

`packages/contracts/METHOD-PLUGIN.md` is a published contract: it tells a third
party that everything they need is on that page, and that they should never have
to read panda's source. Two of its rules are stated in prose and enforced by
nothing.

1. It says an artifact `path` is **"relative to the project root"**. The
   validator accepts `../../etc/passwd`, `/etc/passwd`, `C:\Windows\...`, `~/…`
   and a path carrying a NUL byte — on the one field artifacts are later
   materialised from.
2. The exported `MethodPlugin` **type** rejects a misspelled key at compile
   time — a mistake the runtime validator already catches — and silently accepts
   `onActivate` without `onDeactivate`, which is the rule the document warns
   hardest about.

This is the defect class this whole milestone has been about: *a guarantee
stated in PROSE instead of enforced by something that FAILS when violated.*
After this story, every rule the document states is enforced by the validator,
the compiler, or both, and the document says which.

## The measurement this rests on

Every claim below was executed on 2026-09-01 at `087e357`, never inferred.

1. **`path` accepts everything except blank.** `methodPluginIssues` was run over
   nine forms:

   | input | verdict |
   |---|---|
   | `docs/plan.md` | ACCEPTED |
   | `../../etc/passwd` | **ACCEPTED** |
   | `/etc/passwd` | **ACCEPTED** |
   | `C:\Windows\System32\config` | **ACCEPTED** |
   | `\\server\share` | **ACCEPTED** |
   | `./a/../../../b` | **ACCEPTED** |
   | `~/secrets` | **ACCEPTED** |
   | `a\u0000b` | **ACCEPTED** |
   | `'   '` | rejected — **the control** |

   The last row is the control: the validator ran and can reject, so the eight
   ACCEPTED verdicts are findings, not a query that missed.

2. **The type catches the cheap half only.** Four literals typed as
   `MethodPlugin`, checked with `tsc --noEmit --strict`:

   | literal | compiler |
   |---|---|
   | `descripton: 'typo'` | **TS2561** — rejected (*the control*) |
   | `onActivate` with no `onDeactivate` | accepted |
   | `version: 'latest'` | accepted |
   | `phase: 'nope'` with no phases | accepted (inherently runtime) |

3. **A template-literal semver type is measurably WORSE than none.** `type S =
   \`${number}.${number}.${number}\`` was checked against nine strings with a
   control:

   | string | the type | real semver |
   |---|---|---|
   | `1.0.0` | matches | valid ✓ *(control)* |
   | `01.0.0` | **matches** | invalid ✗ |
   | `-1.0.0` | **matches** | invalid ✗ |
   | `1e3.0.0` | **matches** | invalid ✗ |
   | `1.0.0-rc.1` | **rejects** | valid ✗ |
   | `1.0.0+build.5` | **rejects** | valid ✗ |
   | `1.2`, `latest` | rejects | invalid ✓ |

   It is wrong in both directions, and the second direction is the disqualifying
   one: it would break the build of an author publishing a legitimate
   `1.0.0-rc.1`. Settled by D2 below.

4. **`@ts-expect-error` is a real, failing guard here.** A directive on a line
   with no error raises **TS2578 "Unused '@ts-expect-error' directive"**, and
   `packages/contracts/tsconfig.json` includes `test`, whose `typecheck` script
   is `tsc --noEmit` and runs inside `pnpm check`. So a type rule asserted this
   way FAILS the gate the moment the type stops enforcing it. Verified by
   execution, with the erroring line as its own control.

5. **Nothing consumes `MethodArtifact.path`.** `MethodArtifact`,
   `validateMethodPlugin`, `methodPluginIssues`, `activateMethod` and
   `METHOD_PLUGIN_*` appear outside `packages/contracts/src/method.ts` and its
   test only in: `METHOD-PLUGIN.md`, `src/index.ts` (re-export), two spec files,
   and `.scratch/` probes. **No materialisation exists yet.** This is the last
   moment tightening `path` is free; once third-party plugins exist it is a
   breaking change under NFR-8, which versions every Contract together.

6. **No containment helper is reachable from `contracts`.**
   `isUnderRoot(path, root)` exists in `packages/projection/src/ledger.ts`, and
   AD-2 forbids `contracts` importing `projection` (strictly downward). Control:
   the same grep over `packages/*/src` returned 20 files importing `node:path`,
   so the search worked. The rule this story needs takes **no root** anyway —
   "is this a relative path that cannot escape its base" is a pure string
   question.

7. **`METHOD_PLUGIN_ROOT_KEYS` is pinned by an exact-list assertion** at
   `packages/contracts/test/method.test.ts:120`. It asserts VALUES, not the type
   export list, so D3's two new type exports do not touch it.

8. **NUL bytes must be written as `\u0000`.** `scripts/check-source-bytes.mjs`
   is the first step of `pnpm check` and fails on a literal NUL in any source
   file. The row-9 fixture below is written as the escape.

## Boundaries & Constraints

- **AD-1** — the kernel keeps zero runtime dependencies and is not touched here.
- **AD-2** — `@panda/contracts` gains **no** dependency. `node:path` is already
  imported by `registry.ts` in this package, but the path predicate below needs
  none and must not add one (see D1).
- **AD-5** — typed absence over silence.
- **AD-7** — every refusal is a coded `PandaError`. **No new error code.** A bad
  `path` is a contract violation like any other: `PANDA_METHOD_INVALID_PLUGIN`,
  listed alongside every other violation in the same message.
- `activateMethod`'s runtime semantics are **frozen and untouched**: validate,
  then mount, handle-is-disposer, double-`deactivate` is a no-op, coded hook
  failure. This story changes what counts as valid, never what happens after.
- Relative imports carry the `.ts` extension. All artifacts in English.

### D1 — the `path` rule, exactly

The owner chose **enforce** over "admit it is a convention" (2026-09-01). The
predicate is published as `isProjectRelativePath(value)`, the same way M5.A
published `isSemver`, so an author can check a path before shipping instead of
discovering the rule from a rejection.

It is a **pure string predicate with no `node:path` and no filesystem access**.
A manifest is authored once and consumed on every platform, so the verdict must
not depend on the platform the validator happens to run on — `node:path` on
POSIX would call `C:\Windows` a legal relative filename.

**Rejected, each with its reason:**

| # | Rejected | Why |
|---|---|---|
| 1 | empty or whitespace-only | already rejected; unchanged |
| 2 | contains `\u0000` | truncates in syscalls; the byte that hides defects |
| 3 | contains a backslash | see below |
| 4 | starts with `/` | POSIX-absolute; also covers `//server/share` |
| 5 | matches `^[A-Za-z]:` | Windows drive-prefixed — `C:\`, `c:/` and drive-relative `C:foo` alike |
| 6 | starts with `~` | a leading `~` is a RESERVED marker in this codebase (`normalizeRegistryEntryPaths`), and a home path is not project-relative |
| 7 | escapes its base | after resolving `.` and `..` segments, a leading `..` remains |
| 8 | resolves to nothing | `a/..` names the project root, which is not an artifact |

**On rule 3, because it goes one step past the document's literal words.**
`docs\plan.md` is a nested file on Windows and a single flat filename on POSIX:
the same manifest, two different meanings. That is precisely the "kept
syntactically, broken in substance" failure this milestone keeps shipping. So
`path` uses `/` as its separator on every platform — the rule every
cross-platform manifest format already uses — and the document says so. The cost
is real and small: an author cannot declare a POSIX filename that contains a
literal backslash. Record it in `deferred-work.md` with that cost named.

Rule 3 also makes `..\..\etc` a separator rejection rather than a traversal one.
Both must be tested independently (matrix rows 5 and 6); a guard whose only test
is killed by a different guard is not tested.

**Accepted, and this half matters as much:** `docs/plan.md`, `./docs/plan.md`,
`a/../b`, `a/b/../../c`, `docs/` — resolving `..` inside the base is legal, only
escaping is not. Inventing a rule the document does not need blocks legitimate
manifests, which is its own defect.

**Panda does not rewrite the value.** `path` is validated and stored verbatim.
Normalisation is a materialisation decision and no materialiser exists (M6).

### D2 — semver stays a runtime rule, and the document says so

Measurement 3 settles it: the only type-level spelling available is wrong in
both directions and would reject valid prereleases. No semver type ships.

What ships instead is **honesty**: METHOD-PLUGIN.md gains a short table naming
which rules the compiler enforces and which the validator does, so an author who
compiled clean knows exactly what they have not yet been told.

### D3 — the pair rule moves into the type

RD-3's pair rule is expressible in TypeScript exactly, so it becomes a compile
error instead of a runtime one:

```ts
export interface MethodManifest { /* id, version, description?, phases, artifacts, commands, extensions? */ }

export type MethodHookPair =
  | { readonly onActivate?: undefined; readonly onDeactivate?: undefined }
  | { readonly onActivate: MethodActivateHook; readonly onDeactivate: MethodDeactivateHook }

export type MethodPlugin = MethodManifest & MethodHookPair
```

`?: undefined`, not `?: never`: the runtime rule is `value['onActivate'] !==
undefined`, so an explicit `onActivate: undefined` is accepted at runtime, and
the type must agree with the validator rather than with a neater-looking type.

Both new names are **exported** — `tsc -p tsconfig.build.json` emits
declarations, and an exported alias over a private name is TS4081. They go on
the document's export list too. Two names is the honest price.

This is a narrowing of a published type, and it breaks nothing that worked: a
half-pair manifest was always rejected at runtime. It converts a runtime
rejection into a compile-time one.

**The unknown-key rejection (TS2561) must survive.** Excess-property checking
against an intersection-with-a-union is the risk this decision carries; if it
regresses, the type has traded a guard for a guard and the change is not worth
making. Task T5 pins it.

## I/O & Edge-Case Matrix

`path` rows are `artifacts: [{ id: 'a', path: <input> }]` on an otherwise valid
manifest, so the only issue that can appear is the one under test.

| # | Input / state | Expected behaviour |
|---|---|---|
| 1 | `path: 'docs/plan.md'` | accepted — **the positive control** |
| 2 | `path: './docs/plan.md'` | accepted |
| 3 | `path: 'a/b/../../c'` | accepted; `..` inside the base is legal |
| 4 | `path: '../../etc/passwd'` | rejected, naming the escape |
| 5 | `path: '..\\..\\etc'` | rejected — by the **separator** rule (D1 §3) |
| 6 | `path: '/etc/passwd'` | rejected — POSIX-absolute |
| 7 | `path: 'C:/Windows'` and `path: 'C:x'` | rejected — drive-prefixed, both spellings |
| 8 | `path: '~/secrets'` | rejected — reserved marker |
| 9 | `path: 'a\u0000b'` (written as the escape) | rejected — NUL |
| 10 | `path: 'a/..'` | rejected — resolves to the project root, names no artifact |
| 11 | `path: 'docs\\plan.md'` | rejected — separator, even though it escapes nothing |
| 12 | `path: '   '` | rejected — unchanged from today |
| 13 | two artifacts, both bad paths | **both** issues listed; the message lists every violation, not the first |
| 14 | a bad `path` plus a bad `version` | both listed; the path rule composes with the rest |
| 15 | `isProjectRelativePath` called directly with a non-string | `false`, no throw |
| 16 | valid manifest, `onActivate` only | runtime rejects (unchanged) **and** the compiler rejects (new) |
| 17 | valid manifest, both hooks | accepted by both |
| 18 | valid manifest, neither hook | accepted by both |
| 19 | `onActivate: undefined` written explicitly, no `onDeactivate` | accepted by both — the type agrees with the validator (D3) |
| 20 | a misspelled root key in a typed literal | **still** TS2561 |

Row 13 is the one that would be silent: a per-field early return would report
the first bad path and hide the second, and the document promises every
violation.

## Code Map

```
packages/contracts/
  src/method.ts        + isProjectRelativePath (pure, no node:path, no fs)
                       + the path check inside collectionIssues' artifact pass
                       ~ MethodPlugin: interface -> MethodManifest & MethodHookPair
                       + MethodManifest, MethodHookPair
  src/index.ts         + isProjectRelativePath, type MethodManifest, type MethodHookPair
  METHOD-PLUGIN.md     ~ the artifacts section: the path rule, accepted/rejected
                       + "what the compiler catches, what the validator catches"
                       ~ the export lists
  test/method.test.ts  + matrix rows 1-15 (runtime)
                       + rows 16-20 as @ts-expect-error assertions (compile-time)
_bmad-output/implementation-artifacts/
  deferred-work.md     + the backslash cost (D1 §3), + no semver type (D2)
  sprint-status.yaml   + m5b
```

The path check belongs **inside the existing artifact validation pass**, not in a
new walk of the array: one traversal, and the issue lands in the same list
beside every other one so row 13 falls out of the existing accumulation rather
than needing its own machinery.

## Tasks & Acceptance

- [x] T1 — `isProjectRelativePath` in `method.ts`: the eight rejections of D1, pure, no `node:path`, no filesystem. Exported from `method.ts` and `index.ts`.
- [x] T2 — wire it into the `artifacts` pass so a bad `path` is one more `StandardSchemaIssue`; message names the input and the reason. No new error code.
- [x] T3 — `MethodPlugin` becomes `MethodManifest & MethodHookPair` (D3); both new names exported from `method.ts` and `index.ts`.
- [x] T4 — runtime tests for matrix rows 1-15, with row 1 as the positive control in the same describe block.
- [x] T5 — compile-time tests for rows 16-20 as `@ts-expect-error` assertions in `test/method.test.ts`, **including row 20** (TS2561 must survive D3). Measurement 4 is what makes these fail when the type stops enforcing them.
- [x] T6 — METHOD-PLUGIN.md: the path rule with its accepted/rejected table, the compiler-vs-validator table (D2), the updated export lists.
- [x] T7 — `deferred-work.md` entries: the backslash cost, and "no semver type, with the measurement that disqualified it" so nobody adds one later.
- [x] T8 — `sprint-status.yaml` entry; gate green on Node 24 **and** Node 26.

**Done means:** `pnpm check` green on both Node versions; every matrix row has a
test; and each of the eight D1 rejections plus the D3 pair rule fails the suite
when its guard is removed — including, for the compile-time half, when the type
is reverted to the old interface.

### The falsification must be representative

The session ledger's hardest-won rule: *one plant landing in the one shape the
extractor accepted proves only that shape.* The path predicate has eight
independent rejection reasons, and several inputs trip more than one. A mutation
round that removes one rule and watches "the suite" go red proves nothing about
which rule was tested.

So the falsification is **per-rule**: remove rule N alone, and name the test that
dies. A rule whose removal kills no test, or kills only a test that another rule
would also have killed, is not tested — rows 5, 6 and 11 exist for exactly that
reason.

## Ask First

Stop and ask rather than deciding:

- Any **new** `PANDA_*` error code (the Boundaries say none is needed; a new code
  is a published-surface decision).
- Any dependency added to `@panda/contracts`, `node:path` included (AD-2, D1).
- Any change to `activateMethod`'s runtime behaviour, `METHOD_PLUGIN_SCHEMA`'s
  shape, or `METHOD_PLUGIN_ROOT_KEYS`.
- Normalising or rewriting `path` rather than validating it (D1 says validate
  only).
- Shipping a semver type after all (D2 says no, with the measurement).
- Widening or narrowing D1's eight rules. If one of them turns out to reject a
  legitimate manifest, **file it, do not implement past it** — the accepted half
  of the matrix is as load-bearing as the rejected half.

## Spec Change Log

- 2026-09-01 — frozen at `087e357`. Owner decided "enforce" over "admit it is a
  convention" for `path`; D2 was settled by measurement rather than by asking.

## Verification

Everything below was executed on 2026-09-01, not inferred.

### The gate

- `node scripts/check-source-bytes.mjs` — clean. The NUL fixture is written as a
  JSON-style unicode escape rather than as the byte, and the backslash fixtures
  survived the round trip; both verified with `cat -v`, never by reading.

  It caught a real one on the way. Writing this very section put a **literal NUL
  into the spec file**, in the sentence claiming the NUL is written as an escape:
  the editor turned the escape sequence into the character. `check-source-bytes`
  exited 1 and named the line. That is the third escaping bug in this session —
  a shell heredoc also collapsed a doubled backslash in a ledger entry — and both
  were found by `cat -v`, neither by re-reading the text.
- `pnpm typecheck` — **all ten packages Done**.
- `pnpm lint` — **No issues found**.
- Per-package suites, run individually because `pnpm check` aborts at the first
  failing package:

  | package | result |
  |---|---|
  | contracts | **142 passed** (was 128) |
  | kernel | 229 passed |
  | registry | 68 passed |
  | projection | 2 failed / 246 passed / 3 skipped — **pre-existing, see below** |
  | session | 89 passed |
  | environment | 100 passed |
  | workspace-local | 23 passed |
  | workspace-git-worktree | 13 passed |
  | adapter-cli | 148 passed / 6 skipped |
  | cli | 108 passed |

- **Node 26.8.1 canary** — `@panda/contracts`, 142 passed.

### The projection failure is not this story's

`packages/projection/test/skills-discovery.live.test.ts` fails with 2 tests red.
Rather than assume it was pre-existing, it was **measured**: this story's changes
were `git stash`ed, the file was re-run at `087e357`, and the same two tests
failed identically. Restored afterwards, tree verified. Recorded in
`deferred-work.md` as an occurrence, with the detail that makes it interesting —
the suite's own accounting invariant is what breaks (`measured 2 of 3 executors
-- the remaining cases did not report a reason`), so one executor fell into
neither the measured nor the not-measured bucket. CI is green on both jobs at
this SHA, so it is local/Windows.

### Falsification — eight path rules, eight killed, per rule

Each rule was removed **alone** and the suite re-run, because removing one and
watching "the suite" go red proves nothing about which rule was tested.

| Mutation | Killed |
|---|---|
| NUL rejection removed | 2, incl. `rejects a path carrying a NUL byte` |
| backslash rejection removed | 3, incl. `rejects a backslash traversal` **and** `rejects a backslash separator that escapes nothing` |
| leading-`/` rejection removed | 5, incl. `rejects a POSIX-absolute path` and `rejects a UNC path` |
| drive-letter rejection removed | 3, incl. both `drive-absolute` and `drive-relative` |
| `~` rejection removed | 2, incl. `rejects a home-marked path` |
| escapes-its-base check removed | 3, incl. `rejects a traversal that escapes the root` |
| `resolved.length > 0` → `true` | 2, incl. `rejects a path that resolves to the project root` |
| the wiring (`['path']` argument dropped) | **12** — every path row at once |

No survivors, and every rule has at least one test named after it alone. The
harness itself needed two corrections before it was trustworthy: the first run
reported "1 killed" for all eight because the JSON reporter never wrote its
output file, and the second because `execFile` with `shell: true` lost stdout.
Both were caught only because the harness printed **why** it could not read a
report instead of counting the unreadable result as a kill — a zero without a
control would have read as eight clean falsifications.

### Falsification — the type

`MethodPlugin` was reverted to the pre-M5.B flat interface (hooks independently
optional) and `tsc --noEmit` re-run:

```
test/method.test.ts(472,5): error TS2578: Unused '@ts-expect-error' directive.
test/method.test.ts(478,5): error TS2578: Unused '@ts-expect-error' directive.
```

Rows 16 and 16b die, exactly as intended. **Row 20 does not appear**, which is
the measurement D3 actually needed: excess-property checking (TS2561) still
works against an intersection-with-a-union, so the pair rule was added without
trading away the guard that was already there. Restored, `tsc` clean again.

### What is NOT verified here

Nothing materialises `MethodArtifact.path` yet, so the rule is proven correct as
a rule and has never been exercised by a materialiser — that is M6's to prove.
The `path` value is validated and stored verbatim; no normalisation exists. And
`@panda/projection`'s live-discovery accounting hole is recorded, not fixed.
