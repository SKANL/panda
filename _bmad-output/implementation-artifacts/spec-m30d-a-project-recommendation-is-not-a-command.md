# Spec M30.D — a project's recommendation is not a command, and refusing it must not cost the machine its own

- **Story**: none open. Found by driving M30's own fix; recorded in `deferred-work.md`.
- **Renegotiates**: row E1 of `spec-m25a-a-method-that-arrived-with-a-clone-is-not-a-method-you-chose.md`, which freezes `exit 2`. It is the only frozen row this story moves, and it moves it deliberately.
- **State**: frozen.

## Intent

M25.A stopped `panda run` from executing a module a cloned repository named. It
did that with a FATAL refusal on the deciding LAYER, and the refusal is wider
than the threat.

A project `method` key now stops the run whatever else is configured — including
a method the machine's OWNER selected for themselves. Clone a repository that
carries one and `panda run` is unusable in that directory until someone
hand-edits its JSON, which is the one answer `config-write.ts:10-12` says the
product exists to remove.

## The measurement this rests on

Driven at `220f288`. Every row has its control.

1. **The denial of service is real.** Same machine method both rows; only the
   project document differs.

   | run | exit |
   |---|---|
   | project doc names a method, machine method set | 2 — `PANDA_CONFIGURATION_UNUSABLE` |
   | CONTROL — project doc removed, same machine method | 0, reaches the executor |

2. **panda's own verb creates that state.** `panda project swap method X` writes
   the key (frozen: `spec-m25a` row E4, M5.D row 6), which is why M30 had to ship
   a success message WARNING the user that the write breaks `panda run` in that
   directory. A verb that must warn you it bricks the directory has wrong
   semantics, not wrong wording.

3. **The fallback cannot come from `dump()`.** It returns ONE composed leaf per
   path, carrying only the winning layer.

       layers: global {method:'/abs/machine.mjs'}, project {method:'./clone.mjs'}
       dump() at `method`        -> [{path:['method'], value:'./clone.mjs', layer:'project'}]
       snapshot('global').method -> '/abs/machine.mjs'
       CONTROL, no project layer -> dump() at `method` says layer 'global'

4. **And it must not come from `snapshot()` either, which is the measurement that
   chose the design.** `dump()` has exactly three production consumers — the three
   selections (`executors.ts:397`, `methods.ts:221`, `workspaces.ts:136`). There
   is no diagnostic, no `panda config`, no doctor section reading it. `snapshot()`
   has ZERO production consumers outside the kernel's own definition; control —
   the same grep over `packages/*/test` hits `kernel/test/config.test.ts:86-93`,
   so the zero is a measurement rather than a missed glob. Making `selectMethod`
   read `snapshot()` would make it the product's ONLY layer-by-layer reader.

5. **There is one admission point, and it already knows disk from host.**
   `seedExecutorConfig` (`executors.ts:352`) is the single place a document
   becomes a layer, and its loop already separates `wasReadFromDisk` from a
   host-supplied document, which goes to `agent` instead.

6. **The channel for saying what was declined already exists and already prints.**
   `run-session.ts:351-355` subscribes `onWarning` BEFORE activation and formats
   `configuration ignored: '<key>' <detail>`; `cli/run.ts:440` sends it to stderr.

## Boundaries & Constraints

### D1 — the fallback is carried at ADMISSION, not at selection

The project document's `method` key never becomes part of the `project` layer.
Composition alone then yields the next layer, `selectMethod` is untouched, and
`dump()` still answers with one entry whose layer is the one panda acted on.

The alternative — reading `snapshot('global')` inside `selectMethod` — was
rejected on measurement 4, not on taste: it buys a second resolution rule for the
only selection that would have one.

### D2 — AD-5 argues FOR this, and the current code reads it as a binary

`methods.ts` says "REFUSED rather than ignored, per AD-5". AD-5 is *typed absence
over silence — unavailable is not failed*. Its opposite of "ignored" is TYPED AND
REPORTED, not FATAL. A declined selection that is announced satisfies AD-5 in
full; only the silent skip violates it.

And panda already decided this exact question, in the code that carries the
channel (`cli/run.ts:437-439`): *"A configuration key panda read and could not
use. Reported, never fatal: one forward-looking key in `~/.panda/config.json`
used to fail every run on the machine, and silence would have been the other
wrong answer."*

### D3 — `assertMethodMayMount` keeps its project clause, and it is NOT dead

`run-session.ts:51` states a supplied `kernel` owns its configuration, so a host
that seeds its own `project` layer bypasses admission entirely and reaches the
guard. M25.A's T3 measured that a guard in the wrong place passes all of its own
unit tests while the hostile module runs; moving safety wholly into admission
would give that back. Two lines of defence, and row E7 pins the second.

### D4 — following the advice must SILENCE the notice

If the machine document already selects the module the project recommends
(`resolve(projectDir, recommended) === machineSpecifier`), nothing is printed.
Without this, a user who took panda's advice is told about the declined key on
every run forever — advice that nags after being followed is the same defect
class as advice that does nothing, which this milestone has now found twice.

### D5 — what this does NOT do

- **Make a project method honourable, ever.** No ownership record, no
  `trusted: true`, no per-directory allow file, no prompt. An ownership record
  proves panda wrote the NAME; the danger is the BYTES, which any `git pull`
  replaces. Rejected with evidence in `deferred-work.md`.
- **Remove the project write.** E4 and M5.D row 6 stand. Removing it patches the
  one path that is not the threat model — a hand-written or templated key
  arriving with a clone — and deletes a designed behaviour to do it.
- **Touch the relative-specifier clause** in `assertMethodMayMount`.
- **Add a flag**, a per-layer method precedence setting, or a new notice site.

## I/O & Edge-Case Matrix

| # | Input | Expected |
|---|---|---|
| E1 | `run` in a project whose `.panda/config.json` names a method, nothing else selects one | **the key no longer decides the exit**, the module is NOT imported, and stderr carries `configuration ignored: 'method'` naming the specifier and the file. **Renegotiates M25.A row E1, which froze exit 2.** |
| E2 | same, and the machine document selects a method | the MACHINE method mounts; the notice names what was declined and what is used instead |
| E3 | the machine document selects the module the project recommends | mounts, and NOTHING is printed about the project key (D4) |
| E4 | `run` with the method only in `~/.panda/config.json` | unchanged; no notice |
| E5 | `run` with no method anywhere | unchanged; no notice, no failure (M5.D row 9) |
| E6 | `project swap method X` | still writes the project document (M25.A row E4, M5.D row 6); its message no longer says the write breaks runs |
| E7 | a host supplies its own kernel whose `project` layer names a method | `PANDA_CONFIGURATION_UNUSABLE` — admission was bypassed and the guard is what stops it (D3) |
| E8 | a method on the `agent` layer | mounts; that document is the host's own code |
| E9 | `doctor` / `list` in the same project | unchanged — they never mounted a method |

## Code Map

| Path | Change |
|---|---|
| `packages/session/src/executors.ts` | `seedExecutorConfig` drops `method` from a project document READ FROM DISK, and returns what it declined |
| `packages/session/src/run-session.ts` | hands that to `onWarning`, on the channel that already prints |
| `packages/session/src/methods.ts` | the guard's comment says it is now second-line defence; the orphaned `dump()`-symmetry paragraph is bound to `selectMethod`, which it documents |
| `packages/cli/src/swap-command.ts` | the project message stops warning that the write breaks runs |
| `packages/session/test/` | E1, E2, E3, E7 through the seam, plus the dump-truthfulness gate below |
| `packages/cli/test/method-layer-trust.test.ts` | E1 and E2 through the BINARY, with the no-method control |

## Tasks & Acceptance

1. **T1** — RED first: a clause that a project-named method leaves the machine's
   own mounted, and one that the notice is PRINTED. See them red, paste them.
2. **T2** — the drop, in `seedExecutorConfig`'s `wasReadFromDisk` branch.
3. **T3** — **the gate the design needs, and it is not optional.** A clause that
   composes a project document naming a method and asserts NO `dump()` entry has
   `path: ['method']` with `layer: 'project'`. Without it, a later
   "simplification" moving the drop into `selectMethod` makes `dump()` LIE, and
   nothing else in the repo would notice: a lying dump passes every assertion
   about the run.
4. **T4** — falsify twice: delete the drop and confirm the new clauses go red;
   delete `assertMethodMayMount`'s project clause and confirm E7 goes red. Two
   guards, two falsifications, or one of them is decoration.
5. **T5** — drive the binary: E1, E2 and E3, with the no-method control.
6. **T6** — correct `spec-m25a` row E1 in place, so the renegotiation is recorded
   where the old promise is read rather than only here.
7. **T7** — gate on Node 24 AND 26, plus `pnpm build && pnpm proof:consumer-install`.

## Ask First

- Making a project-layer method mountable under ANY condition.
- Removing `assertMethodMayMount`'s project clause.
- Changing what M5.D's rows 1-9 assert.
- Any trust store, prompt, or per-directory allow mechanism.

## Spec Change Log

1. The first framing read the fallback out of `snapshot('global')` inside
   `selectMethod`. Measurement 4 killed it: `snapshot()` has zero production
   consumers, so that would have made the method selection the product's only
   layer-by-layer reader — more machinery, to fix a defect admission solves with
   less.
2. Both review seats reached admission-stripping independently, from different
   arguments: one from `AGENTS.md` ("panda absorbs the problem, it does not hand
   it back"), one from git's protected-configuration rule, where `safe.directory`
   is honoured from system and global config and NEVER from the repository's own,
   precisely so an untrusted repo cannot vouch for itself.
