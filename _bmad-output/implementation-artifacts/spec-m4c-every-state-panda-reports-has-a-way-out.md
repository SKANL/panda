---
title: 'Every state panda reports has a way out'
type: 'feature'
created: '2026-08-26'
status: 'in-progress'
review_loop_iteration: 0
baseline_commit: '2782fda'
context:
  - '{project-root}/_bmad-output/planning-artifacts/architecture/architecture-panda-2026-08-24/correction-01-native-projection.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-m4b-skills-materialise-where-executors-find-them.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-2-7b-panda-doctor.md'
  - '{project-root}/_bmad-output/planning-artifacts/ROADMAP-02-the-container-and-the-promise.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** panda can put a user in a state the product cannot get them out of, and it now has four ways to do it. A panda-owned entry or tree the user edited reports `edited` forever. One they deleted reports `removed-by-user` and panda never re-adds it. Anything at panda's location the ledger does not claim is a `foreign-collision` panda refuses to resolve — **including panda's own tree after a crash between the write and the ledger update**, which needs no user action at all. And a ledger record damaged in a way that disqualifies it is carried but never repaired.

Every one of these is correct behaviour. Refusing to touch what panda does not own is the guarantee the whole projection subsystem is built on, and M4.B tightened it precisely because two reviewers deleted files through a forged claim. The defect is not the refusal. **The defect is that the refusal is terminal.**

The ledger has been saying so since Story 2.2. The same gap was recorded there, re-homed to Story 2.7, re-homed again to 2.7b, and is still open — and M4.B added a fourth entrance while closing none. Four stories, five entries, one hole.

**And the only exit that exists today is hand-editing `~/.panda/projection-ledger.json`** — the file whose integrity every safety guarantee in this subsystem depends on. Telling a user to repair panda by editing the ownership record by hand is worse than the state it repairs.

**Approach:** an explicit, per-finding remediation the user asks for by name. Panda never decides to resolve anything; the user does, one finding at a time, having been told exactly what will happen. That is the same asymmetry `panda doctor` already has — doctor reports and writes nothing, and this is the other half it was designed to leave room for.

**Every remediation is described before it runs, by the code that runs it.** A preview computed by a second path is a preview that can disagree with the act, which is the divergence `panda doctor` exists to avoid and the reason its inspection mode is the projection engine rather than a copy of it.

**correction-01 C6 lives here too.** A previous build wrote panda-vocabulary blocks into vendor files at locations no executor reads. Those are panda's own litter and nothing removes them; the remediation vocabulary this story builds is what can.

## Boundaries & Constraints

**Always:** remediation is explicit and per finding — the user names what to resolve and panda resolves nothing else; every remediation states exactly which paths and which bytes it will change BEFORE it changes them, computed by the same code that performs it; a remediation that would touch anything outside the location panda owns is refused coded, and M4.B's containment applies unchanged — resolved paths, links disqualifying, no path a surviving claim still holds; every state panda can REPORT has at least one remediation that leaves it, and a test proves the two sets match; the ledger stays the ownership authority — remediation changes what panda claims, it never guesses; a remediation that fails leaves the state it found, or reports plainly that it did not.

**Ask First:** any automatic or on-by-default remediation; a bulk "fix everything" that does not name each finding; remediating a finding panda did not report in the same run; deleting a user's file as part of adoption; remediation of a scope the caller did not name.

**Never:** no remediation panda cannot describe first; no silent adoption of foreign content; no reach outside what the ledger claims or what the user explicitly named; no new way to lose a file the user wrote; no state left reportable-but-unresolvable once this ships — if a finding has no exit, it is not shipped as a finding.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Every finding has an exit | The full set of reportable states | Each has a remediation, proven by a totality test | Missing ⇒ fails |
| Described before done | Any remediation | Names the paths and the change first, from the same code path | N/A |
| Preview equals act | A described remediation, then run | What happened is what was described | N/A |
| Explicit only | A run with no remediation asked for | Nothing is remediated, exactly as today | N/A |
| Adopt | Content at panda's location the ledger does not claim | Panda claims it, or says why it will not | Coded |
| Restore | A panda-owned thing the user edited | Panda's version, only after the user asks | Coded |
| Release | A claim the user wants panda to stop holding | The claim goes, the file stays untouched | Coded |
| The crash state | Panda's own tree with no record | Resolvable — it is panda's litter, not the user's | Coded |
| C6 litter | A block a previous build wrote where nothing reads it | Removable through the same vocabulary | Coded |
| Containment holds | A remediation aimed outside the owned location | Refused coded; nothing touched | Coded |
| A foreign neighbour | Anything panda did not write, beside what it did | Untouched by every remediation | N/A |
| Failure | A remediation that cannot complete | The prior state stands, or the partial result is named | Coded, not silent |
| No hand-editing | Every state reachable in this story | Resolvable without opening the ledger | Proven |

</frozen-after-approval>

## Code Map

- `packages/projection/` -- the remediation vocabulary beside the drift vocabulary that names the states
- `packages/environment/` -- the capability, beside `diagnose` which reports the findings it resolves
- `packages/cli/src/run.ts` -- a thin binding: name the finding, print what will happen, map the result
- tests -- the matrix, the totality proof, and the preview-equals-act proof

## Tasks & Acceptance

- [ ] A remediation vocabulary covering every state panda reports
- [ ] A totality test tying reportable states to remediations, so a new state without one fails
- [ ] Description before action, from the same code path that acts
- [ ] Explicit, per-finding invocation; nothing automatic
- [ ] M4.B's containment applied unchanged to every path a remediation touches
- [ ] The crash state and correction-01's C6 litter both resolvable

**Acceptance Criteria:**
- Given any state `panda doctor` reports, when the user asks for its remediation by name, then panda describes exactly what it will change and then changes exactly that
- And nothing is remediated that the user did not name
- And no remediation touches anything outside what panda owns or what the user named
- And no state reachable in this story requires hand-editing the ledger to leave

## Design Notes

**Why the refusal was right and the terminality was not.** Panda refuses to touch what it does not own, and M4.B made that refusal stricter for good reason. But a guarantee that can only be escaped by editing the file the guarantee is stored in is a trap, and it has been one since Story 2.2.

**Why one finding at a time.** A bulk fix is where a user loses something they meant to keep. The unit of remediation is the unit of reporting, so the thing the user consents to is the thing they were shown.

**Deliberately not built.** No automatic remediation, no bulk sweep, no interactive prompting, no new drift vocabulary, no bundle export.

## Verification

**Commands:**
- `pnpm check` -- expected: fully green, existing suites unmodified
- `pnpm proof:consumer-install` -- expected: still green
