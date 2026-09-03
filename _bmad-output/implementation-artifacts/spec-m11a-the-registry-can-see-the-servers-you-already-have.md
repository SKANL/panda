# Spec M11.A — the registry can see the servers you already have

**Status:** FROZEN
**Story:** gives `ToolProvider` its first production implementation (FR-13b ingest
half; closes the `deferred-work.md` entry re-homed twice and never landed, and
supersedes M9.A's D8, whose stated reason has expired)
**Base commit:** `bda68a0`

---

## Intent

`panda ingest` puts the skills already on this machine into the registry. It does
not put the MCP servers already on this machine into the registry, and
`REGISTRY_ENTRY_TYPES` is exactly `skill | mcp-server` — so the ingest path
covers one of the two kinds the projection layer delivers. This closes the other
half.

The asymmetry is visible in the product, not only in the code: `panda ingest`'s
own help text reads *"Puts the **skills** already on this machine into the
registry"*, and on a machine with MCP servers configured in Claude Code, codex or
opencode, `panda list` after an ingest shows none of them.

## The measurement this rests on

Executed on 2026-09-03 at `bda68a0`, every zero with a control.

| # | Claim | Evidence |
|---|---|---|
| M1 | `ToolProvider` has ZERO production implementations | `registry/src/ingest.ts:55,334` declares and iterates `options.toolProviders`; `environment/src/ingest.ts:103` is the only production call of `ingestProviders` and passes `{ skillSources: [source], dryRun }` only. **Control:** the same query over `packages/*/test` returns 23 hits, so the search sees both trees. |
| M2 | The port's declared family is now `mcp-server` ALONE | `contracts/src/providers.ts:9-11` — "a ToolProvider contributes executables (`mcp-server`)". Story 2.4 wrote `tool | mcp-server`; M4.E retired `tool` and the contract was updated with it. Nothing here re-opens that. |
| M3 | M9.A's reason for deferring this has EXPIRED | D8 reads "`ToolProvider` / `mcp-server` ingestion. The port is real; **its medium is not the filesystem** and its story is separate." The medium IS the filesystem: `projection/src/formats.ts:395` does `memberValue(root, traits.mcpContainerKey)` against the user's real vendor document, and `:414-417` walks its members to detect a duplicate id. |
| M4 | Panda already knows each vendor's container key, verified against the real binaries | `claude-mcp.ts:25` `mcpServers`, `codex-config.ts:22` `mcp_servers`, `opencode-config.ts:21` `mcp`. All three trait records are exported from `@panda/projection`. |
| M5 | The ownership ledger ALREADY records exactly which MCP entries are panda's | `ProjectionLedgerRecord.nativeLocation` (`contracts/src/projection.ts:79-80`), whose own doc comment gives `mcpServers.context7`, `mcp_servers.context7` as its examples, paired with `targetId`, `filePath` and `entryId`. |
| M6 | The three native entry shapes are genuinely different, and only the WRITE direction exists | `claude` `{type:'stdio', command, args}`; `codex` `{command, args}`; `opencode` `{type:'local', command:[cmd, ...args]}` — opencode's `command` IS the argv and has no `args` field. `renderMcpEntry` renders each; there is no inverse anywhere. **Control:** `renderMcpEntry` → 3 trait records + its declaration in `formats.ts:78`. |
| M7 | A `ToolProvider` reports NO change token, by contract | `contracts/src/providers.ts:32` — "`contentHash` is absent for ports that report no change token (a ToolProvider)", and `ToolProvider.list()` returns `readonly RegistryEntry[]` where `SkillSource.list()` returns `SourcedSkill[]`. So this story has no `contentHash` half at all. |

---

## Boundaries & Constraints

### D1 — the inverse of `renderMcpEntry` lives BESIDE it, on the trait record

Reading a vendor's MCP entry back into panda's `{command, args}` is the exact
inverse of `renderMcpEntry`, and the three vendors disagree about the shape.
`opencode-config.ts:10-12` already states the rule this rests on: "OpenCode's
`command` IS the argv — there is no `args` field — so the split panda keeps
internally is joined here **and nowhere else**." A second place that knows how to
un-join it is a second answer that drifts from the first.

So: one new field on `ProjectionTargetTraits`, `readMcpEntry`, declared next to
`renderMcpEntry` and implemented on all three trait records. It is REQUIRED, not
optional: an optional inverse is a target that can be projected into and never
read back, which is exactly the asymmetry this story exists to remove, and the
type system is where that is cheap to enforce.

### D2 — the reader reads ONLY the config locations panda has already verified

The same rule M9.A's D2 states for skills roots. The paths come from
`EXECUTOR_PROFILES.machineConfig`, which is the location panda already writes
into, never a path invented here. An executor whose config file is absent
contributes nothing and is not an error — an executor is allowed not to be
installed (AD-5).

### D3 — an entry the ownership ledger claims is NOT ingested

The hazard M9.A closed for skills, sharper here. Panda writes into the SAME file
the user's own servers live in, under `<container>.<id>`. Reading it back without
the ledger would make the registry a copy of its own projection, and the second
run would differ from the first.

The ledger read is a PRECONDITION, not a refinement: an unreadable ledger is a
coded refusal, reusing `projectionLedgerUnavailable` and the sentence
`environment/src/ingest.ts:80-86` already carries. Exclusion matches a ledger
record whose `targetId` AND `entryId` identify the candidate — `nativeLocation`
is carried in the report but is not the match key, because it is a rendering of
the same two facts and matching on a rendering is how two answers drift.

### D4 — content panda would write is `already satisfied`, not a collision

**AMENDED — see Spec Change Log 1. The original clause asserted code behaviour
that does not exist, and the implementer refused it rather than implementing
past it.**

Two different cases, and the original D4 covered only the first:

**(i) An id the ledger already claims for that target** is simply not offered by
the source. That is the E5 row and it was always right.

**(ii) An id the ledger does NOT claim, whose native content is what panda would
write.** This is the ordinary case — the user's own server, ingested, then
projected back — and panda reports `foreign-collision` on it today.
`formats.ts:1090-1101` decides that verdict on EXISTENCE alone, before any
content is compared. The materialisation half has the verdict this needs
(`materialise.ts:265-320`, "the ONE place the SOURCE-IS-THE-DESTINATION verdict
is reached"); the config half has no analogue.

So the config merge gains one — and see Spec Change Log 2, because the FIRST
implementation of this clause compared the wrong thing and shipped a critical.

Where the ledger claims nothing and an entry already occupies the location, the
existing native entry is READ BACK through `readMcpEntry` and compared against
the registry entry's `{command, args}`. Equal means **already satisfied: nothing
written, nothing claimed, no drift.** Unequal stays `foreign-collision`.

It is a comparison of MEANING, not of bytes, and the distinction is the whole
clause. `stillPandas` asks "are these the bytes panda WROTE?", where a byte hash
is the correct instrument and remains untouched. This asks "does this FOREIGN
entry already deliver what the registry names?", which a byte hash cannot
answer — it can only say whether the user happened to spell panda's exact key
set. Keys panda cannot represent (`env`, a vendor timeout) are IGNORED rather
than counted against the entry, because panda is not going to write them either
way and an entry that already runs the right command is satisfied whatever else
it carries.

**NOT ADOPTED, and that is the load-bearing half**, quoting the reason
`materialise.ts:283-285` already gives for its twin: panda did not write those
bytes, so claiming them would make `panda remediate release` an authority to
delete a server the user owns. The ledger keeps telling the truth.

**THIS WIDENS BEYOND INGEST, deliberately, and the widening is the fix.** It
changes `panda add` + `panda init` for every user, not only for an ingested
entry — because the defect is there for every user, not only for an ingested
entry. Measured at `bda68a0` by driving the binary: a hand-written
`mcpServers.context7` plus `panda add mcp-server context7` with the same command
gives `doctor` exit **1** and a `foreign-collision`, while the control (same
registry, empty container, panda writes it itself) gives exit **0** — and the
bytes panda wrote in the control are **byte-identical** to the hand-written
fixture. Panda reports a conflict against content indistinguishable from its
own, and M4.C's "every state has a way out" then offers two bad exits: adopt
bytes panda did not write, or delete your own entry. Patching only the ingest
path would leave `panda add` broken, which is the sibling this repo's own rule
says not to leave behind.

Degradation is correct in both directions: a user who later EDITS such an entry
has content that no longer matches, so it becomes `foreign-collision` again,
which is the truth; and an unclaimed entry is never in the removal path, because
removal requires a ledger record.

### D5 — ingestion is ADDITIVE, exactly as the port documents

An entry an origin stops listing is left in the registry untouched. Nothing is
removed. Pruning is a separate decision and is deliberately not made here.

### D6 — the id is the vendor's own id, and an unusable one is skipped, never renamed

The key under the container IS the entry id, which is what makes the round trip
hold: panda projects `<container>.<id>` from an entry with that id. An id the
registry contract refuses (`registryEntryIssues`, `UNPROJECTABLE_ENTRY_IDS`) is
reported and skipped — `ingestProviders` raises for the whole run, so an
unusable id must be filtered out before it gets there rather than after.

### D7 — two executors offering the same id

Measured before designed, exactly as M9.A's Amendment 2 required: if the two
candidates render to an IDENTICAL `{command, args}` there is no decision to make
and the first-consulted executor's copy is offered. If they DIFFER, panda offers
neither and reports both, because picking would silently choose between two
different servers. This mirrors the skills source's amended collision rule
(`registry/src/skills-source.ts:277-306`) rather than inventing a second one.

### D8 — a malformed vendor document is REFUSED with its location, never guessed

M7.E's rule, and it is not restated as prose here — the reader goes through the
SAME format strategies the writer does, so a document `parseTree` recovers from
is refused with its `line:column` by machinery that already exists. A second,
lenient read path for ingestion would re-open the exact defect M7.E closed.

### D9 — `--dry-run` uses the SAME call

M9.A's D7, unchanged: the decision is forwarded to the ONE `ingestProviders`
call. A preview computed by different code than the write is a preview that can
lie.

### D10 — not in this story

- Project scope. `panda ingest` is machine-scope today and this does not widen it.
- Pruning, reconciliation, removal of any kind.
- Remote sources: git, npm, marketplace.
- Any change to `ToolProvider`'s signature or to `ingestProviders`. The port is
  real and unchanged; this supplies it.
- Environment-variable / header payloads a vendor's MCP entry may carry. The
  envelope's `command` and `args` are what `REGISTRY_PATH_FIELDS` declares for
  `mcp-server`; anything else would need a root-key change, which is a contract
  decision and not this story's. An entry carrying one is ingested for what
  panda CAN represent and the dropped keys are REPORTED, never silently lost.

---

## I/O & Edge-Case Matrix

| # | Input / state | Expected |
|---|---|---|
| E1 | Vendor config absent | No contribution, no error (AD-5). |
| E2 | Config present, container key absent | No contribution, no error. |
| E3 | Container present and empty | `empty-source` warning, exit 0. |
| E4 | One server, not in the ledger | Ingested as `{type:'mcp-server', id, command, args}`. |
| E5 | One server, ledger claims that `targetId`+`entryId` | Not offered; reported as owned-by-panda. |
| E6 | Ledger unreadable | Coded `projectionLedgerUnavailable` refusal BEFORE any read of any config. |
| E7 | Malformed vendor document | Coded refusal naming `line:column`, through the existing strategy (M7.E). |
| E8 | Container holds a non-object | Coded refusal naming the container key, through the existing strategy. |
| E9 | Id the registry refuses | Reported and skipped; the rest of the run proceeds. |
| E10 | Same id from two executors, identical `{command,args}` | First-consulted offered once. |
| E11 | Same id from two executors, differing | Neither offered; one warning naming both locations. |
| E12 | Vendor entry carries keys panda cannot represent | Ingested for command+args; dropped keys reported. |
| E13 | opencode entry whose `command` array is empty | Reported and skipped: there is no command to run. |
| E14 | `--dry-run` | Same answer, store byte-identical (control: an mtime+content comparison). |
| E15 | Second run over an unchanged machine | Registry document byte-identical to the first. |

---

## Code Map

- `packages/projection/src/formats.ts` — `readMcpEntry` added to
  `ProjectionTargetTraits` beside `renderMcpEntry`; one exported reader that
  lists the ids present in a native document through the existing strategy.
- `packages/projection/src/targets/{claude-mcp,codex-config,opencode-config}.ts`
  — the three inverses, each beside its `renderMcpEntry`.
- `packages/registry/src/mcp-source.ts` — NEW. The `ToolProvider`. Knows neither
  which files nor which ids panda owns; both arrive as options, exactly as
  `skills-source.ts` takes `roots` and `ownedPaths`, and for the same AD-2 reason.
- `packages/environment/src/ingest.ts` — the wiring tier gains the second origin
  and passes `toolProviders` for the first time.
- `packages/cli/src/run.ts` — the `ingest` help text and report gain the
  mcp-server half.

---

## Tasks & Acceptance

- [ ] `readMcpEntry` on the traits, required, implemented on all three targets
- [ ] The exported native reader, going through the SAME strategy as the writer
- [ ] `createMachineMcpSource` — a `ToolProvider` over verified config locations
- [ ] Ledger-owned ids excluded, with an unreadable ledger a coded refusal
- [ ] The collision rule of D7, split on rendered content
- [ ] Wiring: `toolProviders` supplied in production for the first time
- [ ] CLI report and help text cover both halves

**Acceptance Criteria:**

1. **`panda ingest` on a machine with a real MCP server in a real vendor config
   puts it in the registry, and `panda list` shows it.** Driven with the binary
   against a throwaway `HOME`, with the executor's own file as the input — not a
   fixture panda wrote.
2. **`panda ingest` then `panda init` then `panda doctor` reports NO drift.**
   This is the criterion M9.A's seam defect would have failed, and it is the one
   that proves D3/D4 hold: panda must not accuse itself.
3. **`ToolProvider` has a production caller.** `toolProviders` appears in
   `packages/environment/src` — the exact query that returns nothing today.
4. **A second run leaves the registry document byte-identical.**
5. **`readMcpEntry` is required, and removing one target's implementation is a
   TYPE error** — not a runtime one, and not a silently unread target.
6. **The widening of D4 is proven where it bites, which is NOT ingest.** With no
   ingest anywhere in the run: a hand-written vendor entry plus `panda add` of
   the same id and the same command gives `doctor` exit **0** and writes nothing,
   where it gives exit 1 and a `foreign-collision` today. Its control, in the
   same run: change one argument so the content differs, and it must STILL be
   `foreign-collision` — a comparison that says "satisfied" for everything is not
   a comparison. And the ledger must claim neither, because panda wrote neither.

---

## Ask First

- Any change to `RegistryEntry`'s root fields, or to `REGISTRY_PATH_FIELDS`.
- Any widening of `panda ingest` to project scope.
- Any pruning, reconciliation or removal behaviour.
- Any second read path for vendor documents that does not go through the
  existing format strategies.

---

## Spec Change Log

0. Frozen at `bda68a0`. Supersedes M9.A's D8 on the measured ground that its
   stated reason ("its medium is not the filesystem") is false at this commit.

1. **D4 amended, and AC2 kept, because the implementer refused the contradiction
   between them instead of implementing past it.** The original D4 said the
   `already satisfied` case "cannot even arise as a divergence, because the bytes
   compared would be the same bytes". That was a claim about code behaviour
   written WITHOUT executing it — the one thing `AGENTS.md` names first under
   verification discipline, made by this spec's own author. The bytes are indeed
   the same; what does not exist is the comparison. `formats.ts:1090-1101`
   reaches `foreign-collision` from existence alone, and the SOURCE-IS-THE-
   DESTINATION verdict lives only in `materialise.ts`.

   Verified independently by the coordinator before the amendment was written,
   with a control: a hand-written `mcpServers.context7` plus `panda add` of the
   same id gives `doctor` exit 1 and a `foreign-collision`; the control — same
   registry, empty container, panda writing the entry itself — gives exit 0; and
   `fixture === what panda wrote in the control` is **true**.

   Three alternatives were considered and rejected, each for a measured reason.
   Adopting the entry into the ledger is refused by `materialise.ts:283-285`'s
   own stated reason. Accepting `doctor` exit 1 after a successful ingest is the
   product defect this story exists to remove. Having the source decline to offer
   an id read from its own target does not work, because the entry still has to
   project into the other two executors and the originating file collides anyway.

   The chosen resolution widens past ingest on purpose: the defect belongs to
   `panda add` + `panda init` and fixing only the ingest path would leave the
   sibling broken. It carries its own acceptance criterion (AC6) so the widening
   is proven rather than assumed.

   ADDED to the Code Map: `packages/projection/src/formats.ts` — the content
   comparison in the config merge, using only predicates the merge already owns.

2. **D4's MECHANISM corrected after the first implementation of it shipped a
   critical.** Amendment 1 said to compare "the canonical hash of what is there
   against the canonical hash of what panda would write, using only predicates
   the merge already owns". That was written by the same author, in the same
   voice, and it was wrong for the same reason the original D4 was: it reasoned
   about the code rather than executing it. A rendered-byte hash fires only when
   the user's entry spells the exact key set `renderMcpEntry` emits, so the
   ordinary real-world entry — `{"command":"npx"}`, or one carrying an `env`
   block — stayed a permanent `foreign-collision`, which is precisely the defect
   Amendment 1 was written to remove.

   Two independent reviewers found it; the coordinator confirmed it by execution
   with a control, and the control is the point: the ONE shape that passed was
   the shape the acceptance fixture had been built from, because that fixture was
   generated from `renderMcpEntry`'s own output. AC2 was reported green by a real
   binary run over an unrepresentative corpus. **Driving the binary is necessary
   and not sufficient.**

   The mechanism is now a read-back comparison through `readMcpEntry`. Fixing it
   at the root dissolved a separate finding at no cost — a byte comparison made
   TOML key order, spacing and comments significant, and a value comparison
   cannot.

---

## Verification

Every number below was produced by the COORDINATOR driving the binary, not by
reading a report. The drivers are kept in `.scratch/`.

### The before, captured before the implementer wrote a byte

`.scratch/baseline-bda68a0.txt`, on a throwaway HOME carrying one real-shaped
MCP server per vendor: `origin 'panda.machine-skills' contributed no entries`,
`0 entr(ies) ingested`, `panda list` -> `"entries": []`. Three servers
configured across three vendors, invisible. The defect as a number.

### The after, same driver, same sandbox

`3 entr(ies)` on the dry run and on the write; `panda list` shows all three;
opencode's argv correctly un-joined to `command:'uvx'` plus its arguments;
`init` exit 0; **`doctor` exit 0 with no findings**; the second run leaves the
registry byte-identical; and the foreign key planted in each of the three vendor
documents survived every write.

### The critical the first pass shipped, and how it was found

The first implementation compared RENDERED BYTES, so it reported `already
satisfied` only when the user's entry happened to spell the exact key set
`renderMcpEntry` emits. Two independent reviewers reached it; the coordinator
confirmed it by execution WITH A CONTROL:

| native shape | doctor, before the fix | after |
|---|---|---|
| the shape panda renders (the acceptance fixture) | 0 | 0 |
| `{"command":"npx"}` -- no `type`, no `args` | **1** | 0 |
| `type` absent, `args` present | **1** | 0 |
| carries an `env` block | **1** | 0 |

Per vendor, each on its own minimal shape: claude-code, codex (also with `args`
before `command`) and opencode all collided; all four now exit 0.

**THE ACCEPTANCE EVIDENCE WAS ITSELF UNREPRESENTATIVE, and that is the reusable
part.** The coordinator's sandbox fixture was built from `renderMcpEntry`'s
output, so it landed in the one shape the comparison accepted, and AC2 was
reported GREEN by a real binary run. Driving the binary is necessary and not
sufficient: a falsification is worth what its corpus is worth. This repository
had already recorded that lesson once, in these words -- "the plant landed in
the one shape the extractor accepted, and three other shapes sailed through
green" -- and it recurred anyway.

### The root, and why one line moved

`formats.ts`'s `record === undefined` branch was asking a BYTE question about a
MEANING question. The two are genuinely different and conflating them under one
hash is the whole defect:

- `record !== undefined` -- "are these the bytes panda WROTE?" A byte hash is
  the correct instrument, and `stillPandas` is untouched.
- `record === undefined` -- "does this FOREIGN entry already deliver what the
  registry names?" Answered through `readMcpEntry`.

Fixing it at the root dissolved a second finding for free: comparing read-back
values is format-independent, so TOML key order, spacing and comments stopped
mattering by construction rather than by a second canonicaliser.

### The risk the FIX introduced, measured

Ignoring keys panda cannot represent could swallow a real divergence hiding
beside one. Six rows, all passing: `env` present with command and args matching
is NOT a collision **and the `env` block survives untouched**; `env` present with
args differing, or with the command differing, IS a collision; reordered
arguments and an extra argument are collisions; no arguments on either side is a
match. A comparison that answers "satisfied" for everything is not a comparison,
and this one discriminates.

### AC6 -- the D4 widening, proven where it bites, with no ingest in the run

| | doctor | collision | file | ledger |
|---|---|---|---|---|
| content identical | 0 | no | untouched | empty |
| ONE argument different | 1 | yes | untouched | empty |

The ledger claims nothing in either direction, which is the NOT-ADOPTED half.

### The gate

Bytes 0. Typecheck 0 across all ten packages. Lint 0. **1,438 tests green on
Node 24 AND on Node 26.8.1**, live suites excluded. `pnpm build` clean and
`pnpm proof:consumer-install` 9 passed / 1 skipped -- the half `pnpm check` does
not cover, and this change adds exports.

`pnpm check` still aborts in `packages/projection` on
`skills-discovery.live.test.ts`, the known-red live suite that drives real
vendor binaries; it references none of the symbols this story touches.

### What the mutation round proved, after it proved its own harness was lying

The first mutation run shelled through cmd.exe, vitest never started, and every
mutant read as "killed by everything" -- an uninstrumented falsification run
producing exactly the confident green it exists to prevent. The harness now
refuses any result whose output lacks a `Test Files` line. From the fixed
harness, every clause below now has something that fails when it is violated:
the root comparison in both directions, `droppedNativeKeys` returning empty,
the source's unreadable-config report, both source-id literals (`mcp` and its
skills twin), the D3 ownership wiring, the value-versus-key fault split, and
opencode's argv message.

### What is NOT verified here, stated rather than papered over

One clause -- the reader classifying a non-absence errno -- is
`describe.skipIf(process.platform === 'win32')`, because `chmod 0o000` on win32
sets the read-only attribute and does not deny reads, and every other candidate
for a portable non-absence errno returns `ENOENT` on this machine. It runs in
CI, which is Linux. The BEHAVIOUR that depends on it -- a per-origin warning
rather than a run-wide refusal, with the other executor still contributing --
is injected at the source level and runs on every platform.
