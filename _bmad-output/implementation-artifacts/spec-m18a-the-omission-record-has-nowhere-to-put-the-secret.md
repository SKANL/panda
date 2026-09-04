# Spec M18.A — the omission record has nowhere to put the secret

- **Story**: none open. This closes a deviation from the FROZEN spec of M8.A
  (`spec-m8a-the-environment-travels-without-the-secrets.md`), which specified
  the behaviour this story delivers and which the implementation did not deliver.
- **Implements**: FR-21 (`epics.md:40`) and NFR-5 (`epics.md:55`), neither of
  which is currently met on one of five arms.
- **Depends on**: M8.A (`7884e3e`), M8.B (`a2170db`), M17.A (`92bc0cc`).
- **State**: frozen.

## Intent

`OmittedEntry` exists so that an entry panda refuses to export is **named rather
than silently dropped**. Its own doc comment states the guarantee:

> The VALUE is never here — not the token, not an excerpt, not its length.

On four of its five arms that is true. On the fifth — `field: 'id'`, the arm
reached when the credential IS the entry's id — the record carries `id:
entry.id`, which is the credential, verbatim.

The record then travels three ways: into the bundle artifact
(`bundle.ts:184`), onto `panda export`'s **stdout** (`registry-commands.ts:547`),
and onto `panda import`'s **stderr** (`run.ts:1041`).

This is not a design question. M8.A's frozen spec already decided it, at
`spec-m8a…:151-153`:

> `id` and `type` are scanned too — they end up in the omission record, so a
> credential there could leak through the record itself; **an entry whose `id`
> matches is omitted with `field: "id"` and nothing else about it is written.**

The implementation writes something else about it. This story makes the code do
what its own frozen clause says, and makes the deviation **unrepresentable**
rather than corrected — because a corrected value is a value the next edit can
put back, and that is how this one arrived.

## The measurement this rests on

Every claim below was executed on 2026-09-04 at `92bc0cc`, not read.

1. **The leak reproduces through the real `createBundle`.** Driving it with an
   entry whose id is a GitHub classic PAT shape yields
   `{"type":"mcp-server","id":"ghp_…","field":"id"}` in the serialized artifact.
   Control, same driver, the `args` arm: the record carries `id:"leaky"` and the
   artifact does not contain the token.

2. **A shipped clause PINS the leak.** `packages/registry/test/bundle.test.ts:152`
   is the `it.each` row `['id', { type: 'mcp-server', id: FAKE.githubClassic,
   command: 'npx' }]`, and `:163` asserts
   `expect(bundle.omitted).toEqual([{ type: entry.type, id: entry.id, field }])`.
   The suite requires the credential to be in the record.

3. **The clause that would have caught it never runs against the arm that can
   fail it.** `bundle.test.ts:138-150` — *"puts no part of the credential
   anywhere in the artifact, including the record"* — is driven only through
   `args`, with `id: 'leaky'`, and its own control at `:149` is
   `expect(text).toContain('leaky')`. This is the repository's own falsification
   lesson (`document-quoting.test.ts:36-39`) committed inside the test written to
   prevent it: the plant landed in the one shape that could not fail.

4. **The detector needs no change, and this was measured against a real corpus
   with a control in both directions.** `.scratch/drive-idscan.mjs` collected
   **127 real ids** — every directory under `~/.claude/skills`,
   `~/.agents/skills`, `~/.codex/skills`, `~/.claude/plugins/cache` and every
   repo-local `.claude/skills` on this machine, plus every `mcpServers` key in
   `~/.claude.json` and `~/.config/opencode/opencode.json` and every
   `[mcp_servers.*]` header in `~/.codex/config.toml`. `isCredential` flags
   **0 of 127**. Control: the two known token shapes are flagged, 2 of 2, so the
   zero is a measurement and not a silence. Exactly one real id reaches 32
   characters (`codegraph.tools.codegraph_explore`, 33) and does not flag,
   because `.` is outside `OPAQUE_TOKEN`'s alphabet so its longest run is 9.
   **Tuning the detector would be tuning against a population of zero**, which
   `AGENTS.md`'s "do not build a branch that cannot fire" forbids.

5. **`mcp-source.ts:258` is NOT a second leak site and is not in scope.** It
   interpolates a raw `item.id` into a warning, but only on
   `registryEntryIssues` failure (`mcp-source.ts:248-249`), and the only id rules
   are non-empty-string and the eight `UNPROJECTABLE_ENTRY_IDS`
   (`contracts/src/registry.ts:211-215`). A token-shaped id passes both, so that
   branch is unreachable with a credential. An earlier draft of this spec listed
   it; that was wrong and is recorded here rather than deleted.

6. **The type is exported from TWO packages.** `packages/registry/src/index.ts:8`
   and re-exported at `packages/environment/src/index.ts:65-66`. Both are
   `"private": true` at `"version": "0.0.0"`, as are all twelve manifests, so no
   external consumer exists and the shape change costs nothing today. It stops
   being free at the first publish.

7. **The precedent for the shape is already shipped.** `UsageReport =
   UsageObservation | UsageAbsence` (`packages/contracts/src/executor.ts:194`) is
   a discriminated union whose absent arm has nowhere to carry a number it did
   not measure. This story spells `OmittedEntry` the same way; it introduces no
   new pattern.

8. **The gate FR-21 names does not exist.** `epics.md:411` requires *"the
   artifact contains no secret-detector matches (CI-scanned)"* and `prd.md:421`
   makes it testable as a *"secret-detector scan over logs/bundle artifacts in
   CI"*. `.github/workflows/ci.yml` runs install, `pnpm check`, and build +
   `proof:consumer-install`. There is no such scan. M8.A deferred it as *"a
   pipeline concern"* (`spec-m8a…:193`). Out of scope here — see D6 — but
   recorded. NOTE, added 2026-09-04 after this spec shipped: the ledger entry this produced went on to claim the scan "would have caught" this leak, and that claim is FALSE -- corrected in `deferred-work.md` with the disproof on all three surfaces. The gate is still worth having; its justification is that it does not depend on panda's exit-site enumeration being complete, not that it would have caught this one.

## Boundaries & Constraints

### D1 — the `field: 'id'` arm has NO `id` slot, so the leak is a compile error

`OmittedEntry` becomes a discriminated union on `field`:

- the arm for `command | entryPath | args | extensions` keeps `type`, `id`, `field`;
- the arm for `'id'` carries `type` and `field` only.

`field` narrows from `string` to a closed union in the same change, because an
open `string` is what let the two arms share one shape in the first place.

Redaction is **structural**, in M17.A's sense: there is no slot to put the value
in, so no future edit can put it back. A placeholder string is explicitly
rejected — it restores the prose guarantee this story exists to retire.

### D2 — the detector is NOT touched

`isCredential`, `OPAQUE_TOKEN`, `PROVIDER_PATTERNS` and `NOT_A_CREDENTIAL` are
unchanged. Measurement 4 is the reason. A detector change would be a behaviour
change riding on a contract change, and the two would justify each other in a
circle.

### D3 — the sort key must stay total, and the compiler must be the one to say so

`sortKey` (`bundle.ts:152-153`) is `` `${type}:${id}` `` and takes
`{ type: string; id: string }`. Under D1 it stops typechecking at `:191`, and
**that failure is the point** — it forces an explicit decision rather than
letting the id arm fall through to `undefined`.

The decision: the `'id'` arm sorts under its `type` alone. Two `'id'`-arm
records of the same type then tie, and `Array.prototype.sort` is stable, so
D5's criterion — *byte-identity for the same store exported twice*
(`bundle.ts:166`, `epics.md:413`) — holds, because one store read twice yields
one input order. What degrades is the weaker second claim in the same comment,
cross-bundle comparability, and only for that arm. **That degradation is
written into the type's doc, not discovered later.**

### D4 — the corpus is all FIVE arms, in both directions

`bundle.test.ts:138-150`'s "nothing anywhere" assertion is re-driven over every
arm, `id` included. Its control must be per-arm and must be satisfiable only by
the code under test: for the four value arms the id still travels and
`toContain(id)` is the control; for the `id` arm the control is that the
**field name** travels (`toContain('"field"')`) while no part of the token does.

The pinning row at `bundle.test.ts:152,163` is INVERTED, not deleted. A red pin
is a question, and this one is answered: the spec it deviates from is quoted in
the Intent above.

Three needles per arm, as M17.A established: the whole token, its first eight
characters, its last eight.

### D5 — every exit site, or the surface only LOOKS closed

Three sites, and all three ship together for the reason M17.A already gave about
the TOML sibling — a fix for one path that leaves another leaking is worse than
useless:

1. the artifact — `bundle.ts:184`, through `serializeBundle`;
2. `panda export` stdout — `registry-commands.ts:547`;
3. `panda import` stderr — `run.ts:1041`.

`run.ts:1041` currently reads
`pending: ${type} '${id}' was not exported (its ${field} carried a credential)`.
The `'id'` arm needs a second sentence that names no id. It must still say
**what to do**, because the entry is intact in the source machine's registry and
the user has to re-add it by hand: the sentence names the type, the reason, and
that the source registry still holds it.

### D6 — not in this story

- **The CI secret-detector scan** (measurement 8). It is a workflow change, not
  a code change, and FR-21's AC has been unmet since M8.A. Record it in
  `deferred-work.md` with this spec as its evidence, and with the note that
  `bundle.test.ts` is the substitute gate today.
- **`isCredential`'s thresholds** — D2.
- **`mcp-source.ts:258`** — measurement 5.
- **Publishing, versions, `@changesets/cli`, NFR-8's home.** Measured as the
  real gap in M3.A (`ROADMAP-02:125-130` scoped *"package versions"*; all twelve
  are `0.0.0` and the root manifest has no changesets). It is a separate story
  and it needs an owner decision. Recorded here so it is not rediscovered.
- **A `pending` state in `doctor`.** `epics.md:41`'s *"doctor clean except
  pendings"* is unmet — `doctor.ts` reads neither `pending` nor `omitted`
  (control: `'legacy-block'` returns three hits there). Closed on the same
  no-substrate ground the board records for 5-5 at `sprint-status.yaml:130`.

## I/O & Edge-Case Matrix

| # | Input | Expected |
|---|---|---|
| E1 | entry whose `id` matches, exported | omitted; record is `{type, field:'id'}`; artifact contains no part of the id |
| E2 | entry whose `args` match, exported | unchanged from today: `{type, id, field:'args'}`; id travels |
| E3 | two `id`-arm entries of the same type | both recorded; same store exported twice is byte-identical |
| E4 | an `id`-arm entry and a value-arm entry of the same type | both recorded, sorted deterministically |
| E5 | bundle written by this build, read by this build | round-trips; `parseBundle` accepts both arms |
| E6 | bundle written by a PRE-M18.A build (record has `id` on the `'id'` arm) | REFUSED by `isOmittedEntry`, surfacing as `"it holds invalid entries"`. Not a `BUNDLE_VERSION` bump: `bundle.ts:19` bumps only when an older reader could MISREAD, and a refusal is not a misread. Nothing is published, so no such bundle exists outside this machine |
| E7 | `panda import` of a bundle carrying an `id`-arm omission | stderr names the type, the reason, and that the source registry still holds it; names no id |
| E8 | `panda export` printing to stdout | same shape as the artifact; no id on the `'id'` arm |

## Code Map

Read each file's guard test before putting code in it — a manifest is not an
architecture.

| Path | Change |
|---|---|
| `packages/registry/src/bundle.ts` | `OmittedEntry` → discriminated union; `OmittedField` closed union; `credentialField` return type; `createBundle:184` builds the right arm; `sortKey` total over both arms; `isOmittedEntry:319-327` validates both arms; the doc comment at `:28-38` states the D3 degradation |
| `packages/registry/src/index.ts` | export `OmittedField` alongside `OmittedEntry` |
| `packages/environment/src/index.ts` | mirror the re-export at `:65-66` |
| `packages/cli/src/registry-commands.ts` | `:547` — stdout record; `:627` — the `pending` copy |
| `packages/cli/src/run.ts` | `:1041` — the second sentence for the `'id'` arm |
| `packages/registry/test/bundle.test.ts` | invert `:152,163`; re-drive `:138-150` over all five arms with per-arm controls |

## Tasks & Acceptance

1. **T1** — RED first. Extend `bundle.test.ts:138-150` to all five arms with the
   D4 controls. It must fail on the `id` arm against today's code, and the
   failure output must show the token. Do not proceed until it has been SEEN red.
2. **T2** — the type change (D1) and `sortKey` (D3). Typecheck must fail at
   `bundle.ts:191` before it is fixed; record that it did.
3. **T3** — the three exit sites (D5), together.
4. **T4** — invert the pinning row (D4).
5. **T5** — falsify: revert D1 alone and confirm the new clauses redden; revert
   each exit-site change alone and confirm the site it guards reddens. A change
   no clause pins is a change that did not need making.
6. **T6** — drive the binary: `panda export` to a temp path with a planted
   `id`-arm entry in a throwaway `HOME`, read the artifact bytes, read stdout,
   then `panda import` it and read stderr. All three must be clean, and the
   control is a SHORT planted token that would fit whole inside any truncation
   window, because a clean result on a long token is partly truncation doing the
   work.
7. **T7** — `deferred-work.md`: the CI secret-detector scan (D6), append-only.
8. **T8** — gate green on Node 24 AND Node 26.8.1, then
   `pnpm build && pnpm proof:consumer-install`. `pnpm check` is not the CI gate.

**Acceptance**: E1–E8 hold by execution; T5's falsification is recorded per
clause; `pnpm check` green on both Node versions with the live suites excluded
via `**/*live.test.ts` (no dot — panda has two naming styles and the dotted glob
silently misses one).

## Ask First

Stop and renegotiate rather than implementing past any of these:

- Anything requiring a `BUNDLE_VERSION` bump (E6 says none is needed; if the
  implementer finds otherwise, that is a renegotiation, not a decision).
- Any change to `isCredential` or its patterns (D2).
- Touching `mcp-source.ts` (measurement 5).
- A placeholder string instead of the absent slot (D1).
- Adding a `pending` state anywhere (D6).
- Anything that makes `field` remain an open `string`.

An implementer that FILES a renegotiation rather than implementing past a frozen
clause is behaving correctly. It has caught a real defect every time it has
happened here.

## Spec Change Log

1. The first draft named `mcp-source.ts:258` as a second leak site. Measured
   unreachable with a credential (measurement 5) and removed from scope. Kept in
   the record because "fix both formats together" was the right instinct applied
   to the wrong second site.
2. The first draft treated the type shape as an open design choice between four
   candidates. Reading `spec-m8a…:151-153` settled it: the shape was already
   frozen and the implementation deviated. The story is a deviation closure, not
   a design.
3. A reviewer position that the `'id'` arm is dominated by detector false
   positives — and that dropping the id therefore destroys recoverable
   information — was tested against 127 real ids and did not survive (0 flagged,
   controls firing). The position was argued from an INVENTED corpus. Recorded
   because the reasoning was sound and only the data was absent.

## Verification

Executed 2026-09-04. Every row below was RUN, and every clean result carries the
control that makes it a measurement rather than a silence.

### The three exits D5 names, driven through the shipped binary

Coordinator's own driver (`.scratch/verify-m18a.mjs`), with token shapes chosen
DIFFERENT from the implementer's so a clean result is not a rerun of its author's
assumptions. Both a 44-character token and a 39-character control that fits whole
inside any truncation window:

    artifact leaks: []   stdout leaks: []   record: [{"type":"mcp-server","field":"id"}]
    CONTROL benign entry exported: true

The control is what gives the empty arrays meaning: a second, non-credential
entry DID travel, so the artifact is not clean by being empty.

### The read path, which the first implementation left open

The first round closed the WRITE path and left the READ path casting. Reproduced
by the coordinator through `panda import` (`.scratch/verify-b1.mjs`), before the
fix round:

    extra key holds the token   token on STDOUT: true
    the TYPE is the token       token on STDOUT: true   token on STDERR: true
    CONTROL pre-M18.A record    token on STDOUT: false  token on STDERR: false

After the fix round, same driver, same controls:

    extra key holds the token   STDOUT: false  STDERR: false
    the TYPE is the token       STDOUT: false  STDERR: false
    CONTROL pre-M18.A record    STDOUT: false  STDERR: false   (still exit=2, still refused)

`parseBundle` now CONSTRUCTS the record instead of casting the parsed object, and
`type` is checked with `isStoredEntryType` — the same vocabulary predicate the
sibling `entries[]` array in the same document already used twenty lines above.
The defect was one policy for two arrays of one document.

### The derivation, verified by breaking it

`OMITTED_FIELDS` is now the array and `OmittedField` is derived from it. Deleting
a value from the array:

    A. baseline          -> tsc exit 0    [CONTROL: must be 0]
    B. drop 'extensions' -> tsc exit 1    [with the list written twice this was 0]

Before the fix that same deletion gave typecheck 0 and 170 green — and then
`panda export` wrote a bundle `panda import` refused, accusing the user's
document one command after producing it.

### Gate

Node 24.14.1 and Node 26.8.1, the second confirmed by printing `process.version`
from the binary that ran it rather than by assuming the PATH: bytes OK,
typecheck 12/12, lint 0, and the four touched packages green on both —
contracts 147, registry 177, cli 186, environment 126, live suites excluded via
`**/*live.test.ts` (no dot). Then the half `pnpm check` does not run:
`pnpm build` 12/12 and `pnpm proof:consumer-install` 10 passed / 1 skipped.

### What this story cost to learn

1. **D1 was FALSE, and it was the story's own central claim.** The spec said the
   arm having no `id` slot made the leak a compile error. Measured with a control
   — baseline 0, leak line back WITH `id?: never` 1, leak line back WITHOUT it
   **0**. The union alone refused nothing. `readonly id?: never` is what turns
   the guarantee structural. The fifth false spec claim in this project's history
   and the fifth found by EXECUTION rather than by re-reading.
2. **And the comment written to explain the fix was itself over-broad prose.** It
   claimed excess-property checking against a union "admits any property that
   exists on any arm". A reviewer falsified the general sentence: with the
   discriminant as a literal, TypeScript discriminates first and checks per-arm,
   so `{type, id, field: 'id'}` is refused by the loose union too. The conclusion
   survives on the two routes that matter and the general rule does not. **The
   fix for "a guarantee stated in prose" arrived carrying a guarantee stated in
   prose.** Rewritten to the three measured rows and nothing wider.
3. **The `never` had no gate.** Deleting it gave typecheck 0 and 170 green. Now
   pinned with `expectTypeOf`, so the pin's red is a `tsc` red — a runtime suite
   cannot fail on a type that stopped refusing.
4. **Two reviewers contradicted each other and both were partly right.** One
   proved the loose union admits the leak on two routes; the other proved it
   refuses on a third. Neither was wrong about what it ran. The disagreement was
   the finding.
5. **A blast-radius graph does not see a hand-written mirror.**
   `codegraph impact OmittedEntry` returned 10 symbols and missed
   `ImportInstallation.pending`, a restatement of the type one package
   downstream, because a duplicated shape is not an edge. It was the second slot
   the credential could live in. Grep as well as query.
6. **My own verification instrument produced a confident verdict while broken.**
   The first probe ran its typechecker through a shell that could not find it, so
   all three rows returned the same failure and the verdict was computed from
   noise. The baseline control caught it — it had to be 0 and was 1. A
   measurement instrument needs its own control, and this is the second time that
   lesson has been paid for here.
