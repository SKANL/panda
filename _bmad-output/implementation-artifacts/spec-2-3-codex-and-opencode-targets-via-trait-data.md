---
title: 'Codex and OpenCode targets via trait data'
type: 'feature'
created: '2026-08-25'
status: 'done'
review_loop_iteration: 1
baseline_commit: 'bf9052d'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-2-2-projection-engine-with-sentinel-grammar-claude-target.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Only Claude receives projections; Codex and OpenCode users still hand-edit. Adding targets must not require new engine code per executor — format differences are DATA, not branches (FR-8).

**Approach:** A format-trait table driving a generic target factory: `{fileFormat: 'jsonc' | 'toml', ownedRegionStrategy, sentinelVocabulary, defaultPath}`. Two thin trait records — OpenCode (`opencode.json`, JSONC-tolerant root-key splice reusing the Story 2.2 machinery) and Codex (`config.toml`, delimited comment block `# BEGIN panda-managed v1 … # END` replaced wholesale) — prove strategy isolation.

## Boundaries & Constraints

**Always:** both targets satisfy the SAME idempotence + foreign-preservation + malformed-isolation clauses as Story 2.2; adding a target = adding one trait record (+ its owned-region strategy if genuinely new), verified by a test that registers a TRAIT-ONLY stub target without touching existing target code; TOML foreign content preserved byte-for-byte (bytes outside the delimited block untouched; block appended at EOF when absent); OpenCode JSONC parse tolerates comments/trailing commas but output stays byte-preserving via the same surgical splice; grammar version constant shared from contracts; atomic writes everywhere.

**Ask First:** any third target in this story; any change to the Claude target's behavior beyond shared-refactor extraction.

**Never:** no executor adapters (Story 2.5); no liveness hooks injection yet (Story 2.6); no hand-rolled TOML parser — string-level block management only.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Codex first projection | config.toml with user tables/comments | Delimited block appended at EOF; all prior bytes identical | N/A |
| Codex idempotence | Project twice | Byte-identical outputs | N/A |
| OpenCode JSONC | opencode.json WITH comments/trailing commas | Parses fine; splice preserves comments byte-for-byte | N/A |
| Malformed isolation | One target's file corrupt | Only that target fails; sibling succeeds | Coded per-target error |
| Trait-only stub | New trait record, zero new code | Factory produces working target passing suite clauses | N/A |

</frozen-after-approval>

## Code Map

- `packages/projection/src/formats.ts` -- NEW: trait table types + generic region strategies (root-key JSONC splice extracted/shared from 2.2; delimited-block for TOML)
- `packages/projection/src/targets/codex-config.ts`, `targets/opencode-config.ts` -- THIN trait-record definitions
- `packages/contracts/src/projection.ts` -- extend vocabulary only if needed (block marker constants live here)
- `packages/projection/test/` -- goldens per target + trait-only stub test + shared clause suite run across ALL three targets

## Tasks & Acceptance

**Execution:**
- [x] Extract shared jsonc-splice strategy from claude-settings.ts into formats.ts (behavior-neutral refactor, goldens stay green)
- [x] Delimited-block TOML strategy + codex/opencode trait records
- [x] Shared projection clause-suite runner asserting idempotence/preservation/malformed-isolation across all three targets uniformly
- [x] Trait-only stub test -- FR-8 strategy isolation proven

**Acceptance Criteria:**
- Given the trait table modeling format differences, when new targets are added, then no existing target code changes (strategy isolation verified by test)
- Both targets satisfy the same idempotence and foreign-content-preservation clauses as Story 2.2

## Spec Change Log

- **Review, jsonc splice (patch):** `modify()`+`applyEdits()` from jsonc-parser extends its edit range across trailing commas and reformats ADJACENT foreign properties, violating the byte-preservation clause. Replaced with a manual offset-based splice over `parseTree` node positions: present key → replaced exactly within its node span; absent → characters only ADDED at one insertion point. Preservation now holds by construction, not by assertion.
- **Review, verification surface (patch):** the foreign-sentinel assertion could pass while foreign bytes were reformatted. Added `ownedSpan` to `ProjectionMergeOutcome` and a byte-diff clause asserting output = input-prefix + owned region + input-suffix, exercised across all five suite cases.
- **Review, trait validation (patch):** a trait record could declare an incompatible `fileFormat`/`ownedRegionStrategy` pair and silently misbehave. The factory now rejects the mismatch with the coded `PANDA_PROJECTION_TRAITS_INVALID` error.
- **Design Notes escape hatch (accepted):** the TOML delimited-block strategy never parses foreign TOML, so malformed-native isolation is out of scope for codex-config and the TOML stub (`supportsMalformedIsolation: false`). Drift doctor owns anomaly reporting (Story 2.7).

## Design Notes

TOML block strategy (research-backed): JS has no toml_edit equivalent, so we never parse foreign TOML — we manage ONE delimited block at EOF (`# BEGIN panda-managed v1` … `# END panda-managed v1`): absent → append after ensuring trailing newline; present → replace wholesale between markers. Foreign bytes before the block untouched; malformed "TOML" is undetectable without parsing and OUT OF SCOPE for this strategy (documented; drift doctor owns anomaly reporting later). OpenCode JSONC: identical splice path as Claude but WITHOUT the strict-JSON guard (comments/trailing commas legal).

## Verification

**Commands:**
- `pnpm check` -- expected: fully green
