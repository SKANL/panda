---
title: 'technical research: DeepSeek Harness, the product layer above cordis'
type: 'technical'
topic: 'What panda takes from the harness that was built on the paradigm panda re-derived'
decision: 'What ships from DSH into panda, what is refused, and which open stories it settles'
source: 'the deepseek-harness repository at 4e84901, its published reference, and arXiv 2608.25512'
status: complete
preset: 'standard'
validation: 'measured'
created: '2026-09-02'
updated: '2026-09-02'
claims_verified: 31
claims_unverified: 0
supersedes_scope_of: 'cordis-spatiotemporal-composability-2026-09-01 (§ Sources cited DSH once and never opened it)'
---

# DeepSeek Harness, and what panda takes from it

## Executive summary

The cordis note answered *"is the paradigm right?"*. It cited DeepSeek Harness once,
in § Sources, as a quotation. This note opens the repository behind that quotation.

**DSH is the product layer in panda's exact domain, built on the paradigm panda
re-derived by hand.** Where cordis is 991 graph nodes of framework, DSH is 52,691
nodes of shipped agent harness: sessions, storage seams, skills, MCP servers,
hooks, credentials, presets, diagnostics. That is a 53× larger corpus and, more to
the point, it is the layer panda's open stories actually live in.

Six lenses ran over packages nobody had opened, each required to report mechanism
with `path:line` and a control for every zero. The findings sort into four piles,
and the four piles are the answer:

1. **Two open stories get a shipped blueprint** (Epic 3's storage port, Epic 4's
   crash-safe disposal). §2, §3.
2. **Two open stories are SETTLED AGAINST BUILDING** by measured absence — the
   largest agent harness in the world does not have the substrate either. §4.
3. **Three mechanisms are cheap, self-contained, and worth taking now.** §5.
4. **Panda is measurably AHEAD in three places**, recorded as negative results so
   nobody re-opens them. §6.

The single highest-value item is none of the code: it is §7, `AGENTS.md`.

## 1. What was measured, and how

DSH cloned to `C:\code\deepseek-harness` at `4e84901` (`dsh-0.1.2-alpha.4`), indexed
three ways, all current at that commit:

| tool | result |
|---|---|
| codegraph | 4,771 files, 52,691 nodes, 314,277 edges |
| gitnexus | up-to-date at `4e84901` |
| graphify | 873 nodes, 1,097 edges, 77 communities over 121 English docs |

For comparison, cordis at `0027892`: codegraph 73 files, 991 nodes, 3,431 edges —
re-measured this session and unchanged, with all nine packages already covered by
the eight lenses recorded in the cordis note. **Re-running the three tools on
cordis is a measured zero-delta.** This note exists because the delta was
elsewhere.

Six lenses: storage/memory · session lifecycle · settings/presets/credentials ·
skills/MCP/hooks · diagnostics/quota · engineering practice. Each was forbidden
from asserting anything about panda, so every "panda has / lacks" verdict below is
this note's own, measured in panda directly.

## 2. Epic 3 — the storage port, shipped by someone else

Stories 3-1 (a MemoryProvider port) and 3-2 (filesystem + sqlite providers) exist
in DSH as `ctx.storage` → `storage-json` | `storage-sqlite`, one of **24 declared
capability seams** (published reference, `/en/reference/capability-seams`). The
naming convention is a topology answer, not a runtime one: package `X` declares the
interface, packages `X-<impl>` provide it. That matters, because AD-2 forbids the
god-Context shape cordis uses and this shape does not need it.

What to take, measured:

- **The port is deliberately DUMB.** `StorageBackend` → `KvFacet` → `KvUnit` is
  five methods total and values are opaque `unknown`
  (`packages/storage/storage/src/backend.ts:81-114`). No transactions, no queries,
  no migrations, no streaming, and — stated twice as contract — **no write
  serialization**: "write ordering is the caller's responsibility"
  (`backend.ts:66-73`). Schemas, in-memory state, change events and the write
  chain all live in a separate mounted layer, not in the port.
- **One shared conformance suite over every implementation**, with a `reopen()`
  factory that simulates a process restart: `runKvBackendContract(label, create)`
  (`packages/storage/storage/tests/contract.ts:32`, reopen clause `:74-89`).
  Panda already owns this idiom — `packages/projection/test/vendor-conformance.test.ts:211`
  is a `describe.each(SHIPPED_TRAITS)` and `:249` is a meta-test asserting *the
  conformance assertion itself is mechanical*. What panda does NOT have is that
  idiom applied to its two provider implementations: `workspace-local` and
  `workspace-git-worktree` each carry their own `test/contract.test.ts` with one
  `describe` apiece (measured), not one suite parameterised over both. **A second
  provider without a shared suite is two contracts, not one.**
- **Ordering discipline: durable first, memory second, event third.** The domain
  awaits backend durability *before* mutating memory
  (`packages/storage/storage-domain/src/domain.ts:307-313`), so a rejected write
  cannot desync the two. The `single`-layout JSON unit does the inverse and
  therefore carries three hand-written rollback blocks
  (`storage-json/src/single-unit.ts:82-86`, `:95-98`, `:108-111`). The whole
  serializer is a three-line promise chain (`domain.ts:263-270`), and it buys
  synchronous reads, a genuine atomic read-modify-write, and events guaranteed
  equal to current state. DSH evaluated `p-queue`/`async-mutex` for it and rejected
  them because "the serializer is 8–14 lines and the packages are larger than the
  code they'd delete".
- **Versioning is reject-only, never migrate** — both backends stamp a version and
  throw `version-mismatch` on divergence (`storage-json/src/format.ts:66-71`,
  `storage-sqlite/src/index.ts:100-110`). Panda's `STORE_VERSION` equality check
  (`packages/registry/src/store.ts:325-329`) is the same decision, reached
  independently. The one escape hatch is scoped to a *cache*: the `per-record`
  layout reads a stale document as **absent** rather than bricking the unit
  (`format.ts:101-122`), and its single shipped consumer is a projection cache.
  Adopting that for durable user data silently deletes records on a version bump.

**The one to refuse:** the `per-record` layout. It is cheap to describe and
expensive to own — a path-safe key regex, a per-document version stamp, a
directory-walk `loadAll` that must distinguish "no documents" from "unreadable
documents", and a one-way legacy bootstrap. It pays only for large sparse
disposable records.

**And the one that is panda's own defect class, in someone else's repo:**
`storage-sqlite` conforms to the suite and has **zero dependents outside itself**
(control: `dsh-storage-json` → 6 manifests; `dsh-storage-sqlite` → only its own),
and appears in **no** bundle patch (control: `dsh-storage-json` →
`packages/bundle/base/cordis.patch.yml:149`). A finished, tested, unreachable
implementation — exactly `ingest.ts`'s 375 lines with no production caller across
two milestones. **Story 3-2 must name its production caller in its acceptance
criteria, or it ships the same hole.**

## 3. Epic 4 — crash-safe disposal, and a function worth copying whole

DSH's recovery model is **FORWARD**, which is the same choice panda made and for
the same reason. The deciding code is worth taking almost verbatim:

`interruptedTurnClosers` (`packages/core/session/src/repair.ts:29-131`) is a **pure
function** `readonly SessionEvent[] → SessionEvent[]`. No I/O, no clock —
timestamps reuse the last real event so a repair is deterministic and never invents
a future time (`:88`). It replays an append-only log, and where a turn was left
open it appends the missing closing brackets: a synthetic error result per
unmatched call, then the step close, then `turn/end { reason: 'interrupted' }`. A
balanced log returns `[]` (`:84`). 130 lines, one test file, two production callers
— and both callers are **on load of that one session**, not a boot-time sweep.

The part that is not obvious and is the reason to copy it: it encodes **side-effect
uncertainty in the payload the consumer will read**. `TOOL_NOT_STARTED` says retry
it. `TOOL_OUTCOME_UNKNOWN` says *"retry only if the operation is read-only or
idempotent; if it may have side effects, first verify external state or ask the
user. Do not retry blindly."* (`repair.ts:104-107`). That is the hard half of crash
recovery in an agent, and it is a string constant.

Also measured, for Story 4-3:

- **Double-dispose guards, three independent ones**, all memoised rather than
  flagged: `disposing ??= (async () => {…})()` (`agent-loop/src/index.ts:560`).
- **Containment is UNEVEN and the unevenness is measurable.** Session listeners are
  per-listener try/caught (`session/src/index.ts:386-397`); jobs teardown
  force-fails a throwing `cancel` and logs "work may be orphaned" rather than
  deadlocking (`jobs-local/src/index.ts:519-527`); but cordis's own per-effect
  disposer loop has **no try/catch** — one sync throw abandons the spliced
  remainder (`vendor/cordis/src/fiber.ts:427-442`). DSH works around this by
  folding session + agent into **one** effect with an explicitly reversed teardown
  (`agent-loop/src/index.ts:576-577`) rather than trusting fiber ordering. Panda's
  M7.A made the opposite choice — the kernel's teardown contains a throwing
  disposer — and this measurement says panda's is the stronger one.
- **The SIGKILL grace timer is deliberately never cleared and stays ref'd**, because
  "the leader dying does not mean the tree died" and "a parent exiting before it
  fires would orphan a trapped survivor" (`subprocess-local/src/spawn.ts:447-452`).
- **PID reuse is fenced structurally**: `ProcessIdentity` is PID *plus start time*,
  "preventing teardown escalation after PID reuse" (`process-inspector.ts:8-9`).

## 4. Two stories SETTLED against building, by measured absence

### 5-6 (status + quota) — there is no substrate, and this is the proof

The handoff already concluded "wait for a vendor to publish a documented usage
surface", from panda's own absence (`quota` → 2 hits, both a regex over error text;
control `drift` → 198). That was an argument from panda's silence. It is now an
argument from the largest agent harness in the world:

- **No `x-ratelimit-*` header is read anywhere** in `packages/` or `apps/`. Control:
  the same query for `x-request-id` → **6 files**. The query works; the header is
  genuinely not read.
- **No usage or billing endpoint is called.** The only outbound provider requests
  are `POST {baseURL}/chat/completions` (`llm-deepseek/src/adapter.ts:643`, the
  sole `fetch(` in that package) and a model-listing `GET`.
- **Quota versus rate-limit is decided by regex over provider error prose** —
  `isQuotaExceededError`, five regexes (`packages/llm/llm/src/error.ts:94-100`),
  called from `httpErrorCode` **before** the 429 branch so a 429 whose body says
  "insufficient quota" becomes terminal rather than retryable
  (`adapter.ts:332-334`).

So DSH's *only* account-level knowledge is the same error-text classification
panda's 2.6 forbids under a different name. **5-6 is not blocked on panda's
design. It is blocked on the industry.** Close the question and re-open it when a
vendor ships a documented surface.

### 2-6 (liveness) — the shape to copy is not the MCP one

MCP liveness in DSH is spawn-and-handshake plus a bounded reconnect budget
(500 ms doubling to 30 s, 10 consecutive failures per outage, uptime resets the
budget so a crash-looper still exhausts the cap —
`packages/mcp/mcp-client/src/connection.ts:40-45`, `:192-225`). And that is all:
**no ping, no heartbeat, no capability probe, and no connect timeout.** Controls:
`ping|healthcheck|heartbeat` over `packages/mcp/` → 8 hits, every one a test
fixture; `timeout` over the same `src/` → 12 hits, none guarding `connect()`.

Worse for imitation: the failure taxonomy is **log strings**. The states are
distinguished — never-connected vs lost-established, retrying vs given-up — but
only in prose (`connection.ts:198`, `:213`, `:217`, `:283`). Control: 60+
`class …Error extends` exist repo-wide, so the typed idiom was available and was
not applied here. A consumer cannot tell "still retrying" from "gave up".

**The shape worth taking is DSH's subagent one, not its MCP one:**

```
{ kind: 'diagnostic', reason: 'corrupt' | 'unsupported' | 'unavailable' }
```

(`packages/subagent/subagent/src/control-types.ts:63-78`), enforced closed by
`assertNever` at the model-facing boundary
(`tool-subagent-control/src/list-agents.ts:29-45`). Two details are the craft:
`unsupported` is **never produced** and is kept in the union anyway, for consumers
that route on it (`:74-75`); and a candidate that is merely mid-creation is
**omitted, not diagnosed** (`:28-29`) — absence of evidence is not a finding.

## 5. Three mechanisms to take now, each self-contained

**(a) The completeness bit.** Discovery returns
`{ candidates, complete }` (`packages/skill/skill/src/index.ts:240-246`), and an
incomplete observation is **never cached and never republishes the catalog**
(`tool-skill/src/index.ts:225`) — the consumer keeps its last-good list. `complete`
goes false when any provider throws, when a provider says so, or when the
filesystem watcher fails to start (`skill/src/index.ts:604-613`).

This is ~20 lines and it is panda's own hardest-won lesson expressed as a type:
*a zero without a control means "I did not look", not "there is nothing."* A
discovery that reports "I saw 5" is a different fact from "5 is the truth", and
today panda's discovery cannot say which it means.

**(b) Typed absence as a constructor, three worked examples.** AD-5 is panda's
rule; these are three independent spellings of it in a codebase that never heard of
panda:

- `Omitted = {kind:'none'} | {kind:'exact', count} | {kind:'unknown'}`, with the
  producer forbidden from ever returning `unknown` — only a caller genuinely
  lacking a count may (`packages/util/output-retention/src/index.ts:33-43`).
- `TokenMeasurementBaseline = none | estimated | usage`, so a heuristic can never
  be read as a measurement (`packages/llm/token-meter/src/types.ts:17-20`).
- The resolver triad `-unavailable` (nothing registered) / `-not-found` (resolved
  undefined) / `-failed` (the provider threw), same operation, three codes
  (`packages/api/gateway/src/index.ts:838-872`).

And the honest-reporting field worth stealing outright: a gate result carries
`aborted`, because such a result "must not be reported as passed, even if the child
trapped the signal and exited zero" (`scripts/run-gates.ts:74-76`).

**(c) Generator + `--check` as the universal shape for anything derived.** Twelve
generators, each with a `--check` twin under one script-name convention
(`"gen-X": "tsx scripts/gen-X.ts"` / `"verify-X": "tsx scripts/gen-X.ts --check"`,
`package.json:118-142`), ten of them wired as gate leaves. The published plugin
config catalog is generated by `scripts/gen-config-catalog.ts` and re-verified by
`verify-config-catalog`, which cross-checks declared fields against the runtime
validation schemas so **every schema-validated key must map to a declared field**.

Panda has had `configSchema` on every manifest since M7.C. The generator and its
`--check` are the missing half, and the cost is near zero because `--check` is a
few lines on top of a generator you were writing anyway.

## 6. Where panda is AHEAD — recorded so nobody re-opens it

Negative results are results. Three places the measurement went the other way:

1. **Cross-process locking on the persisted store.** DSH has a real
   `withFileLock` — `wx`-created sibling, exponential backoff, and a documented
   refusal to steal an orphaned lock because "file age cannot prove that its owner
   stopped" (`packages/util/atomic-write/src/index.ts:143-186`). Its 17 callers are
   credentials, settings and profile. **Zero are session persistence**, and the
   JSON storage unit states last-write-wins as intentional, predicated on "exactly
   one writer per process" (`storage-json/src/atomic.ts:1-12`). Panda's
   `packages/registry/src/lock.ts` guards its store, with an ownership-safe release
   that renames the lockfile away first and unlinks only if the token still matches
   (`lock.ts:251-256`). Panda's is stronger, and M9.A's race fix hardened it
   further.
2. **Versioned portable artifacts.** DSH versions its credentials document
   (`DOCUMENT_VERSION = 1`, refusing both unversioned and divergent) but versions
   **nothing** about profiles, bundles or presets. Panda ships `STORE_VERSION` and
   `BUNDLE_VERSION` plus a retired-vocabulary read path. Better prior art than DSH
   has.
3. **Ownership proof.** DSH never materialises skills — it reads them in place from
   six ranked roots. Its ownership signal is inside the artefact. Panda's external
   ledger cannot be rejected by a vendor schema, which is the whole point of
   correction-01.

One more, from Lens F and stated as DSH's own instance of panda's defect class:
`verify-cordis-api` is a declared script that **no aggregate and no test runs**
(control: `gen-third-party-notices` → 20+ hits; `verify-cordis-api` outside
`package.json` → 0). A gate nobody runs is prose with a shebang.

## 7. The highest-value item is not code

`AGENTS.md` is the file agents load. Measured in panda on 2026-09-02, and the
measurement is worse than the handoff's:

- In the working tree it is **byte-identical to `CLAUDE.md`**, 44 lines, **100%
  generated GitNexus boilerplate** — zero panda rules.
- **Neither file is tracked.** Both are listed in `.git/info/exclude`, and
  `git show HEAD:AGENTS.md` answers *"exists on disk, but not in `HEAD`"*.
  Control: `git ls-files AGENTS.md CLAUDE.md` → empty, while the same command
  over `_bmad-output/SESSION-HANDOFF.md` returns it.

So the honest statement is not "panda's AGENTS.md carries the wrong rules". It is
**a fresh clone of panda gets no `AGENTS.md` and no `CLAUDE.md` at all**, and this
machine's copies carry instructions to run `impact()` before editing any symbol and
`detect_changes()` before committing — through MCP tools that resolve by the
SESSION's working directory and therefore answer about a **different repository**
whenever the session cwd is not panda, which is the documented normal case here.

The exclusion was itself correct at the time: it keeps a generated block out of a
shared file, which is this project's own rule about personal environment patches.
What it also did was leave the slot empty. Filling it means deciding who owns the
file — the generator or the project — and that is a decision, not a chore.

DSH's answer, measured:

- **One real file, one home.** `CLAUDE.md` is a git **symlink** to `AGENTS.md`
  (mode `120000`, and `packages/CLAUDE.md` is the same blob). The rule is written
  into the file: "`CLAUDE.md` symlinks `AGENTS.md` at root and `packages/`; edit
  the real file." 21 `AGENTS.md` files exist, scoped by directory — one per
  audience, never duplicated.
- **Rules name their own gate, inline.** Of a 10-rule sample, ~6 name an executed
  gate: trailing newline → `git diff --cached --check`; JSDoc on every exported
  function → `verify-export-jsdoc`; no hardcoded UI copy → `verify-client-ui-i18n`;
  per-file 100% coverage → `vitest.config.ts:348-356`. And the policy is stated as
  a rule of its own: *"Wire mechanically checkable invariants into an executed
  top-level gate."*
- **The unenforced remainder is exactly the judgment-shaped rules** — "prefer
  maintained dependencies", "do not use metaphors", "every non-trivial change
  includes an Agent Note". DSH does not pretend those are enforced.
- **The document's own size is gated**, at 1,950 words
  (`scripts/doc-budgets.manifest.json:2`).

Panda's version of this is one file, and it is the cheapest high-value change
available. See the companion commit.

## 8. What was NOT concluded

- Whether panda should adopt DSH's **standing mount** shape for a future Profile
  (one composition per id, joined by re-parenting a scope key). It presupposes a
  scope/fiber substrate panda does not have and whose reclamation is still an open
  `TODO` in DSH itself. The cordis `include` patch-layer finding already banked in
  the previous note remains the cheaper prior art.
- Whether panda's four guard tests should become ten. Measured: exactly **4 of 10**
  packages carry `test/guard.test.ts` (`environment`, `kernel`, `projection`,
  `session`) — the handoff's "5 of 10" is off by one. `registry` and `cli` remain
  the two named gaps. DSH enforces the equivalent with hand-written verifier
  scripts that each carry their own `.spec.ts`, which is the reusable half: *a gate
  nobody tests is a gate that silently passes.*
- Anything about `packages/context`, `session-query`, `goal`, `todo`,
  `interaction`, or the web client. Six lenses covered ten package groups of
  roughly fifty; this note claims nothing outside what it cites.

## Sources

- Repository: `https://github.com/deepseek-harness/deepseek-harness` at `4e84901`
  (`dsh-0.1.2-alpha.4`), cloned to `C:\code\deepseek-harness`.
- Published reference: `https://deepseek-harness.github.io/deepseek-harness/en/reference/`
  — architecture overview, `capability-seams`, `config-catalog`, `subsystems/settings`.
- Paper: *A Programming Paradigm for Spatiotemporal Composability*, arXiv 2608.25512
  (Shi, Zhang, Cui — Peking University / DeepSeek-AI). Claims observational
  equivalence for interleaved components and carries composability "from a single
  component to a whole system"; it states no disposal-order or idempotence theorem
  in the abstract.
- Prior note: `research/cordis-spatiotemporal-composability-2026-09-01/research.md`.
- Every measurement executed on 2026-09-02, with a control wherever a zero was
  involved.
