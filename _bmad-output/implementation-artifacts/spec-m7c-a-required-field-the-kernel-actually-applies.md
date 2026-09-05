# Spec M7.C — a required field the kernel actually applies

**Status:** FROZEN
**Implements:** the cordis `resolveConfig` pattern (`planning-artifacts/research/cordis-spatiotemporal-composability-2026-09-01/research.md` §8), and the fix `deferred-work.md` proposed against M3.B
**Created:** 2026-09-01

---

## Intent

`PluginManifest.configSchema` is a **required** field the kernel only PROBES and
never applies. `packages/workspace-local/src/plugin.ts:52-58` says so in panda's
own words:

> *"the kernel only PROBES `manifest.configSchema` for shape … and never applies
> it to the plugin's subtree … **Replacing this constant with a no-op that accepts
> anything leaves every suite green**."*

So every plugin author must declare a schema, then ignore it, then hand-roll its
application inside their factory. All three first-party plugins do exactly that,
identically, and the duplication is the symptom rather than the disease.

Cordis does the other thing: `resolveConfig(runtime, config)` validates the
plugin's own `Config` **before the plugin body runs**, throws on issues, and
hands the plugin `result.value` — so schema-applied defaults reach it. That is
the pattern this story takes.

## The measurement this rests on

Executed on 2026-09-01 at `37e6e6f`, every claim re-read at the line.

1. **The kernel probes and never applies.** `packages/kernel/src/manifest.ts`
   calls `configSchema['~standard'].validate(CONFIG_PROBE)` with a symbol, to
   check the field's SHAPE. `grep -rn "configSchema" packages/*/src` finds no
   other kernel use.

2. **All three shipped plugins declare their REAL schema and then call it
   themselves.** `configSchema: WORKSPACE_CONFIG_SCHEMA` / `REGISTRY_CONFIG_SCHEMA`
   / `EXECUTOR_CONFIG_SCHEMA`, and
   `grep -c "\['~standard'\].validate" packages/<p>/src/plugin.ts` is **1** in
   each. Control: the same grep for `~standard` in `adapter-cli/src/plugin.ts`
   returns 1, so the query works. The ceremony they duplicate is: read
   `context.config.resolve()`, pick the subtree by a string key, validate, check
   for a promise, map `issues` to strings, return `{ status: 'rejected' }`.

3. **"The plugin's own subtree" is already `manifest.id`, in all three.**
   Measured: manifest id `workspace` ↔ key `workspace`; id `registry` ↔ literal
   `'registry'`; id `executor` ↔ key `executor`. The convention exists de facto
   and has never been a kernel rule. This settles the open question the handoff
   recorded — with evidence, not a choice.

4. **THE RISK IS SMALLER THAN THE LEDGER FEARED, and this is why.**
   `deferred-work.md` records applying the schema as *"a kernel semantic change
   that touches an existing plugin"*, and the obvious fear is that the kernel
   would start REJECTING what `workspace-local` deliberately tolerates — a
   forward-looking key in `~/.panda/config.json` once failed every run on the
   machine, and `run-session.ts:148` records that fix.

   Measured, that fear does not apply: **each plugin's strictness lives in its
   own schema, not in who calls it.** `WORKSPACE_CONFIG_SCHEMA` returns
   `{ value: {} }` for `undefined`, issues only for a non-record or a bad
   `rootDir`, and `{ value }` — accepting unknown keys — for everything else. Its
   per-key warnings are separate factory code and stay there. So the kernel
   calling each plugin's own schema preserves each plugin's own leniency.

5. **No new async path.** `validateManifest` already rejects a schema that
   validates asynchronously (`'configSchema' must validate synchronously`), at
   REGISTRATION. So the kernel may call it synchronously inside `runCandidate`,
   which is synchronous.

## Boundaries & Constraints

- **AD-1** — the kernel keeps zero runtime dependencies and never imports
  `@skanl/panda-contracts`.
- **AD-2** — no new package, no new dependency. Changes land in
  `packages/kernel/`, and the three plugin packages lose code.
- **AD-5** — typed absence over silence. A plugin that declared a schema and got
  no validation was silence wearing a required field.
- **AD-7** — coded errors. **No new error code**: a schema rejection becomes the
  `PANDA_KERNEL_PLUGIN_START_FAILED` the plugin's own `{ status: 'rejected' }`
  already produced.
- **Every `guard.test.ts` stays green UNMODIFIED.** A red guard is a finding.
- All artifacts in English; relative imports carry `.ts`.

### D1 — the subtree is `composed[manifest.id]`, because it already is

Measurement 3. No `configKey` field is added: inventing a way to say something
every plugin already says the same way is a second spelling to keep in sync. The
rule goes on `PluginManifest.configSchema`'s docblock, so an author reads it
where they declare the schema.

A plugin that wants no configuration declares a schema accepting `undefined` —
which is what `WORKSPACE_CONFIG_SCHEMA` already does.

### D2 — the kernel validates BEFORE the factory runs, and rejects coded

In `runCandidate`, before `factory(...)`. A rejection is an
`ActivationRejection` with `reason: 'config'` carrying the schema's issue
messages, which `startFailed` already renders into
`PANDA_KERNEL_PLUGIN_START_FAILED`.

Before the factory, not inside it: a factory that has already opened resources
and is then told its configuration was invalid is the leak M7.A just closed by
another route. Validating first means the body never runs.

### D3 — the VALIDATED VALUE reaches the factory, or this is theatre

`ActivationContext` gains `readonly settings: unknown` — the plugin's own
validated slice, which is `result.value`, so a schema that supplies defaults or
transforms has them reach the plugin.

Without this half the kernel would validate and the plugin would still re-read
raw config through `context.config.resolve()`, which is validation that changes
nothing. `settings` is `unknown` rather than generic: the kernel cannot know the
plugin's output type without a type parameter on `PluginManifest`, and the plugin
already knows what its own schema returns.

`context.config` STAYS. A plugin still legitimately reads other layers and other
subtrees — `@skanl/panda-session` seeds the workspace root as a layer, and the executor
selection reads the composed document whole.

### D4 — the three plugins lose the ceremony, and keep everything else

Each drops: the `config.resolve()` read, the subtree pick, the `validate` call,
the promise check, the issue mapping. Each keeps its own logic —
`workspace-local`'s per-key bus warnings, `registry`'s explicit-option merge over
the config, `adapter-cli`'s catalogue lookup.

The deletion is the point: three copies of one ceremony become zero.

### D5 — the Standard Schema issue `path` is carried NOW, because now it has a reader

M7.B deferred this here in writing, with the reason: *"it belongs in M7.C, in the
change that creates its first consumer."* That consumer now exists — a third
party's Zod or Valibot schema, applied by the kernel, produces issues whose
`path` is populated, and the rejection message is where an author reads it.

`StandardSchemaIssue` gains `readonly path?: readonly (string | number)[]` in
BOTH copies (`kernel/src/manifest.ts`, `contracts/src/standard-schema.ts` — they
are duplicated deliberately under AD-1, and a parity test already pins the pair).
One renderer appends ` (at a.b.c)` when a path is present. Panda's own
hand-written schemas produce no path and render exactly as they do today.

### D6 — not in this story

No `configKey` field (D1). No per-plugin strictness policy in the kernel — a
plugin's schema is its policy. No change to the layered configuration itself. No
async schemas (measurement 5 says the manifest validator already refuses them).

## I/O & Edge-Case Matrix

| # | Input / state | Expected behaviour |
|---|---|---|
| 1 | config has a valid subtree under the plugin's id | the factory receives `settings` equal to the schema's `value` |
| 2 | the schema supplies a DEFAULT for an absent subtree | the factory receives the default, not `undefined` |
| 3 | the subtree violates the schema | the plugin FAILS to start with `PANDA_KERNEL_PLUGIN_START_FAILED` naming the issues; **the factory never runs** |
| 4 | that rejection, with the factory counting its own calls | the call count is 0 |
| 5 | no subtree for the plugin's id at all | the schema decides — `WORKSPACE_CONFIG_SCHEMA` accepts it, a stricter one rejects |
| 6 | a plugin whose schema accepts unknown keys | unchanged: unknown keys are not a kernel-level rejection |
| 7 | a schema that THROWS rather than returning issues | contained as a coded plugin start failure, never an escaping raw error |
| 8 | an issue carrying a `path` | the message renders the coordinate |
| 9 | an issue with no `path` | the message reads exactly as it does today |
| 10 | `swap()` with a candidate whose config is now invalid | the swap is rejected; the previous implementation keeps serving |
| 11 | the three shipped plugins, end to end through `panda run` | unchanged behaviour, including `workspace-local`'s unknown-key WARNING rather than a failure |
| 12 | `context.config` inside a factory | still present and still the whole composed document |

Row 4 is the one that would be silent: validating and then running the factory
anyway is validation that changed nothing, and every other row still passes.
Row 11 is the regression guard — the deliberate leniency measured in
measurement 4 must survive, and only an end-to-end check proves it.

## Code Map

```
packages/kernel/src/manifest.ts
  ~ StandardSchemaIssue   + readonly path?
  ~ configSchema docblock -> states the `composed[manifest.id]` rule (D1)
packages/kernel/src/lifecycle.ts
  ~ ActivationContext     + readonly settings: unknown
  ~ runCandidate          + resolve, validate, reject BEFORE the factory (D2, D3)
  ~ ActivationRejection   + 'config' reason
packages/contracts/src/standard-schema.ts
  ~ StandardSchemaIssue   + readonly path?   (the AD-1 duplicate, D5)
packages/{workspace-local,registry,adapter-cli}/src/plugin.ts
  ~ drop the read + subtree pick + validate + issue mapping; read `settings`
packages/kernel/test/lifecycle.test.ts   + rows 1-10, 12
packages/{workspace-local,registry,adapter-cli}/test/plugin.test.ts  ~ row 11
_bmad-output/implementation-artifacts/
  deferred-work.md   ~ the M3.B configSchema entry becomes RESOLVED
  sprint-status.yaml + m7c
```

## Tasks & Acceptance

- [x] T1 — D2/D3: resolve `composed[manifest.id]`, validate, reject before the factory; `settings` on the context.
- [x] T2 — D1: the rule stated on the `configSchema` docblock.
- [x] T3 — D5: `path` on both `StandardSchemaIssue` copies plus one renderer.
- [x] T4 — D4: the three plugins lose the ceremony and keep their own logic.
- [x] T5 — tests for every matrix row; row 4 must count factory calls, not infer.
- [x] T6 — `deferred-work.md` (mark the M3.B proposal RESOLVED, do not delete it) + `sprint-status.yaml`.
- [x] T7 — gate green on Node 24 **and** Node 26, **plus** `pnpm build && pnpm proof:consumer-install`. Live suites excluded with `**/*live.test.ts` — no dot. No `guard.test.ts` edited.

**Done means:** both gate halves green; every matrix row has a test; rows 3, 4
and 11 each fail when their guard is removed; and the three plugins are each
NET SHORTER.

### The falsification must be per rule

Row 4 is the discriminating one: validating and then calling the factory anyway
passes rows 1, 2, 3, 5-10 and 12. Remove the "before the factory" ordering alone
and name the test that dies. Row 11 likewise — the leniency lives in a schema, so
a kernel that imposed its own strictness would pass every kernel-level row and
break `panda run` for a user with a forward-looking config key.

## Ask First

Stop and ask rather than deciding:

- Any **new** `PANDA_*` error code.
- Adding a `configKey` manifest field (D1 says no, on the measurement).
- Making the kernel impose strictness a plugin's schema does not (D6).
- Removing `context.config` from the activation context (D3 keeps it).
- Editing any `guard.test.ts`.
- Any behaviour change visible to `panda run` beyond WHERE the rejection happens.

## Spec Change Log

- 2026-09-01 — frozen at `37e6e6f`. Two things the queued description had open
  are now settled by measurement rather than by choice: "a plugin's own subtree"
  is `manifest.id` because all three plugins already spell it that way
  (measurement 3), and the feared semantic change does not apply because each
  plugin's strictness is encoded in its own schema (measurement 4).

## Verification

Executed on 2026-09-01, not inferred.

### MEASUREMENT 4 WAS PARTLY WRONG, and the be-a-user pass is what caught it

The frozen measurement said each plugin's strictness lives in its own schema, so
applying it preserves behaviour. That is true for `registry` and `adapter-cli`.
It was **incomplete for `workspace-local`**, and the gap is exactly the one the
ledger feared:

`WORKSPACE_CONFIG_SCHEMA` returned an ISSUE for a non-record subtree — but the
factory never handed it one. It warned on the bus and passed `{}` instead, so
that strict branch was **unreachable**. The moment the kernel applies the schema
to the RAW subtree, an unreachable strict branch becomes a plugin that refuses to
start where it used to warn — and `run-session.ts:148` records one
forward-looking key failing every run on the machine as the failure that leniency
exists to prevent.

I checked the schema and not what value the factory feeds it. The fix is to make
the schema say what the plugin actually does: a non-record subtree yields
`{ value: {} }`, and the warning stays in the factory, off the raw document.
That is a better state than before — the schema now states the real policy
instead of declaring one the code never reached.

Verified by BASELINE COMPARISON rather than by reasoning: with the changes
`git stash`ed, `{"workspace":"oops"}` produces byte-identical output, warning and
all.

### Be a user — three configurations against the real binary

```
{"workspace":{"rootDir":"…","futureThing":true}}
  configuration ignored: 'workspace.futureThing' not a workspace plugin config key … ignored
  { "status": "ok", … }                                    ← leniency intact

{"workspace":"oops"}
  configuration ignored: 'workspace' must be an object; the whole subtree was ignored
  PANDA_KERNEL_PLUGIN_START_FAILED … 'workspace.rootDir' is required
  → byte-identical to the stashed baseline: pre-existing, and correct

{"workspace":{"rootDir":123}}
  PANDA_KERNEL_PLUGIN_START_FAILED … 'rootDir' must be a non-empty string when present
```

### The gate — both halves

- bytes clean; `pnpm typecheck` **10/10 Done**; `pnpm lint` no issues.
- `pnpm build && pnpm proof:consumer-install` — **8 passed / 1 skipped**, before pushing.
- Suites (live excluded with `**/*live.test.ts` — no dot): kernel **264** (was
  253, +11), contracts 142, registry 69, projection 256, session 98, environment
  100, workspace-local 23, workspace-git-worktree 13, adapter-cli 132, cli 122.
- **Node 26.8.1 canary** — kernel 264, registry 69, workspace-local 23,
  adapter-cli 132, contracts 142.

### Falsification — six guards, six killed

| Mutation | Killed |
|---|---|
| validation no longer rejects before the factory | 5, incl. `never runs the factory of a plugin whose configuration was rejected` |
| the factory gets the raw subtree instead of the schema's `value` | **1** — `gives the factory the schema-applied DEFAULT when the subtree is absent` |
| the subtree is not `manifest.id` | **1** — `hands the factory its own validated subtree` |
| a throwing schema's message is discarded | **1** — `contains a schema that THROWS instead of returning issues` |
| the issue `path` is not rendered | **1** — `renders the coordinate of an issue that carries a path` |
| `workspace-local`'s schema rejects a non-object subtree again | **1** — `REPORTS a subtree of the wrong shape instead of ignoring it in silence` |

Five of the six killed exactly one test each: the rows that discriminate. The
last one matters most — the leniency correction above was **already guarded** by
an existing workspace-local test, so unlike M7.A's registry fix this one did not
ship without a net.

The throw-containment mutation was applied by hand after the harness reported
NEEDLE NOT FOUND twice on a shell-escaping problem. Reported as what it is: the
harness could not apply it, so the harness proved nothing there and the edit did.

### What is NOT verified here

`registry` keeps its own validate call on the MERGED candidate — the kernel
checks the document, the plugin checks the result of merging explicit options
over it, and only the merged value can be checked once it exists. One
consequence is recorded in `deferred-work.md`: a document whose registry subtree
is invalid is now rejected even when explicit options would have overridden that
key. Deliberate — the document is invalid either way, and accepting it because a
host happened to override means the next run without those options fails
mysteriously.
