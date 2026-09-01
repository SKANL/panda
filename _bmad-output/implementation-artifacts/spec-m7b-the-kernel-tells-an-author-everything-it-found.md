# Spec M7.B — the kernel tells an author everything it found

**Status:** FROZEN
**Implements:** two author-facing diagnostics measured while reading cordis (`planning-artifacts/research/cordis-spatiotemporal-composability-2026-09-01/research.md` §8); no FR — this is the kernel saying what it already knows
**Created:** 2026-09-01

---

## Intent

Panda teaches an author two different lessons about the same product.

Write a **MethodPlugin** and one run lists every mistake: `@panda/contracts`
accumulates into `issues[]` and `METHOD-PLUGIN.md` promises *"It reports **every**
violation at once, not the first."* Write a **kernel plugin** and it is one
mistake per run — fix the `version`, run again, learn about `provides[2]`, run
again.

And when a plugin's consumed service is absent, the kernel branches on exactly
why — no provider registered, the provider is unready, the provider failed — and
then returns the same `{ kind: 'absent' }` for all three. Typed absence that does
not carry the fact it was invented to carry.

Neither is a cordis feature panda lacks. Both are things panda already knows and
does not say.

## The measurement this rests on

Executed on 2026-09-01 at `4c769da`, every claim re-read at the line.

1. **The kernel throws on the first violation; contracts collects them all.**
   `grep -c "fail(" packages/kernel/src/manifest.ts` → **13**, and `fail()` is
   declared `: never` with a bare `throw` (`manifest.ts:40-42`).
   `grep -c "issues.push" packages/contracts/src/method.ts` → **16**. Same
   product, opposite behaviour.

2. **`ManifestInvalidError` carries no list, and its neighbour does.**
   `packages/kernel/src/errors.ts:55-60` — message only.
   `:134-137` — `SwapRejectedError` already declares
   `readonly issues: readonly string[]`. The shape to copy is in the same file.

3. **`{ kind: 'absent' }` is returned from three distinct branches.**
   `packages/kernel/src/lifecycle.ts` `lookup()`: `serviceIndex.get(service)`
   undefined → absent; `plugin.state !== 'active'` → absent, and `state` is
   `'unready' | 'active' | 'failed' | 'disposed'` with `'disposed'` throwing
   above it. So absent means *no provider registered*, *provider unready*, or
   *provider failed* — and the caller cannot tell a misspelled service name from
   a provider that crashed on startup, two problems with opposite fixes.

4. **THE HAZARD that makes the obvious implementation wrong.** The research note
   summarised this story as *"~20 lines: `fail()` pushes instead of throwing"*.
   Measured against the call sites, that is unsafe. Several failures are
   STRUCTURAL — the code after them cannot run:
   - `manifest.ts:94` `if (!isRecord(input)) fail('manifest', 'must be an object')`
     — every line after reads `input['x']`.
   - `:111` `if (!isRecord(entry)) fail('consumes', ...)` — `:113` then reads
     `entry['service']`.
   - `:122` `if (configSchema === undefined) fail('configSchema', 'is required')`
     — `:130` then calls `configSchema['~standard'].validate(...)`, which on
     `undefined` is a raw `TypeError`, not a coded `PandaError` (AD-7).

   So this story is not "make `fail()` push". It is D1.

## Boundaries & Constraints

- **AD-1** — the kernel keeps zero runtime dependencies and never imports
  `@panda/contracts`. Nothing here needs either; the shape being copied from
  contracts is copied, not imported, exactly as `SEMVER_PATTERN` already is.
- **AD-2** — no new package, no new dependency. Changes land in
  `packages/kernel/` only.
- **AD-5** — typed absence over silence, and this story is that rule applied to
  itself: an absence that cannot say why is silence wearing a type.
- **AD-7** — coded errors. **No new error code.** `PANDA_KERNEL_MANIFEST_INVALID`
  gains a payload; it does not gain a sibling.
- **Every `guard.test.ts` stays green UNMODIFIED.** A red guard is a finding.
- All artifacts in English; relative imports carry `.ts`.

### D1 — two kinds of failure, because the code says there are two

`fail()` keeps its `: never` signature and its meaning: **structural, cannot
continue** (measurement 4). A second helper, `collect()`, records a FIELD-level
violation and returns, so validation walks the whole manifest.

`validateManifest` throws once at the end when anything was collected. A
structural `fail()` throws immediately and **carries every issue collected before
it** — the author still gets everything the kernel had discovered before it hit
the wall, rather than losing it because the last problem was fatal.

The split is not a judgement call per site: a site is structural exactly when the
code below it dereferences the value it just rejected. That rule is written on
`fail()` so the next person adding a check knows which to reach for.

### D2 — `ManifestInvalidError` carries its issues

`readonly issues: readonly string[]`, the shape `SwapRejectedError` already has
twelve lines away. The message keeps its current single-line form for one issue
so no existing assertion on message text breaks, and renders one per line when
there are several. An author's own test can read `err.issues` instead of parsing
prose.

### D3 — absence says which of the three it is

`{ kind: 'absent' }` gains `reason: 'no-provider' | 'provider-unready' | 'provider-failed'`.
Additive to the union: every existing `kind === 'absent'` check still compiles
and still means the same thing.

`ServiceResolution` in `loader.ts` is the same union and gains the same field
where the loader can determine it; where the loader genuinely cannot distinguish,
it says so rather than guessing — an invented reason would be worse than none.

### D4 — the Standard Schema issue `path` is NOT carried, and this is a reversal

The research note paired this story with carrying the Standard Schema `path`,
which panda declares away as `{ message }` only in both copies
(`contracts/src/standard-schema.ts:6-8`, `kernel/src/manifest.ts:12-14`), on the
argument that a third party plugging in Zod gets a populated path panda drops.

Measured, that is premature. **Nothing in panda consumes a third party's schema
issues.** The kernel only PROBES `configSchema` with a symbol and never validates
real config against it; panda's own schemas are hand-written through
`defineStandardSchema` with coordinates baked into the message text
(`artifacts[0]`), so they produce no `path` to carry. The first consumer of a
foreign schema's issues is the kernel APPLYING `configSchema` — which is M7.C.

Adding the field now is a widened published type with no reader, which is the
defect already recorded against four kernel exports nothing consumes. It belongs
in M7.C, in the change that creates its first consumer. Recorded in
`deferred-work.md`.

### D5 — not in this story

No `configSchema` application (M7.C). No new error code. No change to WHICH
manifests are rejected — this story changes only what the rejection SAYS.

## I/O & Edge-Case Matrix

| # | Input / state | Expected behaviour |
|---|---|---|
| 1 | a manifest with a bad `id` AND a bad `version` AND a bad `provides` entry | ONE throw naming all three; `err.issues` has three entries |
| 2 | a manifest with exactly one violation | message reads as it does today — no existing assertion on message text breaks |
| 3 | `input` is not an object | throws immediately (structural); nothing after it is dereferenced |
| 4 | a bad `id`, then `consumes` is not an array | the structural throw carries the `id` issue collected before it |
| 5 | a `consumes` ENTRY that is not an object | structural; the entry's fields are never read |
| 6 | `configSchema` absent, with a bad `version` already collected | structural throw, carrying the version issue; `validate` is never called on `undefined` |
| 7 | `configSchema` present but async | collected, not structural — the probe already ran |
| 8 | duplicate service in `provides` and a duplicate in `consumes` | both reported |
| 9 | a valid manifest | unchanged in every way, including the returned object |
| 10 | `getService` for a name no plugin provides | `{ kind: 'absent', reason: 'no-provider' }` |
| 11 | `getService` whose provider is `unready` | `{ kind: 'absent', reason: 'provider-unready' }` |
| 12 | `getService` whose provider `failed` | `{ kind: 'absent', reason: 'provider-failed' }` |
| 13 | `getService` whose provider was disposed | unchanged: still THROWS `PluginInactiveError` |
| 14 | an existing consumer that only checks `kind === 'absent'` | still compiles, still behaves identically |

Row 4 is the one that would be silent: throwing the structural failure alone
loses everything found before it, and the author fixes one problem to discover
the kernel had already seen two more.

Row 2 is the regression guard: nine existing tests assert on
`ManifestInvalidError` message text, and a story about better messages that
breaks every message assertion has traded one problem for another.

## Code Map

```
packages/kernel/src/manifest.ts
  ~ fail()                -> stays `: never`, gains the rule for when to use it
  + collect()             -> records a field-level issue and returns
  ~ validateManifest      -> one throw at the end; a structural throw carries what was collected
packages/kernel/src/errors.ts
  ~ ManifestInvalidError  + readonly issues
packages/kernel/src/loader.ts
  ~ ServiceResolution     + reason on the absent member
packages/kernel/src/lifecycle.ts
  ~ lookup()              -> names which of the three absences it is
packages/kernel/test/manifest.test.ts   + rows 1-9
packages/kernel/test/lifecycle.test.ts  + rows 10-14
_bmad-output/implementation-artifacts/
  deferred-work.md   + D4's reversal, with the measurement that reversed it
  sprint-status.yaml + m7b
```

## Tasks & Acceptance

- [x] T1 — D1: `collect()` beside `fail()`; the structural/collectable split applied per the rule in measurement 4; one throw at the end.
- [x] T2 — D1: a structural throw carries the issues collected before it (row 4).
- [x] T3 — D2: `ManifestInvalidError.issues`, single-issue message unchanged (rows 1, 2).
- [x] T4 — D3: the `reason` discriminant in `loader.ts` and `lifecycle.ts` (rows 10-14).
- [x] T5 — tests for every matrix row.
- [x] T6 — `deferred-work.md` (D4) + `sprint-status.yaml`.
- [x] T7 — gate green on Node 24 **and** Node 26, **plus** `pnpm build && pnpm proof:consumer-install` (§4: `pnpm check` is not the CI gate). No `guard.test.ts` edited.

**Done means:** both Node versions green and the consumer-install proof passes;
every matrix row has a test; and rows 1, 4 and 11 each fail when their guard is
removed.

### The falsification must be per rule

Row 4 is the one a naive implementation gets wrong in a way no other row catches:
collecting correctly and then throwing the structural failure bare passes rows 1,
2, 3 and 5-9. Remove the "carry what was collected" behaviour alone and name the
test that dies. Row 11 likewise: returning a constant `reason` passes row 10.

## Ask First

Stop and ask rather than deciding:

- Any **new** `PANDA_*` error code.
- Changing WHICH manifests are rejected, rather than what the rejection says.
- Carrying the Standard Schema `path` after all (D4 says no, with its
  measurement; it belongs to M7.C).
- Applying `configSchema` (that is M7.C).
- Editing any `guard.test.ts`.

## Spec Change Log

- 2026-09-01 — frozen at `4c769da`. Two corrections to the queued description
  the research note left: the "~20 lines, `fail()` pushes" summary is unsafe at
  three call sites whose successors dereference the rejected value (D1), and the
  paired `path` work is premature until something consumes a foreign schema's
  issues (D4).

## Verification

Executed on 2026-09-01, not inferred.

### The gate — both halves

- bytes clean; `pnpm typecheck` **10/10 Done**; `pnpm lint` no issues.
- `pnpm build && pnpm proof:consumer-install` — **8 passed / 1 skipped**, run
  before pushing.
- Suites: kernel **253** (was 239, +14), registry 69, workspace-local 23,
  adapter-cli 132 (live excluded), contracts 142, projection 256, session 98,
  environment 100, workspace-git-worktree 13, cli 122.
- **Node 26.8.1 canary** — kernel 253, workspace-local 23, adapter-cli 132.

### The additive widening was caught by exact-equality assertions, in four places

`{ kind: 'absent' }` gaining a field turned four `toEqual` assertions red — two
in the kernel, one in `@panda/workspace-local`, one in `@panda/adapter-cli`. That
is the guard working: an exact-equality assertion is what makes a widening a
decision rather than a drift.

All four were updated to ASSERT the new fact rather than ignore it, and the two
outside the kernel are the better tests for it: both are a plugin whose
activation was REJECTED, which is exactly the case the discriminant exists for —
a consumer must be able to tell that from a service nothing provides.

### A measurement error of my own, found and corrected

The exclusion glob `**/*.live.test.ts` does NOT match
`packages/adapter-cli/test/confinement-live.test.ts` — a dash, not a dot. So
every "live excluded" run in this session had been running that live suite, and
it failed once with the documented flake (*"neither concurrent opencode session
asked to write anything"*) and passed on the immediate rerun: 148 passed. The
correct glob is `**/*live.test.ts`, and the numbers above use it.

### Falsification — six guards, six killed, none inconclusive

| Mutation | Killed |
|---|---|
| `collect()` throws on the first violation again | 5 |
| a structural failure drops what was collected before it | **1** — `carries the issues collected BEFORE a structural failure` |
| `throwCollected()` stops throwing | 21 |
| the issue buffer is not reset per call | 10 |
| `ManifestInvalidError.issues` is always empty | 6 |
| the absence reason is a constant | **1** — `distinguishes a provider that never became ready` |

The two that killed exactly ONE test are the discriminating rows, and that is the
point of them: every other mutation is caught by many tests, so a row that dies
alone is the row nothing else was covering. Row 4's guard in particular — a naive
implementation that collects correctly and then throws the structural failure
bare passes rows 1, 2, 3 and 5-9.

The harness treats a suite that did not compile as **INCONCLUSIVE**, not as a
kill — the correction M7.A's run needed, built in this time rather than
discovered mid-run.

### What is NOT verified here

The Standard Schema issue `path` is still declared away in both copies (D4, a
deliberate reversal — it belongs to M7.C, where it gains its first reader). The
kernel still only PROBES `configSchema` (M7.C). Nothing about WHICH manifests are
rejected changed; this story changed only what a rejection says.
