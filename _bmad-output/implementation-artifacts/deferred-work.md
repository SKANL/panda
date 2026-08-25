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
- source_spec: `_bmad-output/implementation-artifacts/spec-2-2-projection-engine-with-sentinel-grammar-claude-target.md`
  summary: No user-facing resolution/adoption flow for permanent drift yet — markers that classify as drift are reported and never rewritten, leaving affected files frozen until doctor (Story 2.7) defines remediation commands.
  evidence: Projection targets return drift entries verbatim in results without any rewrite path; no CLI surface exists to resolve, adopt, or discard them.
- source_spec: `_bmad-output/implementation-artifacts/spec-2-4-toolprovider-and-skillsource-ports.md`
  summary: Provider ingestion holds no run-scoped lock — `store.get` reads lock-free and each `store.register` takes its own lock, so a concurrent writer can mutate an entry between the change-detection read and the write, and two interleaved ingests leave the store holding a mix of both runs.
  evidence: Code-review finding — needs `RegistryStore.withLock(scope, fn)` spanning reads and writes; acceptable for a single-writer local tool, revisit when panda runs concurrently against one machine store.
- source_spec: `_bmad-output/implementation-artifacts/spec-2-4-toolprovider-and-skillsource-ports.md`
  summary: Phase 2 issues one lock acquisition and one whole-file rewrite per contribution — N locks and O(n^2) bytes for a catalog of N entries, each with its own contention deadline.
  evidence: Code-review finding — wants a `RegistryStore.registerMany(entries, scope)` batching one lock, one read and one persist; the same change shrinks the partial-write window documented in the ingest jsdoc.
- source_spec: `_bmad-output/implementation-artifacts/spec-2-4-toolprovider-and-skillsource-ports.md`
  summary: `list()` on an untrusted origin has no timeout and no cancellation — a provider that never resolves wedges the whole sequential collect phase with no error path.
  evidence: Code-review finding — needs an AbortSignal/timeout policy shared across the provider ports rather than a one-off race in the driver.
- source_spec: `_bmad-output/implementation-artifacts/spec-2-4-toolprovider-and-skillsource-ports.md`
  summary: Ingestion is additive only — an entry an origin stops contributing stays registered and keeps projecting forever, with no reconciliation path.
  evidence: Pruning/reconciliation semantics are explicitly Ask-First in the spec's Boundaries; the drift/doctor surface (Story 2.7) is the natural home for the resolution flow.
- source_spec: `_bmad-output/implementation-artifacts/spec-2-4-toolprovider-and-skillsource-ports.md`
  summary: The provider ports have no production consumer — nothing outside the new tests imports `ingestProviders`, `ToolProvider` or `SkillSource`.
  evidence: Code-review finding — the CLI surface (Story 2.7 init/project-init/doctor) is the first real caller and will exercise the API shapes (outcome keys, batch write, cancellation) that no test can pressure today.
