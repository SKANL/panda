---
title: 'The workspace is a boundary, or panda says it is not'
type: 'feature'
created: '2026-08-26'
status: 'done'
review_loop_iteration: 1
baseline_commit: 'cfad464'
context:
  - '{project-root}/_bmad-output/planning-artifacts/ROADMAP-02-the-container-and-the-promise.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-1-4-executoradapter-port-with-contract-test-harness.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-m3c-the-token-budget-stops-being-a-boolean.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Epic 4 is built on a premise nobody has tested. FR-19 promises *"concurrent isolated sessions"*, Story 4.1 promises managed worktrees with durable ownership, and every one of them assumes that handing an executor a workspace confines it to that workspace. `WorkspaceHandle.rootPath` reaches an executor as the child process's `cwd` **and nothing else**.

M3.C found out by accident that this does not hold. A live check asked opencode to create two files; they appeared in `packages/adapter-cli` — the directory the test process was launched from — twice, reproducibly, while the child had been spawned with `cwd` set to a fresh temp directory outside the repository. A control child through the same spawner reported the temp directory exactly, so the spawn seam is honest and the executor is not bound by it. The mechanism is unproven; an inherited `INIT_CWD` is the named suspect.

**So for at least one of three shipped executors, the workspace is a suggestion.** Two concurrent sessions in two worktrees would not be isolated, and the isolation panda is about to advertise would be a property of the executor rather than of panda.

**Approach:** measure it, per executor, against the real binaries — then make the answer a fact panda holds rather than a thing nobody asked. Whatever each executor does, it becomes known: confined, or not confined, established by execution. Where the cause is something panda controls — and panda builds the child's entire environment — fix it. Where it is not, panda reports it rather than promising an isolation it cannot demonstrate.

**Why this before the rest of M4.** This is a premise, not a feature. It is cheap to retire now and expensive to discover after three stories stand on it — the same argument that put the kernel seams before composition in M1 and put mounting before Epic 3 in M3.B, both of which held. A promise of isolation that turns out to be one executor's good manners is the kind of thing this project has already paid four stories to learn about.

## Boundaries & Constraints

**Always:** every claim about an executor's confinement is established by running that executor's real binary and observing the filesystem, never by reading its documentation or reasoning about its flags; the environment panda hands a child is deliberate and enumerated, because an inherited variable is the named suspect and panda is what builds that environment; a finding is per executor and recorded as such, because the three behave differently and a single verdict for all of them would be false for at least one; whatever panda cannot confine, panda reports — a surface that claims isolation it has not demonstrated is worse than one that admits the limit; `panda run` stays behaviour-neutral for a well-behaved run, and every existing assertion passes unmodified.

**Ask First:** OS-level sandboxing of any kind — containers, jails, seccomp, restricted tokens, filesystem namespaces; refusing to run an executor that does not confine; changing `WorkspaceHandle` or `RunRequest`; anything that reaches into a vendor's own configuration to constrain it.

**Never:** no claim of confinement that has not been observed against the real binary; no single verdict applied to all three executors; no silent scrubbing of a variable an executor legitimately needs; no test that writes outside its own temporary directory — the defect being investigated is exactly that, and a verification suite that reproduces it is not one.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Confinement, measured | Each real binary, told to write a file | Where the file lands is observed, per executor | Absent binary skips visibly |
| The environment panda hands over | Any spawn | Enumerated deliberately; variables that leak a location are accounted for | N/A |
| The named suspect | A child spawned with a hostile ambient variable | Its influence is measured, confirmed or ruled out | N/A |
| A cause panda controls | Confinement broken by something panda passes | Fixed, and the fix proven by the same measurement | N/A |
| A cause panda does not control | An executor that ignores its cwd regardless | Reported as not confining; nothing pretends otherwise | Surfaced, not thrown |
| Per-executor truth | The three shipped executors | Three separate answers, none inferred from another | N/A |
| Behaviour neutrality | A run whose executor behaves | Identical envelope, exit code and cleanup | N/A |
| The suite is clean | The verification itself | Writes only inside its own temp directory, and proves it | Fails loudly if not |
| Concurrency | Two sessions, two workspaces, at once | What each executor does is observed rather than assumed | N/A |
| The claim is falsifiable | The confinement check | Goes red when an executor stops confining | Must be demonstrated |

</frozen-after-approval>

## Code Map

- `packages/adapter-cli/src/node-child-spawner.ts` -- the environment handed to a child, made deliberate
- `packages/adapter-cli/src/traits.ts` / `executors/*.ts` -- if confinement is an executor fact, it belongs beside the other executor facts
- `packages/contracts/src/contract-suite/` -- if it is a port obligation, it belongs in the clauses
- `packages/adapter-cli/test/` -- the per-executor measurement against the real binaries
- wherever panda reports environment truth -- an executor that does not confine has to be sayable
- `packages/adapter-cli/test/confinement-live.test.ts` -- the measurement itself, and the thing that keeps each answer true

## Tasks & Acceptance

- [x] Per-executor confinement measured against the real binaries, by observing the filesystem
- [x] The child's environment made deliberate, with the named suspect confirmed or ruled out
- [x] Whatever panda controls and can fix, fixed and proven by the same measurement
- [x] Whatever panda cannot fix, reported per executor rather than assumed away
- [x] The verification writes only inside its own temp directory, and proves it
- [x] Behaviour neutrality for a well-behaved run; existing assertions unmodified

**Acceptance Criteria:**
- Given each of the three shipped executors, when it is told to write a file inside a workspace, then where the file actually lands is established by execution and recorded per executor
- And where panda's own environment caused the escape, it is fixed and the same measurement now shows confinement
- And where it did not, panda reports that executor as not confining rather than advertising an isolation it cannot demonstrate
- And the check goes red if an executor that confines today stops confining

## Spec Change Log

Every entry states what was MEASURED, against the real binaries, by looking at the
filesystem. Each executor was run at least twice; each run wrote into a fresh
`mkdtemp` workspace, with `PWD` and `INIT_CWD` aimed at two DIFFERENT decoy
directories so a hint that was followed would name itself. Versions: claude
2.1.246, codex-cli 0.149.1, opencode 1.18.23, Windows 11, Node 24.14.1.

**1. The mechanism is `PWD`. `INIT_CWD` is ruled out.** The frozen block names an
inherited `INIT_CWD` as the suspect and asks for it to be confirmed or ruled out.
It is ruled out. In every run `INIT_CWD` pointed at a decoy that stayed empty.
`PWD` pointed at a second decoy, and opencode wrote there — twice — with its own
`write` tool call carrying that decoy's absolute path. opencode resolves its file
tools against `$PWD` rather than against `process.cwd()`.

The ledger's account of WHERE the files landed does NOT hold, and the correction
matters because it is the same finding: it said `packages/adapter-cli`, but
`git log --diff-filter=A` puts `a.txt` and `b.txt` at the repository ROOT. That is
exactly what `PWD` predicts and cwd does not — vitest's cwd was the package
directory, while the `PWD` inherited from `pnpm` named the root, and the files
followed `PWD`. An earlier draft of this entry certified the old location as
re-verified. It was not; the mechanism found here refutes it.

**2. panda handed the child a stale `PWD`, so panda fixed it.** `createNodeChildSpawner`
passed no `env` at all, so the child inherited panda's environment verbatim,
including a `PWD` naming the directory panda was launched from. It now passes
`env: { ...process.env, PWD: cwd }` with `cwd` resolved to an absolute path. The
same measurement that found the escape shows opencode confined afterwards, twice.
Removing that one line reproduces the escape and turns the check red.

**3. Corrected, not scrubbed — and the rest of the environment left alone.** `PWD`
is the only inherited variable that CLAIMS to name the working directory, so it is
the only one panda can make false by moving the child. Deleting it was rejected: a
shell-hosted tool may legitimately read `$PWD`, and a `PWD` that agrees with `cwd`
cannot mislead anything, so correcting it is strictly cheaper than removing it.
The full environment a child receives was printed and audited, and the first
version of this entry got the audit wrong by a factor of six — it claimed six
path-carrying variables from a filter that was silently broken. Re-measured with
`path.isAbsolute`, excluding `;`-separated lists such as `PATH` and
`PSModulePath`: of the **95** variables a child receives on this machine (102
under `pnpm`), **39** hold a single absolute path. `HOME`, `USERPROFILE`,
`APPDATA`, `LOCALAPPDATA`, `TEMP`, `TMP`, `INIT_CWD` and `OLDPWD` are all in that
39 and none was in the six. Two of the original six do not belong at all:
`LOGONSERVER` is a UNC hostname and `HOMEPATH` names no launch location.

Only `PWD` was touched, and the reason survives the corrected count: of those 39,
exactly one CLAIMS to name the child's working directory, so exactly one can be
made false by moving the child. `INIT_CWD` and `OLDPWD` name directories the child
was NOT given and are truthful about that — and both were tested, not assumed:
each was aimed at a live, writable decoy in every run and neither ever received a
file. Deleting a variable measured not to matter is the silent scrub the Never
list forbids, and the check asserts `INIT_CWD` still arrives untouched so a later
scrub cannot happen quietly.

**4. Three separate answers, none inferred from another — and the check now
defends each one where it is actually weak.** The first version of this file
measured all three THROUGH panda's spawner, which corrects `PWD` before any child
sees it. So no live case ever handed a child a hostile `PWD`: the hostility was
aimed at the parent. Had claude started resolving writes against `$PWD` tomorrow,
`PWD == cwd` and the file would still have landed in the workspace — green
forever, while the trait comment claimed the opposite had been demonstrated. The
underlying measurements were true; the artifact carrying them could not fail.
Corrected: claude is now spawned DELIBERATELY OUTSIDE panda's spawner with `PWD`
naming a decoy, so the lie reaches the child, and the claim is falsifiable at the
only point where it could break. opencode stays inside the spawner, because for
opencode the spawner IS the mechanism. Answers: claude resolves against its cwd
and ignores a lying `PWD`; codex, as panda ships it, writes nothing at all
(below); opencode did not confine and now does, on panda's account rather than
its own.

**5. codex is measured on the argv panda actually ships, and the earlier
justification for not doing so was false.** Measured: with panda's shipped argv,
codex writes NOTHING — its `codex exec` default sandbox is `read-only`, it
completes its turn and reports that write access is denied, and the workspace
comes back empty. The first version of this file added `-s workspace-write` to the
check and defended it by saying a check against a non-writing codex would "pass
vacuously". That is wrong about the check as built: it asserts the file IS in the
workspace, so with shipped argv it goes RED. `-s workspace-write` was a flag added
to a test to keep it green, argued from a premise that does not hold.

Corrected: the codex case now runs the shipped argv and asserts the workspace
comes back EMPTY after a completed turn. That guards the fact a panda user
actually meets — `panda run --executor codex` is a coding agent that cannot edit
code — and it goes red the day codex ships a writable default, which is when the
verdict needs re-measuring. The writable measurement is kept as a RECORDED
observation beside codex's traits, explicitly not guarded, because a standing
check on argv panda never sends tests a configuration nobody ships. The
user-facing half is now on a surface: `packages/adapter-cli/README.md` states it
in a per-executor table.

**6. The finding is a trait fact, not a contract clause and not a doctor line.**
Three homes were considered. The contract suite was rejected on a hard constraint:
Story 2.5 fixed "contract-suite runs use fake spawners exclusively — no test may
execute a real binary", and confinement is only knowable by executing one, so a
clause could only assert something weaker than the thing being claimed. A `panda
doctor` line was rejected because after the fix there is no executor that fails to
confine, and a reporting surface with nothing to report is a promise that panda
knows something it would not actually be checking. What is left is where this
repository already keeps every measured vendor fact: the trait record's own
comment, next to the usage fields and failure shapes that were established the same
way — with the live check as the thing that keeps it true rather than a field that
merely says it is.

The user-facing halves went to a SURFACE rather than staying comments, because
two of them are things a person meets rather than things a maintainer reads:
`packages/adapter-cli/README.md` now carries a per-executor table saying that as
panda ships it codex cannot create or edit a file at all, that panda makes the
workspace true without enforcing it, and that `HOME` is shared. Still not a
`panda doctor` finding: its finding kinds are a closed union, adding one is a
contract change under NFR-8's joint-semver rule, and what would be reported is an
always-true architectural fact rather than a condition of this machine. A standing
finding on every run is noise, and doctor's promise is about problems it can see,
not about what panda is.

**7. What panda does NOT confine — now measured, where it was previously only
argued.** panda makes the workspace true for an executor; it does not enforce it.
The first version of this entry admitted that as unmeasured. It is measured now:
told to create a file at an ABSOLUTE path outside its workspace, **claude did**,
without hesitating. panda runs it with `--dangerously-skip-permissions` and spawns
an ordinary child with the user's privileges, and nothing sits between them.
codex, asked the same under `-s workspace-write`, REFUSED — "I can't write outside
the permitted workspace" — but that is codex's own sandbox, not panda's, and it is
off in the mode panda ships.

Second limit, and the one that bites every run rather than only a hostile one:
`HOME` passes through untouched, deliberately, because scrubbing it would break all
three executors. So per-user executor state is SHARED across concurrent sessions —
opencode keeps one SQLite database under `~/.local/share/opencode/`, claude a
per-project directory under `~/.claude/`. Two isolated workspaces do not imply two
isolated executors, and that is not hypothetical the way the absolute-path case is.

Both are in the ledger and both are now on a surface (`packages/adapter-cli/README.md`),
so the sentence Epic 4 inherits is "isolated for a workspace-relative write, modulo
per-user executor state shared across concurrent sessions" rather than "isolated".
Deliberately NOT a `panda doctor` finding: doctor reports over a closed union of
finding kinds, adding one is a contract change under NFR-8's joint-semver rule, and
what would be reported is a permanent always-true fact about every run rather than
a condition of this machine — a standing finding nobody can act on is noise, and
doctor's "every problem panda can see" is about problems, not architecture.

**8. The suite proves its own cleanliness — for the repository, which is what the
claim is scoped to now.** One `mkdtemp` root holds the workspaces, both decoys and
every file the suite writes; the marker filename is a fresh UUID per run, so a
stray file is attributable to the run that made it; and the last case in each block
asserts the repository root and the package directory list exactly the entries they
listed before. The two residue files the M3.C ledger described were still committed
at the repository ROOT — `a.txt` containing `1` and `b.txt` containing `2`, from
`cfad464` — and are deleted.

An earlier draft said flatly that "the suite proves its own cleanliness", which
claimed more than runs, in two ways now stated instead of implied. The directory
comparison is TOP-LEVEL ENTRY NAMES: a file added under `packages/`, or a content
overwrite of a tracked file, would pass. That covers the shape the historical
escape actually had (a stray file at the top of a watched directory) and no more; a
hash-per-file walk is the upgrade if anything ever lands deeper. And the executors
this suite starts write into the user's HOME on every run — an opencode session row,
a `~/.claude/projects/<slug>` directory, a codex rollout — which `escapeSites()`
cannot see, because it probes `homedir()` for the marker file at its top level only.
Measured: `~/.local/share/opencode/opencode.db` is one 522 MB file per USER, and
`~/.claude/projects` holds 292 directories whose newest entries are named after
this story's own temp workspaces, which no longer exist. That is a pre-existing
repo-wide pattern this story did not create — `panda run` does the same, and so
does every other live suite in this package — but this is the story whose Never
list forbids writing outside its temp directory, so the sentence is scoped to what
it proves: the repository and this package, plus one temp root.

**9. Concurrency, observed rather than assumed — and one honest wrinkle.** Two
opencode sessions started at the same instant in two workspaces were measured four
times. In three, each wrote its own file into its own workspace and neither
reached the other's. In the fourth, one of the two answered without creating
anything at all — and every negative assertion still passed for it, so it was a
model declining the task, not an escape. The case therefore asserts the isolation
claim for BOTH sessions unconditionally (neither session's file may appear in the
other's workspace or in any escape site, which holds whether or not that session
wrote) and requires at least ONE of them to have produced its file, so the case
cannot pass with both silent. Requiring both would turn an unrelated
non-compliance into a red isolation defect, which is the one thing a suite about
escapes may not do.

But "the model declined" was an ASSUMPTION in that first version, and it is
indistinguishable from "the write failed because the session was pointed somewhere
it could not write" — which is an isolation defect. The evidence to tell them apart
was already in the stream: opencode prints the absolute path its `write` tool is
pointed at. The case now asserts, for every write call EITHER session emitted, that
the path lies inside that session's own workspace — falsifiable per session whether
or not the model complied — and requires at least one such call, so a pair where
both declined reports that it measured nothing. It also asserts the two runs
overlapped in time: `Promise.all` starts them together but reads identically if one
finished before the other began. The panda-owned half is asserted for free, every
run, with no binary: two children spawned concurrently each receive their own
`PWD`, not one shared value.

**10. The check was shown red, not claimed red — five times, each against a
different guard.** Every one weakens production the smallest realistic way except
the last two, which are noted as what they are.

| # | Weakened | What fired |
|---|----------|-----------|
| A | `resolve(options.cwd)` -> `options.cwd` | `resolves a relative cwd before describing it` fails; the other five deterministic cases stay green, so the case is specific to the thing it names. No API call. |
| B | the whole `env: { ...process.env, PWD: cwd }` line deleted | THREE deterministic cases fail (`replaces an inherited PWD`, `resolves a relative cwd`, `describes each of two children spawned at once`) with no API call, and the live opencode case fails naming the decoy and quoting opencode's own `write` call. |
| C | `CODEX_TRAITS.args` gains `-s workspace-write`, i.e. panda ships codex writable | the codex case fails with `codex wrote into the workspace, so panda no longer ships it read-only and its confinement verdict needs re-measuring` — the shipped fact is guarded, not assumed. |
| D | `OPENCODE_TRAITS` routed down the hostile-`PWD` path claude and codex use (a TEST mutation: no production change can make claude follow `$PWD`) | the case fails naming the decoy — so that path DOES catch a `PWD`-follower, which is what makes claude's and codex's verdicts falsifiable rather than merely true. |
| E | `CLAUDE_CODE_TRAITS.command` -> a name that is not installed | the case skips with `not detected: spawn ... ENOENT` and the summary line reports it, exit 0 — the CI shape, verified rather than assumed. No API call. |

Everything was restored and all ten cases pass: six deterministic, and four live
reporting `[M4.A confinement] measured: claude-code, codex, opencode, opencode
(concurrent pair)`.

## Design Notes

**Why measurement is the deliverable.** The honest output of this story might be "two confine and one does not". That is a result, not a failure — Epic 4 can be designed against a known limit and cannot be designed against an unknown one. What this story must not produce is a comfortable assumption.

**Why the environment is the first suspect.** panda builds the child's environment, so anything leaking a location through it is panda's to stop. That is the cheapest possible fix if it is the cause, and ruling it out is worth as much as confirming it.

**Deliberately not built.** No sandbox, no refusal to run, no vendor configuration, no change to the workspace port.

## Verification

**Commands:**
- `pnpm check` -- expected: fully green, existing suites unmodified
- `pnpm proof:consumer-install` -- expected: still green
- `pnpm --filter @skanl/panda-adapter-cli exec vitest run test/confinement-live.test.ts` -- the per-executor confinement measurement; expected: three recorded answers against the real binaries, plus one concurrent pair. `PANDA_LIVE_CONFINEMENT=0` skips the four live cases; the six deterministic ones still run and need no binary. Read the `[M4.A confinement] measured:` line the last case prints -- on a machine without the binaries this file is green while measuring nothing, and that line is what says so.
