# Spec M39.A — MethodPlugin loading has an explicit trust boundary

Status: FROZEN after approval. Changes go in the Spec Change Log, never silently.
**Story:** records what panda can and cannot guarantee when loading executable
method modules.

## Intent

`MethodPlugin` validation cannot inspect an export without loading the module.
Loading executes top-level code, so structural validation is not a sandbox. The
product must say that plainly and keep the one pre-load refusal that is actually
available: a method selected by a project document is rejected before import.

## Boundaries & Constraints

- `packages/session/src/methods.ts` keeps its runtime order: project rejection,
  import, then `validateMethodPlugin`.
- Global and agent method sources are trusted executable code sources.
- v1 adds no child-process isolation, worker isolation, sandbox, or global
  dynamic-import ban. Untrusted modules require isolation outside panda.
- The public documentation uses English and distinguishes structural validation
  from security isolation.

## Acceptance

1. A real CLI run with a project-named method leaves the module's deterministic
   top-level side-effect marker absent.
2. A real trusted global method may leave its top-level marker and then fail with
   `PANDA_METHOD_INVALID_PLUGIN` for an invalid structural export.
3. The trust test does not describe structural validation as sandboxing or
   security isolation.
4. Existing method ordering and runtime behavior are unchanged.

## Code Map

- `packages/contracts/METHOD-PLUGIN.md` — public trust-boundary documentation.
- `packages/cli/test/method-layer-trust.test.ts` — real public-path side-effect
  and coded-error proof.
- `packages/session/src/methods.ts` — existing ordering, intentionally unchanged.

## Verification

Focused CLI trust tests must pass. The method implementation is not changed by
this story; the test and documentation are the enforceable record of the
boundary.
