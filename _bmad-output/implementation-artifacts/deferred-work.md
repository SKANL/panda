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
  summary: RESOLVED BY DECISION (Story 2.5) — executor contract clauses keep invoking adapter.run() up to four times per suite audit; no caching and no probe isolation are added.
  evidence: The suite runs against FAKE spawners exclusively (spec 2.5 Boundaries: "contract-suite runs use fake spawners exclusively — no test may execute a real binary"), so per-run cost is nil and no side effect leaves the process — the premise that made repeated runs expensive never materialized. All four adapters (claude-code, codex, opencode, trait-only stub) run the full suite through `packages/adapter-cli/test/executor-suite.ts` with `FakeSpawner`; no contract-suite clause ever starts a process. (The overhead and tree-kill suites do spawn `process.execPath`, but they measure the spawn seam, not an executor, and the only test that runs a real coding CLI is the env-gated live smoke.) Revisit only if a real-executor conformance audit is ever added.
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
- source_spec: `_bmad-output/implementation-artifacts/spec-2-5-shipped-adapters-complete-the-set.md`
  summary: The executor trait path vocabulary (`readonly string[]`) cannot address array elements, so payload shapes like `message.content[0].text` — the shape most agent CLIs and the Anthropic/OpenAI message formats actually use — are unreachable without an engine edit.
  evidence: Code-review finding — `resolvePath` rejects non-record intermediates by design; no shipped record needs an index today, so the vocabulary stays minimal until a real executor forces it. Note that the trait-only stub test proves reuse for shapes the engine already handles, not for every shape.
- source_spec: `_bmad-output/implementation-artifacts/spec-2-5-shipped-adapters-complete-the-set.md`
  summary: `envelope.data` is a flat string map, so trait metadata keys can collide with the engine's own `result`/truncation keys and non-string metadata is silently dropped.
  evidence: Code-review finding — the collision risk is closed defensively by trait validation (rejecting the reserved keys); nesting metadata under its own namespace and preserving non-string values is a shape change worth doing when a consumer needs the richer payload (e.g. codex token usage).
- source_spec: `_bmad-output/implementation-artifacts/spec-2-5-shipped-adapters-complete-the-set.md`
  summary: `panda run` has no executor selector — codex and opencode ship as library surface only, reachable exclusively through direct construction.
  evidence: Wiring adapter selection into the CLI is explicitly Ask First in this spec's Boundaries; the natural home is the CLI surface story (2.7 init/project-init/doctor), where executor choice becomes user-visible configuration.
- source_spec: `_bmad-output/implementation-artifacts/spec-1-6-kernel-owned-observability-log.md`
  summary: Records carry no kernel identity, so two kernels sharing one sink interleave into a single unattributable stream.
  evidence: Code-review finding — the closed record shape has no `kernelId`, and nothing today constructs two kernels against one sink. Belongs with composition (ROADMAP-01 M2), when a caller owns more than one container; adding the field later is a record-shape version bump, which `LOG_RECORD_VERSION` already exists to carry.
- source_spec: `_bmad-output/implementation-artifacts/spec-1-6-kernel-owned-observability-log.md`
  summary: No process-exit drain — records still in flight when the process ends are lost, and only the seq gap survives to show it.
  evidence: Code-review finding — `stop()` and `dispose()` both drain, but nothing hooks process exit, and the kernel deliberately owns no process-level concern today. Belongs with composition (ROADMAP-01 M2), when there is an owner of process shutdown to register the handler.
- source_spec: `_bmad-output/implementation-artifacts/spec-1-6-kernel-owned-observability-log.md`
  summary: RESOLVED (Story 1.6) — `KernelOptions.orderLog` deleted rather than deferred; the record sink subsumed it.
  evidence: Two overlapping ordering mechanisms cost real coverage: the test named "treats a second stop as a no-op with no duplicate log entries" watched `orderLog`, which never receives `kernel.stopped`, so this story's own invariant went unchecked. Migrated all 6 call sites (4 in `packages/kernel/test/lifecycle.test.ts`, 2 in `packages/registry/test/plugin.test.ts`) onto `kernel.log.records`.
- source_spec: `_bmad-output/implementation-artifacts/spec-1-7-tool-call-interception-waterfall.md`
  summary: Interception caps are pipeline-wide only — `ActionPolicy` has no per-action scope, so "this one action at most N times" cannot be expressed without constructing a second pipeline.
  evidence: `ponytail:` note on `createActionPipeline` in `packages/kernel/src/intercept.ts`. AD-10's three named budgets (token budgets, loop caps, fan-out limits) are all run-scoped, and nothing today registers more than a handful of actions; the upgrade path is an `ActionPolicy.perAction` map, which stays declarative data and needs no new mechanism.
- source_spec: `_bmad-output/implementation-artifacts/spec-1-7-tool-call-interception-waterfall.md`
  summary: The concurrency cap counts everything in flight, so an action invoked from inside another genuinely holds two slots — depth is indistinguishable from fan-out.
  evidence: `ponytail:` note in `packages/kernel/test/intercept.test.ts` ("releases both concurrency slots the nesting held"). Each invocation is still counted exactly once, which is what the matrix's nested-invocation row asks; what is missing is a depth-aware variant that counts only siblings. Deferred until a caller actually nests under a tight `maxConcurrent`, because the fix (tracking an invocation's parent) is a real mechanism, not a tweak.
- source_spec: `_bmad-output/implementation-artifacts/spec-1-7-tool-call-interception-waterfall.md`
  summary: Counters are in-process and die with the pipeline — a budget cannot span two processes or survive a restart.
  evidence: Explicitly Ask-First in this spec's Boundaries ("persisting counters across processes") and listed under Deliberately not built. Belongs with composition (ROADMAP-01 M2), when there is an owner of run identity to key a persisted counter by.
- source_spec: `_bmad-output/implementation-artifacts/spec-1-7-tool-call-interception-waterfall.md`
  summary: The no-bypass guarantee is kernel-scoped — nothing stops a caller in another package from skipping the kernel and driving an adapter directly, which `panda run` does today.
  evidence: Named as the honest limit in this spec's Design Notes and repeated on `ActionHandle.invoke`. Closing it is composition work: Story 2.7a, where the CLI stops constructing adapters with `new`. The kernel-side half (no exported path around the seam) is enforced and pinned by `packages/kernel/test/intercept.test.ts`.
- source_spec: `_bmad-output/implementation-artifacts/spec-1-7-tool-call-interception-waterfall.md`
  summary: A wedged `around` (or a wedged operation) holds its concurrency slot forever — there is no timeout and no cancellation, so one buggy interceptor is a permanent denial of service for the fan-out budget.
  evidence: `ponytail:` note on `createActionPipeline`. The slot is deliberately tied to the OPERATION settling rather than to `around` returning (that is what makes the fan-out cap real), which means `invoke()` also stays pending. Retries, backoff and scheduling are on this spec's Deliberately-not-built list and cancellation is the same class of mechanism; it needs an `AbortSignal` policy shared with the provider ports, which `spec-2-4` already defers for the same reason.
- source_spec: `_bmad-output/implementation-artifacts/spec-1-7-tool-call-interception-waterfall.md`
  summary: `createActionPipeline` is a public export, so any holder can construct a SECOND, uncapped pipeline — the no-bypass guarantee holds (its stages still run) but the budget half of AD-10 is per-pipeline, not per-process.
  evidence: Code-review finding. A registered action cannot be executed outside a waterfall, which is what the acceptance criterion claims; what a second pipeline escapes is the first one's caps. Making a run's budget singular needs an owner of run identity to hold the one pipeline, which is composition work (ROADMAP-01 M2) — the same place the cross-process counter entry above lands.
- source_spec: `_bmad-output/implementation-artifacts/spec-1-7-tool-call-interception-waterfall.md`
  summary: A contained stage error has no channel to reach a caller — a throwing `post` is recorded as `action.post-failed`, but the thrown value itself (message, cause, stack) is discarded.
  evidence: The 1.6 record shape is closed on purpose (no free-form slot, so a credential has nowhere to hide), and the kernel has no other outbound channel; a growing in-memory list of contained errors would be an unbounded leak. Story 1.6 has the same gap for a hostile sink. The natural home is composition, where a process-level owner can register a handler for contained diagnostics.
