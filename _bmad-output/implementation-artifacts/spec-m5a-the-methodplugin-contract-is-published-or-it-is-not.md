# M5.A — The MethodPlugin contract is published, or it is not

Status: FROZEN after approval. Changes go in the Spec Change Log, never silently.

Implements Story 5.3 / FR-23 / RD-3. **Story 5.4 (hot swap, FR-28) is OUT OF
SCOPE.**

## Intent

The owner's named differentiator is that panda packages a *methodology* as a
loadable plugin. Everything it needs is now unblocked: the kernel mounts plugins
in production (`createKernel` → `loadPlugins`, `lifecycle.ts:180`), and
`PluginManifest` already has 30 dependent symbols including
`createRegistryPlugin`. What is missing is the contract a third party would
write against.

FR-23 asks for four things. Measured against the shipped code:

| FR-23 asks for | today |
|---|---|
| manifest schema (identity, phases, artifacts) | nothing |
| command definitions | nothing |
| `onActivate` / `onDeactivate` pair | only `dispose?` exists |
| validation kit, published | `validateManifest` is kernel-internal |
| semver-versioned | `version` is "a non-empty trimmed string" |

The last row is a promise the code makes about itself, in
`packages/kernel/src/manifest.ts`: *"Semver enforcement arrives with the
MethodPlugin contract in a later story."* This is that story.

**Checked and NOT a gap:** FR-2 ("reversible registration lifecycle") is marked
done with only `dispose?`, which looked like this milestone's recurring defect.
It is not — FR-2 reads *"every registration paired with a disposer; teardown
unwinds reverse order; double-dispose no-op; post-dispose ops raise typed
inactive error"*, and `dispose?` / `disposer?` / `disposed[]` /
`PluginInactiveError` deliver exactly that. `onActivate`/`onDeactivate` is new
surface RD-3 asks for, not something FR-2 failed to build.

## The spine — "published" is a claim about someone who is not us

Story 5.3's acceptance criterion is already falsification-shaped and must be
honoured literally:

> **Given** only the published kit and docs
> **When** a minimal sample MethodPlugin is written
> **Then** it passes validation

A sample written by the person who wrote the contract, with the source open
beside them, proves nothing about publication. **The sample MUST be authored
against the published surface alone** — the package's exported types, its
validation kit, and its documentation — by someone who did not read the
implementation. The orchestrator will commission it that way.

Whatever the sample author cannot do without reading `src/` is the part that is
not published yet, and the finding is the missing documentation or export, never
the author's failure.

## Boundaries & Constraints

- **AD-1 is absolute:** the kernel has zero runtime dependencies and never
  imports `@skanl/panda-contracts`. The MethodPlugin contract is a Contract, so it
  lives in `@skanl/panda-contracts`; the kernel's `PluginManifest` is not moved and
  not made to depend on it.
- **RD-3 caps the surface: EXACTLY two lifecycle hooks.** `onActivate` and
  `onDeactivate`, nothing else — the PRD says *"no further hooks until a second
  real methodology implementation demands them"*. A third hook is out of scope
  even if it looks obviously useful.
- Validation is Standard Schema v1, like every other contract here.
- Do NOT build hot swap, `panda swap method`, or persistence of the selection.
  That is Story 5.4 and this story must not pre-empt its design.
- Relative imports carry `.ts`.

## I/O & Edge-Case Matrix

| # | Input | Expected |
|---|---|---|
| 1 | A minimal valid method manifest | Accepted; identity, phases, artifacts and commands round-trip |
| 2 | A manifest missing any required field | Rejected coded, naming the field |
| 3 | Unknown key at the manifest root | Rejected — same reserved-`extensions` discipline the registry envelope uses |
| 4 | `version: "1.2"` / `"v1.0.0"` / `"latest"` | Rejected as non-semver |
| 5 | `version: "1.0.0-rc.1"` | Accepted — prerelease is valid semver |
| 6 | A command definition with no identity, or two commands sharing an id | Rejected coded |
| 7 | `onActivate` present, `onDeactivate` absent | Rejected — RD-3 says the PAIR, and a mount with no unmount is what 5.4 will need |
| 8 | A method that activates, then deactivates | `onDeactivate` runs; a second deactivate is a no-op, mirroring the kernel's double-dispose rule |
| 9 | `onActivate` throws | Coded, the method is not left half-mounted, and the error names the method |

## Code Map

- `packages/contracts/src/method.ts` — **new.** The manifest type, its Standard Schema validator, the hook pair's types, and the command-definition type.
- `packages/contracts/src/index.ts` — export the kit.
- `packages/kernel/src/manifest.ts` — semver for `version` (see Ask First).
- A sample under a path the sample author chooses; it must not be wired into any package's build.

## Tasks & Acceptance

**T1 — the contract.** AC: matrix rows 1–7.

**T2 — the hook pair.** AC: rows 8, 9. Mirror the kernel's existing
register-with-disposer semantics rather than inventing new ones; RD-3 says the
pair exists *"mirroring the kernel's register-with-disposer rule"*.

**T3 — semver.** AC: rows 4, 5. **Falsification:** show `version: "1.2"` accepted
BEFORE the change and rejected after, both captured verbatim. The comment in
`manifest.ts` that promises this must be updated to describe what now happens,
or deleted — a comment that still promises a future is a comment that lies.

**T4 — the published surface is real.** AC: the sample described in the spine,
written against the published surface alone, passes validation unmodified. The
deliverable is BOTH the sample and **the list of everything its author had to
guess, could not find, or had to read `src/` for.** That list is the finding.

**Ask First (frozen):** semver enforcement lives in `packages/kernel/src/manifest.ts`,
which has ZERO runtime dependencies and may never import `@skanl/panda-contracts`. If
enforcing semver there would require a dependency, or would require moving the
check into contracts and thereby splitting manifest validation across two
packages, STOP and report the options with their costs. Do not add a dependency
to the kernel and do not split the validation without saying so first.

## Spec Change Log

(empty at freeze)

## Design Notes

The measurement was taken with codegraph against panda's own index (146 files,
1,875 nodes, 8,367 edges) after a sync. Note for future sessions: the codegraph
MCP tool resolves the index by the SESSION's working directory, not by its
`path` argument, so from a session rooted elsewhere it silently answers about a
different repository. The upstream CLI run from inside the repo is correct and
is what these numbers come from.

## Verification

### T3 falsification — `version: "1.2"` before and after

**Ask First: not triggered.** Enforcing semver in `packages/kernel/src/manifest.ts`
needed no dependency and no split. The rule is a regular expression — the
recommended semver.org pattern, verbatim — evaluated inside the existing
`validateManifest`, so the kernel keeps its zero runtime dependencies, never
imports `@skanl/panda-contracts`, and manifest validation stays whole in one function.
`@skanl/panda-contracts` carries its own copy of the same pattern for a MethodPlugin's
`version` (AD-1 forbids the kernel the reverse direction), and
`packages/contracts/test/method.test.ts` asserts the two copies agree on an
18-string corpus, so the duplication cannot drift silently.

The probe below was run against `packages/kernel/src/manifest.ts` through
Node's native type stripping, before and after the change, from a script under
`.scratch/` (removed afterwards). Output is verbatim.

BEFORE (`node .scratch/m5a-version-probe.mjs`, Node 24.14.1):

```
ACCEPTED  version: "1.2" -> stored "1.2"
ACCEPTED  version: "v1.0.0" -> stored "v1.0.0"
ACCEPTED  version: "latest" -> stored "latest"
ACCEPTED  version: "1.0.0-rc.1" -> stored "1.0.0-rc.1"
ACCEPTED  version: "1.0.0" -> stored "1.0.0"
ACCEPTED  version: "not.a.semver-at.all" -> stored "not.a.semver-at.all"
```

BEFORE, the kernel's own suite (`vitest run test/manifest.test.ts -t "loose version"`):

```
 Test Files  1 passed (1)
      Tests  1 passed | 23 skipped (24)
```

— the passing clause being `accepts loose version strings pending future semver
enforcement`, which asserted `'banana'`, `'1'` and `'not.a.semver-at.all'` all
round-tripped.

AFTER (same probe, Node 24.14.1; byte-identical on Node 26.8.1):

```
REJECTED  version: "1.2" -> PANDA_KERNEL_MANIFEST_INVALID invalid plugin manifest: 'version' must be a semver version (major.minor.patch, optional -prerelease and +build); got '1.2'
REJECTED  version: "v1.0.0" -> PANDA_KERNEL_MANIFEST_INVALID invalid plugin manifest: 'version' must be a semver version (major.minor.patch, optional -prerelease and +build); got 'v1.0.0'
REJECTED  version: "latest" -> PANDA_KERNEL_MANIFEST_INVALID invalid plugin manifest: 'version' must be a semver version (major.minor.patch, optional -prerelease and +build); got 'latest'
ACCEPTED  version: "1.0.0-rc.1" -> stored "1.0.0-rc.1"
ACCEPTED  version: "1.0.0" -> stored "1.0.0"
REJECTED  version: "not.a.semver-at.all" -> PANDA_KERNEL_MANIFEST_INVALID invalid plugin manifest: 'version' must be a semver version (major.minor.patch, optional -prerelease and +build); got 'not.a.semver-at.all'
```

Matrix row 4 rejected, row 5 accepted, on both Node versions.

**The comment that promised this no longer promises anything.**
`packages/kernel/src/manifest.ts` said *"Intentionally loose for now: any
non-empty trimmed string. Semver enforcement arrives with the MethodPlugin
contract in a later story."* It now describes what happens: the accepted grammar,
the rejected spellings, the trim that precedes the check, and why NFR-8 needs an
orderable version. The `accepts loose version strings pending future semver
enforcement` clause in `packages/kernel/test/manifest.test.ts` is replaced by
eight rejection rows and five acceptance rows.

### Published surface (T1, T2, T4 contract half)

Everything below is reachable from `import … from '@skanl/panda-contracts'`; nothing
requires reading `src/`.

- Values: `validateMethodPlugin`, `methodPluginIssues`, `METHOD_PLUGIN_SCHEMA`,
  `METHOD_PLUGIN_ROOT_KEYS`, `activateMethod`, `isSemver`, `SEMVER_PATTERN`.
- Types: `MethodPlugin`, `MethodPhase`, `MethodArtifact`, `MethodCommand`,
  `MethodActivateHook`, `MethodDeactivateHook`, `MethodActivation`.
- Codes: `PANDA_ERROR_CODES.methodInvalidPlugin` (`PANDA_METHOD_INVALID_PLUGIN`),
  `PANDA_ERROR_CODES.methodHookFailed` (`PANDA_METHOD_HOOK_FAILED`).
- Documentation: `packages/contracts/METHOD-PLUGIN.md`, listed in the package's
  `files` so it ships with the tarball (npm auto-includes only `README.md`).

RD-3's cap is honoured literally: two hooks, `onActivate` and `onDeactivate`, and
no third. Story 5.4 is not pre-empted — nothing here selects a method, persists a
selection, or swaps one for another.

### Matrix coverage

`packages/contracts/test/method.test.ts`, 52 clauses, one describe block per
matrix row: row 1 (round-trip, empty collections, the Standard Schema surface),
row 2 (each required field named when absent, non-object input), row 3 (unknown
root key pointing at `extensions`, unknown key on a collection item, published
root-key set), rows 4–5 (an 18-string version corpus, plus the kernel-parity
clause), row 6 (command identity, duplicate ids across all three collections,
undeclared phase references), row 7 (both directions of the half-pair, a hook
that is not a function), row 8 (activate then deactivate, double-deactivate
no-op, concurrent deactivations collapsing, a throwing `onDeactivate` that is not
retried), row 9 (`onActivate` throwing sync and rejecting async — coded, naming
the method and the hook, `cause` preserved, and no handle returned).

### Gate

`node scripts/check-source-bytes.mjs` ok; `pnpm typecheck` all nine packages
Done; `pnpm lint` no issues.

`pnpm test` aborts at `@skanl/panda-adapter-cli`, whose two live opencode rows fail
with HTTP 403 `DataPolicyError` ("This model collects data used to improve its
quality and requires explicit opt in") — the same environmental refusal recorded
in the M4.F ledger entry, unrelated to this story. The remaining packages were
run individually, as the repository's own instructions prescribe:

| package | Node 24.14.1 | Node 26.8.1 |
|---|---|---|
| cli | 108 passed | 108 passed |
| contracts | 117 passed | 117 passed |
| environment | 100 passed | 100 passed |
| kernel | 229 passed | 229 passed |
| projection | 248 passed, 3 skipped | 248 passed, 3 skipped |
| registry | 68 passed | 68 passed |
| session | 89 passed | 89 passed |
| workspace-local | 23 passed | 23 passed |
| adapter-cli (live rows excluded) | — | 136 passed, 8 skipped |

**One real defect the gate caught, and it was not a version.**
`packages/cli/test/printed-commands.test.ts` — M4.D's *"nothing panda prints is a
command panda does not have"* guard — went red on the first full run:

```
these name a command the binary does not dispatch: expected [ Array(1) ] to deeply equal []
+   "'panda swap method' in C:\\code\\panda\\packages\\contracts\\src\\method.ts names 'panda swap'"
```

A doc comment explaining why `MethodActivateHook` takes no argument had named
Story 5.4's verb in backticks, in shipped source. Fixed by naming the story
rather than the command. Worth recording: the guard scans `.ts` only, so
`METHOD-PLUGIN.md` still names that verb freely (see the deferred-work ledger).

### T4 — the blind sample, and what it cost its author

Commissioned as the spine requires: an author who read ONLY `METHOD-PLUGIN.md`
and the export list in `src/index.ts`, forbidden from opening `method.ts`, any
test, or this spec.

**The sample validated FIRST TRY** — `issues: []`, activation and double
deactivation clean, `tsc --noEmit` exit 0, with a deliberately awkward
`0.3.1-rc.2+build.7`. Zero contract errors, zero re-guesses. The error messages
were rated self-sufficient: the author graded them deliberately and never needed
the source to fix a probe.

So the contract passes. The deliverable is what the author still had to guess,
and it is all documentation debt:

1. **FALSE AS WRITTEN, and the one to fix first.** The doc states `path` is
   "relative to the project root" inside a rules section. It is NOT enforced:
   `path: 'C:/tmp/spec.md'` and `path: '../../etc/passwd'` are both ACCEPTED.
   This is the one field artifacts are later materialised from, so it is exactly
   where traversal matters. Either enforce it or say "by convention; not
   validated".
2. **The type catches the wrong half.** The `MethodPlugin` type rejects unknown
   root keys, unknown phase keys, a missing `artifacts` and hook arity — but
   silently accepts `onActivate` with no `onDeactivate`, and a non-semver
   `version`. The pair rule is what the doc warns hardest about and the one the
   compiler lets through. The doc never says which invariants are compile-time.
3. **No install line.** `--conditions=panda-source` appears nowhere, so an author
   following the page verbatim gets `ERR_MODULE_NOT_FOUND`. The page opens by
   promising "everything an author needs is on this page".
4. `extensions` is documented as "Object" with a nested-object example; in fact
   any value passes and only `null`/arrays are rejected.
5. The non-empty-string rule is stated for the root `description` alone but
   governs seven fields.
6. `MethodActivation`'s surface is example-only, and the handle is an unfrozen
   plain object — `deactivate` can be copied off, which is weaker than the
   doc's "nothing else can deactivate a method it did not activate" implies.
7. Standard Schema issues carry no `path`; locations live in prose inside
   `message`. Worth stating for anyone wiring this into a Standard Schema tool.
8. Getting both a throw and a machine-readable list means validating twice.
9. Id uniqueness is per collection, not per manifest — an artifact and a command
   may share an id.
10. "Returns it typed" does not say whether the same reference or a clone comes
    back. It is the same reference.

None of these are reachable by an author who can read `src/`. That is the whole
argument for commissioning the sample blind, and it is why the AC is phrased
"given ONLY the published kit and docs".
