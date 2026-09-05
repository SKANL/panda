# Spec M31.A — a registry from the future is not a broken one

**Status:** FROZEN
**Created:** 2026-09-04
**Base commit:** `1fcb43f`
**Story:** none. Not an epic story — found by the third DeepSeek Harness research
pass (`research/deepseek-harness-the-last-nine-groups-2026-09-04/research.md` §2.1)
and re-measured by driving the binary.

## Intent

`panda doctor` tells the owner of a **healthy** registry document to *"Repair or
remove that document."* Following that instruction destroys it.

One finding kind, `registry-unreadable`, covers three different facts: a
malformed document, an invalid entry envelope, and **a document written by a
build newer than this one**. The first two are damage. The third is intact data
this build cannot classify, and its only correct action is to upgrade panda —
which panda can name exactly, because it knows both version numbers.

This spec splits the third case out, at the error code AND at the finding kind,
and reuses the two-sentence message `parseBundle` already ships.

## The measurement this rests on

Everything below was driven through the shipped binary
(`node --conditions=panda-source packages/cli/bin/panda.ts <verb>` with `HOME`
and `USERPROFILE` pointed at a throwaway sandbox), **with a green control**, at
`1fcb43f`. Nothing here is asserted from reading.

### M1 — the three states reach one kind, and the control proves the instrument can say "no"

| registry document | `doctor` exit | findings |
|---|---|---|
| `{"version":1, entries:[…healthy]}` — **CONTROL** | 1 | `no-executor` only; **no `registry-unreadable`** |
| `{ "version": 1, "entries": [ }` (malformed) | 1 | `registry-unreadable` |
| entry with an unknown root key (bad envelope) | 1 | `registry-unreadable` |
| `{"version":2, …}` (**written by a newer build**) | 1 | `registry-unreadable` |

### M2 — the three verbs that would fix it are the three that die

With a version-2 document, control being the same document at version 1:

| verb | version 1 (control) | version 2 |
|---|---|---|
| `panda list` | exit 0 | **exit 2**, `PANDA_REGISTRY_STORE_UNAVAILABLE` |
| `panda remove skill alpha` | exit 0, entry removed | **exit 2**, nothing removed |
| `panda init` | exit 2 (unrelated: no executor) | **exit 2**, store error |
| `panda doctor` | exit 1, no store finding | exit 1, `registry-unreadable` |

### M3 — the instruction printed for the intact document

`packages/environment/src/doctor.ts:264-270`:

```
'registry-unreadable': { by: 'outside-panda',
  detail: "Repair or remove that document. Panda's ownership ledger is a
           different file and is not involved, so nothing it already claims is
           at risk while you do" }
```

Driven: the `resolution` line printed for the version-2 document is
**byte-identical** to the one printed for the malformed document.

### M4 — panda already made this exact split, in the sibling subsystem

`packages/contracts/src/errors.ts:58-70` ships BOTH codes for memory:

```
// A store stamped with a format version this build does not speak. Version by
// REJECT, never migrate — the same decision `STORE_VERSION` reached
// independently in `@panda/registry`: a partially-read store is worse than an
// unopened one, and a migration path is a v1 requirement nobody has.
contractMemoryStoreVersionMismatch: 'PANDA_CONTRACT_MEMORY_STORE_VERSION_MISMATCH',
// The medium itself cannot be created, opened or read, naming the path.
contractMemoryStoreUnavailable: 'PANDA_CONTRACT_MEMORY_STORE_UNAVAILABLE',
```

**The registry copied the DECISION and not the VOCABULARY.** It has
`registryStoreUnavailable` (`errors.ts:91`) and no version sibling. This spec
does not invent a distinction; it finishes one.

### M5 — and panda already ships the two-sentence message

`packages/registry/src/bundle.ts:405-415` (`parseBundle`, M8.B):

```js
version > BUNDLE_VERSION
  ? `it was written by a newer panda (bundle schema version ${version}); this build reads version ${BUNDLE_VERSION}`
  : `its schema version ${JSON.stringify(version)} is not one this build recognises (this build reads version ${BUNDLE_VERSION})`
```

with the comment *"Two sentences because two different things are wrong, and
only one of them is the user's cue to upgrade."*

### M6 — blast radius, measured with codegraph and ripgrep, each zero controlled

- `Record<DiagnosisFindingKind` over `packages/**/src` → **exactly 3**:
  `doctor.ts:164` (`RESOLUTION`), `:212` (`FINDING_EXITS`), `:356` (`SEVERITY`).
  All total. These are the compiler-forced sites.
- `Record<PandaErrorCode` over `packages/**/src` → **1, and it is `Partial<…>`**
  (`doctor.ts:409`, `WARNING_KIND`). Control: the same query found the
  `DiagnosisFindingKind` records, so it can hit. **Adding an error code forces
  zero sites.**
- `PANDA_ERROR_CODES.` over `packages/cli/src` → **0**. Control:
  `PandaError|\.code` over the same path → 8 hits, including `run.ts:1318-1324`,
  which duck-types `.code`. The CLI switches on neither union.
- `packages/environment/src/init.ts:516-524` (`toTargetFailure`) passes a thrown
  `.code` straight through to `TargetFailure.code` (`init.ts:81-84`), so a new
  registry code reaches `doctor` with **no change to `init.ts`**.
- `upgrade` over `packages/cli/**/src/**/*.ts` → **0**. Control: `doctor` over
  the same glob → 21 hits across 2 files. **Panda ships no self-update verb**,
  so the new kind's exit is `outside-panda`, not `command`.

## The decision, and the position it refused

Two position papers were commissioned and argued this to a conclusion. They
**agreed** on the error code, the store branch, and that the message must change.
They disagreed on one thing: whether `DiagnosisFindingKind` gains a member.

**Decided: it does — and the exit-override seam is NOT widened.**

The refused alternative was to leave the union at fourteen and widen
`exitSentence(kind, command?)` / `finding(…, command?)` to also accept a
per-finding `detail`. It is refused because:

- The existing `command` override supplies a **spelling** for a shape
  `FINDING_EXITS` still declares, and it is verified per kind by
  `remediate.test.ts:138-176` against `COMMAND_EXITS` — a set-membership check
  that was tried first and let a fabricated `panda evict-retired --all` through.
- A free-form `detail` override has **no shape to verify against**. Nothing in
  the repository could distinguish a correct override from a wrong one.
- That is the split-brain M4.C closed (`doctor.ts:200-211`), and
  `deferred-work.md:743-746` records that this very record pair already printed
  three resolutions that restated their own premise. The unverifiable channel
  goes into the one mechanism built to make exits verifiable.

**The NFR-8 objection was measured and does not carry.**
`spec-m4a…md:185-189` and `:211-215` refused to add a finding kind, and the
refusal is stated twice. Both times it pairs two reasons, and the second is
doing the work: *"what would be reported is an always-true architectural fact
rather than a condition of this machine. A standing finding on every run is
noise."* M4.A's candidate fired on every run forever with no action available.
This one fires on approximately no runs, names a condition **of this machine**,
and has an action. M4.A is the test, and this case passes it.

**The `private: true` / `0.0.0` argument is not the reason either way.**
`ROADMAP-03:37-44` already ruled on it: *"'Contracts semver together' is twelve
manifests AGREEING, and they can disagree at `0.0.0` exactly as easily as at
`1.4.2`."* The reason to do it now is `epics.md:548-551`'s: this is the cheapest
moment the change will ever cost, and — specific to this change — **a
forward-compatibility fix has to be in the build BEFORE the version bump, because
the build that needs the good message is the one already shipped.**

## Boundaries & constraints

- **AD-7.** Route on `error.code`, never on message text. `errors.ts:32-40`
  states this explicitly. A branch that matches the detail string is a
  renegotiation, not an implementation.
- **AD-1 / AD-2.** The code lives in `@panda/contracts`; the throw in
  `@panda/registry`; the kind and its three records in `@panda/environment`.
  Read each package's `test/guard.test.ts` before adding an import — `contracts`
  and `registry` have none, `environment` does and pins its dependency set by
  exact equality.
- **Version by REJECT, never migrate.** Unchanged, and this spec does not
  weaken it. The store still refuses. Only what panda SAYS about the refusal
  changes.
- **`STORE_VERSION` stays 1.** This spec bumps nothing.
- **Only `version > STORE_VERSION` and integer** takes the new arm. A
  non-integer, a string, a negative or a version BELOW the current one keeps
  `registryStoreUnavailable` — same as `parseBundle`.
- **No new verb.** `panda upgrade` is out of scope and does not exist.
- **`FINDING_EXITS`, `RESOLUTION` and `SEVERITY` stay total.** No `Partial`, no
  default arm, no override.
- All code, comments, identifiers and commit messages in English.

## I/O & edge-case matrix

| store document `version` | store throws | doctor finding | exit `by` | severity |
|---|---|---|---|---|
| `1` (current) | — | none from the store | — | — |
| `2`, `3`, … (integer `> 1`) | `registryStoreVersionMismatch` | **new kind** | `outside-panda` | `problem` |
| `0` | `registryStoreUnavailable` | `registry-unreadable` | `outside-panda` | `problem` |
| `"1"` (string) | `registryStoreUnavailable` | `registry-unreadable` | `outside-panda` | `problem` |
| `1.5` (non-integer) | `registryStoreUnavailable` | `registry-unreadable` | `outside-panda` | `problem` |
| absent / `undefined` | `registryStoreUnavailable` | `registry-unreadable` | `outside-panda` | `problem` |
| malformed JSON | `registryStoreUnavailable` (parse) | `registry-unreadable` | `outside-panda` | `problem` |
| bad entry envelope | `registryStoreUnavailable` (validate) | `registry-unreadable` | `outside-panda` | `problem` |
| ENOENT | none — `{version:1,entries:[]}` (AD-5) | none | — | — |

The new kind's sentences must NOT tell the user to repair or remove the file,
and must name both version numbers.

## Code map

| file | change |
|---|---|
| `packages/contracts/src/errors.ts` | new code beside `registryStoreUnavailable` (`:91`), with a comment modelled on the memory sibling at `:58-63`. Zero forced sites. |
| `packages/registry/src/store.ts:345-352` | branch on `typeof foundVersion === 'number' && Number.isInteger(foundVersion) && foundVersion > STORE_VERSION`, reusing `parseBundle`'s two-sentence text. Everything else keeps the existing code. Check the other producers of the old code first: `ingest.ts:79` passes `cause.code` through, `lock.ts:75,148,176` are unrelated. |
| `packages/environment/src/doctor.ts` | union member; `RESOLUTION` (`:164`); `FINDING_EXITS` (`:212`); `SEVERITY` (`:356`, `problem`). `DIAGNOSIS_FINDING_KINDS` (`:401`) is derived. |
| `packages/environment/src/doctor.ts:590-603` | one production branch in `findingsFor` selecting the kind from `registryError.code`, in the shape `WARNING_KIND` (`:409-411`) already uses. |
| `packages/environment/test/doctor.test.ts:720-748` | add the kind to the `PANDA_STATE` partition — the sorted-equality assertion at `:743-748` goes red until you do. |
| `packages/registry/test/store.test.ts` | both arms with a control, mirroring `bundle.test.ts:449,461`. |
| CLI | **none.** `formatFinding` (`run.ts:1235`) interpolates `found.kind`; `describe` (`run.ts:1317-1327`) duck-types `.code`. Verify by driving, not by reading. |

## Tasks & acceptance

1. **AC1 — the intact document is not called broken.** Driving `panda doctor`
   against a version-2 registry prints a resolution that names both version
   numbers and does **not** contain "Repair or remove". Control: the same run
   against a malformed document still does.
2. **AC2 — the code, not the text.** `panda list` against a version-2 registry
   exits 2 with `PANDA_REGISTRY_STORE_VERSION_MISMATCH`; against a malformed one,
   `PANDA_REGISTRY_STORE_UNAVAILABLE`. Asserted on the code, never on prose.
3. **AC3 — the boundary rows hold.** Every row of the matrix above is driven.
   `version: 0`, `"1"` and `1.5` keep the OLD code — a fixture set that only
   covers `2` measures the happy arm.
4. **AC4 — totality is intact.** No `Partial`, no default arm, no override
   parameter added to `exitSentence` or `finding`. `remediate.test.ts:138-176`
   and `printed-commands.test.ts` pass unchanged.
5. **AC5 — falsified, per half.** Reverting the store branch reddens AC1 and
   AC2; reverting the `SEVERITY` row reddens the partition test. State which
   assertion each revert reddens, by running it.
6. **AC6 — the gate.** `pnpm check` green on Node 24 **and** Node 26, plus
   `pnpm build && pnpm proof:consumer-install`. `pnpm check` is not the CI gate.

## Ask First

File a renegotiation rather than implementing past any of these:

- If routing the kind requires matching message text rather than `.code`.
- If `TargetFailure` turns out **not** to carry the code to `findingsFor` — the
  spec claims it does (`init.ts:81-84, 516-524`) and that claim is read, not
  driven.
- If any of `packages/{contracts,registry,environment}/test/guard.test.ts` does
  not exist, or refuses an import this spec implies. Measured: `contracts` and
  `registry` have none, `environment` does. A spec has named a guard test that
  did not exist before.
- If adding the kind reddens a test this spec does not name.
- If the version-ahead state turns out to be unreachable in a way that makes the
  branch un-drivable.

## Spec change log

- 2026-09-04 — frozen at `1fcb43f`. Shape decided by two commissioned position
  papers; the `detail`-override alternative refused with its reason recorded
  above.
- 2026-09-04 — **AC5 named the wrong record, and the implementer caught it.**
  The clause said reverting the `SEVERITY` row reddens the partition test. It
  does not: the partition test is derived from `RESOLUTION`, so reverting
  `SEVERITY` reddens **typecheck** instead
  (`TS2741: Property '"registry-version-ahead"' is missing … in type
  'Record<DiagnosisFindingKind, DiagnosisFindingSeverity>'`), and reverting the
  partition ENTRY is what reddens the partition test. Both halves are pinned;
  the spec had mislabelled which pin catches which. Corrected here rather than
  in place, so the frozen text and its correction both stay readable.

## Coordinator verification (independent of the implementer)

Re-driven at the working tree by the coordinator, with **fixture shapes chosen
deliberately different from the implementer's** — the M8.A/M11.A lesson is that a
fixture generated from the code under test measures only that the code agrees
with itself.

Four shapes the implementer did not name were added: `version: 99` (far ahead),
`-1` (negative), `true` (boolean) and `null`. All four land where the matrix says
— `99` on the new arm, the other three on the old one. Control `version: 1`
produces no store finding at all, so the instrument can say "no".

**Falsified by stashing ONE file.** `git stash push -- packages/registry/src/store.ts`,
re-drive, `git stash pop`: with that file out, the version-2 document goes
straight back to `registry-unreadable` and to "Repair or remove that document".
One file is the whole behavioural fix.

**The repetition gate covers the new kind by construction, and that was checked
rather than assumed.** `doctor.test.ts:947-962` iterates
`DIAGNOSIS_FINDING_KINDS` itself — not a hand-written roster — and carries both a
positive control (`repeatedLeadingWords(…) === 3`) and a roster control
(`length > 10`). A kind added without a distinct exit sentence reddens it
automatically. This matters here specifically: `deferred-work.md:743-746` records
that this exact record pair already shipped three resolutions restating their own
premise.

**Gate, run by the coordinator:** `environment` 131, `registry` 189, `contracts`
164 — green on Node **24.14.1** and on Node **26.8.1**, the second confirmed by
printing `process.version` from the binary that ran the suite rather than by
trusting `PATH`. `typecheck` clean, `lint` exit 0, `pnpm build` exit 0,
`pnpm proof:consumer-install` 10 passed / 1 skipped.

## Verification

Implemented at `1fcb43f` + working tree, uncommitted. Everything below was driven;
nothing is asserted from reading. Drivers: `.scratch/drive-m31a.mjs` (the whole
matrix), `.scratch/drive-m31a-verbs.mjs` (M2's three verbs),
`.scratch/dump-m31a.mjs` (the printed line), `.scratch/ac5-revert.mjs` (AC5).

**AC1 — the intact document is not called broken.** `panda doctor` against a
version-2 registry now prints
`problem: registry-version-ahead (…registry.json): PANDA_REGISTRY_STORE_VERSION_MISMATCH: … it was written by a newer panda (store schema version 2); this build reads version 1 — … Install a panda at least as new as the build that wrote it; …`.
Both numbers present, "Repair or remove" absent. CONTROL: the malformed document
in the same driver still prints `registry-unreadable … Repair or remove that
document.` — byte-identical to the pre-change sentence.

*Nuance, stated rather than glossed:* the two version numbers reach the user
through the finding's `detail` (the store's own coded message), not through the
static `resolution` string — `RESOLUTION` and `FINDING_EXITS` are constants and
cannot know the document's version, and the spec refused the per-finding `detail`
override that would have let them. `formatFinding` prints `detail — resolution`,
so the printed line carries both. Asserted on the printed line.

**AC2 — the code, not the text.** `panda list`: version-2 → exit 2,
`PANDA_REGISTRY_STORE_VERSION_MISMATCH`; malformed → exit 2,
`PANDA_REGISTRY_STORE_UNAVAILABLE`. Routing is `REGISTRY_ERROR_KIND[registryError.code]`
(`doctor.ts:444`); no branch anywhere matches message text.

**AC3 — the boundary rows hold.** Every matrix row driven, both verbs:

| document | doctor kind | `list` |
|---|---|---|
| `1` (CONTROL) | `no-executor` only | exit 0 |
| `2` | `registry-version-ahead` | exit 2, `…VERSION_MISMATCH` |
| `3` | `registry-version-ahead` | exit 2, `…VERSION_MISMATCH` |
| `0` | `registry-unreadable` | exit 2, `…STORE_UNAVAILABLE` |
| `"1"` | `registry-unreadable` | exit 2, `…STORE_UNAVAILABLE` |
| `1.5` | `registry-unreadable` | exit 2, `…STORE_UNAVAILABLE` |
| absent | `registry-unreadable` | exit 2, `…STORE_UNAVAILABLE` |
| malformed JSON | `registry-unreadable` | exit 2, `…STORE_UNAVAILABLE` |
| bad envelope | `registry-unreadable` | exit 2, `…STORE_UNAVAILABLE` |
| ENOENT | `not-initialised` (nothing from the store) | exit 0 |

M2's other two verbs, version 2 versus version 1 as the control:
`panda remove mcp-server alpha` → exit 2, `…VERSION_MISMATCH`, entry still there
(control: exit 0, entry removed); `panda init` → exit 2, `…VERSION_MISMATCH`
(control: exit 2, the unrelated no-executor refusal).

**AC4 — totality intact.** No `Partial`, no default arm, no override parameter
added. `Record<DiagnosisFindingKind` over `packages/**/src` is still exactly 3
sites, all total (`doctor.ts:174, 223, 376`); every `Record<PandaErrorCode` is
still `Partial<…>` (`:435`, `:444`). `remediate.test.ts` and
`printed-commands.test.ts` pass unchanged.

**AC5 — falsified, per half, by running the reverts.**

- Revert the STORE branch → `panda doctor` on version 2 prints
  `registry-unreadable` and "Repair or remove" again, `panda list` exits 2 with
  `…STORE_UNAVAILABLE`. Red: `store.test.ts` *"rejects a future-version store
  document as a NEWER panda-s"* — `expected 'PANDA_REGISTRY_STORE_UNAVAILABLE' to
  be 'PANDA_REGISTRY_STORE_VERSION_MISMATCH'`; and `doctor.test.ts` *"does not
  call a document a NEWER panda wrote broken"* — `expected exactly one
  'registry-version-ahead' finding in ["registry-unreadable"]`.
- Revert the `SEVERITY` row → **typecheck** reddens first:
  `doctor.ts(376,7): error TS2741: Property '"registry-version-ahead"' is missing
  … but required in type 'Record<DiagnosisFindingKind, DiagnosisFindingSeverity>'`.
  The behaviour test reddens too (`severity` comes back `undefined`). It does NOT
  redden the partition test — that one is derived from `RESOLUTION`, not
  `SEVERITY`; the spec's AC5 sentence names the wrong record for this half.
- Revert the `PANDA_STATE` partition entry (the code map's actual claim) → red:
  *"partitions every kind that exists"* — `expected [ Array(15) ] to deeply equal
  [ Array(16) ] − "registry-version-ahead"`.

**AC6 — the gate.** Node **24.14.1** and Node **26.8.1**, both: source-bytes OK,
`pnpm typecheck` clean, `pnpm lint` clean, `pnpm build` clean,
`pnpm proof:consumer-install` 10 passed. `pnpm -r --no-bail test`: every package
green on both runtimes **except** `packages/projection/test/skills-discovery.live.test.ts`
(2 failures) — the known local-only Windows red, present at HEAD, unrelated.
Two further live-only reds were controlled and are NOT this change's:
`adapter-cli/test/usage-live.test.ts` fails identically with the change stashed at
HEAD (real `claude` stdout is not JSON), and `cli/test/status-live.test.ts`'s
`afterAll` temp-dir cleanup timed out once and passed on three re-runs.

**Ask First — none fired.** `TargetFailure` does carry the code to `findingsFor`
(driven, not read: `init.ts:516-524` passed `PANDA_REGISTRY_STORE_VERSION_MISMATCH`
through with no change to `init.ts`). `contracts` and `registry` have no
`guard.test.ts`; `environment`'s passed unchanged — the new code needed no new
import. The CLI needed no change, verified by driving. No unnamed test reddened.
