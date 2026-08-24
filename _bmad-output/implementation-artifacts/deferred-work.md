# Deferred Work

- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-plugin-manifest-foundation.md`
  summary: No CI workflow, format tooling, or aggregate check gate exists yet for the panda repo. Target: repo infrastructure chunk before first push.
  evidence: Review finding from Story 1.1 — a greenfield bootstrap whose spec emphasizes regression protection ships with nothing enforcing gates on push; needs its own bounded chunk before first push.
- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-plugin-manifest-foundation.md`
  summary: Kernel↔contracts error-code parity tests live in @panda/contracts with a test-only devDependency on @panda/kernel (inverted test graph).
  evidence: Neither package may import the other at runtime (AD-1), so the parity suite must observe both tables; relocate it into the shared contract-test harness when Story 1.4 builds that infrastructure.
- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-plugin-manifest-foundation.md`
  summary: Packages export raw TypeScript (`./src/index.ts`) with no compile/consumption story; a build step (or bundler strategy) is needed before CLI packaging.
  evidence: Code-review finding — deliberate greenfield choice (allowImportingTsExtensions + bundler resolution), but `panda run` (Story 1.5) forces a distribution decision.
- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-plugin-manifest-foundation.md`
  summary: "Before any I/O" guarantee for manifest validation is scoped to kernel-owned code by documentation only; no spy-based test harness proves it mechanically.
  evidence: Code-review finding — plugin-supplied Standard Schema validators necessarily execute plugin code, so full mechanical provability needs a dedicated harness; deferred as not actionable now.
- source_spec: `_bmad-output/implementation-artifacts/spec-1-4-executoradapter-port-with-contract-test-harness.md`
  summary: Executor contract clauses invoke adapter.run() up to four times per suite audit; real-executor cost/side-effect strategy (single-run caching or probe isolation) decided in Epic 2.
  evidence: Harness documents repeatability assumption; first-party adapters spawn processes.
- source_spec: `_bmad-output/implementation-artifacts/spec-1-4-executoradapter-port-with-contract-test-harness.md`
  summary: Workspace contract clauses assume disk-persisted state; genericity for in-memory/remote providers needs capability-gated clause variants.
  evidence: Suite hard-couples to node:fs at rootPath.
