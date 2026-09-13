# Sandbox Task 1 Review Fix Report

The contracts now reject lexical cwd escapes, return immutable validated values, correlate statuses with their structured error codes, and reject Windows drive-relative snapshots. No runtime or platform APIs were added.

## Verification

| Command | Result |
| --- | --- |
| `packages/contracts> .\\node_modules\\.bin\\vitest.CMD run test/sandbox.test.ts test/topology.test.ts` | Passed: 2 files, 12 tests. |
| `packages/contracts> pnpm typecheck` | Passed: `tsc --noEmit`. |
| `packages/kernel> .\\node_modules\\.bin\\vitest.CMD run test/guard.test.ts` | Passed: 1 file, 5 tests. |

## Scope

- Lexical containment is deliberately filesystem-free; providers remain responsible for proving physical containment through symlink, junction, and reparse-point handling.
- ToolProvider discovery remains unchanged and distinct from sandbox execution.

## Lint remediation (2026-09-11)

Replaced the regex containing literal control-character ranges with a `charCodeAt` scan. The scan continues to reject every C0 control character and DEL (0x7f) without triggering `no-control-regex`.

| Command | Result |
| --- | --- |
| `packages/contracts> .\\node_modules\\.bin\\vitest.CMD run test/sandbox.test.ts test/topology.test.ts` | Passed: 2 files, 12 tests. |
| `packages/contracts> pnpm typecheck` | Passed: `tsc --noEmit`. |
| `packages/contracts> pnpm lint` | Passed: `eslint .`. |
| `packages/kernel> .\\node_modules\\.bin\\vitest.CMD run test/guard.test.ts` | Passed: 1 file, 5 tests. |
| `node scripts/check-source-bytes.mjs` | Passed. |

## Regression coverage update (2026-09-11)

`sandbox.test.ts` now verifies that an argv token containing a NUL character is rejected. This preserves the prior control-character boundary while the implementation avoids a forbidden control-character regex.

Final verification repeated after the test update: sandbox + topology (12 tests), contracts typecheck, contracts lint, kernel guard (5 tests), source-byte check, and diff check all passed.
