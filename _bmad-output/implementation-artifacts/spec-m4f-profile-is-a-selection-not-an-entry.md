# M4.F — `profile` is a selection, not an entry

Status: FROZEN after approval. Changes go in the Spec Change Log, never silently.

## Intent

M4.E retired `tool` and deliberately left `profile`, recording that the evidence
could not settle it. It can now, and not from more executor research — from
panda's own PRD, which defines the word:

> **Profile** — a named, versioned bundle of **Registry selections** (which
> Tools/Skills/MCP servers are active, for whom, and per-executor model/effort
> selections **where targets support native selection**) that can be exported,
> imported, and swapped as a unit. **Bundles carry one or more Profiles.**

That settles three things M4.E left open:

1. **A Profile is not a peer of `skill` and `mcp-server`. It is a selection OVER
   them** — a container, not a leaf. Modelling it as a flat `RegistryEntryType`
   is a category error, and the symptom was already visible:
   `REGISTRY_PATH_FIELDS.profile` is `[]` because a container has no leaf fields
   to carry.
2. **FR-21's "Registry+Profiles+SkillSources" lists three things because there
   are three things.** M4.E flagged that phrasing as an unresolved ambiguity and
   refused to act on it; the glossary resolves it in the direction M4.E
   suspected.
3. **The PRD had already anticipated the executor research.** "per-executor
   model/effort selections *where targets support native selection*" is exactly
   the finding that two of three executors expose only a singleton scalar
   `model`. The clause is the escape hatch, not an oversight.

**"Bundles carry one or more Profiles", and Bundles are Epic 5.** Designing
Profile now would be designing the contained before the container. So `profile`
is retired here and returns designed in Epic 5, where the PRD puts it.

After this, `REGISTRY_ENTRY_TYPES` is `skill` and `mcp-server`: exactly the two
the projection layer delivers, and exactly the two target kinds panda ships.

## The measurement this rests on

`'profile'` appears in **one** file across all of `packages/*/src` — the type
declaration itself (`contracts/src/registry.ts:14` and `:19`). Nothing branches
on it, nothing special-cases it.

Controlled, because a clean zero is how a broken query looks: the identical
search for `'skill'` returns **three** files with real special handling
(`init.ts`'s `skillsHandled`, `ingest.ts`'s `SKILL_SOURCE_TYPES`). The zero is
an absence, not a missed query.

That smallness is the payoff of M4.E's derivation work: every consumer already
reads `REGISTRY_ENTRY_TYPES` rather than spelling the members.

## The spine — the SECOND retirement is what proves the machinery

M4.E built retirement for one word. A mechanism exercised once is a mechanism
that happens to work; the second member is what shows it generalises. Two
specific hazards its own review recorded, both now live:

- **`RETIRED_PATH_FIELDS` field names must be members of `KNOWN_ROOT_KEYS`,** or
  the unknown-root-key rule rejects the entry and the WHOLE store becomes
  unreadable — the M4.C dead end inside the mechanism built to abolish it. M4.E
  derived `KNOWN_ROOT_KEYS` from the union to close this. `profile`'s field list
  is `[]`, so this retirement is trivially safe **and therefore proves nothing on
  its own** — the derivation must be verified directly, not inferred from a green
  suite.
- **`RETIRED_PATH_FIELDS` is a permanent ratchet** (recorded in the deferred
  ledger). A second entry is the first time that ratchet carries weight.

## Boundaries & Constraints

- Do NOT design what a Profile is, do not add a Profile contract, do not touch
  Bundles. That is Epic 5's work and this story exists to stop pre-empting it.
- Reuse M4.E's retirement machinery exactly. If retiring a second word needs any
  new mechanism, that is a finding about M4.E, not a licence to build one — see
  Ask First.
- Kernel stays zero-dependency and never imports `@panda/contracts` (AD-1).
- Relative imports carry `.ts`.

## I/O & Edge-Case Matrix

| # | Input | Expected |
|---|---|---|
| 1 | `panda add profile p` | Refused as a RETIRED type, naming the remaining types; nothing persisted |
| 2 | `--help` | Neither type list offers `profile` for `add`; `remove` offers it alongside `tool` |
| 3 | A registry holding BOTH a `tool` and a `profile` entry | Readable; `panda list` shows both; `panda doctor` reports two `retired-type` findings |
| 4 | Each finding's printed command, run verbatim | Clears that finding and leaves the other entry untouched |
| 5 | A `profile` entry at project scope, seen by `panda project doctor` | The project spelling, and it delivers (M4.E's scope fix, now with a second type) |
| 6 | `ingestProviders` supplying a `profile` entry | Rejected coded at ingest, before any write |
| 7 | A registry with neither retired type | Byte-identical behaviour to before this story |

## Code Map

- `packages/contracts/src/registry.ts` — `RegistryEntryType`, `REGISTRY_ENTRY_TYPES`, `RETIRED_ENTRY_TYPES`, `RETIRED_PATH_FIELDS`, and the `KNOWN_ROOT_KEYS` derivation.
- Everything else should follow with no edit. **Any file that needs a hand edit is a finding** — it means M4.E left a duplicate that survived its own review.

## Tasks & Acceptance

**T1 — retire `profile`.** AC: matrix rows 1, 2, 6, 7.

**T2 — two retired types coexist.** AC: rows 3, 4, 5. The interesting case is a
registry holding both, at both scopes, so the per-entry command and per-entry
`filePath` M4.E introduced are exercised by more than one row.

**T3 — verify the `KNOWN_ROOT_KEYS` derivation DIRECTLY, not through this
retirement.** `profile` carries no fields, so a green suite here says nothing
about the hazard. **Falsification:** temporarily give the retired `profile` a
path field that is NOT in the live vocabulary, show the store still reads it,
capture that verbatim, and restore. If it does not read, the derivation is
broken and the next retirement would brick every store holding one — report it
rather than working around it.

**T4 — report what did NOT need editing.** List every file you expected to touch
and did not. That list is the measurement of whether M4.E's derivation held, and
it is the deliverable this story exists to produce. A story that quietly edits
six files has found a defect and should say so.

**Ask First (frozen):** if retiring a second word requires ANY new mechanism —
a special case, a second table, a branch on which retired type it is — STOP and
report. That would mean M4.E's machinery was fitted to one member, and the right
answer is a finding against M4.E, not an extension here.

## Spec Change Log

(empty at freeze)

## Design Notes

Recorded so Epic 5 starts from it: the glossary defines a Profile as carrying
"per-executor model/effort selections where targets support native selection".
The verified native surfaces are `model` at the root of `~/.codex/config.toml`,
`~/.claude/settings.json` and `opencode.json` — all three SINGLETON SCALARS —
plus **codex profile v2**, which IS id-keyed by filename
(`$CODEX_HOME/<id>.config.toml`, layered via `-p, --profile
<CONFIG_PROFILE_V2>`), owned whole rather than merged. When Profiles return,
that asymmetry is the design problem, and "where targets support" is the PRD's
own permission to solve it unevenly.

## Verification

**T1/T2 — the change.** One source file: `packages/contracts/src/registry.ts`.
`RegistryEntryType` is `'skill' | 'mcp-server'`, `REGISTRY_ENTRY_TYPES` holds
those two, `REGISTRY_PATH_FIELDS.profile` is gone and `RETIRED_PATH_FIELDS`
gained `profile: []`. No new mechanism, no special case, no branch on which
retired word — the Ask-First clause was not reached.

Matrix, live through `node --conditions=panda-source packages/cli/bin/panda.ts`
against a throwaway `HOME`:

| # | Result |
|---|---|
| 1 | `panda add profile p` → exit 2, `'profile' is a RETIRED entry type; panda has skill, mcp-server. An existing 'profile' entry is still listed by \`panda list\` and removed by \`panda remove profile <id>\``; no registry written |
| 2 | `--help` → `panda add <skill\|mcp-server>` / `panda remove <skill\|mcp-server\|tool\|profile>` |
| 3 | A store holding `tool:rg` + `profile:frontend` + `skill:demo` reads; `panda list` shows all three; `panda doctor` reports TWO `retired-type` problems, each naming its own entry |
| 4 | `panda remove tool rg` then `panda remove profile frontend`, both verbatim from the findings → exit 0 each, each clears only its own entry, `skill:demo` survives |
| 5 | `panda project doctor <dir>` over a project-scope `profile:local` → the PROJECT spelling, `To leave this state: \`panda project remove profile local\``; run verbatim → exit 0, entry gone |
| 6 | `ingestProviders` with a `profile` entry → `PANDA_REGISTRY_PROVIDER_REJECTED`, store untouched (`packages/registry/test/ingest.test.ts`, now derived over both retired words) |
| 7 | Every suite that holds neither retired type is unchanged and green |

**T3 — the `KNOWN_ROOT_KEYS` derivation, verified DIRECTLY.** With
`RETIRED_PATH_FIELDS.profile` temporarily set to `['selection']` — a field name
no live type declares — a store holding
`{"type":"profile","id":"frontend","selection":"~/selections/frontend.json"}`
beside a `tool` and a `skill` READS: `panda list` exits 0 and prints all three,
`panda doctor` exits 1 with two `retired-type` findings and no
`registry-unreadable`. The `~/` marker even round-trips, because `pathFieldsFor`
answers for the retired type. Two controls, so the pass is not leniency:

- same mutation, entry given an extra `model` key →
  `PANDA_REGISTRY_STORE_UNAVAILABLE: ... 'model' is not allowed at the entry
  root`, exit 2. Unknown root keys still fail the whole store.
- mutation reverted to `profile: []`, the same `selection` entry →
  `PANDA_REGISTRY_STORE_UNAVAILABLE: ... 'selection' is not allowed at the entry
  root`, exit 2. So the pass above came from `RETIRED_PATH_FIELDS` flowing into
  `KNOWN_ROOT_KEYS` and from nothing else.

The derivation holds; the next retirement will not brick a store. Restored, and
a derived permanent assertion was added in
`packages/contracts/test/registry.test.ts` ("keeps every field a retired type
carried a KNOWN root key") so it stays measured.

**T4 — what did NOT need editing.** Every file below reads the vocabulary and
followed with no hand edit; M4.E's derivation held:

`packages/projection/src/engine.ts` (`groupByKind`, `isRegistryEntryType`),
`packages/projection/src/formats.ts` (`REGISTRY_ENTRY_TYPES.filter(...)`),
`packages/contracts/src/projection.ts` (`RegistryEntriesByKind`),
`packages/contracts/src/index.ts`, `packages/registry/src/store.ts`,
`packages/registry/src/ingest.ts`, `packages/cli/src/registry-commands.ts`,
`packages/cli/src/run.ts` (the synopsis), `packages/environment/src/init.ts`,
`packages/environment/src/index.ts`, `packages/environment/src/executors.ts`,
`packages/environment/src/remediate.ts`.

Three files outside contracts were touched, all COMMENT-ONLY, no behaviour:
`packages/environment/src/doctor.ts` (two comments justified `unprojectable`'s
`info` severity by naming `profile` and `tool`, both now retired — the second
was already stale from M4.E), and `packages/projection/src/formats.ts` (a
docstring listing "tools, skills, profiles"). Three package READMEs likewise.
No duplicate table survived M4.E's review; the measurement this story exists to
produce is that result.

**Gate.** `node scripts/check-source-bytes.mjs`, `pnpm typecheck` and
`pnpm lint` clean. `pnpm check` aborts at `@panda/adapter-cli`, whose live
opencode rows fail on a reproducible provider refusal (HTTP 403
`DataPolicyError`, opt-in required) unrelated to this change — ledgered. Every
other package run individually: kernel 217, contracts 65, registry 68,
workspace-local 23, projection 248 (+3 skipped), session 89, environment 100,
cli 108 — all passing on Node 24.14.1 and again on Node 26.8.1.
