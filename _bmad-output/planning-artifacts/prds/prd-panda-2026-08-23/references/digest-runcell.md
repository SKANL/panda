# Reference digest: runcell (source-level)

Repo: C:\code\panda\.scratch\references\runcell · Explored 2026-08-23

## 1. Agent primitive
`createAgent(options, context?)` accepts AgentOptions: model string ("anthropic/claude-sonnet-4-5"), systemPrompt, credentials, tools record, events callbacks, sandbox option, maxRepairs, Pi escape hatch (`src/types.ts:104-128`). Eager validation into ResolvedAgentConfig, throws InvalidOptionError before any work (`src/create-agent.ts:75-130`). Returns {run, stream}; run<TSchema> returns RunResult{data, text, files, finishReason, sessionId} (`src/types.ts:180-227`). Hand-rolled single-producer text stream with pre-observed rejection (`src/create-agent.ts:205-286`).
Model resolution: catalog-based via Pi model registry with qualified provider/id disambiguation + gateway preference (`packages/harness-pi-raw/src/pi-model-resolver.ts:32-61`). Custom providers registered via Pi extension factories running BEFORE model resolution — an extension can define the provider the agent's model refers to (`docs/pi-extensions.md:103-123`).
Swap seams: (a) model is a config string; (b) entire engine behind injectable RuncellRuntime.run(input) via `createAgent(opts, {runtime})` (`src/runtime.ts:70-91`, `src/create-agent.ts:185-203`).

## 2. Sandbox abstraction
One interface all backends: Sandbox{id, capabilities, exec(), readFile/readTextFile/writeFile/remove, snapshot(), exposeUrl?, lock(key,fn), destroy()} (`src/sandbox-handle.ts:33-75`). Capabilities declare per-backend features {ports, nativeSnapshot, resume} (`sandbox-handle.ts:81-88,223-240`). Backends: virtual (bundled just-bash), host (real FS at /workspace, env allowlist ~11 safe vars, path-escape guard assertInsideRoot), vercel (lazy opaque import), custom (any object satisfying harness-sandbox-v1 + createSession, duck-typed). Snapshot = portable JSON {version:1, files:[{path, base64}]}, excludes .pi-sessions, validated BEFORE sandbox exists so restore stays atomic (`sandbox-handle.ts:105-119,268-296`); processes never restored.
Ownership: caller-owned handles from createSandbox(); passing to run() pins session id and Proxy-wraps to neuter stop/destroy so harness cleanup can't kill it; runcell only destroys what it created (`runtime.ts:336-357,551-580`). destroy() idempotent; post-destroy ops throw.

## 3. Thread persistence
ThreadState{version:1, id, messages[], continuation?} (`src/thread.ts:37-42`). Messages neutral/portable {role:'user'|'agent', content, data?, createdAt} — no engine fields. continuation = opaque engine state {engine:'pi', resume, journalGz} where journalGz is base64-gzipped engine session journal stored in the sandbox, extracted on detach, re-materialized into fresh sandbox before next run (`thread.ts:24-31`; `runtime.ts:155-160,338-350,464-499`). Malformed continuation → graceful plain-text replay preamble renderThreadContext() (`thread.ts:145-160`). Mutation deep-clones; callers can't rewrite history after append.

## 4. Structured output
Schema run adds hidden submitResult tool projected from Standard Schema, deliberately unvalidated at boundary; real validation inside execute via schema['~standard'].validate(input); failures become tool errors the model sees and corrects. No valid submission → up to maxRepairs repair turns with onRepair events; exhaustion throws IncompleteResultError (`runtime.ts:213-241,610-646`). Validated submission aborts active turn via silent abort surviving cancellation races.

## 5. Tools
Host tools Record<string, ToolDefinition{description, schema, execute}>; reserved names enforced (read/write/edit/bash/grep/glob/ls/submitResult/fileChange) (`create-agent.ts:19-29`). Zod or Standard Schema accepted (`runtime.ts:668-690`). Extension hooks veto calls: pi.on('tool_call', e => ({block:true, reason})) ; extension/user name collisions fail loudly with ExtensionError.

## 6. Credentials
Five plans: env (default scan), apiKeys mapping, agentDir, 'local', 'shared' (`credentials.ts:49-55`). 'local' reuses developer ~/.pi/agent dir incl OAuth logins — REFUSED in production unless allowInProduction:true (`credentials.ts:139-152`). 'shared' adapts lockable whole-blob store to per-provider contract for atomic cross-process OAuth refresh (`runtime.ts:996-1065`).

## Design lessons for panda
- Make the executor itself an injectable interface — public factory stays stable while whole engine swaps
- Validate options eagerly into an internal resolved plan; fail before any I/O
- Persist neutral portable messages + opaque continuation blob; degrade to replay when blob missing/malformed rather than failing
- Model backend differences as explicit capabilities, not scattered optionals
- Ownership structural: proxy-wrap caller-owned resources to neuter internal teardown instead of trusting flags
- Don't trust framework-level schema enforcement as security boundary — re-validate at point of acceptance
- Guardrails in config normalization: refuse unsafe credential modes per environment unless explicitly opted in
- Reserved-name sets prevent user-tool/builtin collisions loudly up front
