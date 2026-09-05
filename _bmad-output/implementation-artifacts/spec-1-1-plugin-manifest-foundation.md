---
title: 'Plugin manifest foundation'
type: 'feature'
created: '2026-08-24'
status: 'done'
review_loop_iteration: 0
baseline_commit: '56acbeacf5355a0dff7f464152a65acd5ffbf269'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** panda has no runnable foundation: integration failures between plugins currently have no load-time surface because neither the monorepo nor the plugin manifest machinery exists. Without eager manifest validation, misconfigured plugins would only fail mid-run.

**Approach:** Bootstrap a pnpm 11 monorepo with exactly two packages (`@skanl/panda-kernel`, `@skanl/panda-contracts`) and implement the declarative plugin manifest: eager, I/O-free validation, service-graph resolution with hard/soft consumption, and cycle rejection naming both sides.

## Boundaries & Constraints

**Always:** `@skanl/panda-kernel` has zero runtime dependencies and never imports `@skanl/panda-contracts` or implementations (AD-1/AD-2). Manifest validation runs eagerly and synchronously before any file/network/process I/O (FR-1). Every failure raises an error carrying a stable `PANDA_<DOMAIN>_<REASON>` code string (AD-7). Schema-facing surfaces use Standard Schema v1 interfaces; Zod 4 may appear only inside implementation/test internals. Stack: TypeScript 7.0.x compiler (`@typescript/typescript6` alias for ESLint tooling), Node >=24, pnpm 11, Vitest 4, ESLint 10.

**Ask First:** creating any Structural Seed package beyond kernel/contracts; adding any runtime dependency to `@skanl/panda-kernel`; changing the declared package topology or error-code convention.

**Never:** no disposal lifecycle, ordering, double-dispose, or swap logic (Story 1.2); no event bus or layered config (Story 1.3); no ExecutorAdapter/workspace/contract-harness work (Story 1.4); no CLI package; no empty placeholder packages "for later".

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Happy path | Plugin A provides svc; plugin B hard-consumes svc; both loaded | B reaches ready state after resolution | N/A |
| Missing required field | Manifest lacking id, version, provides, consumes, or configSchema shape | Load fails synchronously with coded error naming the field | Coded error, nothing loaded |
| Dependency cycle | A hard-consumes what B provides and vice versa | Resolution rejected naming BOTH plugin ids in message/code payload | Single typed cycle error |
| Hard-consumed absent | B hard-consumes svc; no provider registered | B never becomes ready; typed error naming the missing service | Coded not-provided error |
| Soft-consumed absent | B soft-consumes svc; no provider | Declaration accepted; resolution yields typed-absent value (use-site raising deferred to Story 1.2 semantics) | Typed-absent value, not undefined |

</frozen-after-approval>

## Code Map

Greenfield — no existing source. Planning inputs:

- `_bmad-output/implementation-artifacts/epic-1-context.md` -- distilled Epic 1 constraints; primary context
- `_bmad-output/planning-artifacts/architecture/architecture-panda-2026-08-24/ARCHITECTURE-SPINE.md` -- AD-1..AD-10, conventions table, stack row; consult, don't copy
- `.scratch/references/` -- READ-ONLY legacy/reference repos; never copy code from them

Target layout to create:

- `pnpm-workspace.yaml`, root `package.json`, `tsconfig.base.json`, `.gitignore` -- monorepo bootstrap
- `eslint.config.js` (root) -- flat config wired through `@typescript/typescript6` alias (TS 7 incompatible with current ESLint TypeScript API)
- per-package `vitest run` scripts (root `pnpm -r test`) -- Vitest 4 test strategy (workspace file dropped in review: defineWorkspace was removed in Vitest 4 and nothing loaded it)
- `packages/contracts/src/errors.ts` -- `PandaError` base + canonical `PANDA_*` code constants (kernel-independent, zero deps)
- `packages/kernel/src/manifest.ts` -- manifest type + Standard Schema v1 validation interface
- `packages/kernel/src/loader.ts` -- eager validate -> resolve service graph -> cycle check (both names) -> readiness gate on hard consumption
- `packages/kernel/src/errors.ts` -- kernel-local coded error, STRUCTURALLY compatible with contracts' hierarchy (same `code` string field); no import relationship
- `packages/*/test/` -- Vitest suites incl. a zero-dependency guard test for kernel

## Tasks & Acceptance

**Execution:**
- [x] Root scaffold (`package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.config.js`, `.gitignore`) -- bootstrap per stack decisions -- everything else mounts on this
- [x] `packages/contracts` (`package.json`, `src/errors.ts`, `src/index.ts`) -- canonical error-code home per AD-7 -- all later packages assert against these literals
- [x] `packages/kernel` (`src/manifest.ts`, `src/loader.ts`, `src/errors.ts`, `src/index.ts`) -- manifest model + loader per FR-1/AD-5 -- the story's core deliverable
- [x] `packages/kernel/test/*.test.ts` + `packages/contracts/test/*.test.ts` -- lock I/O matrix rows + kernel zero-dep/import guard -- regression protection for Stories 1.2-1.3

**Acceptance Criteria:**
- Given a manifest declaring one provided service and one hard-consumed service with the consumed service available, when the kernel loads both plugins, then the consuming plugin reaches ready state
- Given a manifest missing required fields, when load is attempted, then it fails with a coded error before any I/O occurs
- Given two plugins whose consumptions form a cycle, when the kernel resolves the graph, then rejection names both plugin ids
- Given a hard-consumed service with no provider, when loading completes, then the plugin is not ready and a typed error names the service
- Given `@skanl/panda-kernel`, when inspected, then its `package.json` declares zero runtime dependencies and its sources contain no `@skanl/panda-contracts` import (enforced by test)

## Spec Change Log

- 2026-08-24 (code review round): Sanctioned extension of the error vocabulary with `PANDA_KERNEL_SERVICE_CONFLICT` (duplicate providers of one service) beyond the three suggested codes. Silent last-wins provider resolution was rejected: an ambiguous injection must fail loudly at load, not hide behind an arbitrary pick. KEEP: the kernel emits stable literal code strings, pinned by the contracts-side parity suite so any drift between kernel literals and canonical constants fails CI rather than violating AD-1.

## Design Notes

Error-model boundary: AD-1 forbids kernel importing contracts, AD-7 wants one shared code vocabulary. Resolution: kernel defines a minimal coded-error TYPE (string `code` field) and emits stable literal codes; `@skanl/panda-contracts` publishes the canonical constants; a contracts-side test asserts the expected kernel code literals verbatim, making drift a test failure rather than an import. Suggested prefixes: `PANDA_KERNEL_MANIFEST_INVALID`, `PANDA_KERNEL_CYCLE_DETECTED`, `PANDA_KERNEL_SERVICE_NOT_PROVIDED`.

Manifest validation must be synchronous and side-effect free: no dynamic import, no fs, no env reads during validation — that is what makes "before any I/O" provable in tests.

Scope note (documented decision): remaining Structural Seed packages are created by the stories that own them, keeping this chunk bounded.

## Verification

**Commands:**
- `pnpm install` -- expected: clean install, workspace links kernel/contracts
- `pnpm -r typecheck` -- expected: zero errors under TS 7.0.x
- `pnpm -r test` -- expected: all suites green, including cycle-naming, missing-field, readiness-gate, and zero-dep guard tests
- `pnpm -r lint` -- expected: zero warnings

## Suggested Review Order

**Manifest validation (eager, I/O-free)**

- Entry point: synchronous validation, all fields required before any I/O
  [manifest.ts:74](../../packages/kernel/src/manifest.ts#L74)

- Duplicate provides/consumes entries rejected naming field + service
  [manifest.ts:66](../../packages/kernel/src/manifest.ts#L66)

**Loading pipeline & readiness**

- Throw-vs-collect failure contract documented in JSDoc
  [loader.ts:40](../../packages/kernel/src/loader.ts#L40)

- Soft-consumed absence resolves typed { kind: 'absent' }, never undefined
  [loader.ts:6](../../packages/kernel/src/loader.ts#L6)

**Error model across the AD-1 boundary**

- Canonical code constants (AD-7 home), kernel-independent
  [rrors.ts:1](../../packages/contracts/src/errors.ts#L1)

- Kernel-local coded errors, structurally compatible by string code
  [rrors.ts:8](../../packages/kernel/src/errors.ts#L8)

**Guards & tests**

- Parity suite pins all four codes against canonical constants
  [kernel-code-parity.test.ts:27](../../packages/contracts/test/kernel-code-parity.test.ts#L27)

- Zero-dependency invariant incl. relative-path escape detection
  [guard.test.ts:20](../../packages/kernel/test/guard.test.ts#L20)

- I/O matrix happy path locked end-to-end
  [loader.test.ts:13](../../packages/kernel/test/loader.test.ts#L13)

- Lint-level AD-1 enforcement for kernel sources
  [slint.config.js:16](../../eslint.config.js#L16)
