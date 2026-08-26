---
title: 'Executor selection for panda run'
type: 'feature'
created: '2026-08-25'
status: 'done'
review_loop_iteration: 1
baseline_commit: 'd89aa16'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/spec-2-0-session-composition-through-the-kernel.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-2-7a-panda-init-and-project-init.md'
  - '{project-root}/_bmad-output/planning-artifacts/ROADMAP-01-composition-first.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** panda's headline promise is "swap the agent, keep the workflow", and the binary cannot swap the agent. `runSession` falls back to `createClaudeCodeAdapter()` — a hardcoded constructor — and the Codex and OpenCode adapters, both with full trait records and vendor-conformance suites, are reachable only by a caller who constructs them itself. Two `deferred-work.md` entries name this story as their home. Separately, the kernel's layered configuration has shipped since Story 1.3 with zero production callers, which is the same condition that let a whole projection subsystem ship inert.

**Approach:** one selection resolved through the kernel's layered config — `defaults` → `global` → `project` → `invocation` — naming one of the three shipped adapters, handed to the session. The catalogue is keyed by each adapter's OWN `executorId` trait, never by a second list of names written beside them.

**The session does not read the filesystem.** `runSession` takes the selection already made; `resolveExecutor` is what reads configuration. Two reasons, both load-bearing. A session primitive whose behaviour depends on files under the running user's home is not usable from a host that already knows what it wants — and it would make every existing `panda run` test depend on the `~/.panda` of whoever runs the suite, which is a test that passes or fails for reasons having nothing to do with the code. Both functions ship from `@panda/session`, so FR-29 holds: the CLI parses argv, calls the two, maps the result to an exit code.

**A configuration panda cannot read is an error, not a default.** The whole point of the feature is running the agent the user chose. Falling back to claude-code because the config file was malformed runs a DIFFERENT agent silently — the exact failure this feature exists to remove, wearing the disguise of robustness.

## Boundaries & Constraints

**Always:** the selection resolves through `createLayeredConfig`, with panda's built-in default as the `defaults` LAYER and never as a constructor fallback; the catalogue is derived from the shipped trait records so a fourth adapter appears by being shipped, not by being listed twice; an unknown executor name fails with its own coded error naming every available one; the resolved selection AND the layer that decided it are reported, because a run whose output cannot tell you which agent produced it is not a swap you can trust; every existing `panda run` assertion keeps passing unmodified and machine-independently; `panda run` with nothing configured still runs Claude Code; the capability is reachable by importing `@panda/session` without `@panda/cli` (FR-29).

**Ask First:** any change to `ResultEnvelope`; a configuration format other than the JSON document panda already uses for its own state; per-executor options (model, flags, binary path) inside that configuration; detecting which executors are installed as part of SELECTION — `panda doctor` owns detection and this story does not make the selector probe.

**Never:** no hardcoded adapter constructor left on any path; no second list of executor names; no silent fallback when a configuration exists but cannot be used; no filesystem read inside `runSession`; no envelope shape difference between the three; no new command.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Nothing configured | No configuration at either scope | Claude Code runs; source is the `defaults` layer | N/A |
| Global configuration | The machine document selects codex | Codex runs; source `global` | N/A |
| Project overrides global | Both present, different values | Project wins; source `project` | N/A |
| Invocation overrides all | `--executor opencode` with both documents set | OpenCode runs; source `invocation` | N/A |
| Each really runs ITS vendor | One fake spawner, three selections | The spawned command and argv are that vendor's real ones | N/A |
| Envelope shape | The same prompt through each of the three | Identical key set and types across all three | N/A |
| Unknown name | An executor name panda has no adapter for | Non-zero, coded, listing every available id | Coded, not a crash |
| Malformed configuration | Invalid JSON, not an object, or a non-string selection | Coded error, exit 2, and NO fallback to the default | Coded |
| Hostile configuration | A prototype-polluting key in the document | Rejected by the layered config, coded | Coded |
| Absent vs unreadable | A missing file vs one that errors on read | Missing is an absent layer; unreadable is an error | Distinguished |
| Which one ran is visible | Any run | The selection and its deciding layer reach the user | N/A |
| Argv | `--executor` with no value; an unknown flag | Usage error, exit 2; unknown flags still rejected | N/A |
| Behaviour neutrality | Every existing `panda run` test | Passes unmodified, and does not read the real home directory | N/A |

</frozen-after-approval>

## Code Map

- `packages/session/src/executors.ts` -- NEW: the catalogue keyed by shipped traits, plus `resolveExecutor` over `createLayeredConfig`
- `packages/session/src/run-session.ts` -- `executorId` selects from the catalogue; the claude-code fallback stops being a constructor
- `packages/session/src/index.ts` -- export the resolver, its options and its result
- `packages/contracts/src/errors.ts` -- a code for "panda has no adapter by that name", distinct from the binary not spawning
- `packages/cli/src/run.ts` -- `--executor`, the resolve-then-run composition, the selection line, exit codes
- `packages/session/test/`, `packages/cli/test/run.test.ts` -- the matrix; the three-vendor argv proof; the existing suite unmodified

## Tasks & Acceptance

**Execution:**
- [x] Catalogue derived from the shipped trait records, with no second name list
- [x] `resolveExecutor` over the kernel's layered config, reporting the deciding layer
- [x] `runSession` selects from the catalogue; no hardcoded constructor remains
- [x] Unknown name and unusable configuration as distinct coded failures
- [x] CLI flag, composition, selection reporting, exit codes; existing assertions untouched
- [x] Every matrix row, including the per-vendor argv proof and the shape-identity proof

**Acceptance Criteria:**
- Given the three shipped adapters, when `panda run` selects one, then that executor runs the prompt and the envelope is identical in shape across all three
- And an unknown executor name exits non-zero listing the available ones
- And the default is resolved through the layered config, not a hardcoded constructor (FR-7, FR-9)
- And the same selection is reachable by importing `@panda/session` without `@panda/cli` (FR-29)

## Spec Change Log

Decisions the frozen block did not settle, taken during implementation.

**Two new error codes, not one.** `PANDA_EXECUTOR_NOT_FOUND` is the one the story
asked for. A SECOND, `PANDA_CONFIGURATION_UNUSABLE`, was added for "panda's own
configuration document exists and cannot be used". The Tasks list requires the
unknown name and the unusable configuration to be *distinct* coded failures, and
no existing code covers the second honestly: `executorUnavailable` means the
binary did not spawn, `environmentScopeUnavailable` means a scope DIRECTORY panda
was pointed at cannot be used, and `contractEnvelopeInvalid` is a request-shape
violation. Merging any of them with "your config file is corrupt" reproduces
exactly the argument the story makes against reusing `executorUnavailable` — two
failures with different fixes wearing one code. Both additions are additive.

**The `.panda/config.json` location is spelled in `@panda/session`, not reused
from `@panda/environment`.** `@panda/environment` owns the same `<scope>/.panda`
convention, but its `pandaDirOf` is private and its exported `scopeDirectory`
requires the directory to already EXIST — which is the wrong semantics here,
where a missing scope is an absent layer rather than an error. More decisively:
`@panda/environment` is CONSUMER tier and so is `@panda/session`, and
`packages/session/test/guard.test.ts` pins @panda/session's dependency set to
exactly four packages, so depending on it is an AD-2 violation the gate rejects.
The one-line `join(root, '.panda', 'config.json')` is therefore restated with a
`ponytail:` comment naming the duplication; the upgrade path is to move the
scope-directory convention down into `@panda/contracts` (shared tier) so both
consumers read one spelling.

**ENOENT and ENOTDIR are ABSENT; every other errno is an error.** The matrix
distinguishes "missing" from "errors on read" but not which errnos those are.
Both of these mean there is no such document — a parent that is a file reports
ENOENT on win32 and ENOTDIR on POSIX — while EISDIR, EACCES, ELOOP and the rest
mean something IS there and panda could not read it. Pinned both ways.

**The CLI's selection line is printed BEFORE the run, and is suppressed when the
caller supplied its own `createAdapter`.** Before the run, so it still reaches
the user when the run then fails or hangs. Suppressed under `createAdapter`,
because in that case panda selected nothing — the host handed it the executor —
so a selection line would be a false claim. `createAdapter` is an SDK/test seam
with no argv spelling, so every actual invocation of the binary reports. This is
also what keeps the two existing `expect(io.err).toHaveLength(0)` assertions in
`packages/cli/test/run.test.ts` passing unmodified; both of them inject an
adapter.

**Envelope shape identity is asserted on the envelope AND on `data`.** The matrix
says "identical key set and types". Read strictly on `envelope.data` too, using
each vendor's minimal real result record — which yields `{ result }` for all
three. The vendors' optional metadata traits (`subtype`/`session_id`,
`sessionID`) legitimately differ when present; the ENVELOPE contract does not.

**A hostile document is left to the kernel's own error.** A prototype-polluting
key surfaces as `PANDA_KERNEL_INVALID_LAYER` from `setLayer`, unwrapped. Wrapping
it would replace the kernel's code with panda's; the cost is that the message
does not name the file. ponytail: accepted, upgrade path is a `filePath` field on
`InvalidLayerError`.

**Test-suite home isolation.** `packages/cli/vitest.config.ts` +
`packages/cli/test/isolate-home.ts` point `HOME`/`USERPROFILE` at an empty temp
directory for every file in that package. Without it, every existing `panda run`
assertion — which passes `cwd` but no `homeDir` — would be decided by the
`~/.panda` of whoever ran the suite. Done in a setup file rather than in the test
files because the existing assertions must stay unmodified, and
`packages/cli/test/executor-selection.test.ts` carries the pin that fails if the
setup file is dropped.

**AGENTS.md.** The repository's `AGENTS.md` is untracked and currently contains
only a GitNexus block — no house rules. The rules applied were the ones supplied
with the task (English throughout, `.ts` on relative imports, AD-1/AD-2, no NUL
bytes, `ponytail:` on deliberate simplifications).

### Review round 1 — what did not hold, and what was measured

**The one line that makes the feature real had no guard.** Deleting
`executorId: selection.executorId,` from the CLI's `runSession({...})` call left
CLI 45/45, session 48/48, tsc 0 and eslint 0 green, while the real binary printed
`executor: codex (selected by the 'invocation' layer)` and ran claude-code
(confirmed with vendors installed, and again with PATH stripped:
`spawn claude ENOENT` under `--executor codex`). Every CLI test that reached an
executor injected `createAdapter`, which bypasses `executorId` by design; every
test that asserted the selection line used a provider that threw before an
adapter existed; and the three-vendor proof itself went through
`createAdapter: () => createExecutorAdapter(selection.executorId, { spawner })`,
so it exercised the catalogue and the traits and never the `executorId` → adapter
wiring. Closed by adding `SessionOptions.adapterOptions`
(`CliExecutorAdapterOptions`, threaded into `createExecutorAdapter`) and
forwarding it through `RunCommandOptions`, then rewriting both proofs to run with
NO `createAdapter`. The same seam makes `createExecutorAdapter`'s `options`
parameter live — a separate finding was that it had no production caller, so no
host could point panda at a binary off PATH. Re-measured after the fix: the same
deletion now fails three CLI clauses by assertion, naming `[ 'claude' ]` where
`[ 'codex' ]` was expected. `@panda/session` re-exports the spawner vocabulary
for the same reason it re-exports the rest: a seam whose type a consumer cannot
name is a seam it cannot use.

**A complete selection capability could live in the CLI with the gate green.** A
faithful CLI-owned selection — its own `['claude-code','codex','opencode']`
literal list, its own layered file reads, its own coded throws, `resolveExecutor`
removed from the imports — passed tsc, eslint, the byte guard, CLI 45/45 and
session 48/48. The thin-binding pin watches the dependency list and `@panda/*`
import specifiers, and owning selection needs neither, only `node:fs/promises`
and `node:path`. Closed structurally rather than by a text scan (one was already
tried and deleted on review for being evadable): `eslint.config.js` now forbids
`node:fs`, `node:fs/promises`, `fs` and `fs/promises` in `packages/cli/src/**`
and `packages/cli/bin/**`. The CLI legitimately needs no filesystem access at
all, and config-driven selection cannot be reimplemented there without one.
Verified: the planted import is rejected by `no-restricted-imports`.

**A deeply nested document threw an UNCODED RangeError.** The kernel's
`validateNode` recurses with no depth bound; ~3000 levels of nesting produced
`Maximum call stack size exceeded` with `error.code` undefined, so the CLI printed
six bare words with no `PANDA_*` prefix and no file path — exit 2 by accident on
the one input class the matrix says must be refused coded. Each `setLayer` for a
DOCUMENT is now wrapped and rethrown as `configurationUnusable` naming the file,
with the kernel's error as `cause`. The same wrapper fixes the related finding
that a `__proto__` document produced byte-identical stderr for the machine and
project files: `InvalidLayerError`'s first argument is the KEY, so
`PANDA_KERNEL_INVALID_LAYER: invalid configuration layer '__proto__'` named
neither the file nor a layer, and was actively misleading. Six of the seven
failure modes already named the file; the seventh was the security-relevant one.
Verified against the real binary.

**A UTF-8 BOM bricked `panda run`, and the message misdiagnosed it.**
`readFile(path,'utf8')` does not strip a BOM and `JSON.parse` rejects it, so a
BOM-prefixed VALID document failed with "it is not valid JSON" — the JSON was
valid, three invisible bytes were not. PowerShell 5.1's `>` and `Set-Content`,
Notepad and VS Code's "UTF-8 with BOM" all emit one by default on this platform,
and because the founding rule is no-silent-fallback this did not degrade, it
stopped the command. A leading mark is now stripped before parsing, reusing the
constant `packages/adapter-cli/src/traits.ts` already keeps for executor stdout.
Verified against the real binary.

**A dangling symlink was the one present-but-unusable state that fell back
silently.** `readFile` follows symlinks, so a `config.json` that exists as a
directory entry pointing at a missing target reports ENOENT and was treated as an
absent layer — panda then ran a different agent, in silence, which is the exact
clause the story is built on. Every dotfile manager (stow, chezmoi, dotbot)
materialises this file as a symlink and a broken link is their canonical failure.
`lstat` distinguishes the entry from the target; it costs one syscall on the
absent path only. Verified against the real binary.

**The home-isolation pin pinned nothing.** Deleting `packages/cli/vitest.config.ts`
entirely left the CLI suite 45/45 — it went red only on a machine that already had
a `~/.panda/config.json` naming a non-default executor, so the pin was itself
machine-dependent and could never fire on CI. The isolation IS load-bearing
(measured: a malformed `~/.panda/config.json` fails 9 of the 33 assertions in
`run.test.ts` without it), so it stays; what changed is that the mechanism is now
asserted directly — the resolved home is under `tmpdir()`, and a document written
THERE is picked up as the `global` layer, with the prefix check running first so
the write cannot land in a real home if the setup file is gone. `packages/session`
had no isolation at all despite owning `resolveExecutor`, and its file header
claimed a pin it did not have; it now has the same setup file, and the header says
what the clauses actually assert. Both setup files clean up after themselves — 22
orphaned temp directories were observed in `%TEMP%` from a handful of runs.

**The hostile-document guard was pinned for the project layer only.** Reducing the
GLOBAL document to just its `executor` key before `setLayer`, so the kernel never
saw the hostile keys, left session 48/48 green; the same mutation on the PROJECT
layer failed two clauses. Mirrored, and both now assert the file name and the
layer name.

**The per-layer type check was unpinned and its fallback named the wrong file.**
Disabling `typeof selected !== 'string'` left 48/48 and 45/45 green: bad values
fell through to the post-composition "unreachable" branch, which threw the same
code and happened to name the PROJECT path — which is where every fixture wrote.
Two real jobs were untested and are now pinned: a bad value in the GLOBAL document
names the global file and not the project one, and a bad global value overridden
by a good project value still errors. The fallback branch no longer guesses a
path at all, because the one it guessed told the user to fix a file that was fine.

**An unknown `executorId` cost a mkdir and left a workspace behind.**
`run-session.ts` states "an invalid request must cost no mkdir" and hoists the
prompt check above `provider.create()`; the catalogue lookup ran after the
workspace existed. `panda run` was shielded because `resolveExecutor` validates
first — the FR-29 path the spec promises was not. The lookup is hoisted beside the
prompt check, and a clause asserts the cwd is still empty afterwards.

**`homeDir: ''` relocated the machine scope into the working directory.**
`join('', '.panda', 'config.json')` is relative, so `process.env.HOME ?? ''` — the
exact shape 2.7a was bitten by, forwarded raw from the public
`RunCommandOptions.homeDir` — loaded the PROJECT file and reported it as the
`global` layer: a false claim on the one output this story exists to make
trustworthy. Both scope roots are now rejected coded when blank
(`PANDA_ENVIRONMENT_SCOPE_UNAVAILABLE`, the same code `@panda/environment` uses)
and resolved to absolute. Related and fixed in the same move: when the two roots
are the SAME directory (running `panda run` from your home), the one document was
loaded into both layers and reported as `project` though no project existed —
only `global` is set now.

**An explicit `--executor` was swallowed in silence under an injected adapter.**
`runPanda(['run','--executor','codex','hello'], {createAdapter})` exited 0 with
stderr completely empty. The suppression rule is right for an IMPLICIT selection —
panda selected nothing, the host handed it the executor — and wrong for an
explicit one, where the user typed the name, panda resolved it, and something else
ran. The invocation layer now reports `— overridden by the host-supplied adapter`.
The two existing `toHaveLength(0)` assertions pass no `--executor`, so they stay
green. Validation under injection was already correct and is unchanged: an unknown
name still exits 2 before the injected adapter runs.

**`panda run --help` was the only help in the binary that refused**, exiting 2
with `unrecognized option '--help'` while `init --help` and `project doctor -h`
both worked — and `panda run -h` SPAWNED the executor with the prompt `-h`, a
real billed agent invocation for a typo. Pre-existing, but this story made `run`
the only subcommand with flags, so `--help` is now the natural way to read the
documentation it added. `--help` anywhere is help (every other `--` token is
already a usage error, so it cannot be prompt text); `-h` only as the whole
argument list, because a single dash is legitimate inside a prompt and
`panda run explain -h please` must stay a prompt. Both pinned.

**`--executor` could not rescue an unusable configuration, and the help said it
could.** `readConfigDocument` throws before composition, so the invocation layer
never gets its chance. Refusing is correct on the story's own principle — panda
must not route around a document it cannot read — so the USAGE text was reworded
rather than a short-circuit added.

**Envelope shape identity did not compare types inside `data`.** Making codex
return `data.result` as a number while the others returned a string left the proof
green; it compared only `Object.keys(data).sort()`. It now compares the type of
every value inside `data`, and a second clause compares the FAILURE path across
all three — each vendor reports failure in its own vocabulary (claude's
`is_error`, codex's `message`, opencode's OBJECT `error`) and the envelope must
not.

**Smaller corrections.** The FR-29 consumer proof now covers `resolveExecutor`
through `index.ts`, because the executor tests import `../src/executors.ts`
directly and dropping the re-export left them green. The available-id assertion is
exact rather than a substring (`toContain('codex')` also passes for `codex-2`).
`--executor=-x` now takes the same dash guard as `--executor -x`. A selection
value is trimmed, so an editor's trailing newline works and a blank one is named
as blank instead of arriving as `panda has no adapter named '   '`.
`ExecutorSelection.available` keeps its field and loses its overstated
justification: the CLI does not print it, because on the one path where a user
needs the list the coded error's own message carries it. `packages/cli/README.md`
documents the flag, the document location, the layer table, the two new codes,
and the fact that every real invocation now writes a line to stderr — a behaviour
change for any script treating non-empty stderr as failure.

**Not fixed, filed instead.** `panda doctor` certifies a machine `panda run` then
refuses (`{"executor": 7}` in `~/.panda/config.json`: doctor exits 0 with empty
stderr, run exits 2). Reproduced, and `run.test.ts` already pins this invariant
class for `init`. Not closed because `diagnose` and `resolveExecutor` are both
consumer tier and AD-2 forbids the edge, while duplicating the reader inside
`@panda/environment` is the second-implementation failure correction-01 forbids.
Recorded in `deferred-work.md` with the same upgrade path as the
`.panda/config.json` spelling: move the convention down into `@panda/contracts`.

**Deliberately not done, on review's own instruction:** case-folding executor
names, a configuration file size bound, an upward directory walk for the project
scope (`@panda/environment` uses the same no-walk convention), and a warning on
duplicate `--executor` flags (last-wins is standard).

**Triage, the patch changed a second thing and pinned only the first (patch):**
hoisting the catalogue lookup above `provider.create()` also moved the
`createAdapter` CALL above it, so a throwing adapter factory stopped leasing a
workspace and unwinding through release/dispose. That is the better behaviour
and it was unpinned, which is the same shape Story 2.0 corrected when a throwing
`createProvider` silently went from an unhandled rejection to exit 2. Pinned as
ORDERING — the provider factory is never reached and the cwd stays empty — and
verified by the reverse mutation: restoring the old position fails it.

## Design Notes

**Why the catalogue is keyed by the traits.** Story 2.7a shipped an executor that was never once exercised, because a second list of names drifted from the thing it named. The adapters already carry `executorId` in their trait records; the catalogue reads it from there, so a name that exists is a name that runs.

**Why provenance comes from the layered config's own dump.** It already tracks which layer supplied every composed leaf. Computing "where did this come from" a second time is how a report starts disagreeing with the thing it reports on — the same argument that made `panda doctor` an inspection mode rather than a second implementation.

**Deliberately not built.** No per-executor options, no binary-path override in configuration, no probing, no envelope change, no new command.

## Verification

**Commands:**
- `pnpm check` -- expected: fully green, with the existing CLI and session suites passing unmodified
