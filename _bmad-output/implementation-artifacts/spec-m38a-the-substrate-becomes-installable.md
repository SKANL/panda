# Spec M38.A — the substrate becomes installable

**Status:** FROZEN
**Story:** cuts panda's first release, and gates the documentation claim that
made the previous scope move silently wrong (closes ROADMAP-03's "the decision
that is not a milestone")
**Base commit:** `0ffe90e`

---

## Intent

Panda is an SDK first. `ARCHITECTURE-SPINE.md` says so in its own frontmatter
(`purpose: build-substrate`), and the PRD says it in a sentence: *"Panda ships as
an SDK first: a headless kernel usable from any project… The terminal shell,
Workers & Workflows orchestration, and methodology plugins are future consumers
of the same contracts."*

A substrate is a claim only a third party can validate, and today no third party
can run the experiment: every `@skanl/panda-*` name returns 404. The release
machinery to fix that is already built, armed and has never fired — zero tags,
zero releases, zero runs of `release.yml`.

This story fires it, and closes the documentation defect that would otherwise be
published into thirteen tarballs.

## The measurement this rests on

Driven at `0ffe90e`, each with a control.

1. **Nothing is published.** `npm view @skanl/panda-cli` → E404; same for
   `@skanl/panda-contracts`. `git tag -l` → 0 tags. `gh release list` → empty.
   `gh run list --workflow release.yml` → `[]`.

2. **The account exists and the token authenticates.** `npm whoami` against the
   supplied token → `skanl`. An earlier reading of
   `registry.npmjs.org/-/user/org.couchdb.user:skanl` returned `{"ok":false}`
   and was a FALSE NEGATIVE — that endpoint is not a reliable existence check,
   and the token disproved it. Recorded because the wrong reading nearly became
   a blocker in the spec.

3. **The secret was missing, and that — not the decision — was the blocker.**
   `gh api repos/SKANL/panda/actions/secrets` → `{"total_count":0}` while
   `release.yml` reads `secrets.NPM_TOKEN`, and the workflow declares no
   `environment:`, so only repo/org secrets apply and the repo is personal. A
   tag pushed before this story would have run `pnpm check`, the consumer-install
   proof and the tag/version check — and then failed at the last step on auth.
   Now `total_count: 1 | NPM_TOKEN`.

4. **The publish order is topological, measured not assumed.**
   `pnpm publish -r --access public --no-git-checks --dry-run` succeeded for all
   thirteen and printed: kernel → contracts → adapter-cli → lock →
   memory-filesystem → memory-sqlite → workspace-git-worktree → workspace-local
   → registry → session → projection → environment → cli. Zero-dependency
   packages first, the binding last.

5. **`README.md` ships inside every tarball.** `tar -tzf` on the packed
   `@skanl/panda-contracts` lists `package/README.md` and `package/LICENSE`
   although its `files` names only `dist` and `METHOD-PLUGIN.md`. So this prose
   IS the page npmjs.com renders, and a wrong claim cannot be edited — only
   superseded by another release.

6. **The documentation names a scope the manifests do not use.** A census of
   every `@`-token across the fifteen shipped documents: 65 `@skanl`, **1
   `@panda`**, 2 `@ts-expect-error` (a TypeScript directive), 1
   `@modelcontextprotocol` (a real third-party scope, referenced as an example).
   The single `@panda` is `README.md:28`, left behind by M37.D, sitting two
   lines under install commands that already say `@skanl`.

7. **`README.md:65` says "Twelve packages".** There are thirteen, and the same
   file says "thirteen" three times.

8. **The root README speaks only to a CLI user.** `rg 'runSession|import '`
   over it → no hit for either (control: `rg -c '^```'` → 6, so the file has
   code blocks and the query sees them). A substrate whose front page carries no
   SDK line is asking the wrong reader to arrive.

## Boundaries & Constraints

### D1 — the scope claim is GATED, not corrected

Editing `README.md:28` alone would repair the sentence and leave the defect
class untouched: AGENTS.md's rule is that *a guarantee stated in PROSE instead
of enforced by something that FAILS when violated is a defect*, and this is that
rule violated in the file a stranger reads first.

`packages/contracts/test/docs-scope.test.ts` derives the scope from the manifests
and reddens on any `@`-token in a shipped document that is neither that scope nor
a named non-scope token. **Derived, never spelled** — the day the scope moves
again, every lagging document reddens by name.

It carries four control clauses, because a checker only ever run against the real
tree passes for a reason nobody tested: one drives the exact historical sentence
and requires a failure, one drives a correct document and requires silence, one
asserts the scan reaches more than ten real files, and one asserts the manifests
declare exactly one scope.

### D2 — the release runs through CI, never from a laptop

The local credential existed only for the dry run and was removed
(`npm config delete`, verified: `npm whoami` → ENEEDAUTH, `rg authToken ~/.npmrc`
→ 0). `release.yml` re-runs `pnpm check`, `pnpm build`, the consumer-install
proof and the tag/version agreement BEFORE publishing, and adds npm provenance
via `id-token: write`. A laptop publish would skip all four and sign nothing.

### D3 — the version is `0.1.0`, and the tag must agree

The manifests already carry `0.1.0` and `versions.test.ts` reddens if they
disagree. `release.yml` refuses a tag whose name does not match
`packages/contracts/package.json`. So the tag is `v0.1.0` and nothing is bumped
in this story.

### D4 — the root README gains an SDK block, and keeps the CLI one

Not a rewrite. One fenced `ts` block showing `runSession` from
`@skanl/panda-session`, placed before the CLI block, because the PRD's primary
consumer is an integrator and the current page never addresses one. The CLI
block stays: it is the acceptance test of the substrate, and the PRD names it in
v1 scope.

### D5 — not in this story

- The `MemoryProvider` socket. Two shipped implementations, a published clause
  suite, and zero production consumers — real, measured, and a milestone of its
  own. Publishing does not depend on it and it does not depend on publishing.
- A consumer for a `MethodPlugin`'s `phases`/`artifacts`/`commands`. No FR asks
  for one and no author has. Building it would be inventing a requirement, which
  is this project's most expensive habit.
- Any change to the publish surface itself pending the recorded decision below.

## I/O & Edge-Case Matrix

| # | Input | Expected |
|---|---|---|
| E1 | `README.md` naming `@panda` | `docs-scope.test.ts` fails naming `README.md:28` |
| E2 | `README.md` naming only `@skanl` | the clause is silent |
| E3 | a doc naming `@ts-expect-error` | allowed, with its reason recorded |
| E4 | a doc naming `@modelcontextprotocol` | allowed, with its reason recorded |
| E5 | a doc naming a NEW foreign scope | fails; adding it is a decision someone takes |
| E6 | manifests declaring two scopes | fails before any prose is examined |
| E7 | the scope moves again | the gate follows the manifests; lagging docs redden |
| E8 | a tag `v0.2.0` against `0.1.0` manifests | `release.yml` refuses before publishing |
| E9 | publish fails partway | leaves are on the registry, dependents are not; recovery is a new patch version, never a reused one |

## Code Map

- `packages/contracts/test/docs-scope.test.ts` — NEW. The gate. Lives in
  `contracts` because that package already owns publishing vocabulary
  (`versions.test.ts`, `PANDA_VERSION`, `STORE_VERSION`, `BUNDLE_VERSION`) and
  already reads sibling manifests from `test/`.
- `README.md` — the `@panda` sentence, the "Twelve packages" count, and one new
  SDK block.
- `.github/workflows/release.yml` — CHANGED, and not as planned. It was scoped
  READ ONLY on the belief that it was correct as written and only missing its
  secret. It was not: see Spec Change Log 6.
- `packages/adapter-cli/test/stream-mode-live.test.ts` — CHANGED, out of subject
  and in scope because it blocked this story's gate. See Spec Change Log 5.

## Tasks & Acceptance

1. ☑ Write `docs-scope.test.ts` FIRST and watch it fail naming `README.md:28`,
   with its four controls green. *Done: 1 failed | 4 passed.*
2. ☑ Set `NPM_TOKEN` as a repository secret. *Done: `total_count: 1`.*
3. ☑ Fix `README.md`: the scope sentence, the package count, the CI-trigger
   claim, and the SDK block — plus the six false claims the audit found in the
   `adapter-cli`, `cli`, `session` and `workspace-git-worktree` pages, and
   `AGENTS.md`'s own package census. *See Spec Change Log 2 and 3.*
4. ☑ `docs-scope.test.ts` green: 5 passed, after failing 1-of-5 on the exact
   line it was written to catch. `pnpm check` green end to end.
5. ☑ `pnpm build && pnpm proof:consumer-install` green — the CI half that
   `pnpm check` does not include. *12 passed, 1 skipped.*
6. ☑ Repair the publish path itself: `--provenance` as a flag, `--report-summary`,
   a registry-read assertion that the attestation exists, and a `concurrency`
   group. *See Spec Change Log 6.*
7. ☑ Commit, push, CI green against the exact SHA. *`0a507a7`, matched by hand
   against `gh run list --json headSha,conclusion`.*
8. ☐ **OWNER GATE — the tag.** Everything above is reversible. `v0.1.0` is not.
   Held deliberately: the audit that found the provenance defect found it in the
   last thing checked, and the found-defect rate in this story (six false doc
   claims, one unenforced live-suite guarantee, one dead publish setting) is not
   yet the rate of a surface anyone has finished auditing.
9. ☐ Verify from OUTSIDE: `npm view @skanl/panda-cli version` and a clean
   `npm i -g @skanl/panda-cli` in a throwaway directory.

## Ask First

- **Publishing itself.** Authorized explicitly by the owner in this session,
  who supplied a scoped token for it. ROADMAP-03 records this as the one
  irreversible decision in the repository; it is now taken.
- **The publish surface** — thirteen names claimed forever versus a smaller
  set. Recorded in the Spec Change Log below.
- **Anything that would bump a version.** Out of scope; `0.1.0` publishes as it
  stands.

## Spec Change Log

### 1 — the publish surface was NOT an open question, and parking it was my error

Ask First listed "thirteen names claimed forever versus a smaller set" as
undecided. It was decided **one day earlier**, in
`spec-m37a-panda-is-installable-or-it-is-not.md`, which is `Status: FROZEN` and
says so in a heading of its own: *"Two position papers argued the publish surface
and agreed on every measured fact, disagreeing only on shape. **Decided: all 13
packages, one scope `@skanl/panda-*`, lockstep at `0.1.0`.**"*

I ran the same two position papers again. They re-derived the same facts and
reached the same answer, and the second one found the frozen decision and said
plainly that it was re-litigating a closed fork. That is this repository's
most expensive habit, recorded in its own PR learnings — *"no leer lo que ya
habíamos escrito"* — committed here by the coordinator, not by an agent.

**Kept anyway, because it is not free:** the re-run verified by EXECUTION the
one fact the decision turns on, which M37.A asserted and did not drive. `pnpm
pack` on `packages/cli` rewrites `workspace:*` to a **hard exact pin**, not a
range — the packed manifest reads
`{"@skanl/panda-environment":"0.1.0","@skanl/panda-session":"0.1.0"}`. So
withholding any one of the eleven in the CLI closure does not merely delay it:
it ships a `@skanl/panda-cli@0.1.0` that can never be installed, recoverable
only by burning `0.2.0`. The fork really is 11-versus-13 and never 2-versus-13.

**Decision unchanged: all thirteen.** The reason was re-measured, not assumed,
and it has not expired.

### 2 — the README audit found six false claims, not two, and they all ship

The story was scoped to the `@panda` scope sentence and the package count. A
context-free audit of all fifteen shipped documents found four more, each
verified independently at the line before it was believed:

- `packages/adapter-cli/README.md:19` gave the flagship adapter's argv as
  `--output-format json` returning "one JSON object". Driven against
  `src/executors/claude-code.ts:86-104`: it is `stream-json` **plus `--verbose`**
  (load-bearing — `stream-json` under `--print` exits 1 without it) and
  `payload: 'jsonl'`. M15.A changed the code and not this row.
- `packages/adapter-cli/README.md:131` said "Three suites run a real coding CLI".
  There are **four** — `ls packages/adapter-cli/test/ | rg live` returns
  `confinement-live`, `live-smoke`, `stream-mode-live`, `usage-live`. A reader
  who disabled the two named switches still spent account credit.
- `packages/session/README.md:37` said `<cwd>/.panda/workspaces/<uuid>` is created
  and **nothing ever removes it**. This package exports the removal:
  `src/index.ts:57,58,78,79` re-export `inspectWorktrees`, `removeWorktree`,
  `inspectLocalWorkspaces`, `removeLocalWorkspace`, which is what
  `panda workspace remove` calls (M16.A / M27.A).
- `packages/workspace-git-worktree/README.md:34` said tree removal "are Story 4.3",
  future tense, while `src/git-worktree-provider.ts:340,390` ship
  `inspectWorktrees` and `removeWorktree` in that very package.
- `packages/cli/README.md` had **nine** `pnpm panda …` examples, no Install
  section, and a published `bin` of `panda`. Every command on the npm page for
  the binary package would have failed for the reader who installed it.

All six are fixed. The class is the same one D1 gates: a claim in prose, with
nothing that fails when the code moves underneath it.

### 3 — two more counts, outside the shipped set but the same error

`README.md:37` said "A CI job on **every push**"; `ci.yml:3-6` triggers on
`push: branches: [main]` and `pull_request`. And `AGENTS.md:36` said guard tests
cover "**4 of 12 packages**" while `ls packages/*/test/guard.test.ts` returns 5
and `ls -d packages/*/` returns 13 — it omitted `lock`, `memory-filesystem` and
`memory-sqlite` entirely. Both corrected. `AGENTS.md` does not ship, but it is
the file that tells an agent what is true here, and it was wrong about the shape
of the repository it governs.

### 6 — the release workflow asked for provenance in a way pnpm never reads

**The finding that stopped the tag.** `release.yml:69` set
`NPM_CONFIG_PROVENANCE: 'true'`. pnpm 11 does not read `NPM_CONFIG_*` at all.

Reproduced against the pinned `pnpm@11.23.0`, with a control on both sides:

```
pnpm config list                              → registry https://registry.npmjs.org/
NPM_CONFIG_REGISTRY=http://127.0.0.1:9/  …    → registry https://registry.npmjs.org/   ← IGNORED
PNPM_CONFIG_REGISTRY=http://127.0.0.1:9/ …    → registry http://127.0.0.1:9/           ← honoured
PNPM_CONFIG_PROVENANCE=true              …    → "provenance": true
```

`provenance` travels the same config path as `registry`, so what is proven false
for one is false for the other. The publish would have exited **0** with thirteen
packages on the registry carrying **no attestation**, and nothing would have
failed. A guarantee stated in configuration the tool never reads is the same
defect as one stated in prose — this repository's own rule, found inside the
mechanism built to make the release trustworthy.

Fixed three ways, each verified rather than assumed:
- `--provenance` as an explicit CLI flag, because the env var is the thing that
  just failed silently. Accepted: `pnpm publish -r --provenance --dry-run` exits
  0 across all thirteen.
- `--report-summary`, which writes `pnpm-publish-summary.json`. A partial publish
  is permanent and, without it, the only record of WHICH packages landed is the
  job log.
- A post-publish step that reads `dist.attestations.provenance` back **from the
  registry** for every package and fails by name when it is absent. Without it,
  the fix is another claim nothing checks.

And a `concurrency` group on the job, `cancel-in-progress: false`: a tag can be
deleted and re-pushed, and cancelling a run mid-publish is exactly how a partial
set lands with nothing recording where it stopped.

### 5 — the gate run found a live suite whose stated guarantee was not enforced

`pnpm check` came back **RED**, and not from this story's diff. The harness
reported the backgrounded shell's `exit code 0`; the captured `CHECK_EXIT=1` is
the truth, which is `AGENTS.md`'s `$?`-after-a-pipe lesson arriving a second time
in one session.

`packages/adapter-cli/test/stream-mode-live.test.ts` failed after 195 seconds
with `- "status": "cancelled" … + "status": "ok"` — the single-object arm
exceeded `RUN_TIMEOUT_MS` while the stream arm returned a result. Its own header
says *"A provider outage never fails this suite"*, and that was enforced by an
up-front `claude --version` probe plus a `looksUnauthenticated` check that
early-returns unless `status === 'failed'`. A `cancelled` envelope — the suite's
OWN `AbortSignal.timeout` firing — passed through both guards, so a 180-second
timeout was reported as though the two output modes disagreed.

Fixed at the guard rather than at the timeout: `unusableReason` covers the state
that broke it, and a run that never settled is now skipped with its reason, which
is what "nothing was measured" already means in this file. Three non-live clauses
drive it directly, including a CONTROL that a checker refusing every envelope
would fail. **Falsified by mutation:** deleting the `cancelled` branch turns the
run red (`1 failed | 2 passed | 1 skipped`), and the file was restored
byte-identical (`diff` → no output).

`adapter-cli` then passed whole: 14 files, 171 passed, 7 skipped, exit 0.

Out of this story's subject and fixed anyway, because it blocked its gate and is
the same defect class D1 exists to close. It does not touch CI: `ci.yml` installs
no `claude`, so the probe reports it undetected and the suite skips there — which
is also why this shipped unnoticed.

### 4 — the root README's SDK block is illustrative, and says so

D4 asked for one `ts` block. Measured first: `consumer-install.proof.ts:462`
extracts fenced blocks from `packages/contracts/README.md` **only**, so a block
in the root README is executed by nothing. Rather than build proof machinery for
one example, the block carries a sentence naming that limit and points at the
page whose examples CI does run. A block that claims to be verified and is not
would be the exact defect this story exists to close.

## Verification

Everything below was driven. Nothing here rests on a reading.

### The gate

- `pnpm check` → **CHECK_EXIT=0**, captured before any pipe. The first two runs
  did not: run 1 returned `CHECK_EXIT=1` on `stream-mode-live` (Change Log 5),
  run 2 returned `CHECK_EXIT=1` on `workspace-git-worktree`'s `acquire-roundtrip`
  with an empty `git worktree add … failed:` detail. That second one **passes
  alone** — 3 files, 22 tests, exit 0 — and had passed 22/22 in run 1 with no
  change to that package, so it is contention under the parallel gate on Windows,
  not a defect. Recorded rather than fixed; it does not reproduce in CI.
- `pnpm build && pnpm proof:consumer-install` → 12 passed, 1 skipped.
- `packages/adapter-cli` whole, live suites included → 14 files, 171 passed,
  7 skipped, exit 0.
- **CI green against the exact SHA `0a507a7`**, read from
  `gh run list --json headSha,conclusion` and matched by hand. Not from a
  notification: `gh run list --commit <sha>` returns false zeros in this repo.

### The gate this story added

- Written FIRST and RED: `1 failed | 4 passed`, failing with
  `README.md:28: names '@panda', but the manifests publish under @skanl`.
- GREEN after the fix: `5 passed`.
- Its four controls hold: the historical sentence must fail, a correct document
  must be silent, the scan must reach more than ten real files, and the manifests
  must declare exactly one scope.

### The publish path, exercised without publishing

- `pnpm publish -r --access public --no-git-checks --dry-run` → all thirteen, in
  dependency order: kernel → contracts → adapter-cli → lock → memory-filesystem
  → memory-sqlite → workspace-git-worktree → workspace-local → registry →
  session → projection → environment → cli.
- The same command with `--provenance` → exits 0, so the flag is accepted.
- `PNPM_CONFIG_PROVENANCE=true pnpm config list` → `"provenance": true`; the
  `NPM_CONFIG_*` form is ignored (Change Log 6), with `registry` as the control
  on both sides.
- All thirteen manifests carry `repository` `git+https://github.com/SKANL/panda.git`
  with a `directory`, `license: MIT`, a `description`, `engines.node >=24` and
  `publishConfig.access: public` — every provenance prerequisite.
- `packages/cli/dist/bin/panda.js` begins `#!/usr/bin/env node`.
- The token authenticates as `skanl`, which is the account npm grants the
  `@skanl` scope to by construction. It was removed from disk afterwards:
  `npm whoami` → ENEEDAUTH, `rg authToken ~/.npmrc` → 0.

### The consumer path, from outside the repository

Built, packed with `pnpm pack` (**not** `npm pack`, which leaves `workspace:*`
in the manifest and makes `npm install` fail `EUNSUPPORTEDPROTOCOL`), and
installed into a project outside the repo with every tarball as a `file:`
dependency — the shape `consumer-install.proof.ts` uses:

- `npm install` → *added 14 packages*, offline, no registry.
- `./node_modules/.bin/panda --version` → `0.1.0`.
- `@skanl/panda-contracts` alone: one package, `dependencies: {}`. A deliberately
  half-right `WorkspaceProvider` run through `runWorkspaceContractSuite` returned
  **9 clauses, 3 violations**, each naming the code it expected — so the
  third-party promise is executable, not stated.
- `runSession({ prompt, createAdapter })` with a third-party adapter the
  catalogue does not know: `status: ok`, the caller's own output, and
  `action.invoked` / `action.completed` on the kernel's record stream.

### What is NOT verified here

- **The publish itself.** No tag was pushed. Task 8 is the owner's gate.
- **That the token may WRITE.** `npm whoami` proves read auth; only a publish
  proves publish rights. Its failure mode is a 402/403 on package one, which is
  non-destructive.
- **That the provenance assertion step passes.** It cannot run until something
  is published. Its own failure mode is a red release AFTER the packages land —
  loud, and better than the silence it replaces.
