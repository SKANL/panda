---
status: measured
validation: measured
claims_verified:
  - runcell virtual mode is in-process command emulation, not an OS sandbox
  - Cordis isolation scopes in-process services and lifecycle, not host capabilities
  - DSH separates per-call policy, provider enforcement, lifecycle, and error attribution
  - at the audited baseline, panda had no sandbox execution API and ToolProvider described discovery/ingestion
claims_unverified:
  - hostile execution safety of any future panda provider until real platform probes pass
extends:
  - _bmad-output/planning-artifacts/research/deepseek-harness-upstream-delta-2026-09-11/research.md
  - _bmad-output/planning-artifacts/research/distribution-and-engineering-surfaces-2026-09-11/research.md
---

# Sandbox boundary research

## Executive decision

Panda should add a capability-oriented sandbox subsystem outside the kernel. The kernel remains dependency-free and policy-agnostic. `@skanl/panda-contracts` defines portable policy, capability, result, and error vocabulary; optional providers own process creation, confinement, limits, cancellation, and teardown.

The secure path must fail closed. A provider that cannot prove the controls requested by a call must return `PANDA_SANDBOX_UNAVAILABLE` or an equivalent coded refusal; it must never downgrade the call to an ordinary host process.

The first implementation must not claim that in-process emulation, worker threads, ACLs, or Cordis-style context isolation are hostile-code security boundaries.

## Implementation status, 2026-09-11

The contracts-first slice is now present: `SandboxProvider` and `SandboxSession`
model provider-owned lifecycle, validated policy/snapshots, per-control capability
facts, exact-argv execution, and coded outcomes. `ToolExecutor` accepts `local`
and `mcp-stdio` descriptors only; it appends argument tokens without shell parsing
or expansion. `ToolProvider` remains discovery/ingestion-only.

The local provider is deliberately conservative. It may discover candidate
platform tools, but discovery is not enforcement evidence: it currently reports
no enforced controls and a policy that requires one fails closed. Therefore this
slice does **not** prove or claim Landlock, bubblewrap, Seatbelt, or Windows
Hyper-V enforcement, nor full OS isolation. The remote package accepts an
injected transport adapter and capability facts; it ships no concrete remote
protocol. Session composition exposes the seam but current session tool
invocation remains inert because no executor tool-call flow routes to it.

## Sources audited

- `C:\code\runcell` at `e07564a`: public agent/sandbox API, virtual and host providers, sandbox handles, Pi integration, tests, docs, and packed consumer proof.
- `C:\code\cordis` at `f8ea3cd`: context/service isolation, loader realms, fibers, lifecycle, and isolation tests.
- `C:\code\deepseek-harness` at `4e84901`: sandbox contracts, local backends, Windows ACL provider, subprocess lifecycle, worker runtime, E2B provider, HTTP SSRF policy, and packed tests.
- `C:\code\panda` at `48cb430`: contracts, session composition, workspaces, ToolProvider discovery, and dependency topology.

CodeGraph status was checked in all four repositories. The runcell index was initialized locally; Cordis, DSH, and panda indexes were up to date. Runcell tests were not executed because its checkout has no installed dependencies.

## Comparative findings

### runcell

Runcell has the cleanest user-facing separation of agent, sandbox, and thread. Its `virtual` provider uses `just-bash` with an in-memory filesystem and no native child process. That protects the host by emulating commands, not by creating an OS boundary (`packages/agent/src/sandbox.ts`, `sandbox-handle.ts`, `just-bash-env.ts`).

Its `host` provider invokes a same-user child process with `shell: true`; `isolation: 'external'` is a caller assertion, not enforcement (`packages/agent/src/sandbox.ts:427-471`). Vercel and custom providers own their security properties. Runcell does not enforce general CPU, memory, disk, process-count, or network limits. Host path checks are lexical and do not fully close symlink/reparse-point escapes.

The transplantable ideas are caller-owned lifecycle, explicit provider modes, validated snapshots, and consumer packaging proofs. The unsafe ideas are treating host execution or lexical path mapping as a sandbox.

### Cordis

Cordis `Context.isolate()` creates service/event namespaces and loader realms inside the same Node process (`packages/core/src/context.ts:55-76`, `packages/loader/src/config/isolate.ts:25-125`). Fibers track lifecycle and disposal but do not restrict filesystem, network, module, or process authority (`packages/core/src/fiber.ts:103-199`).

Cordis is useful as a model for lifecycle ownership and scoped dependency composition. Its isolation vocabulary must not be reused as evidence of security.

### DSH

DSH provides the strongest contract model. `ctx.sandbox.confine(argv, policy)` accepts exact argv, carries policy per call, returns enforcement facts, and refuses unavailable backends (`packages/sandbox/sandbox/src/index.ts:23-175`). It distinguishes command denial from runner failure and orders approval before any wider policy escalation (`sandbox/src/escalation.ts:143-187`).

Its local backends are honest about scope: bubblewrap, Landlock, and Seatbelt provide OS-enforced file-effect confinement on supported systems; Windows restricted-token/ACL support is explicitly partial (`sandbox-local/src/profiles.ts`, `sandbox-local/src/index.ts:168-186`). Worker threads provide budgets and crash containment but are explicitly not a security boundary. E2B provides a delegated remote boundary with its own operational assumptions.

DSH's strongest reusable properties are fail-closed selection, exact argv, per-control enforcement facts, structured error attribution, process-tree teardown, environment scrubbing, and hostile negative tests.

## Debate outcome

The security review rejected a built-in same-user or worker-thread sandbox as unsafe marketing. It recommended a Windows-first full backend based on Hyper-V-isolated/remote execution, with any local token/ACL/job implementation labeled partial until hostile tests prove otherwise.

The SDK review rejected returning only a wrapped argv because callers could bypass it with a raw spawner. The provider must own execution. It recommended separating ToolProvider discovery from tool execution and adding a sandbox-specific packed consumer proof.

Both reviews agreed that sandbox contracts belong in contracts plus optional providers, never in the kernel, and that trust level and enforcement strength must be separate dimensions.

## Panda design

### Public contracts

Add a dependency-free `SandboxProvider` contract with:

- exact `argv`, explicit `cwd`, sanitized environment, and immutable per-call policy;
- modes such as `read-only`, `workspace-write`, and explicit `danger-full-access`;
- per-control evidence for filesystem, network, process, and resources: `full`, `partial`, or `none`;
- provider identity, capability version, session identity, and caller-owned lifecycle;
- structured result classes for success, command denial, runner failure, timeout, abort, and unavailable backend;
- coded errors, including `PANDA_SANDBOX_UNAVAILABLE`;
- opaque file snapshots that validate paths before provider creation.

Do not add native APIs, child-process imports, FFI, Docker, bubblewrap, Landlock, Seatbelt, AppContainer, or E2B dependencies to contracts or kernel.

### Provider boundary

The provider owns process creation and all descendants. It must enforce or report the limits requested by the policy, cap output, scrub credentials, support cancellation, await quiescence, and make teardown idempotent. A missing or malformed enforcement report is a refusal, not a best-effort success.

Recommended enforcement vocabulary:

| Level | Meaning | Use |
| --- | --- | --- |
| `simulated` | In-process emulation/policy only | tests and explicit trusted development |
| `partial` | Same-host token/ACL/job/path controls | explicitly low-risk work |
| `os` | Kernel-enforced controls proven by probes | untrusted local work when controls cover the policy |
| `remote` | VM/microVM/remote substrate | hostile work and strongest isolation |

No scalar `secure: true` should hide missing controls. `danger-full-access` is explicit and auditable, never an automatic fallback.

### Windows strategy

The first full-strength Windows provider should delegate to a disposable Hyper-V-isolated or remote environment. Microsoft documents Hyper-V-isolated containers as providing a separate kernel and hardware-level boundary, unlike process-isolated containers; Windows Sandbox defaults must be overridden because networking and clipboard are enabled by default. Sources: [Secure Windows containers](https://learn.microsoft.com/en-us/virtualization/windowscontainers/manage-containers/container-security), [Isolation modes](https://learn.microsoft.com/en-us/virtualization/windowscontainers/manage-containers/hyperv-container), and [Windows Sandbox configuration](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-configure-using-wsb-file).

A same-host Windows provider may later combine restricted tokens, AppContainer, ACLs, Job Objects, handle scrubbing, reparse-point checks, and resource limits, but it remains `partial` until the hostile suite proves its exact claims. It must not be the secure fallback.

## Required gates before claiming a sandbox

- contract-only packed consumer can import policy/types without native dependencies;
- missing backend and failed probe prevent the target command from starting;
- actual workspace writes succeed only under `workspace-write`;
- host-secret reads, outside-root writes, symlink/junction/reparse/hard-link escapes, and device/UNC/ADS paths are denied;
- network denial is tested separately from filesystem denial;
- descendants die on cancellation and teardown; output, time, memory, file, and process limits are enforced or reported unavailable;
- runner failure is not reported as command denial;
- environment credentials are scrubbed by default;
- every provider declares per-control evidence and passes real packed-runtime probes;
- ToolProvider discovery remains separate from Tool execution.

## Explicit non-goals

- Cordis service isolation is not a security boundary.
- Worker threads are not a hostile-code sandbox.
- Path checks and ACLs alone are not full confinement.
- MethodPlugin remains trusted code loaded by panda; sandboxing does not retroactively make module top-level execution safe.
- No sandbox claim is made for a backend that has not passed real platform probes.

## Recommendation

Implement the sandbox as a new SDK capability with contracts first, then a provider-owned execution adapter and ToolProvider integration. Start with fail-closed orchestration and conformance tests. Add a full-strength Windows/remote backend as a separate provider rather than embedding platform security complexity in panda's microkernel.
