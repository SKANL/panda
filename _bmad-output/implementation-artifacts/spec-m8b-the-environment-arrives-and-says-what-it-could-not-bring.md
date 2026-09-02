# Spec M8.B — the environment arrives, and says what it could not bring

**Status:** FROZEN
**Implements:** Story 5.2 / FR-22 / FR-25 — `panda import`, the other half of
Epic 5's portability promise (UJ-2, S4)
**Created:** 2026-09-01

---

## Intent

M8.A gave panda a portable artifact. Nothing can read one back, so the promise
is half a bridge: a user can package their environment and cannot unpack it.

Story 5.2 asks for four things — install, re-project, list what needs a secret,
and refuse a bundle from a newer build by name. Three of them have their
mechanism already: the `omitted` list M8.A records IS the pending list, the
`version` field IS the compatibility check, and `initMachine` IS the
re-projection.

The fourth thing is not in the story text and is what makes it real. **A bundle
written on Windows currently cannot be used on Linux.** `normalizeRegistryEntryPaths`
replaces the home prefix and leaves the remainder verbatim, so the artifact
carries `~/skills\commit-lint.ts`; on POSIX the expander's `join` reads that
backslash as part of the filename. The story's own criterion is *"doctor reports
zero drift"* on the other machine, and it cannot hold across platforms while that
is true. `deferred-work.md` recorded it during M8.A with the words *"belongs in
the story that needs it"*. This is that story.

## The measurement this rests on

Executed on 2026-09-01 at `d9859e0`. Behavioural claims come from running code.

1. **The pending list already exists.** M8.A writes `omitted: [{type, id, field}]`
   into every bundle, carrying no value. FR-22's *"entries requiring secrets are
   listed as pending manual action"* is a projection of that array, not a new
   computation.

2. **The compatibility check already has its field.** `BUNDLE_VERSION = 1` and
   `BUNDLE_KIND = 'panda-bundle'` are in the artifact. Story 5.2's criterion is
   *"importing a newer **schema-major** Bundle exits non-zero naming the
   incompatibility"* — the same shape as `STORE_VERSION`'s equality check
   (`packages/registry/src/store.ts:325-331`).

3. **Re-projection is one call.** `initMachine({homeDir})`
   (`packages/environment/src/init.ts:900-910`) binds the home, prepares the
   scope and runs the projection in `apply` mode, returning an `InitResult` with
   `detected`, `targets` and `skills`. `runInit` in the CLI
   (`packages/cli/src/run.ts`) already owns the whole reporting of that result —
   the no-executor exit 2, the per-target failure lines, `reportDiagnostics`. A
   second implementation of that reporting would be a second answer to one
   question.

4. **Installing a duplicate REPLACES it, silently.**
   `RegistryStore.register` persists by filtering out the same `entryKey` and
   appending (`store.ts:130-132`). So an import onto a machine that already has
   an entry with that `type:id` overwrites it and nothing says so. See D3.

5. **A bundle's entries must be validated on the way in, retired types
   included.** `registryEntryIssues(value, admitRetired)`
   (`packages/contracts/src/registry.ts:204`) is the same validator the store's
   read path uses, and `admitRetired` is why removing a word cannot brick a store
   (M4.E). A bundle is an untrusted file from another machine; it gets the same
   treatment as a store document written by an older build.

6. **THE CROSS-PLATFORM DEFECT, measured.** `normalizePathValue`
   (`registry.ts:301-311`) returns `'~/' + value.slice(prefix.length)` — the
   remainder keeps the separators of the machine that wrote it. Verified in a
   real store written by the real binary: `.panda/registry.json` holds
   `"entryPath": "~/skills\\commit-lint.ts"`. `expandPathValue` (`:313-322`) is
   `join(homeDir, value.slice(2))`, and on POSIX `join` does not treat `\` as a
   separator, so that value becomes one filename containing a backslash.

7. **The fix is safe on both platforms, and that is not an assumption.** Measured
   on win32: `join('C:\\Users\\dev', 'skills/name.ts')` returns
   `'C:\\Users\\dev\\skills\\name.ts'`, **identical** to
   `join('C:\\Users\\dev', 'skills', 'name.ts')`. So emitting `/` in the
   normalized remainder round-trips losslessly on Windows as well as POSIX, and
   the round trip pinned at `packages/contracts/test/registry.test.ts:195`
   continues to hold.

8. **It is backward compatible.** A store written by an older build holds
   `~/skills\name.ts`. Reading it on Windows still works, because `join` DOES
   treat `\` as a separator there — and a store written on Windows is read on
   Windows. Nothing needs migrating; the change is to what panda WRITES from now
   on.

9. **The printed-command scan appends `--help` to the verb.**
   `packages/cli/test/printed-commands.test.ts:227-234` dispatches
   `[...verbPath, '--help']`, so a `<path>` placeholder in a USAGE line is never
   executed as an argument. `panda export <path>` shipped in M8.A on exactly
   that basis.

## Boundaries & Constraints

### D1 — `panda import <path>` installs, then re-projects, in that order

FR-22 is one sentence with two verbs and the order is not free: projecting before
the entries are in place would project the old registry. Install first, then
`initMachine`, then report both halves.

The path is required, for the same reason it is on export: the binary passes no
`cwd` (`packages/cli/bin/panda.ts` is `runPanda(process.argv.slice(2))`), so a
default would resolve one way under a test harness and another for every user.

### D2 — a bundle panda cannot read is refused by NAME, before anything is written

Four refusals, each coded `PANDA_REGISTRY_BUNDLE_UNAVAILABLE` and each naming
what is wrong:

- not readable / not JSON — the path and the parser's message;
- `kind` is not `panda-bundle` — so a stray JSON file is not half-imported;
- `version` is not this build's — **named as an incompatibility**: a NEWER
  version says the bundle was written by a newer panda and names both numbers,
  anything else says the version is one this build does not recognise. Two
  branches because both sentences are true and only one is useful to each reader;
- an entry that is not a valid registry entry — every issue, not the first.

**Nothing is written until every one of these passes.** A partially-imported
registry is the state with no verb to leave it.

### D3 — an entry that was already there is REPLACED, and said out loud

`register` replaces by `type:id` (measurement 4), and that is the right
behaviour: the bundle is what the user asked to install. What is wrong is doing
it in silence.

So import reports `replaced: [{type, id}]` beside `imported`. A user moving
devices who had already run `panda add` gets told exactly which of their entries
the bundle took over — the same doctrine as M8.A's omission record: panda never
drops or overwrites without naming it.

Import does NOT wipe entries the bundle lacks. FR-22 says *"installs a Bundle
into a fresh machine home"*, so the fresh case is unambiguous; for a non-fresh
one, deleting a user's other entries is destructive and nobody asked for it.

### D4 — the pending list is the bundle's `omitted`, forwarded verbatim

FR-22's *"entries requiring secrets are listed as pending manual action"* is
`bundle.omitted`. It is reported on stdout as `pending` and on stderr as one line
each, because a user who ran a command wants to see the manual work without
parsing JSON.

Import does not invent a task list, does not guess at what the secret was, and
does not register a placeholder entry. An entry that could not travel is absent,
named, and the user re-adds it.

### D5 — the projection half is `runInit`'s, not a second copy

Measurement 3. After installing, import calls the same capability `panda init`
calls and reports through the same code. The exit code is the projection's: 0
clean, 1 a target failed, 2 no executor detected — because a script must not have
to learn a second mapping for the same outcome.

### D6 — normalized paths become separator-neutral

`normalizePathValue` emits `/` in the remainder it keeps. This is a change to
`@panda/contracts`, not to import, because the artifact is produced by the
WRITER and a fix inside the reader would leave every already-written store
unportable while pretending otherwise.

Measurements 7 and 8 are what make it safe: lossless on win32, and old stores
still read correctly on the platform that wrote them. What it buys is the only
thing that makes Story 5.2 true across devices, which is the case it exists for.

### D7 — not in this story

Profiles and Skill sources, which have no representation (M8.A's finding, and
§9 item 0 of the handoff). Project-scope import: a bundle carries the global
scope only. And migrating existing stores to `/`: nothing needs it, because a
store is read on the machine that wrote it.

## I/O & Edge-Case Matrix

| Input | Expected |
| --- | --- |
| a bundle from an empty registry | installs nothing, re-projects, exit follows the projection |
| a bundle with 3 entries onto a clean home | all 3 registered at global scope; `imported: 3`, `replaced: []` |
| the same bundle a second time | `imported: 3`, `replaced` names all 3; the registry is unchanged in content |
| a bundle whose entry id already exists with different fields | replaced, and named in `replaced` |
| a bundle with `omitted` entries | `pending` carries them; each is also one stderr line |
| `version: 2` | exit 2, message names BOTH versions and says the bundle is newer; nothing written |
| `version: 0` / `"1"` / missing | exit 2, message says the version is unrecognised; nothing written |
| `kind` missing or wrong | exit 2 naming the file; nothing written |
| not JSON / unreadable path | exit 2 naming the path; nothing written |
| one invalid entry among valid ones | exit 2 listing EVERY issue; **nothing** written |
| a bundle carrying a RETIRED type | accepted, exactly as the store's read path accepts one |
| `panda import` with no path | usage error, exit 2 |
| `panda import a b` | `unexpected argument 'b'`, exit 2 |
| a normalized path, after D6 | contains `/` and no `\`, on either platform |
| export → import on the same machine | the registry round-trips; doctor reports no drift it did not have before |

## Code Map

| File | Change |
| --- | --- |
| `packages/contracts/src/registry.ts` | `normalizePathValue` emits `/` (D6) |
| `packages/contracts/test/registry.test.ts` | the separator clause, both directions |
| `packages/registry/src/bundle.ts` | `readBundle(path)` — parse, validate, refuse by name |
| `packages/registry/src/index.ts` | export it |
| `packages/environment/src/index.ts` | re-export the facade |
| `packages/cli/src/registry-commands.ts` | `runImportCommand` |
| `packages/cli/src/run.ts` | the `import` verb + USAGE |
| `packages/registry/test/bundle.test.ts` | the refusal matrix |
| `packages/cli/test/registry-commands.test.ts` | the verb, end to end, including export → import |

## Tasks & Acceptance

1. D6 first, with its clause, because every later fixture depends on what the
   normalizer emits.
2. `readBundle` and its four refusals, each asserted on the MESSAGE, not only
   the code — "naming the incompatibility" is the criterion.
3. The verb: install, re-project, report, and the `replaced` list.
4. A round-trip clause that drives the real binary: export, wipe, import, compare.
5. Per-rule falsification; a mutant that does not compile is INCONCLUSIVE.
6. Both gate halves.

## Ask First

Nothing. The one decision the story text does not settle — what happens when the
target home is not fresh — is settled by D3 against panda's own doctrine, and the
FR's "fresh machine home" leaves the specified case unambiguous.

## Spec Change Log

- 2026-09-01 — frozen at `d9859e0`.
- 2026-09-01 — **one clause added that the frozen spec did not anticipate**: the
  bundle's entries must be EXPANDED against the destination home before being
  registered. The spec assumed handing them to `register` was the whole of the
  install. See "The defect the spec did not see" below.

## Verification

### The gate — both halves

bytes OK · `pnpm typecheck` clean across ten packages · `pnpm lint` exit 0 ·
**1315 tests pass** (contracts 143, registry 127 from 113, cli 148 from 139) ·
`pnpm build` Done · `pnpm proof:consumer-install` 8 passed, 1 skipped. The known
local-only `skills-discovery.live.test.ts` red is excluded with `**/*live.test.ts`.

### The defect the spec did not see, found by driving the binary

Machine A exported, machine B imported, and B's registry held:

```
"entryPath": "~~/skills/commit-lint.ts"
```

A DOUBLE marker. The bundle carries the portable form, and `register` normalizes
whatever it is handed — so the normalizer ran over a value that already began
with the reserved `~`, and the escape rule turned it into a path to a file
literally named `~/skills/commit-lint.ts`. **Every path field of every imported
entry was quietly wrong, and nothing failed.**

Fixed by expanding against the destination home first, which is also the honest
shape: the store's surface takes REAL paths — it is what `panda add` passes and
what `list()` returns — so import converts back into that vocabulary and lets the
store normalize once.

**This is the third instance of one lesson in three stories.** M7.C: a schema's
strict branch was unreachable because its caller pre-filtered the input. M8.A:
`list()` expanded what the writer had normalized. M8.B: `register` normalized
what the caller had already normalized. All three were caught by running the
binary and reading the output; none by re-reading either function.

### The full journey, driven end to end

Machine A: three entries registered, one carrying a credential. Export →
`exported: 2`, `omitted: [leaky/args]`, and the skill path is
**`~/skills/commit-lint.ts`** — a forward slash, written on Windows, which is D6
working. Machine B: import → `imported: 2`, `pending: [leaky/args]`, registry
correct. B exports again → **entries byte-identical to A's**, with a CONTROL
(A has 2 entries) so the comparison had something to compare. Importing the same
bundle twice → `replaced` names both entries, on stdout and on stderr.

Seven malformed bundles driven through the real binary — newer version, a string
version, not a bundle, wrong scope, invalid entries, no entries array, not JSON —
each refused with a DISTINCT and correct message, and **nothing written by any of
them**, not even panda's own directory.

### `init` and `import` agree, measured rather than assumed

On a throwaway home both exit **2**, for the same reason (no executor
configuration to project into). That is D5: one outcome, one code. It also
corrects a claim made mid-session — an earlier `exit=0` for import was `head`'s
exit through a pipe, not the binary's.

### Falsification — nine rules, nine killed, none inconclusive, three controls green

Harness at `.scratch/falsify-m8b.mjs`, mutating three packages and running each
one's own suite.

| Rule | Mutation | Outcome |
| --- | --- | --- |
| D6 | the separator normalization removed | KILLED — three contracts clauses |
| D2a | "newer" replaced with a generic sentence | KILLED — *names a NEWER schema as newer* |
| D2b | the version check disabled | KILLED — three clauses |
| D2c | the kind check disabled | KILLED — *refuses a document that is not a bundle BEFORE it talks about versions* |
| D2d | only the first issue collected | KILLED — *lists EVERY invalid entry* |
| D2e | `admitRetired` turned off | KILLED — *admits a RETIRED entry type* |
| — | the expand-before-register removed | KILLED — *the double-marker regression*, plus the round trip |
| D3 | the `replaced` list not built | KILLED — *names what it took over* |
| D4 | the pending list emptied | KILLED — *forwards what the bundle could not carry* |

### Two measurements of my own that were WRONG, caught by their controls

Both were shell-quoting failures that produced confident output from commands
that had not run:

1. A `diff` reported the two bundles "BYTE-IDENTICAL" while both sides were
   EMPTY — two `require()` calls had failed on an MSYS path. Redone with a real
   control (`A has 2 entries`).
2. A loop over five malformed fixtures printed five lines that were all the same
   ENOENT, because `$f` never interpolated inside the quoting. Redone as a node
   script, which is why `.scratch/drive-m8b-refusals.mjs` exists.

Tenth and eleventh escaping incidents in this project. The lesson stands and
grew a corollary: **when a shell quoting problem has eaten a measurement twice,
stop quoting and write the driver.**

### What is NOT verified here

A real Windows→POSIX import. The artifact is now separator-neutral and that half
is asserted platform-independently, but the expander half is `join`, which is
correct by construction on whichever platform runs it — no test crosses machines.
And the projection half was exercised only on homes with no executor installed,
so "doctor reports zero drift" after a real import is asserted through
`initMachine`'s own suite rather than end to end.
