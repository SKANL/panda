# Deferred Work

- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-plugin-manifest-foundation.md`
  summary: No CI workflow, format tooling, or aggregate check gate exists yet for the panda repo.
  evidence: Review finding from Story 1.1 — a greenfield bootstrap whose spec emphasizes regression protection ships with nothing enforcing gates on push; needs its own bounded chunk before first push.
- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-plugin-manifest-foundation.md`
  summary: Kernel↔contracts error-code parity tests live in @panda/contracts with a test-only devDependency on @panda/kernel (inverted test graph).
  evidence: Neither package may import the other at runtime (AD-1), so the parity suite must observe both tables; relocate it into the shared contract-test harness when Story 1.4 builds that infrastructure.
