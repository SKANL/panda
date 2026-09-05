# M4.E — The registry declares only what panda can deliver

Status: FROZEN after approval. Changes go in the Spec Change Log, never silently.

## Intent

`REGISTRY_ENTRY_TYPES` declares four words. Two reach an executor: `mcp-server`
through config targets, `skill` through materialise targets. `tool` and `profile`
are expressed by NOTHING — panda ships exactly two target kinds and neither
renders either type.

Until M4.D that was an internal detail. M4.D shipped `panda add`, so **a user can
now create both inert types from the binary**, and panda's own derived message
says so:

```
$ panda add tool rg --command rg
NOTHING TAKES IT HERE: no detected executor has a machine-scope location for a tool entry
no other scope takes it either; it stays in the registry, listed by `panda list`, and removable with `panda remove`
```

That reporting is correct (correction-01 C5) and is why this is incomplete
rather than wrong. But a public vocabulary with inert members is a contract
defect, it lives in `@skanl/panda-contracts`, and NFR-8's joint-semver rule makes it
cheapest before consumers exist.

**This story removes `tool` and does not touch `profile`.** The split is drawn by
what the evidence can settle, not by size.

## The measurement this rests on

All three executors were interrogated directly — `codex-cli 0.149.1`,
`claude 2.1.247`, `opencode 1.18.23` — not read about.

**`tool`: no executor has a non-MCP location for "an identity plus an executable
command."** The spec author independently reproduced the decisive one:

```
$ CODEX_HOME=<tmp> codex exec --strict-config --skip-git-repo-check "hi"
Error loading config.toml:
...\config.toml:1:8: unknown configuration field `tools.rg`
```

codex's `[tools]` is a closed struct of built-in toggles (`web_search = true`
loads), not a catalogue of user commands. opencode's published schema types
`tools` as `{name: boolean}` — an enable-map for tools that already exist — and
its `command` requires a prompt `template`, not an executable. Claude Code's
settings reference carries no id-keyed command catalogue; its command-bearing
keys are role-bound singletons (`apiKeyHelper`, `statusLine`, ...) and `hooks`,
which is keyed by lifecycle event, not identity.

An `mcp-server` entry already carries exactly what a `tool` entry carries
(`command` + `args`) and reaches all three. `tool` is a synonym that renders
nowhere.

**`profile` is NOT settled by evidence, which is why it stays.** Three reasons,
recorded so the next story starts from them rather than re-deriving:

1. It carries no fields. `REGISTRY_PATH_FIELDS.profile` is `[]` and the envelope
   has no profile-specific member: a `profile` entry today models nothing beyond
   `type` and `id`. Building a target means first designing what a profile IS.
2. A native model selection exists in all three (`model` at the root of
   `~/.codex/config.toml`, `~/.claude/settings.json`, `opencode.json`) but two of
   the three are SINGLETON SCALARS. The registry holds N ids. **Projecting N ids
   into one slot is not a projection, it is a selection** — correction-01's
   failure mode one level up from inventing a location.
3. FR-21 reads "Export Bundle — portable artifact with Registry+Profiles+
   SkillSources". Listing Profiles beside Registry suggests a separate concept,
   not `RegistryEntryType.profile`, and Story 5.1's criteria never mention it.
   Removing the type could break a requirement whose meaning is unresolved.

Banked for that story, verified: **codex profile v2** IS id-keyed — by filename,
`$CODEX_HOME/<id>.config.toml`, layered over the base config via
`-p, --profile <CONFIG_PROFILE_V2>`. panda would own the whole file and merge
nothing: structurally the materialise shape panda already ships for skills. It
serves one executor of three.

## The spine — removing a word must not brick a registry

A reviewer proved that ONE entry violating the envelope makes the WHOLE store
unreadable, and that the failure blocks the very command that would remove it:

```
$ panda list / remove / add / init  ->  PANDA_REGISTRY_STORE_UNAVAILABLE  (exit 2)
$ panda doctor -> registry-unreadable, "Repair or remove that document."  (exit 1)
```

So deleting `tool` from `REGISTRY_ENTRY_TYPES` naively turns every existing
registry holding a `tool` entry into exactly the dead end M4.C was written to
eliminate — reachable this time by upgrading.

**Central obligation, stated as a falsification:** a registry written by TODAY's
build containing a `tool` entry must, after this change, still be readable by
`panda list` and `panda doctor`, and the user must have an in-product way to
remove that entry. Build the fixture with the SHIPPED binary BEFORE the change,
keep the bytes, and run the new build against them.

## Boundaries & Constraints

- `profile` is out of scope: do not remove it, do not build a target for it, do
  not change its fields.
- No CLI-side table of valid types. `REGISTRY_ENTRY_TYPES` stays the one source,
  as M4.D established.
- Kernel stays zero-dependency and never imports `@skanl/panda-contracts` (AD-1).
- Relative imports carry `.ts`.
- Do not weaken the per-type field-fit rejection M4.D added to the envelope.

## I/O & Edge-Case Matrix

| # | Input | Expected |
|---|---|---|
| 1 | `panda add tool rg --command rg` | Usage error naming the REMAINING types; nothing persisted |
| 2 | `--help` | The type list no longer offers `tool`, with no hand edit (it derives from `REGISTRY_ENTRY_TYPES`) |
| 3 | Registry written by today's build holding a `tool` entry, read by the new build | `panda list` and `panda doctor` still work — NOT `PANDA_REGISTRY_STORE_UNAVAILABLE` |
| 4 | ...and the user wants it gone | An in-product command removes it, and the exit `doctor` prints is the one that works |
| 5 | `ingestProviders` supplying a `tool` entry | Rejected coded at ingest, before any write, naming the remaining types |
| 6 | A registry with NO `tool` entry | Byte-identical behaviour to before this story |

## Code Map

- `packages/contracts/src/registry.ts` — `RegistryEntryType`, `REGISTRY_ENTRY_TYPES`, `REGISTRY_PATH_FIELDS`.
- `packages/registry/src/store.ts` — the read path that currently fails whole-store.
- `packages/environment/src/doctor.ts` — the finding kind that reports a retired entry, and its exit.
- `packages/cli/src/run.ts` — `USAGE` derives its type list; confirm it follows.

## Tasks & Acceptance

**T1 — remove `tool` from the vocabulary.** AC: matrix rows 1, 2, 5, 6.

**T2 — the upgrade must not brick an existing registry.** AC: rows 3 and 4,
proven with a fixture produced by the SHIPPED binary, not hand-written.
**Falsification:** implement T1 ALONE first, show the fixture failing with
`PANDA_REGISTRY_STORE_UNAVAILABLE`, capture it verbatim, then add T2 and show it
passing. Both captures go in `## Verification`. A migration whose failure mode
was never observed is a migration nobody tested.

**T3 — the exit must be one the binary can perform.** Whatever `doctor` prints
for a registry holding a retired type must be a command that actually clears it.
M4.D's printed-command invariant dispatches every `panda ...` string; this adds
the half that invariant cannot check — that the command DELIVERS.

**Ask First (frozen):** if removing `tool` requires the store to parse entries
leniently in a way that would ALSO admit a genuinely malformed entry, STOP and
renegotiate. Recognising one retired type is not the same as relaxing
validation, and that difference is the whole safety property.

## Spec Change Log

**1 — the Code Map's claim about `USAGE` was false, and the falsification run
proved it.** The Code Map says *"`packages/cli/src/run.ts` — `USAGE` derives its
type list; confirm it follows"*, and matrix row 2 requires the `--help` list to
lose `tool` *"with no hand edit (it derives from `REGISTRY_ENTRY_TYPES`)"*. It did
not derive. Four lines of the synopsis carried the literal string
`<tool|skill|mcp-server|profile>`, so after T1 alone the binary printed:

```
$ panda remove tool rg
unknown entry type 'tool'; panda has skill, mcp-server, profile
usage: panda run [--executor <id>] "<prompt>"
       panda add <tool|skill|mcp-server|profile> <id> ...
```

— help text advertising a word the binary refuses, in the same breath. That is
the CLI-side type table the Boundaries section forbids, hiding in a string. Row 2
is implemented as written (both lists are now interpolated from the contract's
constants); this entry records that the Code Map's premise was WRONG rather than
confirmed, because "confirm it follows" would otherwise read as a check that
passed.

**2 — `panda remove` accepts a retired type; `panda add` does not.** The spec
does not say where the in-product exit of row 4 lives. It is `panda remove`,
whose accepted vocabulary is `REMOVABLE_ENTRY_TYPES` (declared + retired) while
`panda add`'s stays `REGISTRY_ENTRY_TYPES`. Recorded because it makes the two
verbs deliberately asymmetric, and because the synopsis therefore reads
`panda remove <skill|mcp-server|profile|tool> <id>` — `tool` is visible in
`--help` on purpose, under `remove` alone.

**3 — my own Verification claim about the fixture was FALSE, and the fixture was
fixed rather than the prose.** An earlier revision of the section below said the
fixture carried `"~/bin\\fmt.exe"` and called that "the row that would have
CRASHED". Both the fixture and its expectation wrote ONE backslash, which JSON
and JS both read as `\f` — a form feed — so the two sides collapsed to the same
wrong bytes and the row passed while measuring no byte fidelity at all. The
fixture now carries a real backslash, and
`packages/registry/test/store.test.ts` asserts that it does
(`expect(RETIRED_FIXTURE).toContain(BACKSLASH + BACKSLASH)`), so the claim cannot
quietly become false again. The `~/` expansion was genuinely exercised
throughout; only the Windows-path fidelity was not.

**4 — the retired-entry finding carries the entry's OWN scope, not the scope
being diagnosed.** The spec's row 4 says an in-product command removes the entry
and that "the exit `doctor` prints is the one that works". Deriving the verb and
the file from the scope under diagnosis broke that in three places at once, and
the fix is a data-shape change rather than three sentences: `ScopeReport.retired`
is now `RetiredEntry[]`, carrying the entry, the scope it is stored in and that
scope's document. Recorded because it changes an exported type.

**Ask First: NOT triggered.** Recognising `tool` did not require lenient
parsing. `registryEntryIssues(value, admitRetired)` widens the accepted
vocabulary by exactly `RETIRED_ENTRY_TYPES` and changes nothing else: the id
rules, the field types, the per-type field FIT (against the retired type's own
`RETIRED_PATH_FIELDS`) and the unknown-root-key rejection all still apply, and no
write path ever passes `admitRetired`. `packages/contracts/test/registry.test.ts`
asserts that one rule at a time — a `tool` carrying an `entryPath`, a genuinely
unknown type, a missing id, an unprojectable id, a mistyped field, an unknown
root key and a non-object are ALL still rejected under `admitRetired`.

## Design Notes

Graphify over the planning artifacts (422 nodes, 802 edges) reports ZERO
functional requirements and ZERO architecture decisions with no story attached.
That negative result is recorded precisely because it is not reassuring: FR-11
HAD a story — 2.1, whose criteria it passed — and was still unreachable from the
binary until M4.D. **Full coverage on paper is compatible with zero
reachability.** What the graph does flag is diffusion: FR-13 is claimed by five
stories, FR-12 by four.

## Verification

### T2 — the falsification, both halves

**Step 1 — the fixture, built with the SHIPPED binary before any change.** Four
`panda add` calls into a throwaway `HOME`. The bytes below are what that build
wrote, `~/` marker included — it normalized a home-relative `tool` command, which
is why the read path has to expand a RETIRED type's path field too:

```json
{
  "version": 1,
  "entries": [
    { "type": "tool", "id": "rg", "command": "rg" },
    { "type": "tool", "id": "localfmt", "command": "~/bin\\fmt.exe" },
    { "type": "mcp-server", "id": "ctx", "command": "npx", "args": ["-y", "@ctx/server"] },
    { "type": "skill", "id": "demo", "entryPath": "./skills/demo" }
  ]
}
```

(The `localfmt` command holds a real Windows backslash — JSON `\\`, one
backslash after parsing. Spec Change Log 3 records that this document once
claimed so while both the fixture and its expectation collapsed to a form feed.)

**Step 2 — T1 ALONE against those exact bytes. VERBATIM:**

```
$ panda list
PANDA_REGISTRY_STORE_UNAVAILABLE: registry store validate failed on '...\.panda\registry.json': entries[0] violates the canonical envelope: 'type' must be one of: skill, mcp-server, profile
EXIT=2

$ panda doctor
problem: registry-unreadable (...\.panda\registry.json): PANDA_REGISTRY_STORE_UNAVAILABLE: registry store validate failed on '...\.panda\registry.json': entries[0] violates the canonical envelope: 'type' must be one of: skill, mcp-server, profile - panda never replaces a registry document it cannot read; `panda init` fails on it and projects nothing, so no entry is deleted from any vendor file - Panda cannot leave this state itself. panda never replaces a registry document it cannot read, because doing so would delete every entry it holds from every vendor file. Repair or remove that document; panda's ownership ledger is a different file and is not involved
EXIT=1
```

Two facts beyond the predicted one, captured in the same run. `panda init` fails
identically (`EXIT=2`), and `panda remove tool rg` — the only in-product exit —
is refused with `unknown entry type 'tool'`. So T1 alone is not merely "a store
that fails to read": it is the M4.C dead end exactly, with the door bricked from
both sides, reachable by doing nothing but upgrading.

**Step 3 — T1 + T2, the SAME bytes, fixture restored byte-for-byte:**

```
$ panda list
EXIT=0
global - tool - rg (command rg)
global - tool - localfmt (command C:\...\home\bin\fmt.exe)
global - mcp-server - ctx (command npx - args -y @ctx/server)
global - skill - demo (entry-path ./skills/demo)

$ panda doctor
EXIT=1
problem: retired-type (...\.panda\registry.json - rg): 'rg' is a 'tool' entry, and panda no longer has a 'tool' entry type (it has skill, mcp-server, profile); no target will ever take it. Remove it with `panda remove tool rg` - ... To leave this state: `panda remove <type> <id>`. ...
problem: retired-type (...\.panda\registry.json - localfmt): 'localfmt' is a 'tool' entry, ... Remove it with `panda remove tool localfmt` - ...
problem: out-of-date (claude-code - ...\.claude.json): ...
info: unprojectable (claude-code - ...\.claude\skills - demo): './skills/demo' cannot be read (ENOENT) ...
```

The `localfmt` row is the one that would have CRASHED rather than misreported:
`REGISTRY_PATH_FIELDS['tool']` is now `undefined`, and iterating it throws. It
resolves through `pathFieldsFor`, which is why the `~/` marker still expands to
the real home directory. `panda list`'s rows are otherwise identical to the
pre-change baseline captured on the same fixture.

### T3 — the printed command, run verbatim, and re-measured

`doctor` printed `panda remove tool rg`. That exact string, dispatched:

```
$ panda remove tool rg
removed: global - tool - rg (command rg)
stored in '...\.panda\registry.json'
EXIT=0

$ panda remove tool localfmt
removed: global - tool - localfmt (command C:\...\home\bin\fmt.exe)
EXIT=0

$ panda doctor          # re-run, same sandbox
problem: out-of-date (claude-code - ...\.claude.json): ...
info: unprojectable (claude-code - ...\.claude\skills - demo): ...
EXIT=1
```

Both `retired-type` findings are gone, and the document on disk keeps exactly the
two entries that were never retired. M4.D's invariant proves the verb dispatches;
this is the half it cannot reach — the command DELIVERED. The remaining exit 1 is
the pre-existing `out-of-date` row this fixture always had, unrelated to M4.E.

### The rest of the I/O matrix, from the binary

| # | Measured |
|---|----------|
| 1 | `panda add tool rg --command rg` -> exit 2, `'tool' is a RETIRED entry type; panda has skill, mcp-server, profile. An existing 'tool' entry is still listed by \`panda list\` and removed by \`panda remove tool <id>\``. The sandbox `HOME` is still empty afterwards: nothing persisted. |
| 2 | `panda --help` -> `panda add <skill\|mcp-server\|profile> <id> ...` and `panda remove <skill\|mcp-server\|profile\|tool> <id>`, interpolated from `REGISTRY_ENTRY_TYPES` / `REMOVABLE_ENTRY_TYPES`. See Spec Change Log 1 for why getting there took a change the Code Map said was unnecessary. |
| 3 | Step 3 above. |
| 4 | T3 above. |
| 5 | `ingestProviders` with a `tool` contribution -> `PANDA_REGISTRY_PROVIDER_REJECTED`, naming the origin, the entry id and `'type' must be one of: skill, mcp-server, profile`, raised in phase 1 with the store untouched (`packages/registry/test/ingest.test.ts`). |
| 6 | Unchanged. Every pre-existing suite passes with its fixtures retargeted from `tool` to whichever type still models what that fixture needed: `profile` where the point was "an entry no target expresses", `mcp-server` where the row only needed a `command`. |

### Gate

Source-byte check, typecheck and lint clean; every package's suite green on
**Node 24.14.1** and on the **Node 26.8.1** canary:

```
kernel 217 · contracts 64 · workspace-local 23 · registry 68 · session 89
projection 248 (+3 skipped) · environment 99 · cli 106
```

**Not green, and not this story's:** two live rows in `@skanl/panda-adapter-cli`
(`confinement-live.test.ts`, both opencode) fail on both Node versions with
`FreeUsageLimitError` / HTTP 429 from `opencode.ai/zen/v1/chat/completions`, and
their own assertions say `this run measured nothing`. `git diff --name-only --
packages/adapter-cli` is EMPTY: nothing in this change touches that package.
Retried three times across ~25 minutes; it is an account-level free-usage limit,
not a transient burst. The remaining 144 rows in that package pass. The design
question this exposes — a test that could not measure anything fails the gate,
which is the typed-absence rule (AD-5) panda enforces on `doctor` and not on its
own suite — is recorded in `deferred-work.md` rather than built here, per the
review's instruction.

### Review round — what four reviewers falsified, and what changed

The migration itself survived: the safety property held against 13+ planted
documents, `admitRetired` never reaches a write that creates a retired entry,
projection and the ledger keep the type out, and downgrade works. What did not
survive was the set of guarantees held by comments and hand-maintained lists.
Each item below was reproduced before it was fixed.

**The printed-command invariant was blind to the exit slot.**
`FINDING_EXITS[kind].command` is single-quoted and the scanner reads only
backtick-delimited strings, so a planted `command: 'panda evict-retired --all'`
left `printed-commands.test.ts` at 8/8 green while `panda doctor` told users to
run a verb the binary does not have. The only thing that caught it was a
two-element whitelist in `remediate.test.ts` — and adding the fabrication to that
list turned the whole project green. The comment above that list claimed the
mechanical half "now lives in printed-commands.test.ts", which was
self-falsifying: those strings are not backticked, so the mechanical half never
saw them. Fixed by DERIVATION, not by a wider regex: `printed-commands.test.ts`
now imports `FINDING_EXITS` and dispatches every `by: 'command'` exit through
`runPanda`, so quoting is irrelevant. Re-planting the fabrication now fails with
`retired-type names 'panda evict-retired'`. Two adjacent holes closed in the same
pass: a printed command wrapped across two source lines was invisible to the
scanner (a legal multi-line template literal passed 8/8), so an unclosed-line
guard now makes the wrap itself the failure — it immediately found three real
instances, one of which was a printed sentence in `run.ts` that had been hidden
by its own wrapping; and the whitelist is now a per-kind binding checked in both
directions, so a fabrication can no longer be excused by another kind's entry.

**Findings lost the entry's scope and printed commands that fail.** Three
reviewers hit this from three directions: a project-scope entry whose resolution
named the machine verb *and* a placeholder; a global entry seen by `panda project
doctor`, attributed to the empty project document and printing a command that
exits 1 — permanently; and `panda project add tool <id>` reusing the machine
refusal verbatim, asserting the entry "is still listed by `panda list`" (it is
not). One root cause: `retired` was filtered out of `store.list()`, the MERGED
view, and `RegistryEntry` carries no scope, so `findingsFor` had nothing to go on
but the scope under diagnosis. Fixed at the information loss: `runScope` now
reads per scope and returns `RetiredEntry { entry, scope, registryPath }`, and
both the verb and `filePath` come from the row. Separately, `exitSentence` takes
the concrete spelling, so the resolution prints ``To leave this state: `panda
remove tool rg` `` instead of a `<type> <id>` template sitting 700 characters
after the same values were interpolated — and the command left the detail, so the
rendered line states the fact once and the command once. `unprojectable` still
prints the template, because its rows carry an entry id and no type; that
asymmetry is now the documented reason the template exists.

**Silent data loss on the verb this story made the migration path.** Mutating
`store.remove` to filter on `candidate.id !== id` instead of `entryKey` survived
every suite. It matters *because of* this story: the spec's own argument for
retiring `tool` is that an `mcp-server` carries what a `tool` carried, so
`tool:rg` beside `mcp-server:rg` is the sanctioned post-migration state, and
`panda remove tool rg` is the command doctor prints — under the mutation it
deletes the live entry too and empties the registry. The shipped code was always
correct; the hole was entirely in the suite, and is now closed.

**Three "derived, never a literal" sites were not pinned as derivations.**
Replacing each with its currently-correct literal left everything green. The
decisive experiment is paired, and both halves are now measured: with the
synopsis interpolated, reordering `REGISTRY_ENTRY_TYPES` passes (34/34); with the
synopsis hardcoded, the same reorder FAILS — where it previously left 101/101
green while the shipped `--help` disagreed with the contract, which is precisely
the stale-help defect Spec Change Log 1 exists to abolish, restored and
undetected. `registry-commands.test.ts` carried a second self-falsifying comment
("Derived from REGISTRY_ENTRY_TYPES / REMOVABLE_ENTRY_TYPES, so this row goes
red...") above two literal assertions; the assertions now interpolate the
constants, and `formats.ts`'s skipped-kind loop and `doctor.ts`'s vocabulary
sentence are pinned the same way.

**Two guards that stated the bug they prevent in their own comment, and nothing
else.** `runScope`'s `byId` retired-exclusion is one `continue`; deleting it was
confirmed to make panda report *"'claude-code' has no native representation for a
tool entry"* — naming a type it no longer declares, as the explanation for an
entry no target was handed. And `groupByKind` dropping a retired kind is the only
thing between a stored `tool` and a target being asked to render it. Both are
now measured.

**Two containment facts made structural rather than coincidental.**
`KNOWN_ROOT_KEYS` is now derived from the union of `REGISTRY_PATH_FIELDS` and
`RETIRED_PATH_FIELDS`: a retired type whose field no live type still declares
would otherwise fail the unknown-root-key rule for every one of its stored
entries and brick the whole store — the M4.C dead end, inside the mechanism built
to abolish it. It held only because `tool`'s field is `command`, which
`mcp-server` still uses. And the ingest port's rejection is asserted as a whole
sentence with its interpolated vocabulary, not its first half.

**Also measured:** `panda project remove tool <id>` is now dispatched for real
(T3's "the command DELIVERS" half had been proven for one spelling only, and the
scope defect above is exactly where the other one broke), and `panda doctor`'s
`retired-type` is covered end to end from the CLI including its exit code, so
flipping its severity from `problem` to `info` can no longer pass unnoticed.

**Infrastructure, unrelated to the story:** `.gitattributes` covered
`packages/projection/test/goldens/**` but not `test/vendor-schemas/**`, so a CRLF
checkout failed four `vendor-conformance` tests (two reviewers hit it
independently). Extended.

### What the implementation does, in one paragraph

`tool` is gone from `RegistryEntryType`, `REGISTRY_ENTRY_TYPES` and
`REGISTRY_PATH_FIELDS`. It reappears exactly once, in `RETIRED_PATH_FIELDS`,
which is the single source for `RETIRED_ENTRY_TYPES`, `REMOVABLE_ENTRY_TYPES`,
`isRetiredEntryType` and `pathFieldsFor` — no second table anywhere, and three
PRE-EXISTING ones were deleted on the way: `ENTRY_KINDS` in the projection
engine, the `['tool','skill','profile']` literal in `formats.ts`, and the four
literal type lists in the CLI synopsis. `RegistryEntry.type` widened to
`StoredEntryType`, which is what made the compiler point at every reader that had
to decide about a retired word instead of leaving them to fail at runtime. The
store reads with `admitRetired`; every write path still refuses. `groupByKind` is
the boundary: a type with no bucket never reaches a target, so nothing renders a
retired entry and no target can report it — `panda doctor` reports it against the
registry DOCUMENT instead, as the new `retired-type` finding, `severity:
'problem'` because one command clears it for good (unlike `unprojectable`, which
is `info` precisely because nothing can).
