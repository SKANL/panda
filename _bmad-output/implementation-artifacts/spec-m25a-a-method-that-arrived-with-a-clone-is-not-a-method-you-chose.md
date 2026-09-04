# Spec M25.A — a method that arrived with a clone is not a method you chose

- **Story**: none open. A SECURITY defect, found by re-measuring `deferred-work.md`
  entry 60 against HEAD (M24.A).
- **Renegotiates**: an assumption M5.D never stated. See "What M5.D actually froze".
- **State**: frozen.

## Intent

`panda run` executes arbitrary code out of the directory it is run in.

A repository carrying its own `.panda/config.json` with a `method` key causes
`resolveMethod` to `await import()` that specifier, and the module's TOP-LEVEL
CODE RUNS before `validateMethodPlugin` refuses it, before any executor is
spawned, and before the user is told anything. Clone a repository, run `panda`
inside it, and you have run its author's code.

## The measurement this rests on

Executed on 2026-09-04 at `b6562ef`, driving the shipped binary. Every row has
its control.

1. **The clone path is real.** A throwaway `HOME` and a temp "cloned" project
   holding `hostile.mjs` (whose only statement is a `writeFileSync`) plus
   `.panda/config.json` naming `{"method": "./hostile.mjs"}`:

   | run | exit | module executed |
   |---|---|---|
   | `panda run hi` | 2 | **YES** |
   | CONTROL — same command, same project, no `method` key | 1 | no |

   The marker is caused by the `method` key and by nothing else.

2. **Validation cannot prevent it, and reordering cannot either.** A module is
   not inspectable without being loaded. The positive control makes the ordering
   explicit: `panda swap method ./hostile.mjs` exits 2 with
   `PANDA_METHOD_INVALID_PLUGIN` — the refusal fires AND the file exists.

3. **The mount happens early.** `run-session.ts:597-598` selects and resolves the
   method before `provider.create()` and long before the executor is invoked, so
   nothing downstream can gate it.

4. **The read verbs are NOT affected.** `doctor`, `list` and `project doctor`
   with the same hostile project all leave the marker unwritten. Only the verbs
   that MOUNT a method reach the import.

5. **The deciding layer is available at the decision point.** `selectMethod`
   already returns `{ specifier, layer }` (`packages/session/src/methods.ts:134-148`),
   and the layers are `defaults | global | project | agent`
   (`packages/session/src/executors.ts:357-367`).

## What M5.D actually froze, because this is a renegotiation and must be exact

M5.D put the method selection at `<scope>/.panda/config.json` deliberately
(`spec-m5d…:99`). Its I/O matrix is the frozen part, and **no row requires panda
to MOUNT a project-layer selection**:

- Row 6 — `project swap method X` **writes** the project document. Writing.
- Row 7 — machine written while project names another → exit 0 and the
  effective-selection **report** names the overriding layer. Reporting.
- Row 8 — "a session runs with a valid method selected" names no layer.

So refusing to mount from the `project` layer preserves every frozen row. What
it removes is a behaviour no row asserts and that the PRD places post-v1 anyway
(§6.2 — most runs select none).

## Boundaries & Constraints

### D1 — a `project`-layer method is REFUSED, not ignored

`AD-5`: unavailable is not failed, and silence is not an option here. A method
silently not mounted would run a different methodology than the document names —
which is the exact failure `selectMethod`'s own doc comment refuses for a
malformed value.

So the refusal is coded, and the run stops. `PANDA_CONFIGURATION_UNUSABLE`,
naming the specifier, the `project` layer, and the reason.

### D2 — the refusal carries the command that resolves it

"Panda must absorb the problem, not hand it back." The user who genuinely wants
that methodology gets the one command that adopts it into a document they own:
`panda swap method <specifier>`. That is an explicit act by the machine's owner,
which is precisely the consent that a cloned file cannot give.

### D3 — only `project` is refused

`global` is the machine owner's own file. `agent` is a document a host handed
over programmatically, which is that host's own code already. `defaults` cannot
carry a method. Widening the refusal past `project` would refuse the feature.

### D4 — the refusal happens BEFORE the import, or it is theatre

The check reads `selectMethod`'s returned `layer`. It must sit between
`selectMethod` and `resolveMethod`, because after the import the code has run.
A gate placed after `resolveMethod` would pass its test and prevent nothing.

### D5 — not in this story

- **Any per-directory trust mechanism.** Trust-on-first-use is the industry
  answer and it is a mechanism, not a patch. Recorded; not invented here.
- **Ownership tracking for config writes**, which would let panda honour a
  project method it wrote itself. Measured: `packages/projection/src/config-write.ts`
  records none (zero hits for ledger/owned/ownership; control — the file is 185
  real lines). That is the principled long-term shape and it is a story.
- **`panda swap method` itself.** A user typing a specifier is consenting to it.

## I/O & Edge-Case Matrix

| # | Input | Expected |
|---|---|---|
| E1 | `run` in a project whose `.panda/config.json` names a method | exit 2, coded refusal naming the specifier, the layer and `panda swap method <spec>`; the module is NOT imported |
| E2 | `run` with the method in `~/.panda/config.json` | mounts exactly as today |
| E3 | `run` with no method anywhere | unchanged; no warning, no failure (M5.D row 9) |
| E4 | `project swap method X` | still writes the project document (M5.D row 6) |
| E5 | machine and project both name a method | the machine one mounts; no refusal, because the deciding layer is `global` |
| E6 | a method supplied on the `agent` layer | mounts; that document is the host's own code |
| E7 | `doctor` / `list` in the hostile project | unchanged — they never mounted a method |

## Code Map

| Path | Change |
|---|---|
| `packages/session/src/methods.ts` | the layer check, between selection and resolution, with the reason written where it fails |
| `packages/session/test/methods.test.ts` | E1, E2, E5, E6 driven through the seam |
| `packages/cli/test/` or a driver | E1 driven through the BINARY, with the no-method control |

## Tasks & Acceptance

1. **T1** — RED first: a clause that mounts from the `project` layer and must
   fail. See it red, paste it.
2. **T2** — the check, before `resolveMethod`.
3. **T3** — falsify: move the check AFTER the import and confirm the clause goes
   green while the module still executes. A gate that passes in the wrong place
   is the thing D4 exists to prevent, and proving it is what makes D4 real.
4. **T4** — drive the binary: the hostile project, before and after, with the
   no-method control.
5. **T5** — `deferred-work.md`: entry 60 resolved-in-part, and D5's two
   deferrals recorded.
6. **T6** — gate on Node 24 AND 26, plus `pnpm build && pnpm proof:consumer-install`.

## Ask First

- Refusing any layer other than `project`.
- Any per-directory trust or prompt mechanism.
- Touching `panda swap method`'s own behaviour.
- Changing what M5.D's rows 1-9 assert.

## Spec Change Log

1. The first framing was "refuse project-scoped methods". Reading `spec-m5d:99`
   showed project scope is DESIGNED, so the story became a narrower one —
   refuse the MOUNT, keep the write and the report — after checking that no
   frozen row asserts the mount.

## Verification

Executed 2026-09-04. Every clean result carries the control that makes it a
measurement.

### The vulnerability, before and after, through the shipped binary

Same driver both times — a temp project holding `hostile.mjs` (one statement, a
`writeFileSync`) and a `.panda/config.json` naming it:

    BEFORE   panda run hi                       exit 2   module executed: YES
    AFTER    panda run hi                       exit 2   module executed: no
    CONTROL  same project, no `method` key      exit 1   module executed: no

The refusal the user now gets, verbatim from stderr:

    PANDA_CONFIGURATION_UNUSABLE: the 'project' layer selects the method
    './hostile.mjs', and panda will not import a module a project directory
    named: running it is running that project's code. If you want this
    methodology, adopt it into a document you own with `panda swap method
    ./hostile.mjs`

### T3 — and this is the most valuable thing the story produced

D4 said a check placed after the import "would still pass its own test". It was
right, and proving it changed what shipped:

    guard AFTER the import   →  packages/session unit tests: 12 PASSED
                             →  module executed: YES

Twelve green unit tests over a reinstated vulnerability. So the unit tests do
not pin the ordering at all, and a future refactor moving one line would
restore the hole with everything green.

`packages/cli/test/method-layer-trust.test.ts` is the answer: it drives
`panda run` against a cloned-project fixture with a stubbed executor and asserts
a SIDE EFFECT — a file the imported module writes at its top level — which only
the real ordering can suppress. Falsified both ways:

    guard moved after the import  →  1 failed
    guard deleted entirely        →  1 failed
    restored                      →  2 passed

Its own control is the second clause: the same run with no `method` key reaches
the executor and exits 0, so a broken fixture cannot look like a working guard.

### Gate

bytes 0, typecheck 12/12, lint 0, session and cli green on Node 24.14.1 and
26.8.1, build 12/12, `proof:consumer-install` 10 passed / 1 skipped.

### What this cost to learn

1. **A frozen spec's designed feature is not the same as a frozen row.** The
   first framing was "refuse project-scoped methods", which `spec-m5d:99` makes
   illegal — project scope is designed. Reading the I/O matrix showed rows 6 and
   7 are about WRITING and REPORTING, and no row asserts the MOUNT. The narrower
   story was available only after reading what was actually frozen rather than
   what the summary implied.
2. **Validation after loading is not validation.** `validateMethodPlugin` already
   refused the manifest; the module had run by then. The only fact available
   before an import is where the specifier came from.
3. **A guard's placement needs its own gate.** A unit test over the guard
   function is satisfied by a guard that runs too late. Assert the side effect
   the ordering suppresses, not the function's return value.
