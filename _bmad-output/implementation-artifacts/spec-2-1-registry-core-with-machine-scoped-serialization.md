---
title: 'Registry core with machine-scoped serialization'
type: 'feature'
created: '2026-08-24'
status: 'in-progress'
review_loop_iteration: 0
baseline_commit: '370d8dd46ea359519045ee34b16ff7ae796a32e1'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-1-4-executoradapter-port-with-contract-test-harness.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** There is no single source of truth for the environment: tools, skills, MCP servers, and profiles have nowhere canonical to live, and nothing prevents two panda processes from silently clobbering each other's writes.

**Approach:** Canonical entry envelopes in `@skanl/panda-contracts` (tool | skill | mcp-server | profile) plus a Registry service mounted as the first REAL kernel plugin: scoped storage (global | project | agent), machine-scoped write serialization via a portable lockfile protocol, atomic persistence, and typed contention errors naming the holder.

## Boundaries & Constraints

**Always:** entry validation happens against canonical envelopes BEFORE any write; provider-specific payloads accepted ONLY under the reserved `extensions` namespace; every persistent mutation flows through the Registry's serialized API (AD-4); writes are atomic (temp+rename) and normalize machine-specific absolute paths at write time (NFR-6 — no raw absolute paths persisted); concurrent writers across PROCESSES get a typed contention error naming the holder (never lost updates, never silent merge); stale locks (holder process provably dead) are broken safely with the evidence recorded; the service mounts through the kernel lifecycle from Story 1.2 (activation/disposal honored). New codes join contracts canonically + parity pins.

**Ask First:** any networked/remote registry; changing the on-disk store location conventions once stated in Design Notes.

**Never:** no projection logic (Stories 2.2+); no CLI commands (Story 2.7); no schema versioning/migration machinery beyond a `version` field stamped on the store (v1 only); no locking library dependency — hand-rolled portable protocol.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Happy register | Valid tool entry at global scope | Persisted atomically; readable after reload | N/A |
| Invalid envelope | Entry missing required fields / bad shape | Rejected pre-write with coded error naming the field | Coded error |
| Provider payload outside extensions | Custom keys at entry root | Rejected naming the extensions namespace rule | Coded error |
| Contention | Second process holds the lock | Typed contention error naming holder (pid@host) | Coded error |
| Stale lock | Lockfile exists, holder pid is dead | Lock broken safely; break recorded in log/result | N/A |
| Path normalization | Entry carries absolute path under home dir | Stored normalized (no machine-specific absolute path on disk) | N/A |

</frozen-after-approval>

## Code Map

- `packages/contracts/src/registry.ts` -- NEW: entry envelopes (tool/skill/mcp-server/profile), scope vocabulary, Standard Schema definitions, extensions-namespace rule
- `packages/contracts/src/errors.ts` -- codes (`PANDA_REGISTRY_*`: INVALID_ENTRY, CONTENTION, ...) + parity pins
- `packages/registry/` -- NEW package `@skanl/panda-registry`: store layout, lockfile protocol, serialized mutation API, kernel plugin manifest wiring (first real plugin on the Story 1.2 lifecycle)
- `packages/registry/test/` -- suites incl. multi-process contention test (spawn child script taking the lock)
- Root scaffold -- new package wired (glob covers it)

## Tasks & Acceptance

**Execution:**
- [ ] `packages/contracts/src/registry.ts` -- canonical envelopes + scopes -- FR-11/AD-4 contract surface
- [ ] `packages/contracts/src/errors.ts` (+parity) -- registry codes -- stable failure identities
- [ ] `packages/registry/src/lock.ts` -- portable lockfile protocol (O_EXCL, holder metadata, stale detection) -- machine-scoped serialization core
- [ ] `packages/registry/src/store.ts` + plugin mount -- scoped stores, atomic writes, path normalization, kernel lifecycle integration -- the story's core deliverable
- [ ] tests -- matrix rows incl. real cross-process contention -- regression protection

**Acceptance Criteria:**
- Given any entry registered, then it validates against the canonical envelope and rejects invalid payloads with coded errors
- Given provider-specific payloads outside `extensions`, then registration rejects naming the rule
- Given two concurrent panda processes writing the Registry, then the loser gets a typed contention error naming the holder — never a lost update
- Given a stale lock from a dead process, then the next writer breaks it safely and records the evidence
- Given the kernel starts/stops, then the Registry activates/disposes through the normal plugin lifecycle

## Spec Change Log

| 2026-08-24 | Review-sanctioned corrections: path normalization is restricted to a declared per-entry-type path-field allowlist with a `~~` literal-tilde escape (known-bad avoided: identity mangling of ids/extensions payloads and a lossy tilde round-trip); the read path now validates the store version AND every entry envelope so hand-edited documents never flow out; dispose() serializes against in-flight mutations instead of racing them; register() returns nothing (storage-time transformation invisible to callers). KEEP: lockfile protocol shape (O_EXCL + holder metadata + same-host ESRCH staleness + cross-host immunity) is correct and must survive re-derivation. | Normalization mangling, unvalidated reads, dispose race, leaky API |

## Design Notes

Store layout (v1): global `<home>/.panda/registry.json`; project `<project>/.panda/registry.json`; agent-scope entries overlay in-memory within a kernel session (persistence of agent scope arrives when a consumer needs it — not speculative). Scope precedence: agent > project > global at read time.

Lockfile protocol: `<store>.lock` created with O_EXCL containing JSON `{pid, host, acquiredAt}`; contenders poll with bounded timeout then fail with CONTENTION naming holder; staleness = pid provably dead ON THE SAME HOST recorded in the lockfile. All mutations take the lock, read-modify-write, atomic rename, release.

Path normalization: absolute paths under the user home are stored with a `~/` prefix marker at WRITE time; other absolute paths are stored as-is (documented) — machine-specific leakage is the home case that matters.

## Verification

**Commands:**
- `pnpm -r typecheck` -- expected: zero errors
- `pnpm test` -- expected: all suites green incl. cross-process contention
- `pnpm lint` -- expected: zero warnings
