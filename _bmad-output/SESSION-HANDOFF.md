# panda — session handoff prompt

Paste everything below the line into a new session. It is written to be
self-sufficient: it names where the project lives, where every fact comes from,
what to never touch, and what was learned the hard way.

---

## 0. The situation, first, because everything else depends on it

**Your session's working directory is NOT the project.**

- Session cwd: `C:\code\camtom-dev-3` — an unrelated repository (Camtom). Ignore it.
- **The project is `C:\code\panda`.** Every read, every write, every command.

**Never write a single byte outside `C:\code\panda`.** The one read-only
exception is loading BMAD skills from `C:\code\camtom-dev-4\.claude\skills\bmad-*`.

How to hold that discipline in practice:

- Start every shell command with `cd /c/code/panda` (bash) — the shell resets to
  the session cwd between calls, so a `cd` in one call does not persist.
- Use absolute paths under `C:\code\panda` for Write/Edit.
- Temporary files go to the session scratchpad directory named in your system
  prompt, or to `C:\code\panda\.scratch\` (gitignored). Never `/tmp` for anything
  that matters, and never a path that resolves into the Camtom repo.
- Before `git add`, run `git status --porcelain` and read it. There is an
  untracked `rtk/` at the panda root (tooling residue, excluded via
  `.git/info/exclude`) and a `.scratch/`. Stage explicit paths — never `git add -A`.
  That command has put junk in a commit here twice.

## 1. What panda is

A microkernel that manages the environment of AI coding executors (Claude Code,
codex, opencode): a canonical Registry of what you want available, projected
into each executor's NATIVE configuration, with ownership tracked so panda can
undo exactly what it wrote and nothing else.

Stack: pnpm 11 monorepo, TypeScript ~7.0.2 native + `@typescript/typescript6`
alias for eslint, Vitest 4, Standard Schema v1, Node >= 24. Repo
`https://github.com/SKANL/panda` (public). Single writer: commit and push
straight to `main`. `gh` is authenticated as SKANL.

## 2. Where every fact comes from

Never assert a fact about this repo you have not just measured. The sources,
in the order to reach for them:

- **Planning artifacts — `C:\code\panda\_bmad-output\planning-artifacts\`**
  - `epics.md` — the FR/NFR list and every story with its acceptance criteria.
  - `prds/prd-panda-2026-08-23/prd.md` — the PRD, including a **glossary** (§ near
    line 57) and the **Resolved Decisions RD-1..RD-4** (near line 397). The
    glossary settled an argument that two stories could not settle from code.
    Read it before designing anything.
  - `architecture/architecture-panda-2026-08-24/` — `ARCHITECTURE-SPINE.md` and
    `correction-01-native-projection.md`. Correction-01 is binding: panda renders
    NATIVE vocabulary at NATIVE locations and never invents a location a vendor
    does not read.
  - `ROADMAP-01-composition-first.md`, `ROADMAP-02-the-container-and-the-promise.md`
    — the measured plan; ROADMAP-02 carries Amendments 3 and 4.
- **Implementation artifacts — `_bmad-output\implementation-artifacts\`**
  - `sprint-status.yaml` — story states. 16 backlog entries remain, 3 of which are
    epic headers, so **13 real stories**.
  - `spec-*.md` — one frozen spec per story. Read the last two before writing a new one.
  - `deferred-work.md` — **append-only** ledger of deliberate simplifications and
    newly widened surfaces. Read it before claiming something is missing; it is
    often already recorded with an upgrade path.
- **The code itself**, measured with the tools in §3.
- **The vendors**, by RUNNING them: `codex`, `claude` and `opencode` are all on
  PATH. Executing the real tool beats reading about it, and beats remembering.

## 3. Tools — all three work, but two have traps

**codegraph — use the CLI, never the MCP tool.**
The MCP `codegraph_explore` resolves its index by the SESSION's working
directory, so from `camtom-dev-3` it silently answers about a DIFFERENT
repository. It returned Camtom code for a panda question and looked plausible.
Use the upstream CLI from inside the repo instead:

```bash
cd /c/code/panda && codegraph status      # confirms "Project: C:\code\panda"
cd /c/code/panda && codegraph sync        # after edits, if the watcher is behind
cd /c/code/panda && codegraph callers <symbol>
cd /c/code/panda && codegraph impact <symbol>
```

**gitnexus** — works, but check `gitnexus status` for staleness and
`gitnexus analyze .` to refresh. It has answered correctly about panda; always
cross-check its answer against the repo before using it.

**graphify** — a graph over the planning artifacts already exists at
`_bmad-output\graphify-out\graph.json` (422 nodes, 802 edges). Rebuild with the
skill if the artifacts change materially. Useful finding from it: **zero FRs and
zero ADs lack a story.** That is not reassuring — FR-11 HAD a story whose
criteria it passed and was still unreachable from the binary. Full coverage on
paper is compatible with zero reachability.

**context7** — use for vendor documentation (it resolved opencode's model
resolution order correctly). `chrome-devtools` failed to connect this session.

## 4. How to run and check things

```bash
cd /c/code/panda && pnpm check          # full gate: bytes + typecheck + lint + tests
```

**`pnpm check` ABORTS at the first failing package.** When it stops early, run
the rest individually — `pnpm --filter` does NOT work here because of the
node_modules junctions:

```bash
cd /c/code/panda/packages/<name> && ./node_modules/.bin/vitest run
```

Run the binary:

```bash
cd /c/code/panda && node --conditions=panda-source packages/cli/bin/panda.ts <args>
```

For live checks, point `HOME` / `USERPROFILE` / `CODEX_HOME` at a throwaway
sandbox. On Windows, native binaries need Windows paths — convert with
`cygpath -w`. A native tool handed an MSYS path silently misbehaves.

CI runs **Node 24 and a Node 26 canary on Linux**. Node 26.8.1 is installed
locally at `C:\Users\angua\AppData\Local\nvm\v26.8.1\node.exe` — check both
before pushing.

## 5. Architecture rules that are not negotiable

- **AD-1** — the kernel has ZERO runtime dependencies and NEVER imports
  `@panda/contracts`.
- **AD-2** — package topology strictly downward.
- **AD-5** — typed absence over silence. Unavailable is not failed.
- **AD-7** — coded errors via `PandaError` / `PANDA_ERROR_CODES`.
- **correction-01 C5** — report honestly, never fake. A story that writes into a
  surface an external tool owns carries at least one criterion phrased in that
  tool's own terms.
- Relative imports ALWAYS carry the `.ts` extension.
- All code, comments, identifiers, artifacts and commit messages in **English**.
  Conversation with the user is in Rioplatense Spanish.

## 6. The working loop (BMAD, as actually practised here)

1. **Measure first.** codegraph/gitnexus/grep plus running the binary. Never
   write a spec claim about how the code behaves without having just run it.
2. **Write a FROZEN spec** in `_bmad-output/implementation-artifacts/spec-<id>-<slug>.md`
   with: Intent, the measurement it rests on, Boundaries & Constraints, an
   I/O & Edge-Case Matrix, Code Map, Tasks & Acceptance, an **Ask First** clause,
   a Spec Change Log, and an empty Verification section.
3. **Register it** in `sprint-status.yaml` as `in-progress`.
4. **Dispatch one implementer** subagent with the spec path and the repo rules.
   Tell it explicitly: do NOT commit; file a renegotiation rather than
   implementing past a frozen clause.
5. **Review round: four context-free reviewers, each in its own git worktree**
   at `C:\code\panda-worktrees\review-1..4`. Sync them to the base commit first
   (`git -C <wt> reset --hard <base> -q && git -C <wt> clean -fdq -e node_modules`),
   then overlay the uncommitted work.
   The four lenses that have paid off: **containment/blast-radius**,
   **mutation testing** (highest value by far — it found silent data loss with a
   green suite), **be-a-user end-to-end**, and **derivation vs duplication**.
6. **One consolidated fix round** attacking roots, not the individual symptoms.
7. **Verify the blocking findings YOURSELF** by execution before committing.
8. Gate green on both Node versions -> commit -> push -> **wait for CI and check
   the run's `conclusion` against the SHA you just pushed.** Never trust a
   notification. This was got wrong once: a green was reported while CI had been
   red for seven commits.
9. `mem_save` the decision, and `mem_session_summary` before finishing.
   Engram project `camtom-side_projects`, topic_key `panda/build-progress`.

**Worktree trap:** `packages/*/node_modules` are junctions into the main
checkout with RELATIVE `@panda/*` links, so a cross-package source mutation
inside a worktree is INVISIBLE to the binary and to other packages' suites — it
reads exactly like "not a derivation". Either verify byte-identity first, or add
a `resolve.alias` to the downstream `vitest.config.ts` files. Assume any past
cross-package mutation result without that alias is a possible false negative.

## 7. What was learned, and paid for

**The defect class this whole milestone was about: a guarantee stated in PROSE
instead of enforced by something that FAILS when violated.** It was found in
nearly every review — and finally inside the mechanism built to prevent it.

- **A falsification must be REPRESENTATIVE.** Demanding "plant a fake and show
  the test fail" is not enough; the plant landed in the one shape the extractor
  accepted, and three other shapes sailed through green.
- **"Dispatchable" is not "delivers."** Three stories in a row printed a command
  that existed and did not work: wrong scope, false claim, or a `<placeholder>`
  where the concrete value was already known.
- **A test that BETS instead of forcing its precondition fails when it should
  not AND passes when it should not.** A race test that had to WIN a race could
  land in an earlier unguarded window, lose a write for real, count it as a lost
  race, and retry.
- **A ZERO without a control means "I did not look", not "there is nothing."**
  Hit three times in one session with three different tools: a `git grep`
  pathspec matching zero files, a wrong-signature API call, and a worktree
  mutation invisible through junctions. **Before believing a zero, run the same
  query against something you KNOW exists.**
- **Never assert code behaviour from the spec.** Four spec claims were wrong and
  all four surfaced by EXECUTION, never by re-reading: a T4 sequence, an argument
  that "no guard is needed" (which is what left the real guards untested), a
  claim that `USAGE` derived its type list, and a fixture whose `\f` was a form
  feed where the prose claimed a Windows backslash.
- **Escaping bugs are silent.** `\b` became a literal backspace three times in
  one file; a regex "worked" only because other alternatives masked the branch
  that could never match. Verify a generated line with `cat -v`.
- **A comment that promises a future is a comment that lies.** Three shipped.
- **Fixing roots compounds.** Retiring the first registry word cost a full story
  with nine blocking findings; the second cost two lines and touched one file.

**Process rules that earned their place:**

- An implementer that FILES a renegotiation instead of implementing past a
  frozen clause is behaving correctly — it caught a real defect every time.
- Commission any "is it really published?" check from an author who is FORBIDDEN
  to read the implementation. A sample written by the contract's author always
  validates and proves nothing. The blind author found ten documentation gaps.
- Report negative results. "I checked and it is fine" is a real result — FR-2
  looked like a gap and was not.

## 8. State at handoff

`main` is at **`2974edd`**, CI green on both jobs, working tree clean.

Five stories closed this session, each with CI verified against its exact SHA:

| commit | story |
|---|---|
| `84c62e2` | M4.D — gave the registry a door (`panda add/remove/list`), plus the invariant that every printed `panda …` command is dispatched |
| `71db335` | forced the discard race instead of betting on it |
| `bacce70` | M4.E — retired `tool`; retirement machinery so removing a word cannot brick a store |
| `943e393` | M4.F — retired `profile`; it is a selection over entries, not an entry |
| `2974edd` | M5.A — published the MethodPlugin contract; live suite stops blaming panda for provider outages |

`REGISTRY_ENTRY_TYPES` is now exactly `skill` and `mcp-server` — the two the
projection layer actually delivers.

## 9. Next steps, measured and in order

1. **The `path` rule that lies.** `METHOD-PLUGIN.md` documents artifact `path` as
   "relative to the project root" and the validator accepts `../../etc/passwd`
   and absolute paths — on the one field artifacts are later materialised from.
   Deserves its own frozen block: enforcing it or admitting it is convention is
   a CONTRACT decision, not a text fix.
2. **The type catches the wrong half.** `MethodPlugin` rejects unknown keys but
   silently accepts `onActivate` without `onDeactivate` and a non-semver
   `version` — the pair rule is what the doc warns hardest about.
3. **Story 5.4 — methodology hot swap** (`panda swap method`, FR-28). M5.A
   deliberately left it untouched.
4. **Profiles (Epic 5).** The PRD glossary defines a Profile as a named bundle of
   Registry selections including "per-executor model/effort selections **where
   targets support native selection**". The owner arrived at the use case
   independently: a user should never have to learn which model tier their
   executor falls back to, nor hand-edit a vendor config to avoid it. Verified
   and banked: **codex profile v2** IS id-keyed by filename
   (`$CODEX_HOME/<id>.config.toml`, layered via `-p, --profile`), owned whole
   rather than merged — structurally the materialise shape panda already ships.
   `model` at the root of `~/.claude/settings.json` and `opencode.json` are
   SINGLETON SCALARS, and projecting N ids into one slot is a selection, not a
   projection.
5. **The unguarded window** between `readIfPresent` and `statSnapshot` in
   `discardLegacy` — a write landing there is captured by the snapshot, so the
   guard correctly reports no change while `text` is stale. In the ledger.
6. **Four kernel exports with no consumer** outside the kernel:
   `createEventBus`, `createLogSink`, `lostRecordCount`, `validateManifest`.
   Observability that exists and nothing reads.
7. Remaining: Epic 2's 2.6 liveness re-spec, Epic 3 (memory providers), Epic 4
   (worktrees), Epic 5's export/import bundle.

## 10. The live executor tests, and the principle behind them

`packages/adapter-cli/test/confinement-live.test.ts` drives the real binaries.

- It PINS its model via `PANDA_LIVE_OPENCODE_MODEL`, defaulting to
  `opencode/muse-spark-1.2-contributor-free`. **Keep the default on the free
  tier**: a contributor cloning the repo must not need a paid plan for the suite
  to behave. Set the variable to a model you are entitled to for a real
  measurement.
- Why pinning exists: opencode resolves `--model` -> config `model` key -> last
  used -> "first model by internal priority". A live run carries no interactive
  state, so it always reaches the last rule, which lands on a FREE model that
  trains on request data. **panda was routing a developer's prompts into a
  training tier without ever naming a model**, and the account was asked to
  consent to data training just to get a green gate.
- A provider that REFUSES (rate limit, quota, data policy) or NEVER SETTLES now
  SKIPS with its reason instead of failing. Measured: the paid tier settles;
  three different free models timed out at 150s+. The aggregate line still
  reports exactly which executors were measured and which were not, so a run
  that measured nothing says so.

**The principle the owner stated, which governs decisions like this one:**
*panda must absorb the problem, not hand it back.* If the answer to a user's
problem is "edit your vendor config", panda has not solved anything — it has
added a step nobody will discover. That applies to configuration, to
entitlements, and to documentation: if an author has to guess, panda did not
publish a contract, it published a puzzle.
