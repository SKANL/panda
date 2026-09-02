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
  - `sprint-status.yaml` — story states. 13 backlog entries remain, 2 of which are
    epic headers, so **11 real stories**. Counted 2026-09-01; recount rather than
    trust this line, and read the trailing comments — `5-3` sat in `backlog` for
    two stories after M5.A shipped it, which is how a board lies while looking
    complete.
  - `spec-*.md` — one frozen spec per story. Read the last two before writing a new one.
  - `deferred-work.md` — **append-only** ledger of deliberate simplifications and
    newly widened surfaces. Read it before claiming something is missing; it is
    often already recorded with an upgrade path.
- **The code itself**, measured with the tools in §3.
- **The vendors**, by RUNNING them: `codex`, `claude` and `opencode` are all on
  PATH. Executing the real tool beats reading about it, and beats remembering.
- **`research/`** — one folder per investigation, with frontmatter and a
  measured executive summary. `cordis-spatiotemporal-composability-2026-09-01/`
  is the newest: panda's kernel turns out to be a hand-rolled implementation of
  a published paradigm (revertible effects + reactive coeffects), and it records
  what panda takes from it, what it refuses and why, and the answer to Story
  5.4's blocking question. The cordis checkout it measures is at `C:\code\cordis`
  — outside panda, indexed by all three graph tools, and safe to delete.

  **The cordis mining is now GENUINELY exhausted — all nine packages.** Eight
  lenses ran: `core` (fiber/events/registry/service), tests, ergonomics,
  `group`+loader config tree, the logger, a sweep of
  `timer`/`utils`/`create`/`reflect.ts`, and finally `hmr`. They produced FIVE
  shipped stories (M7.A–M7.E). Measured package by package
  (`for d in packages/*/; do wc -l $d/src/*.ts; done`): core 1866, loader 870,
  hmr 443, create 314, include 219, timer 146, logger-console 137, utils 42,
  group 3. Every one is covered. There is nothing left to open.

  Why the last three lenses returned little: `timer` and `utils` are thin
  veneers over `ctx.effect`, cordis's incremental scope-disposer, and panda
  deliberately gives a plugin ONE disposer; `reflect.ts` and `create` are
  load-bearing for choices panda made the other way on purpose (ambient context,
  and an init that converges instead of scaffolding); and `hmr`'s ROLLBACK does
  not port at all, for a reason worth keeping — **cordis's recovery model is
  backward (roll back) because a broken in-memory registry has no next run to
  heal it; panda's is FORWARD (`doctor` → `foreign-collision` → `adopt`) because
  it always has a next run.** `engine.ts:25-30` and `engine.test.ts:103` are
  written to guarantee a failed target never touches its siblings, which is the
  opposite of an all-or-nothing change set, on purpose.

  **But the hmr lens still paid for itself, via a conclusion it got WRONG.** It
  reported that a malformed vendor config gives the user a misleading message.
  Driving it showed there is no message: `parseTree` recovered, panda spliced
  into the guess, and `panda init` exited **0** having destroyed the user's own
  server definition. That is M7.E. Follow a lens's THREAD even when its verdict
  does not survive.

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

**`rtk` silently COLLAPSES function bodies in `head` and `grep` output.** Same
family as the codegraph trap above, and worse, because it fails as a plausible
ZERO: a `grep -n "describe("` over a 375-line test file returned NOTHING, and
the file was full of them. `cat` and `sed -n` pass through raw; `head` and
`grep` go through the hook. Two ways out, both verified:

```bash
rtk proxy head -20 <file>     # bypasses the filter (quoting through it is fragile)
```

or use the harness's own Grep tool, which is ripgrep and is not hooked. Before
believing any zero from a shell `grep` here, run the same query against
something you KNOW is in the file.

## 4. How to run and check things

```bash
cd /c/code/panda && pnpm check          # bytes + typecheck + lint + tests
cd /c/code/panda && pnpm build && pnpm proof:consumer-install   # the OTHER half
```

**`pnpm check` is NOT the CI gate.** CI runs the FR-29 consumer-install proof as
its own step, and `pnpm check` does not include it — it needs a build, which the
development loop deliberately does without. M5.D pushed a green `pnpm check` and
CI went **red on both jobs**: a literal `import('./x.mjs')` inside a JSDoc
comment became a phantom import, because `relativeSpecifiers` in
`packages/session/test/consumer-install.proof.ts` regexes raw source and does not
strip comments, and the packed `.d.ts` keeps JSDoc. Same shape as the doc comment
that tripped M5.A's printed-command scan. **Run the proof before pushing anything
that adds an import specifier or a comment that looks like one.**

**`pnpm check` ABORTS at the first failing package.** When it stops early, run
the rest individually — `pnpm --filter` does NOT work here because of the
node_modules junctions:

```bash
cd /c/code/panda/packages/<name> && ./node_modules/.bin/vitest run
# Excluding the live suites needs `**/*live.test.ts` — NO dot. Panda has two
# naming styles (`skills-discovery.live.test.ts` and `confinement-live.test.ts`)
# and `**/*.live.test.ts` silently misses the second, so several sessions of
# "live excluded" runs were quietly running it and reading its flake as a break.
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
  M5.B hit three more in one session, each through a different writer: a shell
  heredoc collapsed `\\` to `\` in a ledger entry, and the file editor turned a
  unicode escape into a **literal NUL byte** — inside the sentence claiming the
  NUL was written as an escape. `check-source-bytes.mjs` caught that one, exit 1
  with the line number, which is exactly what a guard that fails is for. Neither
  was visible by re-reading the text.
- **A scanner that reads RAW SOURCE reads your comments too.** Twice now: M5.A's
  doc comment spelled a verb the printed-command scan then demanded the binary
  dispatch, and M5.D wrote a literal dot-relative specifier inside JSDoc, which
  the packed `.d.ts` carried and the FR-29 reachability proof followed to a file
  no tarball contains — CI red on both jobs after a green `pnpm check`. DESCRIBE
  the example instead of writing it out, and remember that the local gate is not
  the CI gate (§4).
- **A subagent reports a MECHANISM correctly and a CONCLUSION wrongly.** Four
  cordis lenses returned twenty findings; every one was re-read at the line before
  it was believed, and four did not survive. Two were redesigns of DELIBERATE
  decisions with the reason written directly above the line the agent cited
  (unready plugins activate at most once; the "quiescent" comment is scoped to
  the record stream). One overstated a lying comment that was accurate. One
  claimed panda lacked something it has. The mechanism descriptions were right
  every time — it is the "panda has it / does not have it" verdict that needs
  your own eyes. Ask agents for evidence and controls, then check the line.
- **Checking a VALIDATOR tells you nothing if its caller pre-filters the input.**
  M7.C froze a measurement saying each plugin's strictness lives in its own
  schema, so having the kernel apply it preserved behaviour. For two plugins that
  held. For `workspace-local` it did not: the schema returned an issue for a
  non-record subtree and the FACTORY never handed it one — it warned and passed
  an empty object instead — so the strict branch was unreachable dead code, and
  applying the schema to the raw value turned a warning into a refusal to start.
  Read what the caller
  FEEDS the validator, not only what the validator returns. Caught by driving the
  binary and confirmed against a stashed baseline.
- **A package manifest is not an architecture.** M5.C's frozen spec measured that
  `@panda/environment` declares `@panda/projection` and concluded AD-2 permitted
  the import. `packages/environment/test/guard.test.ts` refused it: that package
  may import only `access`, `constants`, `mkdir` and `stat` from the filesystem,
  and its source may not contain the string `atomicWriteText` — a clause that
  exists because a reviewer had already reached it exactly that way. **Before
  putting code in a package, read that package's guard test, not only its
  `package.json`.** Every package here has one and they encode decisions no
  manifest can.
- **A harness that supplies what the real caller does not is testing a caller
  that does not exist.** `panda project swap` exited 2 for every real user while
  its whole suite was green, because every test passed `runPanda` a `cwd` and the
  binary passes none. Found by DRIVING THE BINARY, which is the only lens that
  could have. Run the thing as a user before believing a green suite.
- **A test that passes without exercising anything.** M5.C's mode-preservation
  row used `chmod(path, 0o600)`, which is a NO-OP on Windows (measured: the mode
  stays 0o666), so it asserted `0o666 === 0o666`. Rewritten with 0o444, which
  maps to the read-only attribute and takes on both platforms — and it
  immediately failed, surfacing a real behaviour nobody had measured.
- **A measurement instrument needs its own control.** M5.B's mutation harness
  reported "1 killed" for all eight mutations, and that was a lie: the reporter
  never wrote its output file, then `execFile` with `shell: true` swallowed
  stdout. It only surfaced because the harness printed **why** it could not read
  a report instead of counting an unreadable result as a kill. A falsification
  run is itself code, and an uninstrumented one produces exactly the confident
  green it was built to prevent.
- **Measure the "better" solution before rejecting the plain one.** The obvious
  upgrade for M5.B's semver rule was a template-literal type. Measured against a
  corpus with a control, it accepts `01.0.0` and `-1.0.0` and REJECTS
  `1.0.0-rc.1` — it would break the build of an author doing everything right.
  The lazy answer (leave it at runtime, and document where the line falls) was
  the correct one, and only the measurement could say so.
- **A comment that promises a future is a comment that lies.** Three shipped.
- **Fixing roots compounds.** Retiring the first registry word cost a full story
  with nine blocking findings; the second cost two lines and touched one file.

- **"Nothing reads this" is a claim about a glob, not about the code.** §9 item 3
  listed four unread kernel exports. Three had readers; the grep had covered
  `src` and not `test`. One of those test readers is the mechanism enforcing an
  architecture rule. Re-run every "no consumer" claim over `test/` before acting
  on it.
- **A capability can be fully consumed while its factory is unread.**
  `createEventBus` has zero callers outside the kernel and its bus has a
  production subscriber, because the kernel constructs it once internally and
  hands it out as `kernel.bus`. Grepping the constructor answers a different
  question than "does anyone use this".
- **A counter keyed by object identity is only readable by whoever holds that
  object.** `lostRecordCount` looked like the obvious thing for the CLI to print.
  Its WeakMap is keyed by the sink `recordSafely` was handed — the session's
  wrapper — so a CLI reading it prints `0` on exactly the runs it was invented to
  expose. Found by reading the WeakMap, not by running anything; a test would
  have agreed with the bug.
- **Do not build a branch that cannot fire.** An unconditional log sink was the
  proposed design, so the loss counters would "always" print. But those counters
  count failures of the write the *caller* supplies, so with no write they are
  structurally zero. The conditional was then confirmed by mutation: making the
  sink unconditional is killed by three clauses that predate the story.
- **Check where `check` stops.** `pnpm check` is
  `bytes && typecheck && test && lint` — lint runs LAST. A run that dies on a
  test never lints, and treating that run as "the gate up to the failure" silently
  skips it.

- **A recovering parser is a silent writer.** `jsonc-parser`'s `parseTree`
  returns a tree for a broken document, and panda spliced by OFFSET into that
  guess. `panda init` exited **0** having nested its own block inside a user's
  server definition. Nothing in 1226 tests saw it, because every fixture was
  valid. **When a library "handles" bad input, find out what it returns for bad
  input before trusting the absence of a throw.**
- **A safe-looking guard can reject valid input, and only a corpus says so.**
  The obvious fix — refuse when `parseTree` reports any error — rejects TRAILING
  COMMAS, which are legitimate JSONC, and reports them with the SAME error code
  a genuinely doubled comma gets. `{ allowTrailingComma: true }` separates them
  cleanly. Proven by mutation: dropping the option is killed by **fifteen**
  clauses, most written long before the story. Same shape as M5.B's semver
  template type — measure the "better" answer against a corpus with a control
  before shipping it.
- **A conclusion can be wrong and its THREAD still be worth following.** The
  eighth cordis lens reported a misleading error message. There was no message —
  the real defect was silent corruption, strictly worse. Had the verdict been
  taken at face value, or discarded when it failed verification, the defect
  stays. **Verify the claim, then follow where it was pointing.**
- **"Next step" in a handoff is a claim like any other.** §9 item 1 said
  Profiles was next. `profile` appears three times in `epics.md` and none is a
  story; no FR specifies it. It was my own framing from a glossary line, carried
  forward across sessions as though it were a requirement. **Re-derive the next
  step from the planning artifacts, not from the last handoff's item 1.**
- **`git stash` of ONE file is the cheapest proof a fix is not theatre.**
  `git stash push -- <file>`, re-run the binary, read the corrupted output,
  `stash pop`. Two commands, and it turned "the tests are green" into "exit 0
  and a destroyed config, versus exit 1 and an untouched one".

- **Reading what a function DOES is not reading what its caller GETS. Twice now,
  one story apart.** M7.C: a schema's strict branch was unreachable because the
  factory pre-filtered its input. M8.A: `RegistryStore` normalizes machine paths
  at write time and the document on disk really is portable — but `list()` maps
  `expandRegistryEntryPaths` over everything it returns, so the first bundle
  carried `C:\Users\…` while the frozen spec asserted NFR-6 was already
  satisfied. Both were caught by DRIVING THE BINARY and reading the output file,
  neither by re-reading either function. **Read the call site, not the callee.**
- **GitHub push protection scans your test fixtures.** M8.A's first push was
  REJECTED: the Slack and GitLab rows of the secret-detector corpus are real
  credential shapes, which is the whole point of them. The unblock URL marks a
  fake as an ALLOWED REAL SECRET and is the wrong answer. Assemble each fixture
  from a prefix and a body (`'glpat' + '-…'`) so no scannable literal exists on
  disk; the value the code under test sees is identical. Applies to any corpus of
  credential shapes anyone adds here later.
- **A mutation can find a hole in the EVIDENCE rather than in the code.**
  Disabling the generic token rule killed *detects a Google API key*, which
  should have been caught by its own provider pattern. The fixture was 41
  characters and Google issues `AIza` plus exactly 35, so that pattern had no
  test exercising it and the generic rule was quietly covering the row. Nothing
  was wrong with the code. **When a mutation kills a clause you did not expect it
  to reach, the corpus is what to look at.**
- **A detector that omits data needs a visible record, and that record is what
  lets it be strict.** FR-21 says omit a secret-bearing entry; FR-22 needs those
  entries listed on import. Recording `{type, id, field}` — never the value —
  serves both AND turns a false positive from silent data loss into a named task,
  which is what makes it safe to tune the detector toward catching credentials
  rather than toward never annoying anyone.

- **Read the call site, not the callee — THREE stories running now, and it has
  never once been found by reading.** M7.C: a schema's strict branch was
  unreachable because its caller pre-filtered the input. M8.A: `list()` expanded
  the paths the writer had normalized. M8.B: `register` normalized a value the
  caller had ALREADY normalized, and the escape rule doubled the `~` marker —
  every path field of every imported entry silently wrong, nothing failing. All
  three surfaced by running the binary and reading the output file. **When you
  hand a value to a function that transforms values, ask what shape the value is
  ALREADY in.**
- **Two of my own measurements were false this session, both from shell
  quoting.** A `diff` reported two bundles "BYTE-IDENTICAL" while comparing two
  EMPTY outputs (both `require()` calls had failed on an MSYS path); a loop over
  five malformed fixtures printed five identical ENOENT lines because `$f` never
  interpolated. Both looked like passes. The corollary the older lesson needed:
  **when shell quoting has eaten a measurement twice, stop quoting and write the
  driver as a script.** That is why `.scratch/drive-*.mjs` exists.
- **A test can pin a DEFECT as an expectation.** Two contracts clauses asserted
  the normalized value contained `join('config', 'server.json')` — the platform's
  own separator — which is exactly the thing that made a Windows-written Registry
  unusable on POSIX. Updating them was the fix, not a concession. **A red pin is
  a question ("was this deliberate?"), not automatically a verdict against the
  change.**
- **`$?` after a pipe is the LAST command's exit code, not the binary's.** An
  `import` was reported as exiting 0 when it exits 2; the 0 belonged to `head`.
  Capture the code before piping, or run the binary from a script.

- **A capability written in code that no product surface reaches is the same
  defect as a guarantee written in prose.** `ingest.ts` was 375 finished lines —
  two phases, coded errors, the store untouched on a phase-1 failure — with ZERO
  production callers across two milestones, while `deferred-work.md` re-homed it
  twice saying "home moves to whichever story first gives ingestion a command"
  and no story gave it one. The tell was a NUMBER, not a reading: `panda list`
  returned `[]` on a machine carrying 40 skills.
- **A feature that reads where another feature writes will accuse itself.**
  Ingest reads the roots projection writes into, so an ingested skill arrived
  already sitting at its own destination and was reported `foreign-collision`:
  `ingest` then `init` then `doctor` FAILED on a completely correct environment.
  The verdict was also factually false — the file panda copies FROM and the file
  it copies TO were the same file, so the bytes could not differ. **The fix that
  looks obvious is the wrong one**: adopting the path into the ledger would make
  `remediate release` an authority to delete a user's own skill. Found by driving
  the binary, invisible to 1,346 green tests.
- **Check whether the "edge case" is the main case before designing for it.**
  A skill id offered by two roots was frozen as a reported refusal. Measured:
  22 of 40 ids sit in ALL THREE roots, because the user has been keeping three
  roots in sync by hand — which is precisely the person panda exists for. As
  frozen the feature delivered 16 of 40. Splitting on real content (11 identical
  → collapse, 13 divergent → keep refusing) took it to 27. **The refusal was
  still right for the 13**; the mistake was applying it to the case with no
  decision in it.
- **A change token is not a content hash.** mtime+size answers "did this path
  change", never "are these the same bytes" — two identical trees copied at
  different times carry different tokens. Reusing the cheap token for identity
  would have silently answered a question it cannot.
- **A discarded promise is a test that bets.** `void writeHolder(...)` inside a
  seam declared `=> void | Promise<void>` that release AWAITS: the ordering was
  always forceable and the test wagered on it instead. Green on Node 26, red on
  Node 24, and it flipped only because the previous commit added two test files
  to that package and changed the load. **The expensive half is not the red one**
  — the same wager could have been WON on a build where the restore was broken,
  and reported green. Falsified after fixing: dropping the token check from
  release turns it red.
- **A spec can name a file that does not exist.** Mine told the implementer to
  read `packages/registry/test/guard.test.ts` and `packages/cli/test/guard.test.ts`.
  Neither exists (control: both `test/` directories do). Filing that as a
  renegotiation rather than implementing past it uncovered the real gap:
  **AD-2 is enforced by a guard test in 5 of 10 packages**, and `registry` and
  `cli` are among the five with none.

**Process rules that earned their place:**

- An implementer that FILES a renegotiation instead of implementing past a
  frozen clause is behaving correctly — it caught a real defect every time.
- Commission any "is it really published?" check from an author who is FORBIDDEN
  to read the implementation. A sample written by the contract's author always
  validates and proves nothing. The blind author found ten documentation gaps.
- Report negative results. "I checked and it is fine" is a real result — FR-2
  looked like a gap and was not.

## 8. State at handoff

`main` is at **`5743438`**, CI green on both jobs (`gates (24)` and `gates (26)`)
verified against that exact SHA, working tree clean. (This document's own commit
sits one above it — check `git log`, do not trust this line alone. It has been
stale about its own state twice.)

**`gh run list --commit <sha>` returns EMPTY for a commit that HAS a run.** It
returned nothing for `6083243` and equally nothing for `100ed99`, which is known
green — a false zero from the instrument, not from CI. Use
`gh run list --limit 5 --json headSha,name,status,conclusion` and match the SHA
yourself. This was caught only because the zero was controlled against a commit
known to be green; taken at face value it reads as "CI has not started yet",
and `6083243` was RED.

Stories closed, each with CI verified against its exact SHA:

| commit | story |
|---|---|
| `84c62e2` | M4.D — gave the registry a door (`panda add/remove/list`), plus the invariant that every printed `panda …` command is dispatched |
| `71db335` | forced the discard race instead of betting on it |
| `bacce70` | M4.E — retired `tool`; retirement machinery so removing a word cannot brick a store |
| `943e393` | M4.F — retired `profile`; it is a selection over entries, not an entry |
| `2974edd` | M5.A — published the MethodPlugin contract; live suite stops blaming panda for provider outages |
| `087e357` | M6.A — worktrees panda can prove are its own (implements 4.1 / FR-18) |
| `3302658` | M5.B — the artifact `path` rule and the hook pair are enforced, not stated |
| `d4800c2` | M5.C — `panda swap executor`; panda writes the selection it used to tell you to hand-edit |
| `88a5333` | cordis measured: take the ideas, refuse the dependency — and Story 5.4 unblocked |
| `182473f` | M5.D — `panda swap method`; a method is a selection panda MOUNTS, not an entry it projects (Story 5.4 / FR-28 / UJ-3) |
| `7d13d58` | M7.A — the kernel's teardown does what the kernel says it does; found by reading cordis, including a live unhandled-rejection hazard |
| `b7e782c` | M7.B — the kernel tells an author EVERY manifest violation, and typed absence says which of three it is |
| `bb8e539` | M7.C — the kernel APPLIES the configSchema every manifest must declare; three plugins stop hand-rolling it |
| `b498b9c` | M7.D — `panda run --trace`; the binary finally holds a sink, and `lostRecordCount` is measured UNREACHABLE from the CLI rather than surfaced wrong |
| `2d4230e` | M7.E — a malformed vendor config is REFUSED with its `line:column`, not spliced into a recovered parse tree; the old build exited 0 having destroyed a user's own server definition |
| `7884e3e` | M8.A — `panda export`, implementing Story 5.1 / FR-21 / NFR-5 / NFR-6; a credential-bearing entry is left out AND named, so nothing goes missing quietly |
| `a2170db` | M8.B — `panda import` (Story 5.2 / FR-22 / FR-25), and the separator fix that lets a Registry cross platforms at all; found a double-marker corruption of every imported path by driving the binary |
| `6083243` | M9.A — `panda ingest`; `ingestProviders` gets its first production caller after two milestones with none, and the seam defect that gave a correct environment a `foreign-collision` is fixed at the one place a plan is obtained |
| `5743438` | forced the successor-lock race instead of betting on it — a discarded promise made a test that could fail when it should not AND pass when it should not |

**A known local-only red:** `packages/projection/test/skills-discovery.live.test.ts`
fails 2 tests on Windows at HEAD and passes in CI. Measured with the working
tree stashed, so it is nobody's uncommitted work. It aborts `pnpm check` before
the later packages run — see §4 for running them individually. Its own
accounting invariant is what breaks (`measured 2 of 3 executors -- the remaining
cases did not report a reason`): one executor landed in neither the measured nor
the not-measured bucket. Recorded in `deferred-work.md`.

`REGISTRY_ENTRY_TYPES` is now exactly `skill` and `mcp-server` — the two the
projection layer actually delivers.

## 9. Next steps, measured and in order

0. **READ THIS BEFORE ITEM 1: "Profiles" is not a specified requirement, and
   item 1 was my framing, not the PRD's.** Measured on 2026-09-01, with a
   control (`grep -c FR-28 epics.md` → 6, so the grep sees):
   - `epics.md` mentions `profile` exactly **three** times and **none is a
     story**. Epic 5's six stories are export, import, MethodPlugin, hot-swap,
     diagnostics, status.
   - The only FR that mentions Profiles is **FR-21**, in passing: *"a Bundle
     containing the Registry, Profiles, and Skill sources"*. There is no FR, no
     story, no acceptance criterion and no lifecycle verb for a Profile.
   - Of FR-21's three legs, **one exists**: the Registry. Profiles have no
     representation, and `SkillSource` is a declared port with an ingest path
     and no shipped implementation (8 hits in `src`, control `ProjectionTarget`
     → 43).

   So designing Profiles means INVENTING requirements from a glossary line,
   which is the thing that costs the most here. Item 1 below is kept for its
   banked evidence, which is real and worth having when a Profile requirement
   actually exists — but it is not a licence to build one.

   **The versioning question it left open is SETTLED**, and by the PRD rather
   than by argument: Story 5.2's own criterion is *"importing a newer
   **schema-major** Bundle exits non-zero naming the incompatibility"*. Schema
   version. Not content revision.

   **Stories 5.1 and 5.2 both SHIPPED (M8.A, M8.B), and Epic 5's portability
   half is closed.** `panda export` and `panda import` exist, a bundle
   round-trips losslessly between machines, and the separator that made a
   Windows-written Registry unusable on POSIX is fixed at the contract.

   **RECOUNTED 2026-09-02, and the board was lying twice.** The real backlog is
   **7 stories**, not the 11 this document claimed and not the 8 it claimed after
   the first recount: 2-6 liveness (needs re-spec onto native hooks) · 3-1
   MemoryProvider port · 3-2 filesystem+sqlite providers · 4-2 concurrent
   sessions · 4-3 crash-safe disposal · 5-5 full diagnostics · 5-6 status+quota.
   `2-10` was `backlog` while SHIPPED — `unprojectable` has been a live
   `DiagnosisFindingKind` since 2.7b with 17 assertions and the binary printing
   it — and is now closed with its evidence in the row. **Recount by running the
   binary, not by reading the file.**

   What the two Epic 5 candidates actually need, measured rather than assumed:
   - **5.5 is ~5/6 shipped.** Drift, executor detection, and a remediation per
     finding are done, and `FINDING_EXITS` is a `Record` over the closed union so
     a kind without an exit does not compile. "Direct plugin writes to
     panda-owned files" is ALSO done — `DRIFT_KINDS`' `edited` and
     `foreign-collision` (`contracts/src/projection.ts:98-105`), asserted at
     `environment/test/doctor.test.ts:159`. **A grep for `FR-26` returns 0 and
     that means nothing**: a grep for an FR LABEL is not a grep for the
     BEHAVIOUR. Its two real gaps are a "pending secret" state panda does not
     have (adding one invents vocabulary) and adapter AVAILABILITY — "is the
     executor runnable", where today panda only detects that a config file
     exists.
   - **5.6 has no substrate.** `quota|Quota` across `**/*.ts` → **2 hits**, both
     a regex classifying an executor's ERROR TEXT in a live test. Control:
     `drift` → 198 hits / 47 files. No vendor read-only usage surface is read
     anywhere. Its own AC permits "unsupported executors show no quota row", so a
     compliant 5.6 can ship showing nothing; anything more is the screen-scraping
     2.6 forbids under a different name. **Wait for a vendor to publish a
     documented usage surface**; then it becomes native rendering, which is what
     panda is for.

   **The strongest candidate that is NOT in the backlog**, recorded with its
   evidence and deliberately not acted on: all 10 packages carry
   `"private": true` at `"version": "0.0.0"`, while
   `m3a-distribution-and-a-falsifiable-sdk-proof: done`. The FR-29 proof spends a
   CI job proving a packed tarball imports cleanly — a tarball nobody can obtain.
   A distribution story marked done that a user cannot execute. If the answer is
   "panda is not meant to be consumed yet", that is a legitimate decision and
   `private: true` is correct; it just is not what the board says.

   **And a chore that is actively harmful, not merely missing:** `AGENTS.md` is
   BYTE-IDENTICAL to `CLAUDE.md` (`diff` → identical, both 44 lines, both
   `<!-- gitnexus:start -->`) and contains **zero** panda rules — grep
   `AD-1|AD-5|AD-7|correction-01|PandaError|guard\.test` over it → 0, control:
   the same pattern over this document hits. Every rule in §5 and §7 lives ONLY
   here, in a file nothing auto-loads, while the file agents DO load orders them
   to route through GitNexus MCP calls — the exact class of tool §3 documents as
   answering about a DIFFERENT repository. An hour of writing, and it is the
   project's own defect class pointed at itself.

   What follows in this item is the measurement M8.A was built on, kept because
   one line of it was WRONG in an instructive way — see the correction directly
   below it.

   The measurement, and its correction:
   `normalizeRegistryEntryPaths` (`contracts/src/registry.ts:339`, labelled
   "(NFR-6)" in the source) runs at WRITE time (`store.ts:123`), with a `~`
   marker, a `~~` escape for literal tildes, and a lossless round trip pinned at
   `contracts/test/registry.test.ts:195`. **The store on disk is already
   portable.** What is missing is the Bundle artifact, the `panda export` verb,
   and the secret detector — `grep -i secret` over all of `packages/*/src`
   returns **one** hit and it is prose in a kernel comment. One more fact for
   its spec: entry order in the store is INSERTION order (`store.ts:130-132`
   filters and appends), so a Bundle is byte-identical for the same store read
   twice — which is what the criterion asks — but is not canonical across two
   stores holding the same content. (M8.A sorts by `${type}:${id}`, so it is
   canonical now.)

   **THE CORRECTION, and it is the reusable part:** "the store on disk is already
   portable, so a bundle carries those bytes forward" was true about the WRITER
   and false about the CALLER. `list()` maps `expandRegistryEntryPaths` over
   everything it returns (`store.ts:253,267`), so `createBundle` received
   absolute paths and the first artifact M8.A produced carried a fully
   machine-specific one while its own frozen spec asserted NFR-6 was satisfied.
   `createBundle` now takes a `homeDir` and normalizes. Caught by driving the
   binary and reading the file.
1. **Profiles (Epic 5)** — evidence bank, NOT a green light; read item 0 first.
   Story 5.4 having
   shipped as M5.D. The PRD glossary defines a Profile as a named bundle of
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

   **Cordis prior art for this, measured (the last lens before the mining closed):**
   - A Profile is a **patch layer over a named document**, not a copy of one.
     `packages/include/src/index.ts:101-164` folds a declarative `PatchOptions[]`
     over a loaded tree and patches a *copy*; the base file is never touched. Its
     `name` field is a **guard**, not an address: a patch whose target no longer
     matches is skipped rather than applied to the wrong entry. Panda's version
     keys on `${type}:${id}` (`registry/src/store.ts:61-63`), guards on `type`,
     and must FAIL coded where cordis warns — panda has no warn-and-continue
     register. Insertion point is one function between `store.list()` and
     `groupByKind`, called from `environment/src/remediate.ts:229` and
     `init.ts:780`.
   - **Do not revive `profile` as an entry type.** In cordis a group IS an entry
     (`loader/src/config/entry.ts:11-12`), which is legal only because its
     payload is `config?: any`. Panda's envelope is closed twice over
     (`KNOWN_ROOT_KEYS`, `REGISTRY_PATH_FIELDS`), so a container has nowhere to
     put members. M4.F's retirement was right, and cordis confirms it from the
     outside.
   - Panda has **no active/inactive axis at all**: `grep -i "disabled|enabled"`
     over `packages/*/src` → 1 hit, prose. Cordis expresses selection as an
     inherited tri-state `disabled` overlay with no membership array anywhere.
     The lazy correct shape is (a) selection lives in the Profile document, the
     registry keeps saying what EXISTS; (b) an `enabled` field on the envelope
     triggers the `REGISTRY_TYPE_FIELDS` split already flagged at
     `contracts/src/registry.ts:107-110`.
   - Panda's scope merge is **whole-entry replacement**
     (`store.ts:262`: `merged.set(entryKey(entry), entry)`), not the per-key
     layering that "per-executor model/effort selections" needs. Confine the
     per-key fold to the Profile layer rather than changing `list()`'s meaning
     for every caller. `extensions` is the only root slot that admits provider
     vocabulary and has **zero** readers in `packages/projection/src`.
   - **Cordis versions nothing** about groups or bundles — verified by absence.
     Panda's own `STORE_VERSION` equality check plus the retired-vocabulary read
     path is better prior art than anything cordis has. First pin whether the
     PRD's "versioned" means schema version or content revision; they are
     different designs.
2. **The unguarded window** between `readIfPresent` and `statSnapshot` in
   `discardLegacy` — a write landing there is captured by the snapshot, so the
   guard correctly reports no change while `text` is stale. In the ledger.
3. ~~**Four kernel exports with no consumer**~~ — **this entry was wrong, and
   M7.D measured it.** Three of the four have readers, and the fourth was the
   real gap:
   - `createLogSink` — genuinely unread. **Fixed by M7.D**: `panda run --trace`
     is its first production consumer.
   - `lostRecordCount` — read by `packages/session/test/kernel-composition.test.ts:130`,
     and **not surfaceable from the CLI by construction**: its `lostRecords`
     WeakMap (`packages/kernel/src/log.ts:403`) is keyed by the sink object
     `recordSafely` was handed, which is always the session's waterfall wrapper
     (`lifecycle.ts:230`), never the caller's. A CLI reading it would print `0`
     on every run *including* the runs where the kernel did reject its own
     records. Do not "fix" this by surfacing it.
   - `validateManifest` — read by two `packages/contracts/test/` suites; that IS
     its job (the AD-1 duplication parity check).
   - `createEventBus` — the FACTORY is unread, but the capability is fully
     consumed as `kernel.bus`, with a production subscriber at
     `packages/session/src/run-session.ts:345`. Nothing to fix.

   The lesson, which is the reusable part: **"no consumer" was measured with a
   grep over `src` only.** Three of four had test consumers, and one of those
   test consumers is the mechanism that enforces an architecture rule. A test is
   a consumer. Re-run any "nothing reads this" claim over `test/` too.
4. Remaining: Epic 2's 2.6 liveness re-spec, Epic 3 (memory providers), Epic 4
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
