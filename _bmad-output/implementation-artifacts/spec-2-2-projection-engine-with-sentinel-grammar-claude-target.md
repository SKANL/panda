---
title: 'Projection engine with sentinel grammar — Claude target'
type: 'feature'
created: '2026-08-25'
status: 'in-progress'
review_loop_iteration: 0
baseline_commit: '395d12346ea359519045ee34b16ff7ae796a32e1'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-2-1-registry-core-with-machine-scoped-serialization.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Shared tools/skills/MCP servers live in the Registry but never reach the executors' native configs — users hand-edit each CLI separately, and nothing marks which config regions panda owns.

**Approach:** Projection engine (`@skanl/panda-projection`) that renders Registry entries into a target's native config through per-target `ProjectionTarget` strategies. Claude Code settings.json is the first target: strict JSON, so ownership is a reserved root subtree (`"panda"` key) spliced with surgical text edits (jsonc-parser modify+applyEdits) — foreign bytes untouched by construction, idempotent because the owned subtree serializes deterministically.

## Boundaries & Constraints

**Always:** projecting twice yields BYTE-IDENTICAL output; foreign content (everything outside the owned subtree) preserved byte-for-byte incl. formatting/key order/whitespace; malformed native file fails ONLY that target with a typed per-target error; sentinel grammar (versioned, namespaced) defined in `@skanl/panda-contracts` and consumed here; unknown/legacy panda markers in a native file classify as Drift entries in the result — reported, never silently overwritten; projection writes go through atomic temp+rename; new runtime deps allowed ONLY in `@skanl/panda-projection` (kernel/contracts stay clean).

**Ask First:** any additional target beyond Claude in this story; writing to files outside the discovered config locations.

**Never:** no Codex/OpenCode targets (Story 2.3); no doctor/drift commands (Story 2.7); no whole-file re-serialization of native configs; no schema validation of foreign content.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| First projection | Native settings.json without panda key, containing user content | Owned subtree appended; all foreign bytes identical | N/A |
| Idempotence | Project the same registry twice | Second output byte-identical to first | N/A |
| Foreign preservation | User file with unusual formatting/order/comments* (*JSONC targets) | Everything outside `"panda"` byte-identical before/after | N/A |
| Malformed native | Target file fails JSON parse | That target fails with typed error naming file+cause; other state untouched | Coded per-target error |
| Legacy marker | File contains panda-owned shape from older/unknown grammar version | Classified as Drift in result; not silently overwritten | Typed drift entry |
| Empty registry | Registry has zero matching entries | Projection still runs: owned subtree written explicitly empty | N/A |

</frozen-after-approval>

## Code Map

- `packages/contracts/src/projection.ts` -- NEW: `ProjectionTarget` port (format-specific merge behind interface), sentinel grammar vocabulary (version constant, owned-subtree shape), drift classification types
- `packages/projection/` -- NEW package `@skanl/panda-projection` (runtime dep: `jsonc-parser`): engine orchestrating targets, Claude settings.json target implementing surgical splice, atomic write path
- `packages/projection/test/` -- golden-file suites: idempotence, preservation, malformed isolation, legacy-marker drift
- Root scaffold -- workspace glob covers new package

## Tasks & Acceptance

**Execution:**
- [ ] `packages/contracts/src/projection.ts` (+parity if codes added) -- target port + grammar vocabulary + drift types -- AD-9 contract home
- [ ] `packages/projection/src/engine.ts` -- orchestrate targets against registry entries, collect per-target results -- FR-12 core
- [ ] `packages/projection/src/targets/claude-settings.ts` -- jsonc-parser surgical splice under reserved root key -- the story's core deliverable
- [ ] tests + goldens -- lock every matrix row incl. byte-level comparisons -- regression protection for 2.3+

**Acceptance Criteria:**
- Given a native Claude settings file with non-panda content, when projection runs twice, then outputs are byte-identical and foreign content is preserved byte-for-byte
- Given the projected section, then it carries the versioned namespaced sentinel from @skanl/panda-contracts
- Given a malformed native file, then only that target fails with a per-target typed error
- Given a native file with legacy/unknown panda markers, then they classify as Drift entries without silent overwrite

## Spec Change Log

## Design Notes

Research-backed decisions (Aug 2026 evidence): Claude settings.json is STRICT JSON (official docs: comments/trailing commas are startup errors; JSONC request closed as dup). OpenCode supports JSONC; Codex uses TOML (their stories own their formats). Therefore: JSON-family strategy = single reserved root key `"panda": {"version": <grammar-version>, ...owned}`; splice via jsonc-parser `modify(content, ['panda'], value)` + `applyEdits` → exactly one edit region, foreign bytes preserved by construction, deterministic serialization → idempotence. TOML strategy (2.3) = delimited comment block `# BEGIN panda-managed v1` … `# END`, replaced wholesale between markers.

Drift classification: any panda-shaped content NOT matching current grammar version/shape (e.g., old version number, unexpected owned-key layout) is surfaced as a drift entry in the result; the engine never rewrites regions it cannot classify.

Atomicity: every target file write = temp+rename in the same directory (same discipline as Registry store).

## Verification

**Commands:**
- `pnpm check` -- expected: fully green
- Byte-comparison goldens live in packages/projection/test/goldens/ -- expected: committed and stable across runs
