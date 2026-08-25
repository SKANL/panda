---
title: 'panda init and project init'
type: 'feature'
created: '2026-08-25'
status: 'in-progress'
review_loop_iteration: 0
baseline_commit: '45450b2'
context:
  - '{project-root}/_bmad-output/planning-artifacts/ROADMAP-01-composition-first.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-2-0-session-composition-through-the-kernel.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-2-8-native-config-projection-with-ownership-ledger.md'
  - '{project-root}/_bmad-output/planning-artifacts/architecture/architecture-panda-2026-08-24/correction-01-native-projection.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** the registry, the projection engine and the ownership ledger all work and none of them has a production caller. Nothing in panda has ever written an MCP server into a real executor's configuration. That absence is not only missing value — it is the reason a whole projection subsystem shipped inert for four stories: with no composed path, nothing exercises the thing end to end, so nothing notices it does nothing.

**Approach:** the first vertical slice. A consumer-tier capability that reads the registry, discovers which executors are actually present on this machine, and projects the registry into each one's own configuration through the existing engine and ledger. `panda init` prepares the machine; `panda project init` binds a project and projects into it.

**SDK-first, per FR-29.** The capability lives in `@panda/environment`; `panda init` and `panda project init` parse arguments, format output and map results to exit codes, and hold no capability of their own. A consumer that has not installed `@panda/cli` performs the same work by importing the package — proven positively by a consumer test, not by scanning the CLI for forbidden text.

**Why a second consumer package.** `@panda/session` is named for running a session and this is not one; putting it there would make the name lie. It cannot live in `@panda/projection` either — projection is implementation tier and AD-2 forbids it depending on the registry, which is exactly the violation Story 2.8's review found and closed. Environment versus execution is the honest split, and it uses the product's own vocabulary.

**On "through the kernel".** Story 2.0 routed the executor call through the interception pipeline because AD-10 governs executor actions. A projection write is not one, so this story does not force the pipeline in where it has not earned its place. What it does take from the kernel is the Story 1.6 record sink: what panda wrote into whose configuration is precisely the kind of thing NFR-4 exists to make reconstructable.

## Boundaries & Constraints

**Always:** every capability is reachable by importing `@panda/environment` without `@panda/cli`, proven by a consumer test that imports only that package (FR-29); detection is honest — an executor counts as present only on evidence, and the evidence is named in the result; projection goes through the Story 2.8 engine and its ownership ledger, and nothing else writes to a vendor's file; a run with no detected executors is a non-zero exit that LISTS what was looked for and where, so the user can act on it; every write is recorded through a log sink; the result distinguishes written, unchanged, drifted and unprojectable per target, because a summary that says only "done" is the failure this epic already made once; per-target failure isolation is preserved — one executor's broken config never stops the others.

**Ask First:** writing anything into a vendor file beyond what the registry holds; any automatic remediation of drift (that is `panda doctor`, Story 2.7b); prompting the user interactively; detecting an executor by running its binary rather than by inspecting the filesystem.

**Never:** no new projection vocabulary — correction-01 governs what gets written and where; no capability in `@panda/cli`; no writing to a config panda's ledger does not claim, and no repair of one that drifted; no invention of registry content — this story projects what is there and reports what is not.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| SDK use without the CLI | A consumer importing `@panda/environment` | Same result the command produces, no code copied from the CLI | Coded errors surface |
| Machine init, fresh | No panda state on the machine | Panda's own directories and registry store exist afterwards; idempotent on a second run | Coded error |
| Project init, executors present | Registry with entries, detected executors | Each executor's own config carries the entries in its own vocabulary at the location it reads | Per-target coded error |
| No executors detected | Nothing installed | Non-zero exit listing each executor looked for and the path checked | Not a crash |
| One target's config is broken | One vendor file unreadable | That target fails, the others still project | Per-target isolation |
| Drift present | A panda-written entry the user edited | Reported as drift and NOT overwritten; the run still succeeds for the rest | Reported |
| Unprojectable entry | A registry entry no target can express | Reported per target with the reason; nothing written for it | Reported |
| Second run, unchanged | Same registry, same configs | Nothing written, reported as unchanged, byte-identical files | N/A |
| Result is specific | Any run | Written / unchanged / drifted / unprojectable distinguishable per target | N/A |

</frozen-after-approval>

## Code Map

- `packages/environment/` -- NEW consumer-tier package: machine init, project init, executor detection, and the result shape
- `packages/environment/test/consumer.test.ts` -- the FR-29 positive proof: imports only this package
- `packages/cli/src/` -- `init` and `project init` as thin bindings; argv, formatting, exit codes only
- `packages/cli/test/run.test.ts` -- existing assertions untouched; the thin-binding pin extended to the new commands

## Tasks & Acceptance

**Execution:**
- [ ] Consumer-tier package with machine init and project init
- [ ] Executor detection from filesystem evidence, with the evidence reported
- [ ] Projection through the Story 2.8 engine and ledger; writes recorded through a sink
- [ ] Result shape distinguishing written / unchanged / drifted / unprojectable per target
- [ ] CLI bindings + the pin extended; consumer test proving FR-29
- [ ] Every matrix row

**Acceptance Criteria:**
- Given a project with detected executors, when project init runs, then each executor's own configuration contains the registry's entries in that executor's vocabulary at the location it reads
- And the same is achievable by importing `@panda/environment` without `@panda/cli` (FR-29)
- And a run with no detected executors exits non-zero listing what was looked for and where
- And drift is reported and never overwritten, unprojectable entries are reported with a reason, and a second run writes nothing

## Spec Change Log

## Design Notes

**Detection is filesystem evidence, not a probe.** An executor counts as present when the configuration location it reads exists. Running a binary to detect it is slower, has side effects, and can hang — and it is not needed for the question being asked, which is "does this machine have a config for this executor to read". The evidence is reported so a user who disagrees can see exactly what was checked.

**Why the result must be specific.** This epic already shipped a projection that reported success while writing something no executor reads. A result that says "3 targets written" is compatible with that failure. Written, unchanged, drifted and unprojectable are four different facts and the caller needs all four — which is also what makes Story 2.7b's doctor a report over the same data rather than a second implementation.

**Deliberately not built.** No drift remediation, no interactive prompts, no binary probing, no new commands beyond the two, no changes to what projection writes.

## Verification

**Commands:**
- `pnpm check` -- expected: fully green, with existing CLI assertions unmodified
