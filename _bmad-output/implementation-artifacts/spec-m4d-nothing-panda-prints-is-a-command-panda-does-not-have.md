# M4.D — Nothing panda prints is a command panda does not have

Status: FROZEN after approval. Changes go in the Spec Change Log, never silently.

## Intent

`panda` projects, materialises, diagnoses and remediates a registry **that a user
has no way to put anything into**. Four stories of projection machinery are
reachable from the shipped binary only with an empty registry.

FR-11 says it plainly: *"register Tool/Skill/MCP server once at global scope or
override per project/agent scope"*. Story 2.1 claims FR-11 and has three
acceptance criteria, all about envelope validation and lock contention. None of
them is about a verb. The **store** was built; the **surface** never was.

Two of `panda doctor`'s own exits already say so out loud:

> `removed-by-user`: *"To keep it absent instead, the entry has to leave the
> registry — panda ships no command for that yet, only `RegistryStore.remove` in
> `@panda/environment`"*
>
> `unprojectable`: *"No sequence of panda commands makes the entry projectable;
> it stops being reported when the entry leaves the registry, for which panda
> ships no command yet"*

That is honest reporting (correction-01 C5) of a gap the previous build could not
close. This story closes it, which makes both sentences false on the day it
lands — so the story is not "add three commands". It is:

**Every `panda …` command that panda's own output names is a command the binary
accepts, and nothing enforced by prose.**

89 backtick-quoted `panda …` strings ship inside panda's output text today. Each
one is a promise. This story makes the promise mechanical.

## Boundaries & Constraints

- **No `--scope` flag.** The grammar the binary already speaks is `panda <verb>`
  for machine scope and `panda project <verb> [directory]` for project scope
  (`init`, `doctor`, `remediate` all do this). The new verbs follow it.
  Consequence, and the reason this is the right call rather than a stylistic one:
  the `agent` scope is an in-memory `Map` that dies with the process
  (`RegistryStore#agentEntries`; `ensure()` excludes it in its own type). A
  `--scope agent` flag would accept the flag, exit 0 and persist nothing. Under
  the shipped grammar that lie is **not expressible**, so it needs no guard.
- **The CLI validates nothing about an entry.** `validateRegistryEntry` in
  `@panda/contracts` already rejects unknown root keys, bad types, empty ids and
  `UNPROJECTABLE_ENTRY_IDS`. The CLI shapes argv into an entry object and hands it
  over. Re-implementing any of that in the CLI is the exact defect the COVE round
  cost us: inventing rules the contract does not state.
- **`add` does not project.** It reports the command that does. Coupling them
  makes registration fail for projection reasons.
- Kernel stays zero-dependency and never imports `@panda/contracts` (AD-1).
- Relative imports carry `.ts`.

## I/O & Edge-Case Matrix

| # | Input | Expected |
|---|---|---|
| 1 | `panda add skill my-skill --entry-path ./s.md` | Registered at global scope; exit 0; output names the entry, its scope, its store path, and `panda init` as the next step |
| 2 | `panda project add tool fmt --command prettier` | Registered at project scope in the resolved directory |
| 3 | `panda add mcp-server fs --command npx --arg -y --arg @mcp/fs` | `args` is `['-y','@mcp/fs']`, order preserved |
| 4 | `panda add profile p` | Registered; `profile` has no path fields, so no field flag is required |
| 5 | `panda add tool t --entry-path ./x` | Rejected by the CONTRACT (unknown/ill-fitting field for the type), coded, non-zero — not by a CLI-side type table |
| 6 | `panda add skill __proto__ --entry-path ./s.md` | Rejected coded at registration (`UNPROJECTABLE_ENTRY_IDS`), never persisted |
| 7 | `panda add` with no type / bad type | Usage error naming `REGISTRY_ENTRY_TYPES`, non-zero |
| 8 | `panda remove skill my-skill` | Removed from global scope; exit 0 |
| 9 | `panda remove skill absent` | Typed absence, non-zero, says the entry was not there — never a silent 0 |
| 10 | `panda list` on an empty registry | Exit 0, says the registry is empty — an empty list is a result, not a failure |
| 11 | `panda list` with entries in both scopes | Each entry shown with its type, id and the scope it came from |
| 12 | `panda add` while another panda holds the lock | `PANDA_REGISTRY_CONTENTION` surfaces coded, naming the holder (Story 2.1's guarantee, now reachable) |
| 13 | Any `--help` | The new verbs appear in `USAGE` |

## Code Map

- `packages/cli/src/registry-commands.ts` — **new.** argv → entry object → store call → report. The only new file.
- `packages/cli/src/run.ts` — dispatch `add` / `remove` / `list` under both `panda <verb>` and `panda project <verb>`; extend `USAGE`.
- `packages/environment/src/doctor.ts` — `FINDING_EXITS` for `removed-by-user` and `unprojectable` now name the shipped command.
- `packages/environment/src/init.ts` — `storeFor` already resolves a scope to a store. Reuse it; do not build a second resolver.

## Tasks & Acceptance

**T1 — the three verbs.**
- `panda add <type> <id> [--command <c>] [--entry-path <p>] [--arg <a>]…`
- `panda remove <type> <id>`
- `panda list`
- each mirrored as `panda project <verb> … [directory]`
- **AC:** matrix rows 1–13 pass.

**T2 — the two false sentences.**
- `removed-by-user` and `unprojectable` name the real command.
- `unprojectable` moves OUT of `outside-panda` into a real exit. The M4.C
  deferred ledger flagged reclassification INTO `outside-panda` as the dangerous
  direction; this is the safe one, and it strengthens that totality proof rather
  than weakening it.
- **AC:** no exit detail anywhere claims panda lacks a command panda ships.

**T3 — the invariant, enforced by code that fails when violated.**
- A test extracts every backtick-quoted `` `panda …` `` string from the SHIPPED
  source of the output-bearing modules and asserts each names a command
  `runPanda` dispatches.
- **AC — this is the story's spine, so it is stated as a falsification, not a
  description:** planting a fabricated command inside any exit detail or
  resolution string makes this test FAIL. The implementer must plant one, record
  the failure output in the Verification section, and remove it. A test that
  passes without ever having been shown to fail proves nothing.

**T4 — the value is only real inside the executor (correction-01).**
- **AC, phrased in the external tool's terms:** `panda add skill … --entry-path`
  followed by `panda project init` puts the skill where **codex** looks for
  skills, and **codex loads it**. Registering into a store nobody reads is not
  the feature.

**Ask First (frozen):** if `add`'s field flags cannot be shaped without the CLI
holding a per-type table of which flag belongs to which entry type, STOP and
renegotiate. Such a table is a second copy of `REGISTRY_PATH_FIELDS` and will
drift from it. Do not implement past this clause.

## Spec Change Log

**0. AMENDMENT of matrix row 5 — the contract did NOT already reject it, and the
rejection was added there rather than in the CLI.** The frozen Boundaries say
*"`validateRegistryEntry` in `@panda/contracts` already rejects unknown root
keys, bad types, empty ids and `UNPROJECTABLE_ENTRY_IDS`"*, and row 5 asks for
`panda add tool t --entry-path ./x` to be *"Rejected by the CONTRACT
(unknown/ill-fitting field for the type)"*. Measured before writing anything:
`entryPath` is a KNOWN root key and a non-empty string, so
`registryEntryIssues({ type: 'tool', id: 't', entryPath: './x' })` returned `[]`.
The entry persisted and was then silently ignored by every projection target.

The row is therefore unsatisfiable as the Boundaries describe the world, and the
frozen **Ask First** clause is exactly the fork it lands on: the only two ways to
make row 5 true are a per-type table in the CLI, which that clause forbids by
name, or the rejection moving into the contract. What shipped is the second, and
it needs no new table at all — `registryEntryIssues` now reads
`REGISTRY_PATH_FIELDS`, the record that already declares tool→`command`,
skill→`entryPath`, mcp-server→`command`/`args`, profile→nothing. The CLI holds
no per-type knowledge, so the clause is honoured rather than implemented past.

Two consequences, both recorded in the deferred ledger rather than left to be
discovered: `REGISTRY_PATH_FIELDS` now carries two meanings (which fields belong
to a type, and which of them are normalized as paths), and a persisted store
document holding an ill-fitting entry from an earlier build now fails to READ
coded instead of being served. No such entry exists anywhere in the repository —
checked across every fixture before the change.

**1. AMENDMENT of matrix row 11 — `panda list` at the machine grammar can see one
scope, and the two-scope case is `panda project list`.** The row reads
"`panda list` with entries in both scopes". Under the frozen grammar (no
`--scope` flag) `panda <verb>` IS the machine scope, and the machine store has no
project directory, so it cannot see a project's entries — asking it to would be
the same "panda goes looking for other projects it has bound" that `panda doctor`
already refuses. What ships satisfies the row's requirement — every entry is
shown with its type, its id and the scope it came from — under both grammars, and
the two-scope listing is `panda project list [directory]`. Pinned by "shows every
entry with its type, its id and the scope it came from" in
`packages/cli/test/registry-commands.test.ts`.

**2. RENEGOTIATION REQUESTED — T4's acceptance names `panda project init`, and
project scope materialises no skills.** NOT implemented past: the end-to-end was
run against `panda init`, and both halves are recorded in Verification below with
what each actually produced. The AC reads *"`panda add skill … --entry-path`
followed by `panda project init` puts the skill where **codex** looks for skills,
and **codex loads it**"*. Story M4.B decided the opposite deliberately and says
so in two places: `targetsFor` plans a skills root only when
`scope === 'machine'`, and `ExecutorProfile.machineSkills` documents that
materialising into a project scope was Ask-First in M4.B's own Boundaries because
no executor has a project-scope skills location panda has VERIFIED by execution.

Measured, not reasoned: `panda project init <dir>` returned `skills: []`, printed
*"codex: nothing was projected: 'codex' has no project-scope configuration file"*,
and left `<home>/.codex/skills` non-existent. `panda init` then materialised the
skill and codex loaded it (transcript in Verification).

So the AC's INTENT holds — the value is real inside the executor — and its
wording names the one command that cannot deliver it. Three ways out, and this is
the ask rather than a choice taken here:
  a. amend T4 to `panda init`, which is what the shipped product does and what
     was verified;
  b. give codex a verified project-scope skills root, which is M4.B's Ask First
     and needs the same live measurement M4.B did for the machine roots;
  c. leave `panda project init` reporting skills as unprojectable and say so in
     its output more loudly than it does today.
Nothing was changed in either direction pending an answer.

**3. NOTED — `--arg` accepts a value beginning with a dash; the other field flags
do not.** Row 3 (`--arg -y --arg @mcp/fs`) requires it: `npx -y @mcp/fs` is the
documented invocation of most MCP servers, so the "a value may not start with a
dash" guard the repo applies to `--executor`, `--entry` and `--command` would
make the flag unable to express the case it exists for. `--help` can never be
swallowed by it, because help is answered before the parse runs. Pinned by "keeps
every --arg, in order, including the ones that look like flags".

**4. NOTED — files touched beyond the Code Map.** `packages/contracts/src/registry.ts`
(entry 0), `packages/registry/src/store.ts` (`list(scope?)`, mirroring the two
modes `get(type, id, scope?)` already had — the merged view keeps one row per
`type:id` and so drops the scope that produced it, which is the one fact row 11
needs), `packages/environment/src/index.ts` (re-exports `storeFor`,
`scopeDirectory` and `REGISTRY_ENTRY_TYPES`, because `packages/cli/test/run.test.ts`
forbids the CLI importing `@panda/registry` or `@panda/contracts` at runtime) and
`packages/cli/README.md`. No new file beyond `registry-commands.ts`.

### Amendment 4 — the spec author was wrong about T4, and the story found a worse bug than the one it was written for (2026-08-26)

**T4 renegotiation: ACCEPTED as option (a), amended, and then widened.**

The implementer refuted the frozen T4 by execution: `panda add skill` followed by
`panda project init` does NOT reach codex. `targetsFor` plans skills roots at
machine scope only, deliberately, because codex has no project-scope
configuration file and M4.B refused to invent one. T4's sequence is amended to
`panda add skill … --entry-path` -> `panda init` -> codex loads it, which the
implementer verified end to end against `codex-cli 0.149.1`.

Filing the renegotiation instead of implementing past the frozen clause was the
correct call and is what caught this.

**What the spec author then found, by execution, chasing the same thread:**

```
$ panda project add skill deadend --entry-path <file>
registered: project - skill - deadend
nothing was projected: `panda project init` puts it into every detected executor
$ panda project init      -> codex: no project-scope configuration file
$ panda init              -> machine store cannot see project-scope entries
$ find <home> -path "*skills*"  -> nothing
$ panda project list      -> still there, permanently
```

A skill registered at project scope can reach NO executor. Machine-scope
projection cannot see project-scope entries (`storeFor('machine', …)` builds a
store with no `projectDir`); project-scope projection plans no skills root. The
entry is inert forever, and `add`'s success line points the user at a command
that will not deliver it.

That is this story's own invariant, violated by this story's own new code. T3
does not catch it: T3 proves a printed command is DISPATCHABLE, not that it
DELIVERS. A promise can be kept syntactically and broken in substance.

**T5 (new, and the fix is a derivation, not an assertion).** After a successful
`add`, the reported next step is composed from `targetsFor(scope, detected,
homeDir, projectDir)` — the same planner `init` uses — and never from a sentence
authored next to the command.

- **AC:** `panda project add skill …` states that no executor takes a
  project-scope skill and names the scope that does. `panda add skill …` names
  the machine-scope command, as today.
- **AC:** the CLI holds no list of which entry types have a projectable location
  at which scope. Giving a profile a project-scope skills root must change this
  message with no edit to the CLI — a per-scope table in the CLI is the same
  drift trap the frozen Ask First already refused for per-type field flags.
- **AC, falsification:** removing every skills root from the machine scope must
  change what `panda add skill` prints. If it does not, the message is authored,
  not derived, and the task is not done.

**Renegotiation 1 (per-type field fit moved into `@panda/contracts`): ACCEPTED.**
Deriving the rejection from `REGISTRY_PATH_FIELDS` is right — the Ask First
forbade a CLI-side table precisely to avoid a second copy, and a derivation is
not a copy. One consequence needs an answer before this closes, recorded here as
an open question rather than a decision: whether an ill-fitting entry makes the
WHOLE store fail to read, and if so, which exit a user has. M4.C's whole subject
was states with no way out; introducing one in its successor would be the same
mistake twice.

**Renegotiation 3 (matrix row 11): ACCEPTED.** Machine-grammar `list` sees the
global scope; `panda project list [directory]` sees both. Accurate as amended.

## Design Notes

`--ext <json>` for the `extensions` namespace is deliberately omitted: no
consumer reads a CLI-supplied extension payload yet. Recorded in the deferred
ledger.

## Verification

### The gate

`pnpm check` (check-source-bytes + typecheck + test + lint) — **exit 0, fully
green**, run on the final tree.

Said rather than tidied away: the gate was run four times over the course of this
story and ONE of those runs failed with a single assertion in `@panda/registry`
(`1 failed | 60 passed`). It does not reproduce — `pnpm --filter @panda/registry
test` is green on its own, and the two full-gate runs after it are green — and
the log was not kept, so the case cannot be named. The change to that package is
`list(scope?)`, which touches no lockfile and no timing; the timing-sensitive
files in it (`lock.test.ts`, `contention.test.ts`) run alongside
`@panda/adapter-cli`'s twelve parallel files under `pnpm -r`. Recorded as an
unidentified transient rather than as four green runs. Chased afterwards and
still not reproduced -- see "The transient: not reproduced" below.

Per-package test counts, before this story and after:

| Package | Before | After |
| --- | --- | --- |
| `@panda/kernel` | 217 passed (9 files) | 217 passed (9 files) |
| `@panda/contracts` | 58 passed (5 files) | **59 passed** (5 files) |
| `@panda/registry` | 60 passed (5 files) | **62 passed** (5 files) |
| `@panda/workspace-local` | 23 passed (3 files) | 23 passed (3 files) |
| `@panda/adapter-cli` | 148 passed, 6 skipped (12 files) | 148 passed, 6 skipped (12 files) |
| `@panda/session` | 89 passed (6 files) | 89 passed (6 files) |
| `@panda/projection` | 243 passed, 3 skipped (15 files) | **246 passed**, 3 skipped (16 files) |
| `@panda/environment` | 91 passed (7 files) | **94 passed** (7 files) |
| `@panda/cli` | 61 passed (3 files) | **97 passed (5 files)** |
| **Total** | 890 passed, 9 skipped | **937 passed, 9 skipped** |

New: 28 rows in `packages/cli/test/registry-commands.test.ts` (the I/O matrix, the four T5 rows and the review round's) and
8 in `packages/cli/test/printed-commands.test.ts` (T3, rebuilt), +1 in
`packages/contracts/test/registry.test.ts` (the per-type field fit, derived over
the whole type × field matrix), +1 in `packages/registry/test/store.test.ts`
(`list(scope)`). No existing assertion was deleted; one was WIDENED —
`packages/environment/test/remediate.test.ts`'s pinned set of commands a
`command` exit may name now holds `panda remove <type> <id>` beside `panda init`,
because T2 reclassified `unprojectable`.

### T3 — the falsification, run rather than described

A fabricated `panda purge <type> <id>` was planted in the `removed-by-user` exit
detail in `packages/environment/src/doctor.ts` — an exit DETAIL, which is one of
the strings the invariant is about — and the test was run. Verbatim output:

```
 RUN  v4.1.11 C:/code/panda/packages/cli

 ❯ test/printed-commands.test.ts (3 tests | 1 failed) 12ms
     × dispatches every one of them 7ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  test/printed-commands.test.ts > nothing panda prints is a command panda does not have > dispatches every one of them
AssertionError: 'panda purge <type> <id>' in C:\code\panda\packages\environment\src\doctor.ts names 'panda purge', which the binary does not dispatch: expected 2 to be +0 // Object.is equality

- Expected
+ Received

- 0
+ 2

 ❯ test/printed-commands.test.ts:139:9
    137|         code,
    138|         `'${command.text}' in ${command.file} names 'panda ${path}', w…
    139|       ).toBe(0)
       |         ^
    140|     }
    141|   })

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed (1)
      Tests  1 failed | 2 passed (3)
   Start at  22:41:31
   Duration  1.60s (transform 548ms, setup 40ms, import 1.29s, tests 12ms, environment 0ms)
```

The fabrication was removed and the same command re-run: `Test Files 1 passed
(1) · Tests 3 passed (3)`. The failure had already been observed once before that,
against a different plant — the test's own first run flagged a
`panda project <verb> [directory]` grammar sketch in a comment, which is what led
to the placeholder-verb rule.

The mechanism is not a text scan: every extracted command is DISPATCHED, by
calling `runPanda([...verbPath, '--help'])` and requiring 0. A third case in the
same file (`fails when a command panda does not have is planted…`) keeps the
falsification in the suite, so a probe that could never answer non-zero would
itself go red.

### T4 — end to end, against the real `codex` binary

`codex --version` → `codex-cli 0.149.1`. Sandbox: an injected home under `%TEMP%`
with `USERPROFILE`/`HOME` pointed at it, `CODEX_HOME=<home>/.codex`, an empty
`<home>/.codex/config.toml` so codex is DETECTED, and a real entry file at
`<sandbox>/sources/entry.md` carrying the marker
`materialised-by-panda-m4d-end-to-end` in its description.

1. `panda add skill panda-m4d-t4-skill --entry-path <sandbox>/sources/entry.md`
   → exit 0, entry in `<home>/.panda/registry.json`, stderr:
   `nothing was projected: `panda init` puts it into every detected executor`.
2. **`panda project init <project>` → exit 0 and `"skills": []`**, stderr
   `codex: nothing was projected: 'codex' has no project-scope configuration
   file; panda will not invent a location it does not read`, and
   `<home>/.codex/skills` did not exist afterwards. This is the frozen T4 wording,
   run and observed NOT to deliver the AC — see Spec Change Log entry 2.
3. `panda init` → exit 0, with the skills row
   `{"executorId":"codex","targetId":"codex-skills","filePath":"<home>\\.codex\\skills","written":true,"drift":[],"unprojectable":[]}`.
   On disk: `<home>/.codex/skills/panda-m4d-t4-skill/SKILL.md`, byte-identical to
   the source file.
4. `codex debug prompt-input`, run with `CODEX_HOME=<home>/.codex` and cwd at the
   project → exit 0. The model-visible prompt's `<skills_instructions>` block
   contains, verbatim:

```
- panda-m4d-t4-skill: materialised-by-panda-m4d-end-to-end, and it does nothing. (file: C:/Users/angua/AppData/Local/Temp/panda-m4d-t4-EzOM/home/.codex/skills/panda-m4d-t4-skill/SKILL.md)
```

So codex loaded the skill panda materialised, named by the marker that exists
nowhere else on the machine and at the path panda wrote — the executor declared
what it discovered, nothing was inferred. **What is verified is
`panda add` → `panda init` → codex; `panda add` → `panda project init` → codex is
verified NOT to hold, by execution, for the reason M4.B recorded.**

(Codex also listed skills from the developer's real `~/.agents/skills`, which is
the known read-outside-the-injected-home ceiling already in the deferred ledger
from M4.B. Those are READS; nothing outside the sandbox was written.)

### T5 — the reported next step is derived, and the falsification changed it

The dead end Amendment 4 found is reproduced and closed. `add`'s next step is now
composed by `deliveryFor` in `packages/environment/src/init.ts`, which runs
`targetsFor` — the same planner `panda init` runs — and then asks each target it
planned whether it would take THIS entry, in the target's own vocabulary:

- a **config** target is asked to `merge` into an EMPTY document. `nativeText: ''`
  is the contract's "the file does not exist yet", the three shipped config
  targets import no `node:fs` at all, and an entry the target cannot express
  comes back in `skippedEntryIds`. No vendor file is read and none is written.
- a **materialise** target is asked to `plan`. It describes what it would place
  and never touches the destination; where it refuses, it says why.

So nothing anywhere maps an entry TYPE to a surface — not in the CLI, and not in
`deliveryFor` either. The binding prints what the planner found.

Measured, on a sandbox home where only codex is detected:

| Command | What it printed |
| --- | --- |
| `panda add skill good --entry-path <file>` | ``nothing was projected: `panda init` puts it into codex`` |
| `panda project add skill deadend --entry-path <file>` | ``NOTHING TAKES IT HERE: no detected executor has a project-scope location for a skill entry, so `panda project init` would project it nowhere`` + ``the machine scope takes it (codex): register it with `panda add` and project it with `panda init` `` |
| `panda project add mcp-server fs --command npx` | the same dead end, naming the machine scope — correct, because codex is the only detected executor and it has no project-scope configuration file |
| `panda add tool rg --command rg` | ``NOTHING TAKES IT HERE … `` + ``no other scope takes it either`` — no target expresses a `tool`, which is the same fact `panda doctor` already reports as `unprojectable`, said at the moment the entry is created rather than a command later |

**The falsification, run rather than described.** Every `machineSkills` root was
removed from `packages/environment/src/executors.ts` (all three profiles set to
`machineSkills: undefined`), with nothing else touched, and the SAME command was
re-run on the SAME sandbox:

```
### WITH every machine skills root removed:
registered: global · skill · falsify (entry-path C:\Users\angua\AppData\Local\Temp\panda-t5-juMn\src\e.md)
stored in 'C:\Users\angua\AppData\Local\Temp\panda-t5-juMn\home\.panda\registry.json'
NOTHING TAKES IT HERE: no detected executor has a machine-scope location for a skill entry, so `panda init` would project it nowhere
no other scope takes it either; it stays in the registry, listed by `panda list`, and removable with `panda remove`
```

Before the edit the same command printed ``nothing was projected: `panda init`
puts it into codex``. The message changed, with no edit to the CLI, so it is read
and not authored. `executors.ts` was restored (`git diff` clean) and the message
came back:

```
nothing was projected: `panda init` puts it into codex
```

Pinned permanently by four rows in `packages/cli/test/registry-commands.test.ts`
under `what panda add reports as the next step`, including one that varies only
DETECTION — the same entry at the same scope on a machine with no executor — which
an authored sentence could not tell apart.

### The open question Amendment 4 recorded: an ill-fitting entry kills the WHOLE store

**Answered by execution. The whole store, and the only exit is hand-editing it.**
A registry document holding one `{ "type": "tool", "id": "legacy", "entryPath":
"./x" }` beside two healthy entries:

| Command | Result |
| --- | --- |
| `panda list` | exit 2, `PANDA_REGISTRY_STORE_UNAVAILABLE: … entries[1] violates the canonical envelope` |
| `panda remove tool legacy` | exit 2, the same — **the entry cannot be removed by the command that removes entries** |
| `panda add tool another --command x` | exit 2, the same |
| `panda init` | exit 2, the same; nothing is projected and no vendor byte is touched |
| `panda doctor` | exit 1, and it is the ONE command that still answers: `registry-unreadable`, `outside-panda`, *"Repair or remove that document"* |

**It is NOT introduced by this story, and that was checked rather than assumed.**
The same document with a violation that predates M4.D — `{ "type": "tool", "id":
42 }` — fails identically (`entries[1] violates the canonical envelope: 'id' must
be a non-empty string`, exit 2 on `list`). The whole-store refusal is
`RegistryStore#readStore`'s generic behaviour for ANY envelope violation, and it
is deliberate: the alternative is serving a partially-parsed registry, which
would delete every entry panda could not read from every vendor file. What M4.D
changed is only WHICH documents can reach it. Removing the offending entry by
hand restores the store (verified: `panda list` back to exit 0 with the healthy
entry).

So it is a state with no in-product exit, which is M4.C's whole subject — but a
PRE-EXISTING one, whose exit `panda doctor` already names, and whose only
in-product remedy would be a `panda remediate` verb over panda's own registry
document. **Not built, per the instruction to report and check back.** The shape
it would take is `repair`'s: describe the entries it would drop, then drop only
those, touching no vendor file. Recorded in the deferred ledger.

### The transient: not reproduced

`pnpm --filter @panda/registry test` was run 10 times in a row: **10/10 green,
61 passed each time**, no failure captured. The honest note above stands — one
full-gate run failed a single unnamed assertion in that package and the log was
lost, and it has not been seen since across the loop plus every full-gate run of
this story.

### Review round: nine blocking items, all fixed

Four context-free reviewers drove the binary; the spec author reproduced items 1
and 2. Every fix below is verified by execution, not by reasoning.

**1 — the project scope collapsed onto the global one (DATA LOSS).** When the
project directory resolved to the home directory, `#storePath` returned the SAME
file for both scopes: `panda project list` showed every global entry twice under
an invented `project` label, and `panda project remove` reported a project-scope
removal while EMPTYING the global registry, exit 0. Fixed at the root, in
`RegistryStore`'s CONSTRUCTOR rather than at each call site, so the CLI,
`initProject`, `diagnose` and a third party holding the class all inherit it:
equal directories are refused coded (`PANDA_REGISTRY_STORE_UNAVAILABLE`) because
there is no state in which the aliasing is wanted. Pinned twice — at the store
(`refuses a project directory that IS the home directory…`) and through the
binary, where all three project verbs exit 2 and the global document is asserted
byte-identical afterwards.

**2 — a dead end reached by following panda's own printed instructions.** Root
cause: `occupied()` answered "taken" for ANY existing path, so an EMPTY leftover
directory was treated as foreign content — panda refusing to write in order to
protect nothing. `occupiedByContent()` now answers only for a directory that
holds something; a LINK is still occupation whatever it points at, and a
directory panda cannot list is still not proof that a location is free. Walked
end to end against the real binary after the fix:

```
delete the materialised SKILL.md (its directory survives)
  → doctor: removed-by-user
  → panda remediate release --apply     exit 0
  → panda init                          written back
  → panda doctor                        exit 0
```

**The constraint held.** The same walk with a user file left in the directory:
`panda init` reports `drift (foreign-collision) … is not claimed by panda's
ledger and it already exists; panda will not resolve the collision`, writes
nothing, and the user's file is untouched. Both directions are pinned in
`packages/projection/test/materialise.test.ts`. The `foreign-collision` exit text
no longer overpromises: it now says `adopt` claims what is THERE and refuses
rather than writing an empty claim where nothing is.

**3 — T3 was decorative.** See the three captures below.

**4 — an id starting with `-` could never be removed.** `parseTokens` takes `--`
as a POSIX terminator; past it every token is a positional. Round-tripped:
`panda add mcp-server --command npx -- --fs` registers, `panda list` shows it,
`panda remove mcp-server -- --fs` removes it. `--help` detection also stops at
the terminator, so an entry may legitimately be called `--help`.

**5 — `remove`'s sentence was FALSE, not vacuous.** It claimed `panda init`
"takes it out of every executor panda wrote it into"; over a user-edited location
`panda init` answers "panda will not remove a tree it no longer recognises" and
the content stays. It now states the rule panda applies — *removes it from every
location panda still owns, and reports the ones it no longer recognises rather
than deleting them* — asserted literally, because this is the one printed
sentence the invariant cannot check: it is a claim about what a command DOES.

**6 — the dead-end headline stated something false.** It explained WHY ("no
detected executor has a machine-scope location for a skill entry") seconds after
codex had used exactly such a location. The headline now says only what was
observed — *no detected executor would take this `<type>` entry at the `<scope>`
scope* — every target refusal is rendered as `refused: <executor>: <reason>`, and
where no target gave one the message says so rather than inventing it.

**7, 8, 9 — the three surviving mutations now die.**
- `scopeDirectory` replaced by a bare `resolve` → `panda project add … <missing
  tree>` used to CREATE the whole tree and exit 0. Pinned: exit 2,
  `PANDA_ENVIRONMENT_SCOPE_UNAVAILABLE`, and the path asserted still `ENOENT`.
- the two argv guards that make `--scope agent` inexpressible were both untested,
  and disabled together `panda add skill s --scope agent` exited 0 and persisted
  at GLOBAL. Pinned across four spellings, with the store asserted absent.
- `deliveryFor` had NO test in `@panda/environment`; its `catch` survived being
  replaced by a rethrow, which would turn a completed registration into exit 2.
  Pinned with a REAL throwing target (`collectMcpEntries` raises for an id that
  can never be a native config key), plus the two happy paths.
- and the `remove` coverage the reviewer specified: a project-scope removal now
  asserts the project document is emptied AND the machine document is unchanged,
  which kills the surviving `remove(type, id, 'global')` mutation.

### T3 — three falsifications, each planted, run and captured

The mechanism was rebuilt before these were run. Every backticked `panda …`
string in `packages/*/{src,bin}` is now a COMMAND that is dispatched — verb AND
flags — unless it is listed by hand as prose, and a listed string that stops
appearing fails too. Unrecognised is loud; there is no third outcome.

**(a) a fabricated verb hidden behind a single-quoted argument**, planted in
`panda add`'s own success output:

```
 FAIL  test/printed-commands.test.ts > nothing panda prints is a command panda does not have > dispatches the VERB of every command it prints
AssertionError: these name a command the binary does not dispatch: expected [ Array(1) ] to deeply equal []

- Expected
+ Received

- []
+ [
+   "'panda purge 'demo'' in C:\\code\\panda\\packages\\cli\\src\\registry-commands.ts names 'panda purge'",
+ ]
```

**(b) a flag the binary rejects**, which probing `argv[0]` alone never saw:

```
 FAIL  test/printed-commands.test.ts > nothing panda prints is a command panda does not have > accepts every FLAG in every command it prints
AssertionError: these print a flag the binary rejects: expected [ Array(1) ] to deeply equal []

- Expected
+ Received

- []
+ [
+   "'panda remove --all' in C:\\code\\panda\\packages\\cli\\src\\registry-commands.ts: unrecognized option '--all'",
+ ]
```

**(c) a fabricated command in `packages/cli/bin/panda.ts`**, the shipped entry
point the previous scan never opened:

```
 FAIL  test/printed-commands.test.ts > nothing panda prints is a command panda does not have > dispatches the VERB of every command it prints
AssertionError: these name a command the binary does not dispatch: expected [ Array(1) ] to deeply equal []

- Expected
+ Received

- []
+ [
+   "'panda flush --pipes' in C:\\code\\panda\\packages\\cli\\bin\\panda.ts names 'panda flush'",
+ ]
```

All three plants were removed and the file re-run green (`Tests 8 passed (8)`).
All three are also kept IN the suite as assertions, so the mechanism cannot lose
any of them again silently. The corpus is now 59 distinct strings across nine
packages including `bin/`, of which 24 are listed as prose and 2 as
counter-examples panda prints on purpose — and the counter-examples are asserted
to still be REFUSED, so an entry that quietly became valid fails too.

### CI red on Node 26: a test that had to WIN A RACE to pass

`84c62e2` went red on the Node 26 job only, on
`packages/projection/test/remediate.test.ts > discard refuses to overwrite a
change that landed while it was reading > loses no competing write`, with *the
race was never won in 25 attempts*.

The root cause was established by execution before anything was changed, and it
is not the canary and not M4.D's only projection source change: `0144745`
re-run on the same canary is green on both jobs; `84c62e2` is red on Node 26
twice; the test passes 12/12 isolated on Node 24 and 5/5 on Node 26 locally; and
a probe making `occupiedByContent` throw unconditionally fails eight remediate
tests WITHOUT this one among them. What M4.D actually did was add two tests to
`materialise.test.ts`, which moved parallel scheduling on Linux — and the test
then lost a race it had to win.

**The defect was the test's construction, and its own comment named the false
premise:** *"the loop is what makes the assertion deterministic rather than the
interleaving"*. A loop makes winning likelier, never certain.

It was never even a fair bet, which is the part worth writing down. Between the
snapshot and the guard, `discardLegacy` performs **no await at all** — the scan,
the removal span, the JSONC re-parse and the change record are every one of them
synchronous. So the window a competing write had to hit is a single microtask
boundary, while issuing that write costs two filesystem round-trips. Windows on
Node 24 happened to win it; Linux on Node 26 stopped.

**The design: force the precondition, do not wager on it.** The guarantee is
unchanged and is split exactly the way it decomposes:

1. **The guard's DECISION** — `packages/projection/test/engine.test.ts`'s
   `hasFileChangedSince` rows. Already deterministic, unchanged: mtime change,
   size change, and the absent-snapshot case.
2. **The apply path is WIRED to it, before the write** —
   `packages/projection/test/remediate-race.test.ts`, new and separate. The
   competing write is fired **by the remediation's own snapshot `stat`**, through
   a wrapper around `node:fs/promises` scoped to that file: the first `stat` of
   the target path IS `statSnapshot`, so the hook runs after that call resolves
   and before anything else can. There is no window to miss, on any platform.

What it deliberately does not do:
  - **no production seam.** `runRemediation` is called exactly as the CLI calls
    it, same request shape, no injected clock, filesystem or callback. A seam
    that let a test skip the guard would be worse than the flake.
  - **the guard is not mocked**, nor is its `stat`, nor its verdict. The wrapper
    decides only WHEN the competing write happens; everything the guard then
    reads is the real file on the real disk.
  - **the assertion is not lowered.** The refusal, its message and the SURVIVAL
    of the competing bytes are all required, every run. A second row asserts the
    ordinary discard still applies, so a guard that refused unconditionally
    cannot satisfy the first.

**Falsification, run rather than described.** The guard was deleted from
`discardLegacy` — the four lines between the change record and
`atomicWriteText` — and the test was run:

```
 FAIL  test/remediate-race.test.ts > discard refuses to overwrite a change that landed while it was reading > loses no competing write
AssertionError: the competing write was clobbered: expected '{\n  "theme": "vercel"\n}\n' to be '{\n  "theme": "someone else was here"…' // Object.is equality

- Expected
+ Received

  {
-   "theme": "someone else was here"
+   "theme": "vercel"
  }
```

The failing assertion names the DATA LOSS rather than a missing refusal, which
is why the survival check is asserted first. The same deletion fails identically
on Node 26.8.1. The guard was restored (`git diff` clean) and the file re-run
green.

**Determinism, measured rather than assumed:** 10 consecutive runs on Node 24 and
10 on Node 26.8.1, 2 passed every time — 20/20. Every package's suite was then
run under Node 26.8.1 as well as the default Node 24, and all nine are green on
both.

### The matrix, row by row

Every row is an executing test in `packages/cli/test/registry-commands.test.ts`
unless noted.

| # | Verified by |
| --- | --- |
| 1 | `registers at the global scope and names the entry, its scope, its store and the next step` |
| 2 | `registers at the project scope through the project grammar, in the resolved directory` |
| 3 | `keeps every --arg, in order, including the ones that look like flags` |
| 4 | `needs no field flag for a type that has no fields` |
| 5 | `lets the CONTRACT refuse a field that does not belong on the type…` (exit 2, `PANDA_REGISTRY_INVALID_ENTRY`, nothing persisted) + the derived matrix in `packages/contracts/test/registry.test.ts` |
| 6 | `never persists an id that could not be projected, and says so coded` |
| 7 | `is a usage error with no type, and names the types panda has` (both the missing and the misspelled form) |
| 8 | `takes the entry out of the global scope and exits 0` |
| 9 | `says the entry was not there and exits non-zero, never a silent 0 (AD-5)` — exit 1 |
| 10 | `exits 0 on an empty registry, because an empty list is a result` |
| 11 | `shows every entry with its type, its id and the scope it came from` (see Spec Change Log 1) |
| 12 | `surfaces registry contention coded rather than hanging or half-writing` — a live-pid lockfile, `PANDA_REGISTRY_CONTENTION`, exit 2, the holder named |
| 13 | `advertises all three under both grammars` + `answers --help for each of them rather than treating it as an argument` |

### T2 — the two false sentences

Neither `removed-by-user` nor `unprojectable` claims panda lacks a command panda
ships. `unprojectable` moved from `outside-panda` to a `command` exit naming
`panda remove <type> <id>` (the SAFE direction the M4.C ledger asked for), and
its severity stays `info`: nothing makes the entry projectable, and deleting an
entry a user deliberately registered is not a fix. T3 is what keeps both true
from here — it reads those exact strings out of the shipped source and dispatches
what they name.
