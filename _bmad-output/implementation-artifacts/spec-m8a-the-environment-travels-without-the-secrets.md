# Spec M8.A — the environment travels, and the secrets do not

**Status:** FROZEN
**Implements:** Story 5.1 / FR-21 / NFR-5 / NFR-6 — `panda export`, the first
half of Epic 5's portability promise (UJ-2, "a developer moving devices")
**Created:** 2026-09-01

---

## Intent

Panda's whole claim is that your environment is data, not a pile of hand-edited
vendor files. That claim is only worth something if the data can leave the
machine. Today it cannot: there is no export verb and no artifact.

Story 5.1 asks for three testable things — no secret-detector matches in the
artifact, machine-specific paths normalized, and byte-identical bytes for an
unchanged Registry. **One of the three is already satisfied** and this story must
not re-derive it.

The design question the story actually turns on is not the format. It is what
happens to an entry that carries a credential: FR-21 says *omit* it, and FR-22
says import must list such entries as *pending manual action*. **An entry omitted
without a trace makes that list impossible**, and makes a false positive in the
detector indistinguishable from a user who never registered the thing. So the
omission is recorded — type, id, and which field matched — and never the value.

## The measurement this rests on

Executed on 2026-09-01 at `49b7294`. Behavioural claims come from running code.

1. **Nothing exports today.**
   `grep -rniE "\b(export|import)\s+bundle|createBundle|panda export" packages/*/src`
   → **0**. CONTROL over the same tree: `isRegistryVerb` → **4**. The CLI's verbs
   are the registry trio, `init`, `doctor`, `remediate`, `swap`, `run` and their
   `project` variants (`packages/cli/src/run.ts:191-258`).

2. **There is no secret detector.** `grep -rni secret packages/*/src` → **1**
   hit, prose in a kernel comment (`intercept.ts:599`).

3. **NFR-6 is already satisfied, at WRITE time.**
   `normalizeRegistryEntryPaths` (`packages/contracts/src/registry.ts:339`,
   labelled `(NFR-6)` in the source) is applied by
   `RegistryStore.register` at `packages/registry/src/store.ts:123`, with `~` as
   a reserved marker and `~~` escaping a literal tilde. The round trip is pinned
   lossless at `packages/contracts/test/registry.test.ts:195`. **The store on
   disk is already portable**; a bundle carries those bytes forward and
   re-normalizes nothing.

4. **The secret surface is `args`, and `extensions`.** The envelope
   (`registry.ts`, `RegistryEntry`) is exactly `type`, `id`, `command`,
   `entryPath`, `args`, `extensions` — **there is no `env` field**. `args` is the
   live route: `--arg` is repeatable and stored verbatim
   (`packages/cli/src/registry-commands.ts:68,126`), so
   `panda add mcp-server x --command npx --arg --api-key --arg sk-…` persists a
   credential. `extensions` is free-form but today only panda's own ingest writes
   it (`packages/registry/src/ingest.ts:212`); it is scanned anyway because it is
   `Record<string, unknown>` and nothing stops a host from filling it.

5. **The `agent` scope cannot be exported.** It is an in-memory `Map`
   (`store.ts:85`), so it does not survive the process that made it. And the
   `project` scope is bound to a directory that will not exist on the other
   machine. FR-22's own words are *"installs a Bundle into a fresh machine
   home"* — so the exportable unit is the **global** scope. See D2.

6. **`@panda/environment` cannot write the file, by a guard test that has
   already caught two evasions.** `packages/environment/test/guard.test.ts` pins
   its filesystem imports to exactly `access`, `constants`, `mkdir`, `stat`,
   counts every mention of the fs module to defeat namespace/dynamic imports, and
   asserts no source file contains the string `atomicWriteText`.

7. **`@panda/registry` already writes atomically, and is the thing being
   exported.** `store.ts:363-386`: temp file in the same directory, `rename` over
   the target, with a bounded retry for Windows `EPERM`. Its dependencies are
   `@panda/contracts` and `@panda/kernel` only, and `@panda/environment` already
   re-exports `RegistryStore` as the CLI's facade (`environment/src/index.ts:57`).

8. **The binary passes NO options.** `packages/cli/bin/panda.ts` is
   `runPanda(process.argv.slice(2))`, so `options.cwd` is `undefined` for every
   real user — the defect that made `panda project swap` exit 2 for everyone
   while its suite was green. See D4.

9. **The detector was measured against a corpus with controls before being
   frozen** (`.scratch/probe-secret-detector.mjs`). Eleven credential shapes —
   OpenAI/Anthropic `sk-`, GitHub classic and fine-grained, Slack, AWS, Google,
   GitLab, a raw 32-char hex token, a base64-ish token, and a `--api-key=<token>`
   pair — **all detected**. Seventeen legitimate values — `npx`, a package spec,
   a bare flag, `-y`, normalized `~/` paths, a Windows path, a URL, a long dashed
   phrase, a long digitless word, a semver, a UUID in both cases, a git object
   name, a sha256 digest, a `sha256:` docker digest, and a long numeric id —
   **all clean**. First pass had two false positives (UUID, git sha); both are
   now excluded by exact shape. Final: **0 missed, 0 false positives**.

10. **Nothing panda prints may be a command panda does not have.**
    `packages/cli/test/printed-commands.test.ts` dispatches every backticked
    `panda …` string in shipped `src/` and `bin/`, and unrecognised is LOUD. So
    no message, comment or usage line in this story may mention an import verb
    that does not exist yet.

## Boundaries & Constraints

### D1 — the artifact, and why it carries no empty promises

```
{
  "version": 1,
  "kind": "panda-bundle",
  "scope": "global",
  "entries": [ … ],
  "omitted": [ { "type": …, "id": …, "field": … } ]
}
```

`version` is a SCHEMA version, checked by equality exactly like `STORE_VERSION`
(`store.ts:41,325-331`). This is settled by the PRD rather than by argument:
Story 5.2's criterion is *"importing a newer **schema-major** Bundle exits
non-zero naming the incompatibility"*.

FR-21 names three legs — Registry, Profiles, Skill sources. **Only one exists.**
There is no Profile representation anywhere, and `SkillSource` is a declared port
with no shipped implementation. The bundle therefore carries neither key. An
empty `"profiles": []` would claim panda has profiles that happen to be empty,
which is correction-01 C5's definition of faking. An absent key is also what
lets a later story add one without a version bump meaning something it did not.

### D2 — the global scope, because it is the only one that can travel

Measurement 5. `agent` dies with its process; `project` names a directory that
will not exist on the destination. The bundle states `"scope": "global"` rather
than leaving it implied, so a later story that widens it changes a value instead
of changing a meaning.

### D3 — a credential omits its whole ENTRY, and the omission is recorded

FR-21's word is *omitted*, and it is the right one: redacting a value would leave
an `mcp-server` whose argv is a lie, and importing it would produce a server that
fails at run time instead of a task the user knows they have.

The record carries `type`, `id` and the **field name** that matched — never the
value, never an excerpt, never a length. That record is the load-bearing part:

- It is what FR-22's *"entries requiring secrets are listed as pending manual
  action"* is computed from. Without it, import has nothing to list.
- It is what makes a detector false positive **visible and recoverable** instead
  of silent data loss. That, in turn, is what allows the detector to be tuned
  toward catching credentials rather than toward never annoying anyone.

An entry is omitted whole if ANY of its scanned values matches. Scanned:
`command`, `entryPath`, every element of `args`, and every string reachable
inside `extensions`. `id` and `type` are scanned too — they end up in the
omission record, so a credential there could leak through the record itself; an
entry whose `id` matches is omitted with `field: "id"` and nothing else about it
is written.

### D4 — `panda export <path>`, and the path is required

The binary passes no `cwd` (measurement 8), so a default path would resolve
correctly under a test harness that supplies one and incorrectly for every real
user. Node resolves a relative path against the real process cwd, which is what
the user's shell means, so the argument needs no panda-side plumbing at all.

No `--force`: writing where the user pointed is what they asked for, and an
overwrite guard that panda invents is a step nobody asked for. Existing-file
behaviour is the atomic write's: replaced whole, or not at all.

### D5 — deterministic bytes, and canonical ones

The criterion is "exporting twice unchanged yields byte-identical Bundles", which
insertion order already satisfies. Entries are nonetheless **sorted by
`${type}:${id}`**, and the omission list with them.

The reason is that the store's order is the order things were REGISTERED
(`store.ts:130-132` filters the old out and appends the new), so re-registering
an unchanged entry moves it, and two machines holding identical content produce
different bytes. Sorting costs one comparator and makes the artifact comparable,
which is what anyone diffing two bundles will expect. Serialisation is
`JSON.stringify(bundle, null, 2)` — the same writer the store uses.

### D6 — it lives in `@panda/registry`

Measurements 6 and 7. Environment cannot write; projection is the vendor-file and
ownership-ledger package and a bundle is neither; the registry already writes its
own document atomically and the bundle IS its own document leaving the machine.
`@panda/environment` re-exports the facade, exactly as it does `RegistryStore`.

This deliberately does NOT trigger the deferred-work item about extracting a leaf
atomic-write package "when a THIRD caller appears": the bundle does not need the
symlink-resolving vendor writer at all. It writes a new file at a path the user
named, not a convergent write into someone's config.

### D7 — not in this story

`panda import` (Story 5.2), Profiles, SkillSources, and the `project` scope. The
CI secret-detector scan NFR-5 mentions is a pipeline concern; what this story
owns is that the artifact panda produces has nothing for it to find.

## I/O & Edge-Case Matrix

| Input | Expected |
| --- | --- |
| a populated global registry, no secrets | every entry in the bundle, sorted, `omitted` empty |
| an entry with `--arg sk-proj-…` | that entry ABSENT; `omitted` holds `{type,id,field:"args"}`; the artifact contains no part of the token |
| an entry whose `command` is a credential | omitted with `field:"command"` |
| a credential inside `extensions` | omitted with `field:"extensions"` |
| a UUID / git sha / sha256 in `args` | exported normally — not a credential (measurement 9) |
| an empty registry | a valid bundle with `entries: []`, exit 0 (5.2's criterion names this) |
| export twice, unchanged | byte-identical |
| two stores, same content, different insertion order | byte-identical (D5) |
| `panda export` with no path | usage error, exit 2 |
| the path's directory does not exist | coded failure naming the path, exit 2, nothing written |
| a `project`-scope entry exists | not in the bundle; the bundle says `"scope":"global"` |

## Code Map

| File | Change |
| --- | --- |
| `packages/contracts/src/errors.ts` | `registryBundleUnavailable` |
| `packages/registry/src/bundle.ts` (new) | the bundle type, the detector, `createBundle(entries)` (pure), `writeBundle(path, bundle)` |
| `packages/registry/src/index.ts` | export the above |
| `packages/environment/src/index.ts` | re-export the facade (types + the verb's entry point) |
| `packages/cli/src/run.ts` | the `export` verb + USAGE |
| `packages/registry/test/bundle.test.ts` (new) | the detector corpus and the matrix |
| `packages/cli/test/` | the verb, end to end |

## Tasks & Acceptance

1. The detector, with its corpus as the test — both directions, controls
   included. It is the only part where being wrong is a security failure.
2. `createBundle`: pure, sorted, omission-recording.
3. The writer, and its coded failure.
4. The verb, USAGE, and the printed-command invariant (measurement 10).
5. Per-rule falsification; a mutant that does not compile is INCONCLUSIVE.
6. Drive the binary as a user, with a real secret in a real registry, and read
   the artifact.
7. Both gate halves.

## Ask First

Nothing. Every decision above is settled by a measurement in this file, and the
one that could not be settled from code — what "versioned" means — is settled by
Story 5.2's own acceptance criterion.

## Spec Change Log

- 2026-09-01 — frozen at `49b7294`.
- 2026-09-01 — **measurement 3 was WRONG and is corrected in place by the
  Verification section below.** It said NFR-6 was already satisfied for a bundle
  because the store normalizes at write time. True of the writer, false of the
  caller: `list()` maps `expandRegistryEntryPaths` over what it returns, so
  `createBundle` receives absolute paths. `createBundle` therefore takes a
  `homeDir` and normalizes, which the frozen spec did not ask for. Recorded
  rather than quietly widened, because the spec's own claim is what was at fault.

## Verification

### The gate — both halves

bytes OK · `pnpm typecheck` clean across ten packages · `pnpm lint` exit 0 ·
**1290 tests pass** (registry 113 from 69, cli 139 from 129) · `pnpm build` Done ·
`pnpm proof:consumer-install` 8 passed, 1 skipped. The known local-only
`skills-discovery.live.test.ts` red is excluded with `**/*live.test.ts`.

### Driven as a user, which is what caught the spec's own error

A throwaway home, four entries registered through the real binary — a clean
`mcp-server`, one whose argv carries `sk-proj-…`, one whose argv carries a git
object name, and a skill with an absolute `entryPath` — then `panda export`:

```
{ "path": "…\\out\\bundle.json", "version": 1, "scope": "global",
  "exported": 3, "omitted": [ { "type": "mcp-server", "id": "leaky", "field": "args" } ] }
```

Measured on the artifact itself, which is what NFR-5 scans: `grep -c sk-proj` →
**0**, `grep -c Ab3dEfGh` → **0**, CONTROL `grep -c context7` → **2**. Exporting
twice: `cmp` reports the files identical. The git-sha entry travelled, so the
false-positive exclusion works on the real path and not only in a unit.

**And the third criterion FAILED on that first run**, which is the whole reason
this section exists: the skill's `entryPath` came out as
`C:\code\panda\.scratch\…\skills\commit-lint.ts`. See the Change Log. After the
fix: `~/skills\commit-lint.ts`, `grep -cE '"[A-Za-z]:\\\\|"/home/|"/Users/'` →
**0**, CONTROL `grep -c '"~'` → **1**.

### Falsification — nine rules, nine killed, none inconclusive, control green

Harness at `.scratch/falsify-m8a.mjs` (gitignored), each mutant restored
byte-for-byte and the control run proving the restoration.

| Rule | Mutation | Outcome |
| --- | --- | --- |
| D3a | a credential-bearing entry kept anyway | KILLED — four clauses |
| D3b | the omission recorded nowhere | KILLED — four clauses |
| D3c | `extensions` not scanned | KILLED — two clauses |
| D3d | an `extensions` KEY not scanned | KILLED — *reads a credential used as an extensions KEY* |
| NFR-6 | normalization removed | KILLED — *normalizes machine paths, because list() hands back EXPANDED ones* |
| D5 | sorting removed | KILLED — *sorts by type and id* |
| detector | the opaque-token rule disabled | KILLED — four clauses |
| detector | the not-a-credential shapes disabled | KILLED — *leaves a UUID / git object name / sha256 alone* |
| D1 | a `profiles: []` key added | KILLED — *claims no Profiles and no Skill sources* |

### The mutation run found a hole in my own corpus

Disabling the generic opaque-token rule killed *detects a Google API key*, which
should have been caught by its own provider pattern. It was not: the fixture was
41 characters and Google issues `AIza` plus exactly 35, so that pattern had
**no test exercising it** and the generic rule was quietly covering the row.
Fixture corrected to 39, re-measured by hand — with the generic rule disabled the
Google row now SURVIVES and only the three rows that are supposed to depend on it
fail. All eight provider patterns are exercised by their own fixtures.

This is the "a falsification must be REPRESENTATIVE" lesson arriving from the
other direction: the mutation did not find a defect in the code, it found one in
the evidence.

### The printed-command invariant caught a placeholder, as designed

A comment written for this story contained a backticked `panda project <verb>`,
which `printed-commands.test.ts` dispatched and the binary refused. Rewritten as
prose rather than added to that test's exception list — a list that may rot is a
list that will.

### What is NOT verified here

Import (Story 5.2), and everything that depends on reading a bundle back. Two
limitations are recorded in `deferred-work.md` rather than fixed: a normalized
path keeps the separator of the machine that wrote it (pre-existing, and Story
5.2 is where it bites), and the detector treats exactly-40 and exactly-64
lowercase hex as not-a-credential. Neither Profiles nor Skill sources are in the
artifact, because panda has neither — FR-21 names three legs and one exists.
