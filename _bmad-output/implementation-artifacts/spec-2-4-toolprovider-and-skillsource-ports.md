---
title: 'ToolProvider and SkillSource ports'
type: 'feature'
created: '2026-08-25'
status: 'done'
review_loop_iteration: 1
baseline_commit: 'c0e22ff'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-2-1-registry-core-with-machine-scoped-serialization.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-2-3-codex-and-opencode-targets-via-trait-data.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Today the only way into the Registry is `RegistryStore.register()` called by hand. A plugin that wants to contribute a catalog of tools, or mirror a directory of skills, has no supported seam — it must drive the store imperatively and re-derive change detection itself. FR-13b/FR-13c require two ports so third parties extend the catalog without touching the engine.

**Approach:** Two provider-side interfaces in `@panda/contracts` (`ToolProvider`, `SkillSource`) plus ONE ingestion function in `@panda/registry` that drives them. Ingestion is **two-phase**: collect and validate every contribution from every origin FIRST, then write. A schema-invalid definition therefore fails before any store mutation exists to roll back — nothing is registered, so nothing is projected. `SkillSource` contributions carry a `contentHash`; ingestion compares it against the hash recorded on the stored entry and re-registers only when it changed, so unchanged sources produce no store write and therefore a byte-identical projection.

## Boundaries & Constraints

**Always:** provider contributions validate against the canonical `RegistryEntry` envelope (`validateRegistryEntry`) before anything is written, plus the origin's own optional Standard Schema v1 when it declares one; every rejection is a coded `PandaError` naming the origin AND the offending entry id; each origin may only contribute its own entry types (`ToolProvider` → `tool` | `mcp-server`, `SkillSource` → `skill`); source-tracking state (`sourceId`, `contentHash`) lives under the reserved `extensions` namespace so the entry envelope needs no new root field and the hash never reaches a projected file; an empty-but-valid origin yields a typed warning in the ingest outcome, never an error and never silent success; two origins contributing the same type+id is a coded error naming both, never last-write-wins.

**Ask First:** wiring ingest warnings onto the kernel event bus (returning them in the outcome is the contract for this story); any provider-driven REMOVAL of entries an origin stopped contributing (the reconciliation/pruning semantics are their own decision).

**Never:** no new package; no projection changes — ingestion ends at the Registry and the existing engine projects whatever is there; no executor adapters (Story 2.5); no hashing algorithm owned by panda — the origin supplies `contentHash` as an opaque string, panda only compares it.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Schema-invalid tool definition | ToolProvider yields an entry failing the envelope (or its own declared schema) | NOTHING is registered from ANY origin in the run; store unchanged | Coded error naming origin + entry id |
| Wrong type for the port | SkillSource yields a `tool` entry | Rejected in the validate phase | Coded error naming origin + entry id |
| Changed skill source | Stored entry hash `h1`, source now reports `h2` | Entry re-registered; next projection writes the new bytes | N/A |
| Unchanged skill source | Stored hash equals reported hash | No store write; reported as `unchanged`; projection stays byte-identical | N/A |
| Empty-but-valid source | SkillSource yields zero skills | Typed `empty-source` warning in the outcome; run succeeds | N/A |
| Id collision across origins | Two origins contribute `skill:commit-lint` | Rejected in the validate phase, both origins named | Coded error |
| Origin throws while listing | `list()` rejects | Ingest fails coded, wrapping the cause; store unchanged | Coded error naming origin |

</frozen-after-approval>

## Code Map

- `packages/contracts/src/providers.ts` -- NEW: `ToolProvider`, `SkillSource`, `SourcedSkill`, `IngestWarning`, `IngestOutcome`, and the reserved `PANDA_SOURCE_EXTENSION_KEY` constant
- `packages/contracts/src/index.ts` -- re-export the new port surface
- `packages/contracts/src/errors.ts` -- NEW codes: `registryProviderRejected`, `registryOriginConflict`
- `packages/registry/src/ingest.ts` -- NEW: `ingestProviders(store, {toolProviders, skillSources})`, the two-phase driver
- `packages/registry/src/index.ts` -- export `ingestProviders`
- `packages/registry/test/ingest.test.ts` -- NEW: the matrix above, using in-memory fake origins
- `packages/projection/test/` -- one end-to-end assertion that an unchanged source re-projects byte-identically (reuses the existing engine, adds no projection code)

## Tasks & Acceptance

**Execution:**
- [x] Port interfaces + source-extension vocabulary in contracts (zero runtime deps preserved)
- [x] Two-phase `ingestProviders`: collect → validate ALL → write; coded rejection before any mutation
- [x] Content-hash change detection through the reserved `extensions` namespace; unchanged origins skip the write
- [x] Typed `empty-source` warning surfaced in the outcome
- [x] Tests covering every row of the I/O matrix + the byte-identical re-projection clause

**Acceptance Criteria:**
- Given a ToolProvider registering a schema-invalid tool definition, when registration is attempted, then it is rejected with a coded error and nothing is projected
- A modified source skill re-projects while unchanged sources remain byte-identical
- An empty-but-valid SkillSource yields a typed warning, not silent success

## Spec Change Log

- **Review, scope correctness (patch):** change detection read the store's MERGED view (agent > project > global) while the write targeted one scope, so an entry shadowing from another scope could suppress the target-scope write silently and permanently. `RegistryStore.get` gained an optional scope argument that reads exactly one scope with no fallthrough; ingest now compares at the scope it writes to. The unrequested `scope` option was DELETED — the port contract says nothing about scopes and the knob only widened the hazard; ingestion is global-only (`INGEST_SCOPE`).
- **Review, cross-run ownership (patch):** the "never last-write-wins" boundary only held WITHIN a run. `sourceId` is now stamped on both ports (`contentHash` optional in `SourceTracking`), and a stored entry owned by a different origin — or by nobody, i.e. hand-registered — is a coded `registryOriginConflict` instead of a silent overwrite. An equal-hash handover is a conflict too: reporting it `unchanged` would keep the previous origin's entry on disk forever. A contribution arriving with the reserved `extensions` key already set is rejected, without which the ownership check would be forgeable.
- **Review, two-phase honesty (patch):** the doc blocks claimed a failed run leaves the store exactly as it was. True for VALIDATION rejections only — phase 2 is N lock-protected writes and `store.register` throws routinely (contention, EPERM on the Windows rename retry, inactive store). Comments corrected, and a phase-2 failure now throws `IngestWriteFailure` carrying the partial outcome (keys already registered plus the collected warnings) instead of discarding it. Deliberately NO rollback: a compensating `remove()` loop runs against the same failing store and turns one partial write into an unbounded mess.
- **Review, unprojectable ids (patch, crosses a package boundary):** an id like `__proto__` passed the envelope, persisted, and from then on made EVERY projection target fail with no way to remove it through a provider. Fixed where all callers route through — `UNPROJECTABLE_ENTRY_IDS` moved into contracts and enforced inside `registryEntryIssues`; `owned-subtree.ts` imports the shared set and keeps its own check as defense in depth. Consequence accepted and pinned by a contracts-level test: the store's read-time envelope validation now rejects such an entry too, so a store already holding one fails loudly on `get`/`list` rather than breaking every projection target.
- **Review, untrusted-origin hardening (patch):** origins are third-party code. The declared `entrySchema` is version-checked and its `validate()` wrapped so a throwing schema still fails coded; an empty issues array yields a legible rejection; `result.value` stays deliberately ignored (adopting it would let an origin rewrite the entry after envelope validation — documented on the port). The listed array is snapshotted and each candidate deep-copied before validation, closing the window where a provider mutates an entry between validation and write.
- **Ask First, unchanged:** warnings still travel in the outcome only (no kernel event bus), and ingestion stays additive — pruning of withdrawn entries is out of scope and tracked in deferred-work.

## Design Notes

**Why two-phase instead of per-entry rejection.** "Rejected AND nothing is projected" is only honest if the store never saw a partial write. Validating everything before touching the store makes that true by construction — there is no rollback path to get wrong, which matters because `RegistryStore.register()` is lock-protected and per-entry, so a mid-run failure would otherwise leave a half-ingested catalog on disk.

**Why `extensions` carries the hash.** The entry envelope deliberately rejects unknown root keys and reserves `extensions` for provider payloads; the projection renderer reads only known fields. Recording `{sourceId, contentHash}` there means no envelope change, no new persistence, and no chance of the hash leaking into a projected executor config. Write-time path normalization only touches the declared path fields, so the payload survives the round trip verbatim.

**Hash is opaque.** The origin knows what "changed" means for its medium (file mtime+size, git blob sha, HTTP ETag). panda compares strings and nothing else.

## Verification

**Commands:**
- `pnpm check` -- expected: fully green
