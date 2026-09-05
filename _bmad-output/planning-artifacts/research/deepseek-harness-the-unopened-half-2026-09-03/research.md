---
title: 'technical research: DeepSeek Harness, the thirty-nine package groups nobody opened'
type: 'technical'
topic: 'What the second pass over DSH finds, once the first six lenses have taken the obvious'
decision: 'What ships from the unopened half into panda, what is refused, and where panda is measurably ahead'
source: 'the deepseek-harness repository at 4e84901, measured with codegraph, gitnexus and ripgrep'
status: complete
preset: 'standard'
validation: 'measured'
created: '2026-09-03'
updated: '2026-09-03'
claims_verified: 41
claims_unverified: 0
extends: 'deepseek-harness-the-product-layer-2026-09-02 (which covered ~10 of 49 package groups and said so in its own § 8)'
---

# DeepSeek Harness, the unopened half

## Executive summary

The 2026-09-02 note ran six lenses over ten package groups and closed by naming
what it had NOT opened. This note opens the rest: **five lenses over
`workspace`/`sandbox`/`subprocess`/`shell`/`fs`/`e2b`/`code-runtime`,
`boot`/`bundle`/`preset`/`extensions`/`sdk`/`host`,
`context`/`compaction`/`session-query`/`spill`/`todo`/`goal`/`plan`,
`guard`/`identity`/`credentials`/`api`/`acp`/`webhook`/`runtime-diagnostics`,
and the whole engineering machinery** (`scripts/`, CI, every `AGENTS.md`, the
coverage and doc gates).

Every lens was forbidden from asserting anything about panda and required a
control for every zero, so each "panda has / lacks" verdict below is this note's
own, measured in panda directly.

**The first thing shipped from it is already in `main`**, and it was not a DSH
mechanism — it was found while looking for a home for one. §6.

Otherwise the piles are:

1. **Six mechanisms worth taking, each self-contained.** §2.
2. **Three refusals with the reason measured, not asserted.** §3.
3. **Panda is AHEAD in four more places**, recorded so nobody re-opens them. §4.
4. **What the open stories get.** §5.

## 1. What was measured

DSH at `4e84901` (`dsh-0.1.2-alpha.4`), the same commit the previous note used;
codegraph confirms the index is current and unchanged — 4,771 files, 52,691
nodes, 314,277 edges. `packages/` holds 49 groups plus `apps/cli` and
`apps/web`; the previous note cited ten.

**Method note that cost a lens a re-run:** `rtk proxy grep` returned a **false
zero** on `scripts/type-equiv.manifest.json` — 0 for a pattern with 403 real
matches. Every zero in this note was re-run with ripgrep, and every zero carries
its control. Positive hits from `rtk proxy grep` are safe (it fails only as a
false negative); zeros from it are worthless.

## 2. Six mechanisms to take

**(a) One shared meaning, called from every enforcement point.**
`writableRoots(policy)` is three lines
(`packages/sandbox/sandbox/src/roots.ts:52-55`) and is the single definition of
"workspace-write", consumed by BOTH the macOS Seatbelt profile generator and the
in-process filesystem fence — so the two cannot drift about which paths are
writable. Panda already reaches for this shape (`noExecutorsDetected` is shared
by `init` and `doctor` with the reason written above it), and the generalisation
is worth stating: **when two enforcement points answer one question, the answer
is a function, not a convention.**

**(b) The dump and the mount come out of the same function.** `applyEntryPatches`
(`vendor/include/src/index.ts:58-128`) is called by the mounting plugin AND by
offline `dsh --dump-config`, so what the dump reports provably cannot diverge
from what actually mounts. Panda's `panda doctor` and `panda init` already share
`noExecutorsDetected` for exactly this reason; the DSH instance says the rule
generalises past a boolean to the whole composition.

**(c) Two failure classes for two different absences.** A patch whose TARGET is
missing warns and skips; a patch FILE that was named and is missing, unreadable,
or not an array **throws** (`vendor/include/src/index.ts:83-119` versus
`packages/boot/app-boot/src/index.ts:280-307`). "You referred to something that
is not there" and "the thing you named to me is broken" are different facts, and
DSH refuses to collapse them. Panda's `readRoot` already makes this exact split
(ENOENT is absence, everything else throws coded); the bundle case shows it is
a general rule, not a filesystem one.

**(d) A per-backend evidence type, deliberately not a union.**
`ConfinedArgv.enforcement: 'full' | 'partial'` travels with `denialSignatures`
that are per-backend, and the comment says why a cross-backend union was
rejected: it "claims denials a given backend never produces"
(`packages/sandbox/sandbox/src/index.ts:95-116`). That is AD-5's rule pointed at
a place panda has not pointed it: **a union wide enough for every implementation
lets each one claim states it cannot reach.**

**(e) Redaction by DISCARDING the parser's message.** A YAML parse error over the
credentials document is re-rendered as code plus line/column ONLY, because "the
parser quotes the offending source line and in this document that line is a
secret" (`credentials-local/src/index.ts:154-162`), with a test asserting the
secret appears in neither the message nor the stack
(`tests/local.spec.ts:286-301`). Panda's M7.E prints `line:column` for a
malformed vendor config and is already the right shape; what it does not have is
that test. The panda-side question this raises is narrow and real: **does any
panda error path quote source text from a document that can hold a credential?**
Not measured here, and it is the cheapest follow-up in this note.

**(f) A type with no slot for the value.** `CredentialInfo` and
`CredentialRecordInfo` (`credentials/src/types.ts:67-74`) make wire leakage
*unrepresentable* rather than filtered. Panda's FR-21 omission is detector-based
and therefore fallible by construction; a view type with no secret field is the
half that cannot fail. Where panda hands an entry to something that leaves the
machine, this is the shape.

## 3. Three refusals, with the reason measured

**Do not adopt DSH's process-tree teardown ladder.** It is genuinely excellent —
`{pid, started}` identity fencing PID reuse with a re-read immediately before
every signal (`process-inspector.ts:9-12, 360-362`), a SIGKILL grace timer
deliberately never cleared and kept ref'd, a `/proc` zombie scan, a four-tier
terminal ladder. Panda spawns executor CLIs through
`packages/adapter-cli/src/node-child-spawner.ts` and does not own a process
tree, a terminal, or a sandbox. Taking any of this would be building the
machinery first and looking for the hazard afterwards.

**Do not adopt the `dsh plugin` / bundle-patch composition model.** Its layering
by provenance is the right idea and panda already HAS it, spelled as
`LayeredConfig` with `dump()` reporting which layer supplied every leaf — which
is strictly more than DSH's YAML patch list gives, because panda can answer "who
decided this" per key and DSH answers it per row. What DSH has that panda does
not is a plugin INSTALL verb, and that is a distribution question gated behind
`private: true`, not a composition one.

**Do not adopt `runtime-diagnostics`.** Measured: it has no finding union, no
severity, and no remediation — a violation is an `InvariantError` carrying a
package name and a free-text string (`src/index.ts:50-66`). Control: the same
grep for `remediation|Finding|Diagnosis|severity` over that package returns 0
while `InvariantError` returns 6. Panda's `DiagnosisFindingKind` with
`FINDING_EXITS` as a `Record` over the closed union — so a kind without an exit
does not compile — is the stronger design and this is the outside evidence.

## 4. Where panda is AHEAD, so nobody re-opens it

1. **Mutation testing.** DSH has none: `stryker|mutation test|@stryker` over
   `package.json` and `pnpm-workspace.yaml` → 0, control `vitest` → 16. Panda's
   M5.B mutation harness found silent data loss under a green suite. DSH's
   nearest equivalent is `fast-check` property testing in six suites, which
   answers a different question.
2. **A closed diagnosis vocabulary with an exit per kind.** §3 above.
3. **A credential-shape detector at all.** DSH has none anywhere: `sk-\[`,
   `entropy|secretScan|gitleaks|trufflehog|credentialPattern|SECRET_PATTERNS`
   repo-wide → 2 hits, both `getRandomValues` comments. Its redaction is purely
   structural. Panda's FR-21 detector plus the omission RECORD — which turns a
   false positive from silent data loss into a named task — has no counterpart
   there.
4. **Layer provenance per key.** §3 above.

One negative result on DSH's own side, and it is panda's defect class in
someone else's repo: **six declared gate aggregates and a dozen scripts that
nothing invokes** — `check:ci:snapshot`, `check:ci:artifacts`, `check:all`,
`hygiene`, `lint:fix`, `publish:npm-baseline`, measured over `.github/`,
`scripts/`, `apps/`, `packages/`, `website/`, `native/`, `.gitlab-ci.yml` and
`lefthook.yml` → 0, control `run doc-sync|check:ci:consumers` → two real hits.
They are *tested* (`run-gates.spec.ts:138-160` constructs all 16 modes) but no
CI job runs them. A gate nobody runs is prose with a shebang, and the second
note in a row finds one.

## 5. What the open stories get

**3-1 / 3-2 (storage port)** — the previous note's blueprint stands; this pass
adds one clause worth stealing from the conformance idiom:
`runKvBackendContract`'s harness takes a `reopen()` that opens a NEW backend over
the SAME medium, "as after a process restart"
(`packages/storage/storage/tests/contract.ts:12-18`), and two of its clauses
exist only to exercise it. Panda's own two workspace providers now share
`WORKSPACE_CLAUSES`; a storage port arriving without a restart clause arrives
untested for the failure that matters.

**4-3 (crash-safe disposal)** — unchanged: `interruptedTurnClosers` remains the
thing to copy. This pass adds the shape around it, which is that DSH's compaction
never DELETES: it appends a surface `replace` citing every shadowed seq
(`region.ts:473-474`) so the pre-compaction state stays readable and is
classified `shadowed` rather than gone (`session-query/src/documents.ts:69-71`).
Panda's registry retirement path already thinks this way about vocabulary; the
same discipline applied to session state is what makes a repair auditable.

**A general rule for panda's own invariants, from `compaction/src/invariant.ts`:**
package-owned invariants register against a dispatch hook and validate BEFORE
commit, and an event of that package's type that reached publication unvalidated
FAILS. And the pairing that makes it survivable: **the invariant is deliberately
WEAKER than the tool policy** (`tool-todo/src/invariant.ts:18-22`), so tightening
a rule today cannot reject a log written yesterday. Panda's retired-vocabulary
read path is the same insight; DSH states it as a design rule.

**The doc-gate machinery, for whoever next edits `AGENTS.md`:** DSH enforces a
word budget on its instruction files (`scripts/verify-doc-budgets.ts` against
`scripts/doc-budgets.manifest.json`, wired at `run-gates.ts:751`), and at HEAD
its root `AGENTS.md` measures **exactly 1950 of 1950** — a hard ratchet with no
slack, re-measured here by re-implementing its counting algorithm rather than by
trusting the manifest. Twenty-one `AGENTS.md` files exist, scoped per directory,
deduplicated by git SYMLINK (`git ls-files -s | grep ^120000` → 12 symlinks,
four of them `CLAUDE.md` pointing at a blob whose content is the literal string
`AGENTS.md`). Panda has one `AGENTS.md` and a `CLAUDE.md` that points at it in
prose rather than by symlink; the budget is the part worth copying, and only
when the file starts growing.

## 6. What shipped from this pass, and it was not a DSH mechanism

Looking for the first customer of DSH's generator + `--check` pattern in panda
surfaced a defect in panda's own kernel, and fixing it is `2982123` on `main`
(M10.B), CI green on `gates (24)` and `gates (26)` verified against that SHA.

M7.C shipped "the kernel APPLIES the `configSchema` every manifest must declare".
Measured by wrapping each manifest's schema and driving a real kernel, that was a
**no-op for `@skanl/panda-workspace-git-worktree`**: it registered under
`workspace-git-worktree` and read the config key `workspace`, so the kernel
handed its schema `undefined` on every activation, while its sibling
`@skanl/panda-workspace-local` — id and key both `workspace` — received the real
subtree in the same driver. Invisible to 1,353 green tests, because both
factories re-validated the subtree themselves and so no behaviour differed. The
rule it broke existed only as a comment at `packages/adapter-cli/src/plugin.ts`.

The gate is `packages/session/test/plugin-config-key.test.ts`, and it is
behavioural rather than a string comparison — it seeds a marked value at each
plugin's config key, drives a real kernel, and reads what the kernel actually
validated, because a gate comparing two constants would pass for a plugin whose
factory read a third key. Falsified: reverting the id turns that one row red and
leaves the other three green.

**The transferable part is the instrument, not the bug.** Wrapping the very
object the system under test consumes, then reading what it was HANDED, answers
"what did this actually validate" where reading either side answers only "what
would it accept". It is the same family as this project's three-stories-running
lesson — read the call site, not the callee — and it is the first time here that
lesson has been turned into something that runs.

## 7. What was NOT concluded

- Whether any panda error path quotes source text out of a document that can hold
  a credential (§2e). The cheapest follow-up in this note and deliberately not
  guessed at.
- Anything about `apps/web`, `packages/client`, `lsp`, `attachment`,
  `compaction`'s LLM summariser prompts, `schedule`, `workflow`, `jobs`,
  `terminal`, or `feedback`. Five lenses covered roughly thirty of forty-nine
  groups; this note claims nothing outside what it cites.
- The Landlock addon's syscall-level behaviour: `@deepseek-ai/node-addon-landlock-run`
  is an external package, and a lens that cannot open it says so rather than
  inferring from the call site.
- Whether DSH's `session-telemetry` redaction extension point is mounted by any
  shipped composition. It ships zero rules of its own and its own test asserts a
  secret-shaped fixture passes through unchanged when nothing is mounted; no
  in-tree listener was found, and "no listener found" is not "no listener".

## Sources

- Repository: `https://github.com/deepseek-harness/deepseek-harness` at
  `4e84901`, cloned to `C:\code\deepseek-harness`, indexed by codegraph,
  gitnexus and graphify — all three current at that commit and re-confirmed on
  2026-09-03.
- Prior notes:
  `research/deepseek-harness-the-product-layer-2026-09-02/research.md` (which
  this extends) and
  `research/cordis-spatiotemporal-composability-2026-09-01/research.md`.
- Cordis at `C:\code\cordis` was re-measured and is a ZERO-DELTA: all nine
  packages were covered by the eight lenses in the cordis note, codegraph
  reports 73 files / 991 nodes unchanged, and nothing here comes from it.
- Every panda-side verdict executed on 2026-09-03, with a control wherever a
  zero was involved.
