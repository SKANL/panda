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
| E1 | `run` in a project whose `.panda/config.json` names a method | ~~exit 2, coded refusal naming the specifier, the layer and `panda swap method <spec>`~~ **RENEGOTIATED BY M30.D — the key no longer decides the exit; it is declined at admission and reported.** The half that stands, and is what this spec was for: **the module is NOT imported.** |
| E2 | `run` with the method in `~/.panda/config.json` | mounts exactly as today |
| E3 | `run` with no method anywhere | unchanged; no warning, no failure (M5.D row 9) |
| E4 | `project swap method X` | still writes the project document (M5.D row 6) |
| E5 | machine and project both name a method | ~~the machine one mounts; no refusal, because the deciding layer is `global`~~ **FALSE — see the correction below** |
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

## Correction — E5 is false, and the advice D2 shipped was a closed loop

Written by this spec's own author, hours after it froze, by driving the three
things it asserted instead of reading them. All three are wrong in the same
direction: they assume the refusal LEAVES A WAY OUT, and it did not.

### E5 is false

It says the machine selection mounts "because the deciding layer is `global`".
The layer order is `defaults → global → project → agent` and `config.dump()`
returns the NARROWEST deciding layer, so when both documents name a method the
deciding layer is `project`, not `global`, and the guard fires.

Driven: same machine selection both rows, only the project document differs.

    project doc present, machine method set   →  refused
    project doc REMOVED, machine method set   →  reached the executor

So a cloned repository carrying a `method` key does not merely fail to run ITS
method — it **denies service to the machine owner's own**, and `panda run` stays
unusable in that clone until someone hand-edits the JSON.

### D2's command did not resolve anything

D2 says the refusal "carries the command that resolves it". Driven verbatim,
`panda swap method <spec>` exits 0, writes `~/.panda/config.json`, and changes
nothing observable: `project` still decides, this same guard fires byte for
byte. **A closed loop.** The user's only real exit was editing the file that
`config-write.ts:11-12` says the product exists to stop asking for.

### And the loop's exit was a wildcard

When the machine selection DOES decide, `run-session.ts:602` resolves the
specifier against **the run's cwd**, whatever layer chose it. So
`"method": "./mine.mjs"` in the machine document means *whatever `./mine.mjs` is
where you are standing* — every repository on the machine at once. Driven: a
directory holding only a `mine.mjs` and NO `.panda` config ran that module's
top-level code; the same directory with an empty `HOME` did not.

That is WIDER than the hole this spec closed — E1 needed the hostile repo to
carry a config, this needs only a file with the right name — and it was
reachable **only by following this spec's own printed instruction**.

### What shipped instead (M30)

Refusal on both sides, chosen over resolution deliberately. Resolving a
machine-layer relative specifier against `homeDir` would silently change what an
existing selection MEANS; refusing says the true thing, which is that a relative
specifier in a machine-wide document never named a file.

- `assertMethodMayMount` refuses a relative specifier from any non-`project`
  layer, and the `project` refusal now names the FILE that holds the key plus
  the fact that a machine selection must be ABSOLUTE.
- `swap-command.ts` refuses to WRITE one, because that verb validated
  `<cwd>/mine.mjs` and then stored the raw `./mine.mjs` — **the thing it
  validated was not the thing it stored.**

### E1 was renegotiated by M30.D, and the reason is that this refusal was wider than its threat

`exit 2` was frozen here for any project-named method. Driven at `220f288`, that
stopped the run WHATEVER ELSE WAS CONFIGURED: with a method the machine's owner
had selected, present and valid, a cloned repository carrying its own `method`
key made `panda run` unusable in that directory until someone hand-edited the
JSON. Control: the same machine method with the project key removed reaches the
executor.

So the threat — importing a module a clone named — was closed by a refusal that
also denied service to the machine's own configuration. M30.D keeps the closed
half and drops the rest: `seedExecutorConfig` refuses to ADMIT the key into the
`project` layer, composition yields the next layer, and the run says on stderr
what it declined and what it is using instead. The module is still never
imported, which is the only thing this spec was ever about.

`assertMethodMayMount`'s project clause STAYS, and is not decoration: a supplied
kernel owns its configuration and never reaches admission. Driven — with that
clause deleted, the supplied-kernel path imports the module and the run returns
`ok`.

See `spec-m30d-a-project-recommendation-is-not-a-command.md`.

### The reusable lesson, and it is about tests

Both of this spec's clauses asserted `message.toContain('panda swap method')`.
That pins that panda gives **advice**. Nothing in it can pin that the advice
**works** — and it did not. Assertions about a message's text are satisfied by a
message that lies. The proof that an exit is an exit lives in a driven
transcript, never in a `toContain`.
