# AGENTS.md

Agent guidance for panda. This is the real file; `CLAUDE.md` points here. Edit
this one.

panda is a microkernel that manages the environment of AI coding executors
(Claude Code, codex, opencode): a canonical Registry of what you want available,
projected into each executor's NATIVE configuration, with ownership tracked so
panda can undo exactly what it wrote and nothing else.

Stack: pnpm 11 monorepo, TypeScript ~7.0.2 native, Vitest 4, Standard Schema v1,
Node >= 24. CI runs Node 24 and a Node 26 canary on Linux.

## The rule behind every other rule

**A guarantee stated in PROSE instead of enforced by something that FAILS when
violated is a defect.** It has been found in nearly every review of this repo,
including inside the mechanism built to prevent it. When you can wire an
invariant into an executed gate, wire it; when you cannot, say so out loud rather
than writing a sentence that sounds enforced.

Rules below name their gate where one exists. Rules under "Judgment" have none
and are not pretending otherwise.

## Architecture — enforced

- **AD-1** — the kernel has ZERO runtime dependencies and NEVER imports
  `@panda/contracts`. *Gate: `packages/kernel/test/guard.test.ts`.*
- **AD-2** — package topology is strictly downward. *Gate:
  `packages/contracts/test/topology.test.ts`, which derives the ONE universal
  clause for EVERY package — every `@panda/*` import in every
  `packages/*/src`, against one declared role order restated from
  `ARCHITECTURE-SPINE.md` — and fails on a package the order does not name, or
  an order that names a package that is gone.*
- **AD-2, the package-SPECIFIC half** — a `test/guard.test.ts` in `environment`,
  `kernel`, `projection`, `session` — **4 of 12 packages**. `adapter-cli`,
  `cli`, `contracts`, `registry`, `workspace-git-worktree` and `workspace-local`
  have none, which is a known gap, not a permission. The universal clause above
  covers every package; what those four add is package-specific and is not
  derivable.
- **Read a package's guard test before putting code in it, not only its
  `package.json`.** A manifest is not an architecture: `@panda/environment`
  declares `@panda/projection` and its guard test still refuses the import,
  permitting only `access`, `constants`, `mkdir`, `stat` from the filesystem and
  forbidding the literal string `atomicWriteText` in its source.
- **A plugin's `manifest.id` IS the key its configuration lives under.** The
  kernel validates `composed[manifest.id]` against the manifest's own
  `configSchema` and hands the result to the factory as `context.settings`, so a
  plugin registered under anything else is handed `undefined` forever and its
  schema is never applied to one real value. *Gate:
  `packages/session/test/plugin-config-key.test.ts`, which drives a real kernel
  and reads what the kernel actually validated — a gate comparing two constants
  would pass for a plugin whose factory read a third key.*
- **Source bytes** — no literal NUL, no stray control characters, however they
  got there. *Gate: `node scripts/check-source-bytes.mjs`, first step of
  `pnpm check`.*
- **FR-29 consumer install** — a packed tarball must import cleanly.
  *Gate: `pnpm proof:consumer-install`, a separate CI step (see below).*
- **The third-party promise** (`ARCHITECTURE-SPINE.md`, AD-2) — a port is
  implementable installing ONLY `@panda/contracts`. *Gate: the contracts-only
  scenario in `pnpm proof:consumer-install`, which installs that one tarball
  into its own project, asserts nothing else arrived, imports it, and compiles a
  `WorkspaceProvider` against the shipped declarations.*

## Architecture — stated, and worth stating

- **AD-5** — typed absence over silence. Unavailable is not failed. Give absence
  its own constructor, never a bare `null` a caller can read as a measurement.
- **AD-7** — coded errors via `PandaError` / `PANDA_ERROR_CODES`. Route on the
  code, never by parsing a message.
- **correction-01** — panda renders NATIVE vocabulary at NATIVE locations and
  never invents a location a vendor does not read.
- **correction-01 C5** — report honestly, never fake. A story that writes into a
  surface an external tool owns carries at least one criterion phrased in that
  tool's own terms.
- **panda absorbs the problem, it does not hand it back.** If the answer to a
  user's problem is "edit your vendor config", panda has not solved anything.
- Relative imports ALWAYS carry the `.ts` extension.
- All code, comments, identifiers, artifacts and commit messages in **English**.

## Running and checking

```bash
pnpm check                                  # bytes && typecheck && test && lint
pnpm build && pnpm proof:consumer-install   # the OTHER half
node --conditions=panda-source packages/cli/bin/panda.ts <args>   # drive the binary
```

- **`pnpm check` is NOT the CI gate.** CI runs the consumer-install proof as its
  own step and `pnpm check` does not include it — it needs a build the
  development loop deliberately skips. Run the proof before pushing anything that
  adds an import specifier, or a comment that looks like one:
  `packages/session/test/consumer-install.proof.ts` regexes RAW SOURCE and does
  not strip comments, and the packed `.d.ts` keeps JSDoc.
- **`pnpm check` ABORTS at the first failing package, and `lint` runs LAST.** A
  run that dies in `test` never lints. When it stops early, run the rest per
  package with `./node_modules/.bin/vitest run` — `pnpm --filter` does not work
  here because of the node_modules junctions.
- Excluding live suites needs `**/*live*.test.ts` — **stars on both sides**.
  Three naming styles exist: `confinement-live.test.ts`, a dot in
  `skills-discovery.live.test.ts`, and a PREFIX in `live-smoke.test.ts`. A
  suffix glob cannot cover a prefix, and this sentence twice taught a pattern
  that missed one — first `**/*.live.test.ts`, then `**/*live.test.ts`, each
  recorded as fixed while a live suite kept running inside "live excluded" runs.
  *Gate: `packages/contracts/test/live-suite-naming.test.ts`, which holds the
  roster and fails BOTH ways — a live suite the glob misses, and an ordinary
  suite the glob would swallow (`live` is a substring of `delivery`).*
- On Windows, native binaries need Windows paths (`cygpath -w`). A native tool
  handed an MSYS path silently misbehaves.

## Verification discipline — how claims about this repo get made

- **Never assert code behaviour from a spec or a comment. Execute it.** Four spec
  claims were wrong here and all four surfaced by running the code, never by
  re-reading it.
- **A ZERO without a control means "I did not look", not "there is nothing."**
  Before believing any zero, run the same query against something you KNOW
  exists. Also: a grep for an FR LABEL is not a grep for the BEHAVIOUR, and
  "nothing reads this" measured over `src` only is a claim about a glob — a test
  is a consumer.
- **Read the call site, not the callee.** Three stories running, never once found
  by reading: a validator whose caller pre-filtered its input, a writer whose
  reader re-expanded what it had normalized, a normalizer applied twice. All
  three surfaced by driving the binary and reading the output file.
- **A test that BETS instead of forcing its precondition** fails when it should
  not AND passes when it should not. Force the ordering; never `void` a promise a
  later step awaits.
- **`git stash push -- <file>`, re-run the binary, read the output, `stash pop`**
  is the cheapest proof a fix is not theatre.
- Verify a generated line with `cat -v`. Escaping bugs here are silent, and a
  heredoc has collapsed `\\` in a committed file.

## Tooling — two traps that fail as plausible correct answers

- **Use the codegraph CLI from inside this repo, never the `codegraph_explore`
  MCP tool.** The MCP tool resolves its index by the SESSION's working directory,
  so from another checkout it silently answers about a DIFFERENT repository, and
  the answer looks right. `cd` here first and run `codegraph status` — it prints
  the project path — then `codegraph callers` / `impact`.
- **The same caveat applies to every GitNexus MCP call.** `gitnexus analyze`
  generates a `<!-- gitnexus:start -->` block and will append it to this file;
  that block instructs an agent to run `impact()` before every edit and
  `detect_changes()` before every commit, through MCP tools with the same
  session-cwd resolution. It is deliberately not committed here. Remove it with
  `git checkout -- AGENTS.md CLAUDE.md` — **not** by cutting from the marker to
  end-of-file, which was tried and silently deleted 34 lines of real content
  because the generator does not strictly append. And confirm which repository
  any GitNexus answer came from before acting on it.
- **`gitnexus analyze` exits 0 while failing.** It left the index five commits
  stale after throwing; re-running in the foreground reported an
  `incrementalInProgress` flag and rebuilt. Read `gitnexus status` and match the
  commit yourself. Separately, its MCP `query` can return an empty result with an
  "FTS indexes missing" warning that survives `--repair-fts`, while `context`
  answers correctly from the same index — an empty `query` here is not a zero.
- **`rtk` silently COLLAPSES function bodies in `head` and `grep` output.** A
  `grep -n "describe("` over a file full of them returned nothing. `cat` and
  `sed -n` pass through raw; use `rtk proxy grep`, or ripgrep directly.

## Judgment — no gate, and no pretending

- Fix the ROOT, not the path the report names. Grep every caller before editing;
  one guard in the shared function is a smaller diff than a guard in every
  caller, and patching one path leaves the siblings broken.
- Prefer the plain solution, and **measure the "better" one before rejecting the
  plain one**. A template-literal semver type looked like the upgrade and, against
  a corpus with a control, rejected `1.0.0-rc.1`.
- Do not build a branch that cannot fire, and do not surface a counter its holder
  cannot read.
- A comment that promises a future is a comment that lies.
- Record deliberate simplifications in `_bmad-output/implementation-artifacts/deferred-work.md`
  — append-only, with the upgrade path. Read it before claiming something is
  missing.

## Where the rest lives

- `_bmad-output/planning-artifacts/` — PRD (glossary + resolved decisions),
  epics, architecture spine and corrections, roadmaps, research notes.
- `_bmad-output/implementation-artifacts/` — `sprint-status.yaml`, one frozen
  spec per story, `deferred-work.md`. Recount story state by running the binary;
  the board has lied twice.
- `_bmad-output/SESSION-HANDOFF.md` — the long-form session record. Everything in
  it that is a RULE belongs here instead.

