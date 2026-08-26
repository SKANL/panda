---
title: 'panda doctor'
type: 'feature'
created: '2026-08-25'
status: 'in-progress'
review_loop_iteration: 0
baseline_commit: 'd8b001c'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/spec-2-7a-panda-init-and-project-init.md'
  - '{project-root}/_bmad-output/planning-artifacts/architecture/architecture-panda-2026-08-24/correction-01-native-projection.md'
  - '{project-root}/_bmad-output/planning-artifacts/ROADMAP-01-composition-first.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** panda now writes into configuration files it does not own, and tracks what it wrote in a ledger. Everything that can go wrong with that — a user edited a panda entry, deleted one, or wrote their own at a location panda claims; a registry entry no executor can express; a ledger that can no longer be read — is computed on every `project init` and visible only as a side effect of a command that also writes. A user who wants to know the state of their environment currently has to change it to find out.

**Approach:** `panda doctor` reports, and writes nothing. It is deliberately **the same code path** as `project init` with application switched off, not a second implementation: the engine already computes drift, unprojectable entries and whether a file would change, so a report derived from anything else could disagree with what applying would actually do. That divergence is the failure mode a diagnostic tool exists to not have.

**What it does not do.** It does not remediate. `project init` converges; doctor tells you what converging would do. Keeping the read path free of writes is what makes it safe to run on a machine you are unsure about — which is exactly when it is used.

## Boundaries & Constraints

**Always:** doctor writes NOTHING — not a vendor file, not the ledger, not the registry — and a test proves it by comparing every byte under the scope before and after; the diagnosis comes from the same engine call that `project init` uses, with application disabled, so the two cannot disagree; every finding names the executor, the file, the native location and the entry it is about, because a diagnosis a user cannot act on is not one; the three drift kinds stay distinguishable (`edited`, `removed-by-user`, `foreign-collision`) and each carries what panda would do about it; a ledger that cannot be read is reported as a finding, not as a clean bill of health; unprojectable entries are surfaced per target with the reason (correction-01 C5, which Story 2.10 carries in the abstract); the capability lives in `@panda/environment` and the CLI only parses argv, formats and maps exit codes (FR-29); a clean environment exits 0 and a diagnosed problem exits non-zero, so a script can branch on it.

**Ask First:** any remediation, adoption or repair; prompting the user; reporting on anything outside the scope the caller named; a machine-wide scan for projects panda has bound.

**Never:** no writes of any kind, including "harmless" ones like creating a missing panda directory or seeding an absent registry — doctor diagnoses a machine, it does not prepare one; no second implementation of drift classification; no remediation advice panda cannot itself perform, because the next story has to be able to perform what this one promises.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Clean environment | Registry projected, nothing touched since | No findings, exit 0 | N/A |
| Writes nothing | Any state at all, including a broken one | Every byte under the scope identical before and after, ledger included | N/A |
| Edited entry | User changed a panda-written entry | Reported `edited`, naming executor, file, location and entry | Reported |
| Removed entry | User deleted a panda-written entry | Reported `removed-by-user`, distinctly from `edited` | Reported |
| Foreign collision | A non-panda entry sits where panda would write | Reported `foreign-collision`; panda states it will not resolve it | Reported |
| Unprojectable entry | Registry holds what no target can express | Reported per target with the reason | Reported |
| Ledger unreadable | Corrupt or unreadable ledger | Reported as a finding; NOT reported as clean | Reported, not thrown |
| Nothing initialised | No panda state on the machine | Says so plainly and exits non-zero; creates nothing | Not a crash |
| Broken vendor config | One target's file unparseable | That target reported failed; the others still diagnosed | Per-target isolation |
| Converges | Doctor finds work, `project init` runs, doctor again | Second run reports clean for what the first one said would be applied | N/A |
| Exit code | Any findings vs none | Non-zero when diagnosed, 0 when clean | N/A |

</frozen-after-approval>

## Code Map

- `packages/projection/src/engine.ts` -- an inspection mode: compute the outcome and report it without writing the file or the ledger
- `packages/environment/src/doctor.ts` -- NEW: the diagnosis, composed from the same detection and the same engine call as `initProject`
- `packages/environment/src/index.ts` -- export the capability and its result types
- `packages/cli/src/run.ts` -- `panda doctor` as a thin binding
- `packages/environment/test/`, `packages/cli/test/run.test.ts` -- the matrix, the writes-nothing proof, and the CLI pin extended

## Tasks & Acceptance

**Execution:**
- [ ] Inspection mode on the projection engine — same computation, no writes
- [ ] `diagnose` composed from the same detection and engine call as `initProject`
- [ ] Findings naming executor, file, native location and entry, per drift kind
- [ ] Unreadable ledger and uninitialised machine reported, never mistaken for clean
- [ ] CLI binding, exit codes, pin extended, consumer proof (FR-29)
- [ ] Every matrix row, including the byte-level writes-nothing proof and the convergence loop

**Acceptance Criteria:**
- Given a hand-edited panda-owned entry, when doctor runs, then it is reported as drift naming the entry, the location and the suspected cause, and nothing is written
- And re-projection converges the state, and a second doctor run reports clean
- And an entry no target can express is reported per target with its reason
- And a clean environment exits 0 while any finding exits non-zero

## Design Notes

**Why inspection mode belongs in the engine, not in doctor.** A diagnosis computed by a second code path is a diagnosis that can disagree with what applying would do — and the disagreement would surface exactly when a user is trying to fix something. One engine, one classification, one switch for whether the bytes land.

**Why it writes nothing at all, not even panda's own directories.** Doctor is what you run when you are not sure about a machine. A tool that prepares state while diagnosing it cannot be run safely on a machine you would rather not change yet, and "it only created panda's own directory" is exactly the reasoning that makes a read-only tool stop being read-only.

**Why no remediation here.** `project init` already converges. Doctor telling the truth and one command fixing it is a smaller surface than two commands that both write, and it keeps the destructive path in one place. Adoption of foreign entries is a real gap and stays in the ledger; it needs a decision about ownership transfer that this story is not the place to make.

**Deliberately not built.** No repair, no adoption, no prompts, no machine-wide project discovery, no new drift vocabulary.

## Verification

**Commands:**
- `pnpm check` -- expected: fully green, with existing CLI assertions additive-only
