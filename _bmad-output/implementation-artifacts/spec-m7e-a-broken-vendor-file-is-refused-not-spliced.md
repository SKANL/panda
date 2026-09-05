# Spec M7.E — a broken vendor file is refused with its location, not silently spliced

**Status:** FROZEN
**Implements:** correction-01 C5 (report honestly, never fake) and AD-7 at a
surface that today does neither; found by the last cordis lens
(`packages/hmr/src/error.ts`), whose stated conclusion was WRONG and whose thread
was right
**Created:** 2026-09-01

---

## Intent

Panda splices its entries into a user's native vendor config by TEXT OFFSET,
using a tree it gets from `jsonc-parser`'s `parseTree`. `parseTree` is a
RECOVERING parser: handed a broken document it returns a tree anyway, and panda
calls it with no error out-param and no options.

So panda does not refuse a malformed JSONC vendor file. It splices into a tree
built from a guess, and writes the result.

Measured, by execution: for a file whose only fault is an unquoted top-level key,
panda injects an entire `"mcp"` object **inside the user's own server
definition** and writes it out. The user began with one typo and ends with a
structurally destroyed config. Panda claims it can "undo exactly what it wrote
and nothing else"; after this splice the ownership span does not mean what the
ledger thinks it means.

The cordis lens that found the thread reported the wrong symptom — it said the
user gets a misleading message. There is no message. That is the defect.

## The measurement this rests on

Executed on 2026-09-01 at `3ed86f8`. The behavioural claims were produced by
RUNNING the real target's `merge`, not by reading.

1. **`objectRootOf`'s non-strict branch parses with no options and collects no
   errors.** `packages/projection/src/formats.ts:221` — `const root =
   parseTree(body)`. The only guard is `!root || root.type !== 'object'` (`:222`),
   which a recovering parse almost never trips.

2. **A recovering parse returns `type === 'object'` for every realistic fault.**
   Driven directly against the installed `jsonc-parser@3.3.1`: stray comma,
   missing close brace, unquoted key and a truncated string ALL return
   `root.type === 'object'` with `errors.length > 0`. Only a genuinely non-object
   root (`[1,2,3]`) trips the existing guard, and there the existing message is
   correct.

3. **Panda writes a corrupted document.** `.scratch/probe-malformed-jsonc.mjs`
   drives `createOpenCodeConfigTarget().merge({...})` — the same pure call the
   engine makes at `engine.ts:189` — with one `mcp-server` entry.
   CONTROL, a valid file: merge succeeds and the result parses as strict JSON.
   Unquoted top-level key: merge SUCCEEDS, and the result is

   ```
   {
     mcp: {
       "keep": { "type": "local", "command": ["x"],
   "mcp": {
     "context7": { ... }
   } }
     }
   }
   ```

   Panda's object landed INSIDE `keep`. The other three faults are less violent —
   panda preserves the pre-existing breakage and appends — but all four succeed
   silently and all four produce a file that is not valid JSON.

4. **`errors.length > 0` is NOT a safe refusal condition, and this is the whole
   design.** A TRAILING COMMA is legitimate JSONC and every JSONC-tolerant vendor
   accepts it. Measured: `parseTree('{"mcp":{},\n}', errors)` → `errors.length ===
   2`, with the SAME code (`PropertyNameExpected`) a genuinely broken double comma
   produces. Refusing on any error would reject working user files — and
   `packages/projection/test/native-projection.test.ts:145` ("preserves comments
   and trailing commas byte-for-byte") is the clause that would catch it.

5. **`{ allowTrailingComma: true }` separates them cleanly.** Same corpus, same
   run: line comment, block comment, trailing comma, nested trailing comma and
   array trailing comma → **`errors.length === 0`**. Unquoted key, double comma,
   missing brace and unterminated string → **`errors.length >= 1`**, each with a
   `ParseErrorCode` and a byte `offset`.

6. **The option is already used in this very file.** `formats.ts:394` —
   `parse(\`{${ownedText}}\`, [], { allowTrailingComma: true })`. So `formats.ts`
   currently gives two different answers to "what is valid JSONC" depending on
   which function you enter through. This story removes the inconsistency; it does
   not introduce a policy.

7. **`printParseErrorCode` is exported by the installed dependency.**
   `jsonc-parser@3.3.1`, already a declared dependency of `@skanl/panda-projection`.
   No new dependency.

8. **TOML is deliberately NOT parsed and stays that way.**
   `formats.ts:547-551`, verbatim: *"Foreign TOML is never parsed, so malformed
   foreign TOML is undetectable here by design. Every shape panda MUST notice is a
   container conflict, which fails closed below."* A comment above the line
   explaining the decision means the decision is deliberate.

9. **A refusal is contained to one target.** `engine.ts:257-259` catches per
   target and `continue`s, so a broken `opencode.json` fails that target alone and
   the other executors still project. Pinned by `engine.test.ts:103`.

## Boundaries & Constraints

### D1 — the non-strict branch collects errors, with trailing commas allowed

`objectRootOf`'s JSONC branch becomes
`parseTree(body, errors, { allowTrailingComma: true })`. Any collected error is a
refusal. Measurement 5 is what makes this safe and measurement 4 is why the
option is not optional.

### D2 — the refusal names WHERE, in the vendor's own coordinates

The thrown `nativeMalformed` detail carries `printParseErrorCode(errors[0].error)`
plus a 1-based `line:column` derived from `errors[0].offset`. Panda already tells
a user which FILE is malformed and has never told them where. This is cordis's
`error.ts:22-30` idea — a finding has a location — with panda's one-line CLI
output instead of a rendered code frame. **No code frame and no `@babel/code-frame`:**
that is a dependency for a renderer, and panda prints one line.

Only the FIRST error is named. A recovering parser cascades — an unquoted key
produced four — and the first is the one the user has to fix; the rest are its
shadow.

### D3 — the strict branch is untouched

`claude-mcp.ts:24` is the only `strictJson: true` target, and its `JSON.parse`
already throws with a position on every fault in the corpus. Changing it would
mean re-deriving a message V8 already gets right.

### D4 — refusal, not repair

Panda does not fix the file, does not reformat it, and does not fall back to
appending. `runProjection` reports the target as failed and every sibling target
still projects (measurement 9). The user fixes one typo at a named line; panda's
job is to not make that worse.

### D5 — not in this story

TOML (measurement 8). The `entryConflict` and `locate` callbacks at
`formats.ts:373` and `:382` also call bare `parseTree`, but both are reached only
AFTER `validate()` has accepted the document, so hardening them would be guarding
a path this story has already closed. Named here so the next reader does not
mistake them for an oversight.

## I/O & Edge-Case Matrix

| Native file | Expected |
| --- | --- |
| valid JSON | unchanged behaviour — CONTROL for every row below |
| line comment / block comment | accepted, byte-preserved (unchanged) |
| trailing comma, nested or in an array | accepted, byte-preserved (unchanged) |
| unquoted key | REFUSED `projectionNativeMalformed`, naming code and `line:column` |
| double comma | REFUSED, same shape |
| missing close brace | REFUSED, same shape |
| unterminated string | REFUSED, same shape |
| root is an array | REFUSED with the EXISTING "document root is not an object" |
| one broken target among three | that target fails; the other two still project |
| a `strictJson` target with any fault | unchanged: V8's message with its position |

## Code Map

| File | Change |
| --- | --- |
| `packages/projection/src/formats.ts` | `objectRootOf` non-strict branch: collect errors, allow trailing commas, refuse with location; one small offset→line helper |
| `packages/projection/test/native-projection.test.ts` (or a sibling) | the matrix above, including the accept rows as regression guards |

## Tasks & Acceptance

1. The offset→`line:column` helper, with its own clauses (offset 0, first line,
   last line, after a trailing newline).
2. The refusal, with `allowTrailingComma: true`.
3. Tests: every REFUSED row asserts the code AND the location; every accepted row
   asserts byte-preservation, because those are the rows that make the refusal
   safe.
4. Per-rule falsification; a mutant that does not compile is INCONCLUSIVE.
5. Both gate halves.

## Ask First

Nothing. Every decision is settled by a measurement above, and every behavioural
claim was produced by executing the real code path.

## Spec Change Log

- 2026-09-01 — frozen at `3ed86f8`.

## Verification

### The gate — both halves

bytes OK · `pnpm typecheck` clean across ten packages · `pnpm lint` exit 0 ·
**1237 tests pass** (projection 267, up 11) · `pnpm build` Done ·
`pnpm proof:consumer-install` 8 passed, 1 skipped. The known local-only
`skills-discovery.live.test.ts` red is excluded with `**/*live.test.ts` and was
verified pre-existing in the previous story.

### Driven through the real binary, against a stashed baseline

A throwaway home under `.scratch/` with one fault in `opencode.json` — an
unquoted top-level `mcp` key — plus one registered `mcp-server`, then `panda init`:

| build | exit | the user's file afterwards |
| --- | --- | --- |
| **with the fix** | **1** | byte-identical to what they wrote, plus one stderr line: `opencode: PANDA_PROJECTION_NATIVE_MALFORMED: … is malformed: InvalidSymbol at line 2, column 3` |
| **baseline** (`git stash` of `formats.ts` only) | **0** | their `keep` server definition destroyed, with panda's whole `"mcp"` object nested inside it |

The baseline row is the story: exit **0**, reporting success, on a corrupted
write into a file panda then claims it can undo exactly.

`written: false` in the envelope, and the other executors' targets in the same
run are unaffected — `engine.ts:257-259` contains the failure per target, as
measurement 9 predicted.

### Every location verified by hand

A position that is merely PRESENT is worse than none: it sends the user to the
wrong line carrying panda's authority. Each was counted against its body before
being pinned — `line 3, column 51` is the second comma of `…["x"] },,`;
`line 2, column 3` is the `m` of the unquoted key; `line 4, column 1` is EOF
after three lines; `line 3, column 44` is the opening quote of the unterminated
string.

### Falsification — six rules, six killed, none inconclusive, control green

Harness at `.scratch/falsify-m7e.mjs` (gitignored), each mutant restored
byte-for-byte.

| Rule | Mutation | Outcome |
| --- | --- | --- |
| D1a | `errors[0]` forced to `undefined` | KILLED — all four refusal clauses plus the offset-0 clause |
| D1b | `allowTrailingComma` dropped | KILLED — **fifteen clauses, most of them pre-existing** |
| D2a | line hardcoded to 1 | KILLED — four refusal clauses |
| D2b | column made 0-based | KILLED — five clauses |
| D2c | the parser code replaced with prose | KILLED — four refusal clauses |
| D3 | the strict branch routed through the new path | KILLED — *reports a broken file through JSON.parse, unchanged by M7.E* |

D1b is the one that matters. Measurement 4 predicted that refusing without
`allowTrailingComma` would reject working files; the mutation proves it against
the suite, and most of its fifteen killing clauses — `preserves comments and
trailing commas byte-for-byte`, the byte-idempotence rows across three targets —
were written long before this story. The option is load-bearing, not decoration.

### A dead branch of my own, measured and deleted

`positionOf` was first written with a `bounded === 0 ? 1 : …` special case for
offset 0. Driven against eight inputs including every edge, the special case and
the general form are **identical in all eight**: `lastIndexOf('\n', -1)` is -1,
the `+1` makes `lineStart` 0, and `''.split('\n')` has length 1. Deleted, and
`reports the very first byte as line 1, column 1` is what proves deleting it
changed nothing. Same lesson as M7.D's unconditional sink: do not build a branch
that cannot fire.

### A fact about `merge` found only by running it

`ProjectionConfigTarget.merge` is declared `async` and refuses
**synchronously** — `validate()` runs before the first `await` — so
`expect(target.merge(...)).rejects` never receives a promise and every refusal
clause failed on the first run while the code was correct. The tests use an
explicit `try/catch` helper that also fails loudly if `merge` RETURNS, which is
the one outcome this story exists to prevent.

### What is NOT verified here

TOML (deliberately unparsed, measurement 8). `entryConflict` and `locate` still
call bare `parseTree`, reachable only after `validate()` has accepted the
document. And the corpus is the four faults measured — a recovering parser has
more shapes than four, and the guarantee proven is "these four are refused with a
correct location", not "every malformed document is".
