# Epic 1 Context: Run coding tasks through panda

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Epic 1 delivers the foundational layer of panda: a working pnpm monorepo with a generic plugin-kernel container (declarative manifests, dependency injection with reversible disposal, atomic swaps, scoped event bus, layered config) plus the ExecutorAdapter port, its contract-test harness, and a workspace-local provider — culminating in running a real coding task through Claude Code headlessly from any Node script and getting a typed result envelope back. This epic proves the platform's first end-to-end execution path (the groundwork for user journey UJ-1) and enables every later epic: Epics 2–5 all build on the kernel, the contracts package, and the contract-test infrastructure established here.

## Stories

- Story 1.1: Plugin manifest foundation
- Story 1.2: Injection, disposal, and atomic swaps
- Story 1.3: Scoped event bus and layered configuration
- Story 1.4: ExecutorAdapter port with contract-test harness
- Story 1.5: First execution — Claude Code driven headlessly

## Requirements & Constraints

**Plugin manifest (Story 1.1):** Plugins declare provided services, consumed services (hard or soft), and a config schema in a static manifest evaluated before any I/O. Missing/malformed manifest fields fail load fast with a named error; hard-consumed missing services block readiness; soft-consumed missing services yield an explicit typed-absent value whose use-site raises a "not configured" error — never silent undefined propagation. Dependency cycles are rejected at load naming both sides.

**Lifecycle & swaps (Story 1.2):** Every service registration pairs with a disposer; kernel stop disposes in exact reverse start order (verified via ordering log). Double-dispose is a no-op; operations after dispose raise a typed inactive error. Implementation swaps commit only after full validation; an invalid replacement leaves the previous implementation serving and returns a typed swap error naming the validation failure. An individual plugin's startup failure is contained (event emitted; kernel and other plugins keep running).

**Event bus & config (Story 1.3):** The bus supports scope-filtered subscription (`global | project | agent`): two interleaved concurrent sessions each observe exactly their own subset. Config resolves through ordered layers (defaults → global → project → agent → invocation overlay), deep-merged; a diagnostic dump shows composed values with originating layer per key; narrower-scope overrides never mutate wider-scope files.

**Executor port & workspace (Stories 1.4–1.5):** An ExecutorAdapter spawns an Executor inside a Workspace, delivers a prompt, streams progress events, and returns a typed structured envelope `{status, data, summary, changedPaths?, errors?}`. Cancellation terminates the underlying process tree and yields a typed cancelled result. A published contract-test suite validates any adapter against named clauses; a partial stub must fail with each violated clause identified. The WorkspaceProvider contract covers create/acquire/release/dispose of an opaque handle exposing root path + capabilities; workspace state persists across executor sessions (the executor process itself is ephemeral per task). The local-directory implementation passes the workspace contract clauses.

**Performance:** adapter spawn overhead ≤150ms above raw CLI startup.

## Technical Decisions

- **Microkernel + ports paradigm:** `@panda/kernel` is a generic container (lifecycle, DI, event bus, config layers) with zero runtime dependencies. It never imports `@panda/contracts` or any implementation package — no kernel module may know a concrete Contract. Everything else (adapters, providers, engines, CLI) mounts as plugins.
- **Package topology (strictly downward imports):** `kernel` → nothing; `contracts` → no external runtime deps; implementation packages (`adapter-claude`, `workspace-local`, etc.) → contracts; `cli` → kernel + contracts + implementations. Third parties implement any port installing only `@panda/contracts`.
- **Monorepo bootstrap:** pnpm 11 layout under `packages/*` per the Structural Seed (kernel, contracts, adapter-claude/codex/opencode, memory-fs/sqlite, workspace-local/git, projection, cli). Stack: TypeScript 7.0.x compiler (`@typescript/typescript6` alias for lint tooling), Node ≥24 LTS, Standard Schema v1 as the cross-contract schema interface (Zod 4 only inside implementations/tests), Vitest 4, ESLint 10.
- **Typed error hierarchy:** stable `PANDA_<DOMAIN>_<REASON>` codes live in `@panda/contracts`; every contract violation raises a coded error naming the violated clause; contract-test suites assert on codes.
- **Injection semantics:** hard-consumed services block readiness until provided; soft reads yield typed-absent values requiring explicit use-site errors.
- **Event bus discipline:** synchronous, ordered fan-out within scope; handlers async-capable and contained per-listener (one rejection never breaks siblings); handlers must not synchronously re-emit during fan-out; shutdown drains pending handler mutations before unwinding registrations.
- **Config/sentinel grammar:** `@panda/contracts` owns a single versioned, namespaced sentinel grammar covering both layered-config vocabulary and projection markers; unknown/legacy sentinels classify as Drift.
- **Executor boundary:** Executors are external out-of-process CLIs — adapted, never plugins. Adapters receive the abstract workspace handle, never a bare cwd. Plugins are trusted code loaded in-process (dynamic ESM import); port methods stay async-compatible.
- **Observability:** a kernel-owned append-only log service initializes before any plugin loads, with a fixed failure policy (typed degraded mode).

## Cross-Story Dependencies

- Story 1.1 establishes the manifest/loading machinery that Stories 1.2 and 1.3 extend (lifecycle, events, config).
- Story 1.4 depends on the kernel container and on `@panda/contracts`; it delivers the contract-test suite that Story 2.5 later runs all three shipped adapters through, and the workspace-local provider that Story 1.5 consumes.
- Story 1.5 depends on Stories 1.4 (adapter port + workspace) and requires Claude Code installed/authenticated externally; its minimal `panda run` command is the first slice of the CLI package bootstrapped in this epic.
- Later epics assume this epic's outputs: kernel zero-dependency invariant, error-code conventions, and the shared result-envelope schema (Epic 2 completes the adapter set against the same suite).
