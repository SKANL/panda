# Spec M5.C — panda writes the selection it tells you to edit

**Status:** FROZEN
**Implements:** the persistence half FR-28 / Story 5.4 needs, and closes the hand-edit hole Story 2.7c left in FR-7 / FR-9
**Created:** 2026-09-01

---

## Intent

`panda run --help` tells the user, in panda's own words, that the executor
selection "comes from `<project>/.panda/config.json`, then `~/.panda/config.json`,
then the built-in default." It never says how a value gets into either file,
because there is no way: **no panda verb writes a configuration document.** The
answer panda gives a user who wants a different default executor is *open a JSON
file and edit it.*

That is the owner's own §10 principle turned inward: *if the answer to a user's
problem is "edit your config", panda has not solved anything — it has added a
step nobody will discover.* It is panda's config rather than a vendor's, and the
shape is identical.

This story gives panda the verb: `panda swap executor <id>`. It is deliberately
`swap`, the word the PRD already reserves for v1's CLI (§6.1
`init/project/export/import/doctor/status/swap`) and the word FR-28 uses, so
`panda swap method <id>` later becomes a second NOUN under an existing verb
rather than a second verb — and it inherits this story's persistence, its scope
rules and its honesty about which layer actually decides.

## The measurement this rests on

Every claim was executed on 2026-09-01 at `3e6f85c`, never inferred.

1. **No verb writes a configuration document.** `writeFile`/`readFile` across
   `packages/*/src` is 29 occurrences in 10 files (the control — the query
   works). `packages/session/src/executors.ts`, which owns config reading, has
   **four `readFile` and zero `writeFile`**. Grepping `config.json` under
   `packages/cli/src` and `packages/environment/src` matches only `run.ts`, and
   every match is HELP TEXT.

2. **The binary has 11 verbs and `swap` is not one.** From `panda --help`: run,
   add, remove, list, init, doctor, remediate, each with a `project` variant
   where it applies.

3. **The layers, and which file is which.** `CONFIG_LAYERS` is
   `['defaults', 'global', 'project', 'agent', 'invocation']`, widest to
   narrowest. `<homeDir>/.panda/config.json` is the **`global`** layer;
   `<projectDir>/.panda/config.json` is the **`project`** layer.

4. **A config document holds more than one key.** Run against a sandboxed
   `HOME` holding `{"executor":"codex","workspace":{"rootDir":"/tmp/x"}}`,
   `panda run` printed `executor: codex (selected by the 'global' layer)` and
   the real codex adapter answered. `EXECUTOR_CONFIG_KEY` is `'executor'` and
   `WORKSPACE_CONFIG_KEY` is `'workspace'`, and they live side by side in one
   document. **A writer that replaces the document loses `workspace`.**

5. **The refusal for an unknown id already exists, coded, with the list.**
   `panda run --executor bogus "hi"` exits **2** with
   `PANDA_EXECUTOR_NOT_FOUND: panda has no adapter named 'bogus'; available
   executors: claude-code, codex, opencode`. **No new error code is needed.**

6. **The symlink hazard is real here and already solved once.**
   `packages/session/src/executors.ts` says in its own comment that "every
   dotfile manager (stow, chezmoi, dotbot) materialises panda's config as a
   symlink". `packages/projection/src/atomic-write.ts` resolves the link, copies
   the prior mode, writes a temp file in the same directory and renames — and
   refuses a dangling link coded rather than materialising a regular file where
   the user put a link. It is the only code in this repository that handles this
   correctly.

7. **The topology permits reusing it, and forbids the obvious alternative.**
   Measured from the manifests: `@panda/environment` depends on `contracts`,
   `kernel`, `projection`, `registry` — so it may import `atomic-write`.
   `@panda/session` (which owns the config READER) depends on `adapter-cli`,
   `contracts`, `kernel`, `workspace-local` — **not** projection. `@panda/cli`
   depends on `environment` and `session`, so it is the only package that can
   see both.

8. **`availableExecutorIds()` lives in `@panda/session`**, re-exported through
   `executors.ts`. `@panda/environment` cannot call it (measurement 7).

9. **The printed-command invariant is live.**
   `packages/cli/test/printed-commands.test.ts` dispatches every backtick-quoted
   `panda …` string in every package's shipped `src/` and `bin/`, and anything
   not dispatchable must be listed by hand as prose. A new verb that this story
   prints is dispatched by that suite for free; a *grammar* line with a
   placeholder has to be listed.

## Boundaries & Constraints

- **AD-1** — the kernel is not touched.
- **AD-2** — no new package edge. The capability lands in `@panda/environment`,
  which already holds the projection dependency; the executor catalogue reaches
  it as a PARAMETER from `@panda/cli`, the one package that can see both
  (measurements 7 and 8).
- **AD-5** — typed absence over silence. A config document that exists and
  cannot be read is not the same as one that is absent, and this story must not
  collapse them: the first refuses, the second creates.
- **AD-7** — coded `PandaError`. **No new error code** (measurement 5).
- **correction-01 C5 — report honestly, never fake.** See D3; it is the whole
  substance of this story beyond the file write.
- Relative imports carry the `.ts` extension. All artifacts in English.

### D1 — the capability is key-agnostic, and its key list is an allowlist

The capability is *"set one key in panda's own configuration document at one
scope"*, not *"set the executor"*. Writing it narrowly would mean writing it
again for `method` when Story 5.4 lands, and a second writer is a second place
the symlink rule can be got wrong.

Key-agnostic is not unconstrained. The accepted keys are a published constant —
`executor` today, `method` when 5.4 adds it — so a caller cannot persist a key
panda does not read, which is the M4.E discipline (*declare only what panda can
deliver*) applied to configuration. A key panda would ignore forever is the same
defect as a registry type nothing projects.

What the key may CONTAIN is the caller's question, not the capability's: the CLI
validates an executor id against `availableExecutorIds()` before calling. That
is also what keeps `@panda/environment` from needing to know what an executor
is (AD-2).

### D2 — `atomic-write.ts` is REUSED, not copied

M6.A's D1 declined to import this same module and wrote its own ~10-line
temp-then-rename. That decision does not reach here, and the reason is the
hazard, not the preference: M6.A wrote *inside a directory panda itself created*,
where no user symlink and no foreign mode can exist. This story writes
`~/.panda/config.json`, the exact file `executors.ts` documents as
symlink-managed. Copying the writer here would mean maintaining the symlink rule
in two places, and the second copy is the one that rots.

**The cost, stated because it is real:** a refusal surfaces as
`PANDA_PROJECTION_NATIVE_UNCLAIMABLE`, a `PANDA_PROJECTION_*` code out of a
configuration verb. That is odd vocabulary and it is still the right trade — the
alternative is a second symlink implementation. Record it in `deferred-work.md`
with the upgrade path (promote the writer to a leaf package with a neutral code
when a third caller appears; two callers is not yet three).

### D3 — writing the key is NOT changing the selection, and the command must say which happened

This is the criterion that makes this more than a JSON writer, and it is the
"dispatchable is not delivers" lesson applied before shipping instead of after.

`panda swap executor codex` writes the `global` layer. If the project document
names `claude-code`, the effective selection **does not change** — the narrower
layer still wins. A command that printed "done" there would be lying in exactly
the way this repository keeps paying for.

So after the write, the command reports the **effective** selection and the
layer that decides it, using the same resolution `panda run` already reports
(measurement 4's `executor: codex (selected by the 'global' layer)`), and when
the layer that decides is NOT the layer just written, it says so and names the
document that overrides.

### D4 — the scopes mirror the six verbs that already have them

`panda swap executor <id>` writes the machine scope (`global` layer);
`panda project swap executor <id> [directory]` writes the project scope. Same
shape as `add`, `remove`, `list`, `init`, `doctor`, `remediate`. Leaving the
project layer hand-edited would half-solve the exact problem this story exists
to remove.

### D5 — not in this story

No `--for` flag (it is FR-28's outgoing-method argument and has no meaning for
an executor). No `panda swap method` (Story 5.4 owns it, and it has no method
source — see the M5.C findings note in `deferred-work.md`). No unset/reset verb.
No `workspace.rootDir` writing, though the allowlist makes adding it one line.

## I/O & Edge-Case Matrix

| # | Input / state | Expected behaviour |
|---|---|---|
| 1 | `swap executor codex`, no config file, no `.panda` dir | dir and file created; document is exactly `{"executor":"codex"}`; exit 0 |
| 2 | `swap executor codex`, config holds `workspace.rootDir` | `workspace` **preserved byte-for-byte in meaning**; only `executor` set; exit 0 |
| 3 | `swap executor codex`, config already says `codex` | exit 0, reported as already selected; the write is still safe to perform |
| 4 | `swap executor bogus` | exit **2**, `PANDA_EXECUTOR_NOT_FOUND` naming the three available ids; **nothing written** |
| 5 | `swap executor` with no id | exit 2, usage; nothing written |
| 6 | `swap executor '  '` (blank) | exit 2 naming it blank, not as a missing adapter; nothing written |
| 7 | existing config is not valid JSON | coded refusal, exit non-zero, **file left exactly as it is** |
| 8 | existing config holds a JSON array / scalar | same refusal; a document that is not an object is not silently replaced |
| 9 | `~/.panda/config.json` is a symlink into a dotfiles repo | the **link is followed**; the real file is rewritten; the link still exists afterwards |
| 10 | that symlink is dangling | coded refusal; no regular file materialised in its place |
| 11 | the file exists with mode 0444 | the prior mode is preserved by the write, or the write refuses coded — never silently widened |
| 12 | global written while the PROJECT document names another executor | exit 0, and the report says the effective selection is unchanged and names the overriding document (D3) |
| 13 | `project swap executor codex` in a directory with no `.panda` | project dir and file created; the machine document untouched |
| 14 | `project swap executor codex [directory]` with an explicit directory | writes that directory's document, not the cwd's |
| 15 | after any successful write, a fresh `panda run` in a new process | reads the value back and reports it — persistence across processes, proved by a second process |
| 16 | `panda swap` with no noun | exit 2, usage |
| 17 | `panda swap nonsense <id>` | exit 2, usage naming the nouns swap accepts |

Row 2 is the one that would be silent: a writer that serialises only the key it
was given deletes the user's `workspace.rootDir` and nothing reports it. Row 12
is the one that would be a lie.

## Code Map

```
packages/environment/src/
  config-write.ts       setConfigValue(scope) — allowlisted key, atomic, symlink-safe
  index.ts              + setConfigValue, + the key allowlist constant
packages/cli/src/
  run.ts                + the `swap` branch, machine and project; USAGE lines
  swap-command.ts       the thin binding: parse, validate the id against
                        availableExecutorIds(), call, report effective selection
packages/environment/test/
  config-write.test.ts  rows 1-3, 7-11, 13-14
packages/cli/test/
  swap-command.test.ts  rows 4-6, 12, 15-17
_bmad-output/implementation-artifacts/
  deferred-work.md      + the PANDA_PROJECTION_* vocabulary cost (D2)
                        + the Story 5.4 finding: no method source exists
  sprint-status.yaml    + m5c
```

## Tasks & Acceptance

- [x] T1 — `setConfigValue`: read-or-absent, refuse a malformed document, merge ONE allowlisted key, write through `atomic-write`. **Landed in `@panda/projection`, not `@panda/environment`** — see the Change Log.
- [x] T2 — the published key allowlist; a key not on it is a coded refusal, not a silent write.
- [x] T3 — `swap-command.ts`: argv parse, id validation (through `resolveExecutor`, so the refusal is byte-identical to `panda run --executor`), machine and project scopes, the effective-selection report of D3.
- [x] T4 — dispatcher branches in `run.ts` for `swap` and `project swap`, plus the USAGE lines.
- [x] T5 — `config-write.test.ts`: every capability row, with rows 2, 7 and 9 as the load-bearing ones.
- [x] T6 — `swap-command.test.ts`: every binding row; row 15 spawns a SECOND process and makes it ANSWER from what the first wrote, rather than asserting the file's bytes.
- [x] T7 — `deferred-work.md` entries; `sprint-status.yaml`.
- [x] T8 — gate green on Node 24 **and** Node 26; `printed-commands.test.ts` green with the new verb.

**Done means:** `pnpm check` green on both Node versions (modulo the known
projection live red, §8 of the handoff); every matrix row has a test; and rows
2, 7, 9 and 12 each fail when their guard is removed.

### The falsification must be per rule

Rows 2, 7, 9 and 12 are four INDEPENDENT guards, and three of them are invisible
when they fail: a lost `workspace` key, a clobbered malformed file and a
destroyed symlink all exit 0 today. Remove each alone and name the test that
dies. A guard whose removal kills only a test another guard would also have
killed is not tested.

## Ask First

Stop and ask rather than deciding:

- Any **new** `PANDA_*` error code (measurement 5 says none is needed).
- Any new package edge (AD-2, measurement 7) — in particular making
  `@panda/environment` depend on `@panda/session` to reach the executor
  catalogue. D1 routes it as a parameter instead.
- Naming the verb anything other than `swap`, or adding a noun beyond `executor`.
- Adding `--for`, an unset/reset verb, or any second key beyond the allowlist.
- Copying `atomic-write.ts` rather than importing it (D2 says import).
- Writing anything into a VENDOR's configuration — this story touches panda's
  own documents only.

## Spec Change Log

- 2026-09-01 — frozen at `3e6f85c`. Owner chose "the persisting verb first" over
  building Story 5.4's capability or a method source, after the measurement that
  Story 5.4's precondition ("two installed methods") is unreachable: panda has
  **zero** dynamic imports and cannot load a method from anywhere.

- 2026-09-01 — **D2 was WRONG and the writer moved to `@panda/projection`.**
  Filed rather than implemented past, and found by a guard rather than by
  reasoning. `packages/environment/test/guard.test.ts` holds two clauses this
  spec's measurement never looked at: `@panda/environment` may import **only**
  `access`, `constants`, `mkdir` and `stat` from the filesystem, and its source
  may not contain the string `atomicWriteText` at all. The second clause's own
  comment says the symbol *"is no longer exported from the projection index"*
  because a reviewer had reached it exactly the way this spec proposed to — so
  the frozen D2 undid a previous story's deliberate fix, and the index export it
  required was reverted.

  Measurement 7 asked "does AD-2 permit the edge?" and the manifest said yes.
  The question that decided it was "does this repository permit the import?",
  and only the guard answers that. A package manifest is not an architecture.

  **The resolution needs no new package edge:** `config-write.ts` lives in
  `@panda/projection` beside the primitive it uses, `@panda/projection` publishes
  the WRITER but still not `atomicWriteText`, and `@panda/environment`
  re-exports the writer as the CLI's facade — the same shape it already uses for
  `createMemoryLogSink` from `@panda/kernel`. Environment names no filesystem
  verb and no atomic writer, so both clauses pass unchanged.

- 2026-09-01 — **the "root fix" in `atomic-write.ts` was reverted, because there
  was no root defect.** A 0o444 target made `rename` fail `EPERM` and the bare
  errno escaped, so the writer was changed to raise a coded `PandaError`. That
  broke `doctor.test.ts`: `toTargetFailure` in `engine.ts` already wraps a raw
  error as `PANDA_PROJECTION_TARGET_FAILED` and passes a `PandaError` through
  unchanged, and `doctor` classifies `not-writable` from that code — so every
  caller reaching the writer through the engine was already getting a coded
  failure, and the premise "every projection caller throws a bare errno" was
  false. The writer rethrows raw again; the one caller that does NOT go through
  the engine codes it at its own boundary, in configuration vocabulary
  (`PANDA_CONFIGURATION_UNUSABLE`) rather than projection's.

  The lesson is narrower than "do not fix roots": the writer was measured and
  its CALLER was not, and one level up was where the handling already lived.

## Verification

Everything below was executed on 2026-09-01, not inferred.

### The gate

- `node scripts/check-source-bytes.mjs` — clean.
- `pnpm typecheck` — all ten packages Done. `pnpm lint` — No issues found.
- Per-package suites (run individually; `pnpm check` aborts at projection's
  known local red):

  | package | result |
  |---|---|
  | projection | 2 failed / 259 passed / 3 skipped — the 2 are the pre-existing `skills-discovery.live` reds recorded in §8 of the handoff; 246 → 259 is this story's 13 |
  | environment | **100 passed** — back to its pre-story count after the guard fix below |
  | cli | **122 passed** (was 108, +14) |
  | contracts 142 · kernel 229 · registry 68 · session 89 · workspace-local 23 · workspace-git-worktree 13 | unchanged |
  | adapter-cli | 148 passed / 6 skipped — one live row failed on the first run and passed on the second; the known flaky live executor, and this story touches nothing in that package |

- **Node 26.8.1 canary** — projection 256, environment 100, cli 122.

### Be a user — which is what found the defect the suite could not

The binary was driven against a sandboxed `HOME`, and this is the pass that
earned its place:

```
$ panda swap executor bogus
PANDA_EXECUTOR_NOT_FOUND: panda has no adapter named 'bogus'; available executors: claude-code, codex, opencode   (exit 2)
$ panda swap executor codex
selected: 'codex' in '…\home\.panda\config.json'                                                                 (exit 0)
$ panda swap executor codex
already selected: 'codex' in '…\home\.panda\config.json'                                                         (exit 0)
$ panda project swap executor claude-code
selected: 'claude-code' in '…\proj\.panda\config.json'                                                           (exit 0)
$ panda swap executor opencode
selected: 'opencode' in '…\home\.panda\config.json' (was 'codex')
the effective selection is still 'claude-code', decided by the 'project' layer, which is narrower than the 'global' layer just written
```

The last two lines are D3, doing the only thing that makes this more than a JSON
writer.

**The first run of that pass failed.** `panda project swap` exited 2 with
`PANDA_ENVIRONMENT_SCOPE_UNAVAILABLE`, for every real user, while the whole suite
was green — because every test in `swap-command.test.ts` handed `runPanda` a
`cwd` and the real binary hands it none. A harness that supplies what the real
caller does not is testing a caller that does not exist. Fixed by defaulting to
`process.cwd()` where `homeDir` is already defaulted, and pinned by a test that
`chdir`s instead of passing the option.

### The invariant found two more

`packages/cli/test/printed-commands.test.ts` failed twice on real defects, not
on bookkeeping:

1. `panda project swap --help` exited **2** — the help flag was read as the NOUN.
   The machine branch handled it and the project branch did not.
2. A `panda project swap …` string in a source comment wrapped across two lines,
   which the scanner cannot see; the anti-wrap clause refused it.

It also refused three prose strings that had to be declared by hand, and its
anti-rot clause then refused one of those declarations the moment the reverted
`atomic-write` change stopped printing it.

### Falsification — eight guards, eight killed, per rule

Each guard removed **alone**:

| Mutation | Killed |
|---|---|
| the merge drops other keys (`{...existing}` → `{}`) | 2, incl. `sets the one key and leaves every other key exactly as it was` |
| malformed JSON treated as absent | 1: `refuses a document that is not valid JSON, and leaves the bytes untouched` |
| a non-object document treated as absent | 3: the array, string and null rows |
| the symlink is not resolved | 2: `follows the link…` and `refuses a dangling link…` |
| the key allowlist removed | 1: `refuses a key panda does not read…` |
| the effective-selection report removed | 1: `says the effective selection did not change, and names the layer that decides` |
| the id check removed | 1: `exits 2 listing the available executors, and writes nothing` |
| the `process.cwd()` fallback removed | 1: `falls back to the process working directory…` |

No survivors, and every guard has at least one test named after it alone. The
two malformed-document mutations kill DIFFERENT tests, which is the
representativeness rule: `JSON.parse` throwing and the shape check failing are
separate branches and neither row is redundant.

### What is NOT verified here

Nothing persists a `method` selection — the allowlist holds one key, and Story
5.4 adds the second in the change that teaches panda to read it. No unset verb.
`~/.panda/registry.json` has the same symlink exposure as `config.json` and
`@panda/registry`'s writer does not resolve links; found while measuring, not
fixed here, recorded in `deferred-work.md`.
