---
title: 'technical research: DeepSeek Harness, the nine package groups the first two notes never named'
type: 'technical'
topic: 'What the third pass finds in hooks/settings, skill/mcp/subagent, experimental, and typert/test-support'
decision: 'What ships from the last unopened groups into panda, what is refused, and where panda is measurably ahead'
source: 'the deepseek-harness repository at 4e84901, measured with codegraph and ripgrep, panda measured at 1fcb43f'
status: complete
preset: 'standard'
validation: 'measured'
created: '2026-09-04'
updated: '2026-09-04'
claims_verified: 34
claims_unverified: 0
extends: 'deepseek-harness-the-unopened-half-2026-09-03 (which covered ~30 of 50 groups and named its own limits in § 7)'
---

# DeepSeek Harness, the last nine groups

## Executive summary

Two prior notes covered roughly thirty of DSH's fifty package groups. This note
opens the ones **neither of them mentions even once**, measured by subtraction
rather than assumed: `hooks`, `settings`, `typert`, `test-support`, `experimental`
have **zero** occurrences across both notes (control: `storage` → 16 and 3, the
query works). `subagent`, `skill`, `mcp`, `util` were named in passing and are
gone past here.

Four lenses ran, each forbidden to assert anything about panda it had not
measured in panda itself with a control. Every panda-side verdict that would
become a story was then re-verified at the line by the orchestrator, because the
recorded failure mode of this method is a correct mechanism attached to a wrong
verdict.

**The largest single finding is not a mechanism to take. It is that panda already
wrote the argument for one of these fixes and applied it to one axis only.** §2.1.

The piles:

1. **Four measured gaps in panda**, three of them verified at the line. §2.
2. **Six instruments worth taking**, each self-contained. §3.
3. **Five refusals with the reason measured.** §4.
4. **Eleven places panda is AHEAD**, recorded so nobody re-opens them. §5.
5. **DSH's own defect class, third note running — and this is the sharpest
   instance yet.** §6.

## 1. What was measured

DSH at `4e84901` (`dsh-0.1.2-alpha.4`), the same commit both prior notes used.
codegraph run **from inside** the DSH checkout — never the MCP tool, which
resolves its index by the session's working directory and answers about a
different repository — confirms `Project: C:\code\deepseek-harness`, 4,771 files
/ 52,691 nodes / 314,277 edges, unchanged.

Panda measured at `1fcb43f` on `main`, 12 packages.

| lens | corpus | src lines opened |
|---|---|---|
| A | `hooks/*`, `settings/*` | 3,281, read end to end |
| B | `skill/*`, `mcp/*`, `subagent/*` | ~5,500 of 14,341 |
| C | `experimental/*` | ~4,000 of 36,244, with the full map published |
| D | `typert/*`, `test-support/*`, `util/*` | ~4,500 of 19,000 |

**The DSH clone is three days behind upstream and that is fine**, because both
prior notes pin `4e84901` and this one continues them. A method note: measuring
that staleness with `git rev-list --count HEAD..@{u}` returned **15,176**, which
is a false number — the clone is GRAFTED, so the count includes history the graft
cut. Controlled by dates instead: local HEAD 2026-09-01, upstream 2026-09-04.
Same family as every other false zero this project has recorded, in the opposite
direction: **an instrument can report a confidently wrong LARGE number too.**

## 2. Four measured gaps in panda

### 2.1 A store version bump is a dead end reachable by DOWNGRADE, and panda already wrote the argument against it

`packages/registry/src/store.ts:345-352` throws `unavailable('validate', …)` for
the WHOLE store when `foundVersion !== STORE_VERSION`.

Fifteen lines below, at `store.ts:358-365`, sits the argument:

> `admitRetired`, and ONLY here: a document written by an older build may hold a
> word panda has since retired, and one such row used to make the **WHOLE store
> unreadable — which blocks `panda list`, `panda remove` and `panda init`, i.e.
> the very commands that would take it out.** Retiring a word must not be
> reachable as a dead end by upgrading (M4.C).

That is the same dead end, reached from the other direction. An older build
reading a `STORE_VERSION` it does not recognise loses exactly those three
commands, and the user's exit is to hand-edit the document panda exists to stop
them hand-editing.

DSH splits the two absences at
`packages/subagent/subagent/src/descriptor.ts:203-212` and `:305-322`: an
unrecognised **version** returns `undefined` — the record is *unclassifiable by
this runtime*, not damaged — while a current-version payload violating its schema
**throws**. Its consumer then collapses missing / malformed / unrecognised-version
into one contained per-record diagnostic *because the consumer's action is
identical* (`control-types.ts:63-78`), which is the second half of the design and
the reason it does not multiply vocabulary.

**Verified at the line by the orchestrator.** This is the strongest candidate in
the note: the reasoning is already panda's own, the fix is one branch, and the
failure it prevents is the one panda has already declared unacceptable once.

### 2.2 An HTTP/SSE MCP server cannot be represented at all

Panda's `mcp-server` entry carries `command` + `args` and nothing else
(`contracts/src/registry.ts:110-113`). A URL transport has no root field to land
in, and panda's own source says so three times:

- `projection/src/formats.ts:120` — *"a vendor's `env` table or a `url` has no
  root field to land in"*
- `projection/src/targets/claude-mcp.ts:28` — *"a server with no command at all —
  an HTTP or SSE entry carries a `url`"*
- `projection/src/targets/opencode-config.ts:25` — *"A `remote` server carries a
  url and no argv at all"*

Control: `command` → 23 hits in `formats.ts`, so the files were read.

DSH's `Config` is a **discriminated union on `transport`** with a whole second
branch carrying `url` and `headers`
(`packages/mcp/mcp-client/src/index.ts:75-92, 111-129`).

**Verified at the line.** Two things keep this from being a defect and make it a
decision instead. First, panda REPORTS it: `droppedNativeKeys`
(`formats.ts:118-127`) is derived from the renderer via `renderedKeys` so the drop
list cannot drift, and D10 says dropped native keys are reported, never silently
lost. Second, it is a widening of the entry envelope, which is exactly the kind of
change M4.E and M4.F were about. But it is the one place DSH's entry vocabulary is
**structurally wider** than panda's, and all three of panda's target vendors
support it natively — by panda's own comments.

### 2.3 The cross-process lock: panda named the upgrade path, DSH ships it

`packages/projection/src/ledger.ts:205-214`:

> `ponytail:` in-process only, so two panda **PROCESSES** can still interleave and
> lose a claim. A cross-process lock cannot be borrowed from `@skanl/panda-registry`
> (AD-2/AD-7: that edge was removed in Story 2.8 and leaked `PANDA_REGISTRY_*`
> codes out of a projection API); **extracting a leaf lock package with its own
> codes is the upgrade path**, recorded in `deferred-work.md`.

DSH ships that leaf package (`withFileLock`, banked 2026-09-03 §6.1) **and** a
worked example of wrapping a vendor-facing read-modify-write in it
(`settings-file/src/index.ts`). The deferral's stated reason is a cost. That cost
is now lower.

**Verified at the line.** ROADMAP-03's own method note applies directly here:
*"Re-measure the reason, not the entry — five deferrals in one session had a
reason that had expired while the entry had not noticed."*

Do NOT take the rest of DSH's write policy with it — see §4.3.

### 2.4 `test/guard.test.ts` is in 4 of 12 packages, and the ratio is getting worse

Measured directly: `ls packages/*/test/guard.test.ts` → **4**; `ls -d packages/*/`
→ **12**. The banked note measured 4 of 10. Two packages have been added since and
neither carries a guard.

The eight without: `adapter-cli`, `cli`, `contracts`, `memory-filesystem`,
`memory-sqlite`, `registry`, `workspace-git-worktree`, `workspace-local`.
`registry` and `cli` were already the two named gaps, and a frozen spec once told
an implementer to read guard tests that do not exist — which is how this was found
the first time.

**Verified at the line.** This is a trend, not a snapshot: the guard is not
part of whatever ritual adds a package.

## 3. Six instruments worth taking

**(a) `assertConsumed` — a harness that cannot silently measure nothing.**
`packages/test-support/llm-replay/src/index.ts:143-151, 902-916`. Teardown throws
unless every recorded script bound to a live session AND every bound cursor
consumed its full entry list, with the two failures named separately. The
instrument carries **its own control**: three negative tests
(`tests/llm-replay.spec.ts:1001, :1028, :1038`) assert it goes red for underrun,
for an underrunning named session, and for a never-bound script.

This is the exact defect class of panda's mutation harness reporting "1 killed"
eight times when the reporter never wrote its output file. Note that panda's
CONTRACT suite already has this discipline (§5.10) — the gap is the mutation
harness, not the conformance one.

**(b) `assertUniqueSnapshotContents` — a fixture set where a false positive cannot
form.** `test-support/session-snapshot/src/suite.ts:311-337` rejects
byte-identical committed snapshots stored under different paths. Two scenarios
whose expected outputs are accidentally the same are not two tests; they are one
test and a decoy. Paired with `claimSharedSnapshot` (`:289-310`), which fails when
two scenarios generate DIFFERENT bytes for a deliberately shared snapshot. Both
halves: sharing must be identical, non-sharing must be distinct.

Panda has only the opposite check — every `identical` assertion in panda asserts
outputs ARE identical (`cli/test/registry-commands.test.ts:893`,
`environment/test/ingest.test.ts:493`). Nothing rejects two fixtures that
collapsed into one.

**(c) `snapshotJsonValue` / `isJsonValue` — a losslessness gate, not a
serializer.** `packages/util/values/src/index.ts:72-183`. Rejects `-0`,
non-finite numbers, sparse arrays, symbol and non-enumerable keys, cycles, and
**forged or cross-realm prototypes** (`Function.prototype.toString.call(ctor)`
against the native-code string). Validation and detaching happen in ONE iterative
traversal with one read per property — a validate-then-clone pair reads every
getter twice and can be handed a different value each time.

Measured in panda: `structuredClone` appears once (`registry/src/ingest.ts:197`);
`Object.getPrototypeOf` appears once and it is a test assertion, not a gate.
Panda's registry entries round-trip through JSON.

**(d) `publicToolName` — a lossy-safe, one-way id → native-name projection.**
`packages/mcp/mcp-client/src/tools.ts:113-118`. Identity is `(serverName,
rawName)`. The clean case renders verbatim; when normalization to the vendor's
name grammar CHANGES the string, a 12-hex SHA-256 of `` `${serverName}\0${rawName}` ``
is appended — NUL-separated so `("ab","c")` and `("a","bc")` cannot collide. Two
properties are the craft, both stated at `tools.ts:6-11`: it is a pure function of
the identity, and *"the public name is never parsed to recover it"* — the wire
call always sends `rawName`.

Panda rejects at registration (`UNPROJECTABLE_ENTRY_IDS`,
`contracts/src/registry.ts:118-120`) where DSH re-encodes at projection. Both are
legitimate; DSH's is the answer for a vendor whose key grammar is NARROWER than
panda's id grammar, and the hash-on-lossy rule turns "two distinct entries can
never project to one native key" from a hope into a property.

**(e) Late-bound credential expressions the dump cannot evaluate.** DSH configures
MCP credentials as `!!js process.env.GITHUB_TOKEN` — a loader node evaluated at
mount (`boot/app-boot/src/index.ts:205`) — and the part that makes it a guarantee
is that `dsh --dump-config` prints it **verbatim, unevaluated**, asserted at
`boot/app-boot/tests/config-dump.spec.ts:84-85`. Panda's `mcp-server` has no
credential slot today (§2.2); the day it grows one, a literal is a leak in every
`panda list` and `panda doctor` output.

Honest limit: DSH's test asserts the EXPRESSION round-trips unevaluated, not that
a planted secret never appears. The stronger claim lives in a different package
(`credentials-local`, banked 2026-09-03 §2e) — and panda's own version of that
test is stronger still (§5.9).

**(f) The write-validator IS the reader.** `experimental/agent-team/src/invariant.ts:20-32`
validates a candidate event by REPLAYING it through the projection's own `apply`
on a `structuredClone` of committed state, then failing if the clone's `failure`
field got set. There is no second spelling of the rules: every legality rule lives
once, in `projection.ts:238-305`, enforced both when reading history and when
admitting a write.

The 2026-09-03 note banked "invariants register against a dispatch hook and
validate before commit". It did not bank *that the validator is the replay
function itself*. That is the general form of that note's own §2(a) rule — when
two enforcement points answer one question, the answer is a function — pointed at
the read/write axis. **Panda has no transition rules to apply it to**, because the
registry is a record set and not a log, so this is a mechanism to hold rather than
a gap to close. Panda already applies the same discipline to the envelope
(`registryEntryIssues` from five call sites) and to serialisation
(`serialiseLedgerDocument`, exported so a remediation preview and the write cannot
diverge, `ledger.ts:188-197`).

## 4. Five refusals, with the reason measured

**4.1 Do NOT take DSH's symlink policy. Panda's is the opposite and panda is
right.** DSH's atomic write REPLACES a symlinked target with a regular file, with
a gate asserting it (`util/atomic-write/src/index.ts:68`, `local.spec.ts:199`).
Panda FOLLOWS and never replaces, and says why at
`projection/src/atomic-write.ts:15-21`: *"`~/.claude.json -> ~/dotfiles/claude.json`
is the ordinary way people keep these files in a repo, and `rename()` over a
symlink destroys the link and orphans the source"*, with a coded refusal for a
dangling link. Both correct for their own file — DSH's document lives in
`$DSH_HOME` and is DSH's alone; panda's targets are the user's dotfiles. Taking
DSH's rule into panda destroys dotfile-manager setups.

The half worth a glance: DSH defends the pre-planted-symlink race with a fixed
temp path plus `wx` exclusive create. Panda uses `randomUUID()` in the temp name
(`atomic-write.ts:62`) with a plain `writeFile`, so pre-planting is infeasible
already. `flag: 'wx'` is a nice-to-have, not a defect.

**4.2 Do NOT copy DSH's JSON rendering.** `settings-file/src/index.ts:362-368` is
`root[ns] = section; JSON.stringify(root, null, 2)` — it reformats the ENTIRE
document. Only the YAML path gets a comment-preserving CST diff, and its own
round-trip gate asserts the parsed result, not the bytes. Claude Code's
`settings.json` and `~/.claude.json` are JSON. Panda's `formats.ts:34-40` splices
at OFFSETS over `parseTree` node positions, derives the indentation unit from the
file's own first indented line and its own EOL, and reports `ownedSpans` so byte
preservation is checkable mechanically. Panda is ahead; do not regress toward DSH.

**4.3 Do NOT adopt DSH's fold-the-foreign-edit-in write policy.**
`settings-file/src/index.ts:217-223` re-reads inside the writer lock and MERGES an
unobserved external edit into the render, with a passing gate. Right for DSH,
where a namespace is a whole top-level key with one in-process owner. Wrong for
panda, which writes rows inside vendor-owned containers — folding in a concurrent
foreign edit is precisely the state `foreign-collision` exists to report
(`contracts/src/projection.ts:104`). Panda's answer is to snapshot the `stat`,
re-check after the read, and REFUSE (`projection/src/remediate.ts:522-530`). Take
the lock (§2.3), refuse the policy.

**4.4 Do NOT read `subagent-claude-code` as prior art for panda's projection.**
DSH spawns Claude Code and Codex — panda's exact executors — and deliberately
REFUSES to own their configuration, with tests enforcing the refusal:
`expect(options).not.toHaveProperty('settingSources')`
(`subagent-claude-code/tests/subagent-claude-code.spec.ts:890`) and
`.not.toHaveProperty('pathToClaudeCodeExecutable')` (`:704, :882`). Its README
says it *"does not copy or filter those files, create or modify login state,
inspect `PATH`, or fall back to a host `claude` executable."* This is a consumer
declining the problem panda exists to solve. Its value is as outside evidence
that the problem is real and that the largest agent harness ducked it — not as a
blueprint.

**4.5 Do NOT adopt DSH's skill collision policy, nor its advisory write scopes.**
DSH resolves a duplicate skill name by fixed rank constants within a layer and
SILENTLY by scope-chain order across layers (`skill/src/index.ts:809-813, :558-565`),
and it **never compares content** — control-backed: `hash|digest|checksum|identical|sha256`
over `packages/skill/` returns ~25 hits and not one compares two candidate bodies;
the README states *"Bodies are not versioned"*. Worse, the repo carries **four
incompatible collision policies for one question** (rank-wins-with-warning,
first-wins-with-a-no-op-disposer, throw-at-load, throw-with-a-typed-code) and only
one carries a code a consumer can route on.

Likewise its multi-agent coordination is an ADVISORY write-scope convention plus a
policy string in a system prompt (`agent-team/src/validation.ts:22-33`,
*"Normalize one workspace-relative path prefix without treating it as a lock"*).
Panda's answer to the same problem is enforced isolation, proven by a live test
that fails if neither session tried to write
(`adapter-cli/test/confinement-live.test.ts:447-538`).

The one micro-mechanism worth stealing from that pile: a rejected duplicate
registration must not be handed a disposer that unregisters the WINNER
(`skill/src/index.ts:443-447`).

## 5. Eleven places panda is AHEAD, so nobody re-opens them

1. **Same id in two roots, split on CONTENT.** `registry/src/skills-source.ts:270-300`:
   refusing outright refused 24 of 40 ids on the measured machine; eleven of those
   trees are byte-identical, so there is no decision to make there. `treeIdentity()`
   collapses those and keeps refusing the 13 that genuinely differ, with ONE warning
   naming every root. `mcp-source.ts:277` does the same over a different equality.
   **DSH does not have the question**, control-backed (§4.5).
2. **The byte-identical-foreign case is refused adoption, deliberately.**
   `formats.ts:1481-1487` — *"ALREADY SATISFIED: nothing written, nothing claimed,
   no drift. … NOT ADOPTED, and that is the load-bearing half"*, resting on
   `ledger.ts:17-19`: the ledger is the ONLY proof of ownership.
3. **An ownership ledger at all.** Control-backed zero in DSH's settings:
   `owner|owned|ownership|provenance|managed|marker|reclaim|retract|undo|orphan`
   over `packages/settings/*/src/*.ts` → 20 hits, **none a record of written rows**;
   every one is in-process registrant ownership or a file mode. DSH's undo guarantee
   is structural instead — one namespace, one top-level key, one owner — which does
   not transfer, because `hooks.PreToolUse[]` is a shared array, not a panda-owned
   namespace.
4. **Byte-preserving splice rendering.** §4.2.
5. **Symlink policy.** §4.1.
6. **`foreign-collision` refusal over fold-in.** §4.3.
7. **Write rollback restores prior CONTENT, not just prior registration.**
   `projection/src/materialise.ts:767-798` captures the previous bytes, so a
   mid-tree failure restores content; DSH's equivalent
   (`tool-agent-team/src/index.ts:388-394`) only un-registers. Panda's docstring
   names its own ceiling honestly.
8. **Interrupted intent is reported with a verb exit, and the startup sweep is
   refused in writing.** `environment/src/doctor.ts:104-120`: *"It is REPORTED here
   and resolved by a verb, never swept at startup: a sweep that removed on every
   process start would make panda destructive on a run the user did not ask to be
   destructive."* DSH auto-reconciles at session start because it settles its own
   provisional records; panda touches the user's filesystem. **Take DSH's
   intent→outcome record and its compare-and-set-returning-current-phase; refuse
   the sweep.**
9. **The credential-quoting question is CLOSED and generalised.** The 2026-09-03
   note left *"does any panda error path quote source text from a document that can
   hold a credential?"* as its cheapest open follow-up. Answer: it did, it was
   found, it was fixed as M17.A, and the rule was generalised. `store.ts:341-345`
   and both `document-fault.ts` copies drop V8's message WHOLE plus the `cause`,
   deriving `line:column` from `jsonc-parser` offsets.
   `projection/test/document-quoting.test.ts` asserts the needle appears in the
   message, the stack **and the RENDERED cause** across six document classes —
   and the reason for the third is written at `:60-61`: `error.stack` alone does
   not render an attached cause, so a `cause` restored by a later edit would slip
   past a message-and-stack check. **DSH's `credentials-local` test checks message
   and stack only.** Panda is ahead, not behind.
   `ledger.ts:243-247` applies the rule preemptively: *"'no credential happens to
   sit inside V8's snippet window today' is not a property of the code."*
10. **Conformance suites that verify themselves.** `contracts/src/contract-suite/`
    exports `WORKSPACE_CLAUSES`, `MEMORY_CLAUSES`, `EXECUTOR_CLAUSES`, carries
    DSH's `reopen()` restart seam AND more of it (`state-survives-reopen` checks
    payload, sequence, provenance and search-after-reopen with a distinct failure
    sentence per axis), and adds three self-verification layers DSH's does not
    visibly carry: `expect(report.clauses).toEqual(MEMORY_CLAUSES.map(c => c.name))`
    so a silently-skipped clause is red; a deliberately broken adapter driven
    through the same runner asserting the exact ordered list of violated clause
    names; and the comment stating the thesis —
    *"Driven, not described: a subject that fails the FIRST clause, run through the
    same runner both providers use. Without this, 'the provider is named' is a
    claim about a code path no green run ever takes."*
11. **Zero unconditional disabled tests.** Measured: `(describe|it|test)\.(skip|todo)`
    over `packages/` → 13 hits, and **all thirteen are `skipIf(...)`** — three live
    executors, three win32 platform splits, a tarball opt-out, and six clause-shape
    conditionals. Control: `describe(` → 110 files. DSH has exactly two
    unconditional skips in the whole repository and they are §6.

Also LEVEL, so neither side is a lead: **counted loss**. DSH quantifies dropped
observations (`inspector/.../buffer.ts:118`, `droppedBefore`); panda already ships
the same in two subsystems (`environment/src/ingest.ts:70`, `init.ts:416`, and
`projection/src/ledger.ts:256-271`, which names the count AND the consequence).

## 6. DSH's own defect class, third note running, sharpest instance yet

**The doc-generator's entire negative-path contract suite is switched off while
the gate that depends on it runs in CI.**

`packages/typert/generator/tests/cordis-catalog-contract.spec.ts:127` and `:242`
are both **unconditional `describe.skip`** — 343 lines, 26 `it()` cases, **21
`toThrow` assertions**, dark.

The control is what makes this a finding rather than noise:
`(describe|it|test)\.(skip|todo)` across all of `packages/` → 10 hits, and eight
are conditional and legitimate (`apiKey ? describe : describe.skip`,
`platform === 'win32' ? …`). **These two are the only unconditional skips in the
entire repository.**

Meanwhile the gate is live — `scripts/run-gates.ts:724` runs
`tsx scripts/gen-cordis-catalog.ts --check` — and the generator source is
**coverage-exempt** (`vitest.config.ts:328`, under an otherwise 100% per-file
threshold), with the exemption justified by naming *"its fixture suites"* as the
correctness signal. For this module that signal is the file that is off. Its live
sibling has **0** `toThrow`; the skipped file has 21.

The failure mode is quiet by construction: `--check` compares emitted bytes, so if
the validation stopped firing, existing docs still reproduce byte-for-byte and the
gate stays green. The loss appears the next time someone adds an undocumented
event — which is then silently emitted instead of rejected.

Two prior notes each found a gate nobody runs. This one found a gate that runs
whose contract does not. **A gate is not one artifact; it is a runner and a
contract, and either half can be dark while the other reports green.**

## 7. What was NOT concluded

- **`packages/experimental` is ~89% unopened**: all 78 files / 12,893 lines of
  `webworker-runtime`, 144 of 148 files of `inspector`, all of
  `code-runtime-python` (3,159) and `client-ui-agent-team`. The full map with
  per-package sizes is published in the lens output and is itself the deliverable
  there. Refused deliberately: `inspector` is a CDP hub whose own README says the
  target grants arbitrary code execution in both realms and does not redact
  credentials; panda has no in-process runtime to inspect.
- **`packages/subagent` is ~80% unopened.** `continuation.ts` (1,631 lines — cold
  resume, ownership authorization, inbox admission) is the largest unopened file
  and is where per-child authorization actually lives — the closest thing in DSH
  to an ownership proof, and the likeliest place a further pass finds something.
- **`packages/preset`** was named by lens B as the right next corpus if panda ever
  grows a third entry type for agents, and was outside every lens's scope. Agent
  definitions in DSH are not frontmatter+markdown documents; a preset is a
  directory holding a plugin composition list.
- **Whether panda has an equivalent of a refusing ACTION result** (DSH's
  `noProgress`, `tool-agent-team/src/index.ts:245-267`: a verb that provably
  cannot help you says so and names the verb that can). Panda's `FINDING_EXITS`
  guarantees every DIAGNOSIS kind has an exit; the action side was not measured
  with a control and is not claimed either way.
- **Whether panda's bundle tests parse the shipped composition through the
  consumer's real reader**, the way `agent-team-profile/tests/profile.spec.ts:8,27-30`
  does with the consumer's own `entryListSchema`.
- **Whether any story plans source-driven retraction.** Measured:
  `store.register(` has 3 call sites, `.remove(` has 2, and nothing retracts an
  entry when its source stops offering it — ingest is additive by construction. A
  related consequence: panda's discovery sources have no completeness flag, so a
  source whose root was unreadable is indistinguishable from one that genuinely
  saw fewer entries. That difference only bites the day retraction exists.
- **The `@deepseek-ai/node-addon-landlock-run` addon, `@deepseek-ai/schemastery`,
  and `@deepseek-ai/dsh-shell`** remain external and unopened. A lens that cannot
  open a dependency says so rather than inferring from the call site.

## Sources

- Repository: `https://github.com/deepseek-harness/deepseek-harness` at
  `4e84901`, cloned to `C:\code\deepseek-harness`, indexed by codegraph, gitnexus
  and graphify — all three current at that commit.
- Prior notes: `research/deepseek-harness-the-unopened-half-2026-09-03/research.md`
  (which this extends), `research/deepseek-harness-the-product-layer-2026-09-02/`,
  and `research/cordis-spatiotemporal-composability-2026-09-01/`.
- Cordis at `C:\code\cordis` (`0027892`) was NOT re-measured and contributes
  nothing here. It was already established as a zero-delta on 2026-09-03: nine of
  nine packages covered by eight lenses, 73 files / 991 nodes unchanged. **The
  mining of cordis is closed and re-running the three graph tools over it produces
  nothing.**
- Panda measured at `1fcb43f`. Every panda-side verdict in §2 was re-verified at
  the line by the orchestrator after the lens reported it, because the recorded
  failure mode of this method is a correct mechanism attached to a wrong verdict.
  One lens claim did not survive verification and is corrected in place: §5.11
  reported zero `.skip` hits in panda; there are 13, all of them `skipIf`. The
  substance held, the number did not.
