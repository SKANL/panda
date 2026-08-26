---
title: 'The workspace is a boundary, or panda says it is not'
type: 'feature'
created: '2026-08-26'
status: 'in-progress'
review_loop_iteration: 0
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

## Tasks & Acceptance

- [ ] Per-executor confinement measured against the real binaries, by observing the filesystem
- [ ] The child's environment made deliberate, with the named suspect confirmed or ruled out
- [ ] Whatever panda controls and can fix, fixed and proven by the same measurement
- [ ] Whatever panda cannot fix, reported per executor rather than assumed away
- [ ] The verification writes only inside its own temp directory, and proves it
- [ ] Behaviour neutrality for a well-behaved run; existing assertions unmodified

**Acceptance Criteria:**
- Given each of the three shipped executors, when it is told to write a file inside a workspace, then where the file actually lands is established by execution and recorded per executor
- And where panda's own environment caused the escape, it is fixed and the same measurement now shows confinement
- And where it did not, panda reports that executor as not confining rather than advertising an isolation it cannot demonstrate
- And the check goes red if an executor that confines today stops confining

## Design Notes

**Why measurement is the deliverable.** The honest output of this story might be "two confine and one does not". That is a result, not a failure — Epic 4 can be designed against a known limit and cannot be designed against an unknown one. What this story must not produce is a comfortable assumption.

**Why the environment is the first suspect.** panda builds the child's environment, so anything leaking a location through it is panda's to stop. That is the cheapest possible fix if it is the cause, and ruling it out is worth as much as confirming it.

**Deliberately not built.** No sandbox, no refusal to run, no vendor configuration, no change to the workspace port.

## Verification

**Commands:**
- `pnpm check` -- expected: fully green, existing suites unmodified
- `pnpm proof:consumer-install` -- expected: still green
- the per-executor confinement measurement -- expected: three recorded answers against the real binaries
