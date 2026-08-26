---
title: 'panda doctor'
type: 'feature'
created: '2026-08-25'
status: 'done'
review_loop_iteration: 1
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
- [x] Inspection mode on the projection engine — same computation, no writes
- [x] `diagnose` composed from the same detection and engine call as `initProject`
- [x] Findings naming executor, file, native location and entry, per drift kind
- [x] Unreadable ledger and uninitialised machine reported, never mistaken for clean
- [x] CLI binding, exit codes, pin extended, consumer proof (FR-29)
- [x] Every matrix row, including the byte-level writes-nothing proof and the convergence loop

**Acceptance Criteria:**
- Given a hand-edited panda-owned entry, when doctor runs, then it is reported as drift naming the entry, the location and the suspected cause, and nothing is written
- And re-projection converges the state, and a second doctor run reports clean
- And an entry no target can express is reported per target with its reason
- And a clean environment exits 0 while any finding exits non-zero

## Design Notes
## Spec Change Log

- **Review, the clause that held (kept unchanged):** "doctor writes nothing" was verified twice by execution — one reviewer snapshotted contents, kind, size, mode, mtime and ctime across eleven hostile states AND ran a recursive `fs.watch` during the call to catch transient temp and lock files a before/after snapshot cannot see: 0/11 dirty, zero watch events. They then proved the harness could fail by swapping in `initMachine`, which came back 9/11 dirty with lockfiles, `.releasing` and two `.tmp` files firing. A second reviewer confirmed independently over mtime and atime: only atime moves, which is inherent to reading. Moving panda's own writes into a `prepareScope` doctor cannot reach is what earned that, and it was left exactly as it was.
- **Review, the exit code was wrong on the three states doctor most needs (patch):** taken together a script could not trust the command. A machine `panda init` had never touched reported CLEAN, because `not-initialised` keyed on the `.panda` DIRECTORY and the ledger's own persist creates it for the project scope — so one `project init` anywhere made the machine scope read as initialised forever; it keys on the registry document now. No executor detected exited 0 while `init` exits 2, so `panda doctor && panda init` ran init on an environment doctor had just certified; it is a finding kind now, and both commands ask the question through one function, because two spellings of "did panda find anything" is how they come to disagree about one machine. And `unprojectable` exited 1 FOREVER on a state whose own resolution says nothing will change — a `tool` entry is unprojectable by every executor permanently, so the branch could never be taken back; findings carry a severity now and informational ones are reported in full without being counted.
- **Review, doctor promised what panda could not perform (patch):** a vendor file panda can read but not write — a root-owned config, a read-only mount, corporate MDM, a file held by the vendor CLI — was reported `out-of-date` with the resolution "`panda init` writes this file so it matches the registry". Init failed `EPERM` on the rename and wrote nothing, and doctor said `out-of-date` again, forever. That breaks the Never clause this spec wrote for exactly this. Writability is probed on the nearest existing ancestor now and reported as its own finding. The second half mattered as much: `access(W_OK)` on win32 reflects only the read-only attribute and not ACLs, so a positive answer is not a guarantee — the resolution says what panda checked and names both limits, rather than making a promise that has to survive being wrong. The unwritable LEDGER is the sharper case: it made inspect report a completely clean row, because that failure is born in the write inspect skips.
- **Review, the prediction skipped what applying would hit (patch):** the read-write race check ran only under apply, reasoned as "an inspection has no window to lose". True of the write, false of the PREDICTION — which is doctor's whole artifact. For a target whose merge creates the vendor file, inspect reported `written: true` with no error while apply returned no result row and a coded target failure. `~/.claude.json` being rewritten by Claude Code itself is named in the ledger's own comments as a live condition, so that is the machine doctor gets run on. The check runs in both modes now and the two are asserted deep-equal on that state.
- **Review, the switch meaning "do not touch this machine" failed open (patch):** `'Inspect'`, `'inspect '`, `'dry-run'`, `null` and `0` all wrote, on a function exported as part of the FR-29 parity surface where untyped callers reach it. The original trade — that a junk value silently no-op'ing `panda init` is worse — is backwards for this one field: a no-op init is visible in its own output, a stray write into a user's configuration is not. Anything that is not `apply`, `inspect` or absent is now a coded error, and `undefined` is distinguished from `null` deliberately, because null is a value a caller passed rather than an omission.
- **Review, panda's own two state files were classified oppositely (patch):** a corrupt LEDGER was reported as a finding; a corrupt REGISTRY threw out of the diagnosis and printed no JSON at all — by the command whose job is diagnosing panda's state. The registry read failure is contained under inspection only (apply still refuses, because init must not project against a registry it cannot read) and returns empty targets: with no registry every per-target verdict would be invented, and "panda is about to remove these" is the worst thing to invent.
- **Review, the report asserted more than it checked (patch):** `out-of-date` said "does not match the registry" from byte inequality while the ownership layer compares canonically — four of five subtly-clean states were already correct (byte-identical, LF to CRLF, reindent, a foreign key added), and the leak was a key reorder inside panda's own member. The wording now says what was compared. Every projection warning was also relabelled as a ledger problem, true only because one source seeds them today; it switches on the code now, so a new source cannot ship wearing the ledger's resolution text.
- **Review, pins for what was plumbed (patch):** `panda init`'s JSON key order had silently changed — `written` moved past `error` to last because the row was rebuilt by spread — with both suites green; fields are named in order and the shape is pinned for a clean row and an error row. The "every finding names what it is about" test was fixture-scoped over exactly the kinds that satisfy it; it now judges against a four-way partition asserted TOTAL over the finding kinds, so a new kind lands as a missing partition entry rather than as silence. The writes-nothing snapshot records size and mtime rather than contents alone, matching what its comment always claimed.


**Why inspection mode belongs in the engine, not in doctor.** A diagnosis computed by a second code path is a diagnosis that can disagree with what applying would do — and the disagreement would surface exactly when a user is trying to fix something. One engine, one classification, one switch for whether the bytes land.

**Why it writes nothing at all, not even panda's own directories.** Doctor is what you run when you are not sure about a machine. A tool that prepares state while diagnosing it cannot be run safely on a machine you would rather not change yet, and "it only created panda's own directory" is exactly the reasoning that makes a read-only tool stop being read-only.

**Why no remediation here.** `project init` already converges. Doctor telling the truth and one command fixing it is a smaller surface than two commands that both write, and it keeps the destructive path in one place. Adoption of foreign entries is a real gap and stays in the ledger; it needs a decision about ownership transfer that this story is not the place to make.

**Deliberately not built.** No repair, no adoption, no prompts, no machine-wide project discovery, no new drift vocabulary.

## Verification

**Commands:**
- `pnpm check` -- expected: fully green, with existing CLI assertions additive-only
