# Reference digest: deepseek-harness (source-level)

Repo: C:\code\panda\.scratch\references\deepseek-harness · Explored 2026-08-23

## 1. Kernel/plugin anatomy
Cordis plugin = object implementing Service — function with inject/apply(ctx) fields or Service subclass; services claim stable ctx.<key> names; dependencies via inject wait until available; every registration is a reversible effect (docs/cordis-primer.md:9-13).
Real example — the agent loop itself is a plugin (`packages/core/agent-loop/src/index.ts`): class AgentLoop extends Service implements AgentFactory with `static inject = ['agents','sessions','llm','tools','systemPrompt']` (:296-297); declarative schema config `static Config = z.object({...})` (:300-311); context augmentation via TS declaration merging adds agentLoop to Context (:160-172); constructor registers named effects with disposers (`ctx.effect(() => () => this.ownership.dispose(), 'agentLoop.transactions()')`) (:349-350); per-agent resume effects into child fibers (:370-380). Storage plugin registers backend through ctx.storage.backend.register('sqlite', backend) inside named effect whose disposer unregisters then closes + ctx.provide(storageBackendServiceKey) (`packages/storage/storage-sqlite/src/index.ts:158-167`).

## 2. Core plugins and boundaries
dsh-base first layer of every profile: model adapters, tools, persistence, sandbox+approval policy, settings, credentials, telemetry; dsh-web-app adds browser app; dsh-headless adds serverless runner (docs/architecture.md:25). Core table: session→ctx.sessions (append-only SessionEvent log), system-prompt→ctx.systemPrompt, tools→ctx.tools (scoped registry + pre/guard/around/post pipeline), agent→ctx.agents, agent-loop→ctx.agentLoop, llm→ctx.llm.
ExecutorAdapter-like roles: ctx.llm (LlmAdapter) plus capability seams — filesystem/subprocess providers share one execution world so pointing them at a remote sandbox moves Bash/PTY/LSP together without forks (architecture.md:102,115,120).

## 3. Config & scopes
Composition: profile ($DSH_HOME/profiles/<name>) lists ordered bundles; each bundle's package.json dsh.bundle.patch points to cordis.patch.yml. Layers apply over empty entry list: bundles in order → profile patch → home-level → --patch overlays; a patch targets a row by id and replaces its config or inserts rows (architecture.md:17-27; profile.ts:5-22). Introspection: `dsh --profile web --dump-config`. Settings second dimension: schema defaults → composition base layer → user layer; describe() exposes detached layers so forms mark overrides.
Scope system: ScopeKey opaque object identity, Scoped<T> compile-time carrier for scope-filtered event dispatch, Scope pairs registration context with quiescent disposal, ScopedLayers keeps eager global layer + lazy exact-scope layers reclaimed when empty (docs/subsystems/scope.md:11-57). Tool pipeline events scope-filtered so agent-scoped listeners see only their agent's calls.

## 4. Lifecycle
Load order = dependency order; no manual boot sequencing. Teardown: effect disposers run reverse order on disposer call OR fiber unload; double-call no-op; post-dispose throws INACTIVE_EFFECT. Ordering-sensitive work in ONE effect so disposal unwinds in sequence (cordis-primer.md:44).
Missing service: hard inject blocks until present; soft reads ctx.get() return undefined — resume throws "cannot resume: session persistence is not configured" (agent-loop:654-657); optional persistence consumed via ctx.inject(['sessionPersistence']) into child fiber. Contained startup failure: declarative agent startup failures warn-log + emit config-start-failed event instead of crashing factory.
Hot reload: fiber.update() internal/update waterfall lets HMR hooks veto/replace restart; tool hot-swap idiom = dispose owning effect, register replacement; settings watcher hot-publishes external edits.

## 5. Model/provider abstraction
LlmRuntime extends Service (ctx.llm) holds adapter registry; abstract LlmAdapter requires only stream(options): AsyncIterable<StreamChunk>, optional providerInfo/retryPolicy/listModels/resolveModel/prepareCall (`packages/llm/llm/src/index.ts:185-260,311`). Registration registerAdapter(providers[], adapter) all-or-nothing, duplicate throws DUPLICATE_ADAPTER, auto-disposed with fiber; handles support atomic replace() route swaps validated fully before commit (:262-292). Every call flows through llm/stream waterfall (retry/replay/routing middleware). Unknown provider → NO_ADAPTER error. Shipped adapters meet same contract through different internals.

## 6. architecture.md invariants
No privileged core; extend by mounting a plugin beside others; registrations unwind on unload. Three event domains: durable session events, live agent/* interception, capability-seam attachment. "Model-visible means logged": anything reaching a model request must be reconstructable from append-only session log — runtime invariant asserts it. A seam needs three roles: Service Definition (interface) + Provider + Consumer. New behavior attaches to documented extension points only.

## Design lessons for panda
- Make even the loop a plugin: kernel contracts consumable via declared inject without importing concrete impls
- Pair every registration with a disposer via one named effect; reverse-order unwind IS the lifecycle story — no separate shutdown phase
- Distinguish hard inject (block until present) from soft ctx.get() + explicit "not configured" errors; contain per-entity startup failures as emitted events, never process crashes
- Design swappable capabilities as three roles (interface + provider + consumer); validate-and-commit swaps atomically so no observer sees a gap
- Route cross-cutting policy through waterfalls rather than call-site conditionals
- Layer config in explicit ordered patches targeting rows by id, with dump command to inspect composed tree
- Enforce "model-visible means logged" as runtime invariant over one append-only event log
- Opaque per-agent scope keys with lazily-created reclaim-on-empty scoped layers for per-agent visibility
