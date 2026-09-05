# The MethodPlugin contract

A **MethodPlugin** packages a development methodology — its phases, the
artifacts it produces, the commands it offers — as something panda can load.
This is the whole contract. Everything an author needs is on this page and in
the types `@skanl/panda-contracts` exports; you should never have to read panda's
source to write one.

Implements FR-23 / RD-3.

```ts
import { activateMethod, validateMethodPlugin, type MethodPlugin } from '@skanl/panda-contracts'
```

## The shape

A MethodPlugin **is** its manifest plus an optional pair of lifecycle hooks —
one object, one validator.

```ts
const tdd = {
  id: 'tdd',
  version: '1.0.0',
  description: 'Red, green, refactor.',      // optional
  phases: [
    { id: 'red', description: 'write the failing test' },
    { id: 'green', description: 'make it pass' },
    { id: 'refactor' },
  ],
  artifacts: [
    { id: 'plan', path: 'docs/plan.md', phase: 'red' },
  ],
  commands: [
    { id: 'tdd.start', summary: 'begin a cycle', phase: 'red' },
  ],
  onActivate: async () => { /* mount */ },   // optional, but see "the pair"
  onDeactivate: async () => { /* unmount */ },
  extensions: { 'my-vendor': { anything: true } },  // optional
}

validateMethodPlugin(tdd)   // returns it typed, or throws PANDA_METHOD_INVALID_PLUGIN
```

### Root fields

| Field | Required | Rule |
|---|---|---|
| `id` | yes | Non-empty string. The method's identity. |
| `version` | yes | **Semver** — see below. |
| `description` | no | Non-empty string when present. |
| `phases` | yes | Array of phases. May be empty; write `phases: []`, do not omit it. |
| `artifacts` | yes | Array of artifact conventions. May be empty. |
| `commands` | yes | Array of command definitions. May be empty. |
| `onActivate` | no | Function. See *the pair*. |
| `onDeactivate` | no | Function. See *the pair*. |
| `extensions` | no | Object. The one place payloads panda does not define may live. |

**Any other key at the root is rejected.** That is deliberate, and it is the same
envelope discipline the registry entry uses: the shape can grow canonically
instead of drifting silently, and anything vendor-specific has exactly one home
(`extensions`). The key list is published as `METHOD_PLUGIN_ROOT_KEYS`, so you
can enumerate it rather than guess.

### Phases

```ts
{ id: string, description?: string }
```

Declaration order **is** the phase order; there is no ordering field. Phase ids
must be unique within the manifest.

### Artifacts

```ts
{ id: string, path: string, phase?: string }
```

An artifact is a **convention**, not a claim that the file exists: `path` says
where the methodology puts the thing, relative to the project root. `path` is
required, because a declared artifact with no location states nothing anyone can
act on. Artifact ids must be unique.

**"Relative to the project root" is enforced, not advisory.** This is the field
artifacts are later materialised from, so the rule is checked rather than
trusted. The predicate is exported as `isProjectRelativePath(value)` — check a
path before you ship it instead of learning the rule from a rejection.

| Accepted | Rejected |
|---|---|
| `docs/plan.md` | `/etc/passwd` — no leading `/` (this covers `//server/share` too) |
| `./docs/plan.md` | `C:/Windows`, `C:x` — no drive letter, absolute or drive-relative |
| `a/b/../../c` — `..` inside the base is fine | `../../etc` — it must not climb above the project root |
| `docs/` | `~/secrets` — a leading `~` is a reserved marker |
| | `a/..` — resolves to the project root, which names no artifact |
| | `docs\plan.md` — see the separator rule below |
| | anything containing a NUL byte |

**The separator is `/` on every platform**, and a backslash is rejected rather
than translated. `docs\plan.md` is a nested file on Windows and a single flat
filename on POSIX — the same manifest meaning two different things depending on
who reads it. Your manifest is authored once and consumed everywhere, so it gets
one meaning. The cost, stated plainly: you cannot declare a POSIX filename that
contains a literal backslash.

Panda validates `path` and stores it **verbatim** — it never rewrites it.

### Commands

```ts
{ id: string, summary?: string, phase?: string }
```

`id` is the command's identity and must be unique — a manifest with two
`tdd.start` commands is rejected. `summary` is optional but recommended: it is
what a person reads when the command is listed.

### Phase references

`phase` on an artifact or a command must name a phase the **same manifest**
declares. A reference to an undeclared phase is rejected, and the rejection
lists the phases that do exist.

### Unknown keys inside phases, artifacts and commands

Collection items are strict too, and they have **no `extensions` hatch of their
own** — the root's is the single reserved namespace. So `{ id: 'red',
descripton: '...' }` is a rejection, not a field that silently does nothing.

## Versions are semver

`version` must be `major.minor.patch`, optionally `-prerelease` and `+build`.

| Accepted | Rejected |
|---|---|
| `1.0.0`, `0.0.0`, `10.20.30` | `1.2` — too few parts |
| `1.0.0-rc.1`, `1.0.0-alpha` | `v1.0.0` — no prefixes |
| `1.0.0+build.5` | `latest` — a dist-tag is not a version |
| `1.0.0-rc.1+build.5` | `01.0.0` — no leading zeros |
| | `^1.0.0` — a range is not a version |

Every panda Contract versions together under one semver major (NFR-8), and a
version that cannot be ordered against another cannot take part in that policy.
The predicate is exported as `isSemver(value)`, and the pattern as
`SEMVER_PATTERN`, so you can check a version before you ship it.

The kernel enforces the identical rule on a `PluginManifest.version`.

## The pair

RD-3 gives this contract **exactly two lifecycle hooks and no more** —
`onActivate` and `onDeactivate`. There is no `onPhaseEnter`, no `onCommand`, no
`beforeUnload`; the PRD's rule is *no further hooks until a second real
methodology implementation demands them*.

```ts
type MethodActivateHook = () => void | Promise<void>
type MethodDeactivateHook = () => void | Promise<void>
```

Both take **no argument**. What panda would hand a method on activation belongs
to `panda swap method` (FR-28 / Story 5.4), and deciding it here would decide it
for that story.

Either declare **both** hooks or **neither**. A mount with no unmount cannot be
undone; an unmount with no mount disposes something that was never registered.
Both halves are rejected the same way.

This one is in the **type**, so in TypeScript a half-pair never compiles — you
do not have to run the validator to find out:

```ts
const bad: MethodPlugin = { ...manifest, onActivate: mount }
//                                        ~~~~~~~~~~ 'onDeactivate' is missing
```

Hooks may be async. Anything they set up is theirs to tear down.

## What the compiler catches, and what only the validator does

A clean compile is not a valid manifest. Here is exactly where the line falls,
so you know what you have not yet been told:

| Rule | Compiler | Validator |
|---|---|---|
| Missing or wrongly-typed required field | ✅ | ✅ |
| Unknown key at the root or on a collection item | ✅ | ✅ |
| The `onActivate` / `onDeactivate` pair | ✅ | ✅ |
| `version` is semver | — | ✅ |
| `path` is project-relative | — | ✅ |
| Ids unique within a collection | — | ✅ |
| `phase` names a phase this manifest declares | — | ✅ |

**Why `version` is not in the type.** The only type-level spelling available is
`` `${number}.${number}.${number}` ``, and it was measured to accept `01.0.0`,
`-1.0.0` and `1e3.0.0` while **rejecting** `1.0.0-rc.1` and `1.0.0+build.5`. A
type that breaks the build of an author publishing a legitimate prerelease is
worse than no type at all, so semver stays a runtime rule. Use `isSemver` if you
want it early.

Everything in the right-hand column is a value question — it depends on what the
string says, not on its type — so run `validateMethodPlugin` (or
`methodPluginIssues`) in your own tests. It reports **every** violation at once,
not the first.

## Activating

```ts
const activation = await activateMethod(tdd)
// activation.id === 'tdd'
await activation.deactivate()
await activation.deactivate()   // no-op; the hook runs at most once
```

`activateMethod` validates first, then runs `onActivate`, then hands you the
handle that unmounts it. The handle **is** the disposer — the same rule the
kernel applies to a plugin registration — so nothing else in the product can
deactivate a method it did not activate.

- A second `deactivate()` is a no-op, mirroring the kernel's double-dispose rule.
  Concurrent calls collapse into one run.
- If `onActivate` throws, `activateMethod` raises `PANDA_METHOD_HOOK_FAILED` and
  **no handle is returned**, so `onDeactivate` can never run for an activation
  that did not happen. Undoing whatever the hook did before it threw is the
  hook's own business — panda cannot know what it started.
- If `onDeactivate` throws, the rejection is coded the same way and the hook is
  **not** retried: the method is already considered unmounted, exactly as the
  kernel marks a plugin disposed even when its disposer threw.

## Errors

Every rejection is a `PandaError` with a `code`:

| Code | Raised by | Means |
|---|---|---|
| `PANDA_METHOD_INVALID_PLUGIN` | `validateMethodPlugin`, `activateMethod` | The value does not satisfy this contract. The message lists **every** violation, not just the first. |
| `PANDA_METHOD_HOOK_FAILED` | `activateMethod`, `deactivate()` | A hook threw. The message names the method and the hook; the original error is on `cause`. |

Constants live on `PANDA_ERROR_CODES` (`methodInvalidPlugin`, `methodHookFailed`).

## Validation kit

Three ways to ask the same question — pick the one that fits your call site:

```ts
validateMethodPlugin(value)   // → MethodPlugin, or throws PANDA_METHOD_INVALID_PLUGIN
methodPluginIssues(value)     // → StandardSchemaIssue[]; empty array means valid
METHOD_PLUGIN_SCHEMA          // → Standard Schema v1: { value } | { issues }
```

`METHOD_PLUGIN_SCHEMA` is a plain [Standard Schema v1](https://standardschema.dev)
object, like every other contract here, so it drops into any tool that speaks
that interface:

```ts
const result = METHOD_PLUGIN_SCHEMA['~standard'].validate(value)
if (result.issues) console.error(result.issues.map((i) => i.message).join('\n'))
```

## Everything this package exports for methods

Values: `activateMethod`, `validateMethodPlugin`, `methodPluginIssues`,
`METHOD_PLUGIN_SCHEMA`, `METHOD_PLUGIN_ROOT_KEYS`, `isSemver`, `SEMVER_PATTERN`,
`isProjectRelativePath`, plus `PandaError` and `PANDA_ERROR_CODES`.

Types: `MethodPlugin`, `MethodManifest`, `MethodHookPair`, `MethodPhase`,
`MethodArtifact`, `MethodCommand`, `MethodActivateHook`, `MethodDeactivateHook`,
`MethodActivation`.

`MethodPlugin` **is** `MethodManifest & MethodHookPair` — the declarative half
and the pair rule. The two halves are exported because the pair rule is a union
and TypeScript needs both names to emit the declaration; write your manifests
against `MethodPlugin` and you will not need either directly.

## Not in this contract

Selecting a method, persisting that selection, and swapping one method for
another (`panda swap method`) are FR-28 / Story 5.4. This contract defines what a
method *is* and how it mounts and unmounts; it does not decide who mounts it.
