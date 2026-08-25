# Deferred Work

- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-plugin-manifest-foundation.md`
  summary: RESOLVED (Fase 0, post-Epic 1) — CI workflow (Node 24 + 26 canary) and aggregate `pnpm check` gate added; repo published at github.com/SKANL/panda.
  evidence: .github/workflows/ci.yml green on both matrix nodes; format tooling intentionally omitted — ESLint + editorconfig-level consistency deemed sufficient for a single-writer repo until a second contributor lands.
- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-plugin-manifest-foundation.md`
  summary: Kernel↔contracts error-code parity tests live in @panda/contracts with a test-only devDependency on @panda/kernel (inverted test graph).
  evidence: RESOLVED BY DECISION (Fase 0 reassessment) — the Story 1.4 contract-test harness validates adapters/providers, not kernel error codes, so it is NOT a natural relocation home; the current contracts-side pinning with a test-only devDependency is coherent, disclosed, and drift-guarded. No move needed.
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
- source_spec: `_bmad-output/implementation-artifacts/spec-2-1-registry-core-with-machine-scoped-serialization.md`
  summary: Registry persistence lacks fsync-level durability — there is a power-loss window after rename where the store file may be stale or empty.
  evidence: Atomicity (temp+rename) covers process crashes, not power loss; acceptable for v1 local tool, revisit if the Registry becomes a multi-device source of truth.
