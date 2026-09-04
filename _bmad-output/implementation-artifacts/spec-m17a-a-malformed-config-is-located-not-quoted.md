# Spec M17.A — a malformed config is LOCATED, not quoted

**Status:** FROZEN
**Story:** not an epic story. Closes a credential leak measured through the real
binary in three of four verbs, and the follow-up the DeepSeek Harness note named
as "the cheapest follow-up in this note" and then went unread for four
milestones.
**Base commit:** `4232e9c`

---

## Intent

`panda doctor`, `panda init` and `panda ingest` print the contents of a user's
`~/.claude.json` back to the terminal when that file is malformed — and that file
is where MCP server arguments live, which is where an API token lives.

Measured, through the shipped binary:

```
native config file '…\.claude.json' is malformed:
Unexpected token ',', ..."","args":[,"sk-live-"... is not valid JSON
```

`nativeMalformed` (`packages/projection/src/formats.ts:272-279`) embeds
`cause.message` verbatim and attaches `{ cause }`, so the parser's text reaches
stdout, stderr, panda's JSON output, and any stack that is logged.

The DeepSeek Harness research note recorded the fix four milestones ago and named
it the cheapest thing available (`§2(e)`): DSH re-renders a YAML parse error as
**code plus line/column only**, deliberately discarding `error.message`, "because
the parser quotes the offending source line and in this document that line is a
secret" — with a test asserting the secret appears in neither the message nor the
stack. Panda has the same hazard and did not have the fix.

## The measurement this rests on

Executed 2026-09-03 at `4232e9c`, every zero with a control.

| # | Claim | Evidence |
|---|---|---|
| M1 | Node's `JSON.parse` quotes SOURCE TEXT in some error messages | Eight malformed shapes probed, identical on Node 24.14.1 and 26.8.1. Six report position only. **Two quote the document**: a stray comma before an array element gives `Unexpected token ',', "{"args":[,"sk-live-"... is not valid JSON`, and a `NaN` literal gives `...ackslash"3XYZ","n":NaN}"`, which is the token's TAIL. **Control:** the secret is present in all eight inputs. |
| M2 | The leaking shapes are exactly the ones with NO location | The six clean shapes end in `at position N (line L column C)`. The two leaking ones end in `is not valid JSON` and carry no position at all. So the parser's message cannot simply be trimmed to its location — for the dangerous shapes there is no location in it. |
| M3 | It reaches the user through the real binary | With the secret placed immediately after the syntax error, `panda doctor`, `panda init` and `panda ingest --dry-run` all print `sk-live-`. `panda list` does not (it never parses the vendor file). **Control:** panda names `.claude.json` in its report, so "clean" for `list` is an absence and not a run that never looked. |
| M4 | Only the PREFIX escaped here, and that is luck, not a limit | Node's snippet is a fixed window around the error position. A shorter token, or a syntax error one character further along, puts more of it — or all of it — inside the window. |
| M5 | ~~Panda's OWN documents do not leak~~ **FALSE — see Spec Change Log 1.** | The measurement placed the stray comma at the start of `entries` with the credential far down the document, outside V8's fixed snippet window. Re-run with the credential ADJACENT to the fault, `.panda/registry.json` leaks through `panda list`, `panda doctor` AND `panda init`. |
| M6 | Panda already has the machinery the fix needs | The non-strict path already uses `jsonc-parser`'s `parseTree` errors, which carry offsets. M7.E's whole story was refusing a malformed vendor file **with its `line:column`**, so panda already believes a location is what a user needs. |

---

## Boundaries & Constraints

### D1 — the parser's message is DISCARDED, not trimmed

M2 is why. For the shapes that leak, the message has no location to trim down
to — the location and the leak are not separable parts of the same string. So
the message is dropped whole and replaced with a location panda derives itself.

The attached `{ cause }` goes too. A cause is reachable from any stack that is
printed or logged, so keeping it would move the leak rather than close it. What
survives is what the user acts on: the file, and where in it.

### D2 — the replacement is a LOCATION, because that is what M7.E already promised

M7.E's story is "a broken vendor file is REFUSED with its `line:column`, not
spliced". The location comes from `jsonc-parser`'s `parseTree` errors, which
panda already uses on the non-strict path and which carry offsets — not from
re-parsing with a second library, and not from a regex over Node's message.

Where no location can be derived at all, panda says the file is malformed and
says it could not locate the fault. **It does not fall back to the parser's
message**, because "we could not find the line" is a smaller loss than printing
a credential.

### D3 — the gate asserts absence from the MESSAGE and from the STACK

DSH's test shape, verbatim in intent: plant a credential-looking value adjacent
to a syntax error, and assert the value appears in NEITHER the thrown error's
message NOR its stack. Asserting only the message would leave the `cause` path
open, which is the half this story is closing.

### D4 — the corpus is the shapes that LEAK, plus the ones that do not

A test built only from the shapes measured to leak would pass a fix that broke
the location for everything else. Both classes are in the corpus: the two
leaking shapes, and at least two of the six that report a clean position, so the
fix is proven to keep the location where one exists.

This is the falsification lesson this repository has paid for twice: a corpus
drawn from one shape proves only that one shape.

### D5 — the other two vendor formats are checked, not assumed

TOML (codex) and JSONC-tolerant (opencode) travel different code paths. M1 and M3
measured the strict-JSON path only. Both others are driven with the same planted
credential before this story claims anything about them, and whatever is found is
reported — a fix for one format that leaves a sibling leaking is worse than
useless, because it makes the surface look closed.

### D6 — not in this story

- Redacting values panda READS successfully. A well-formed config's token is not
  printed today and this story does not change what panda does with valid input.
- Any change to the secret DETECTOR (`bundle.ts`). That is about what leaves in a
  bundle; this is about what leaves in an error.
- Any new error code. `projectionNativeMalformed` already names this state.

---

## I/O & Edge-Case Matrix

| # | Input / state | Expected |
|---|---|---|
| E1 | Strict JSON, stray comma, credential adjacent | Refused with the file and a location. The value appears in neither message nor stack. |
| E2 | Strict JSON, `NaN` literal after a credential | Same. This is the shape whose snippet carries the token's TAIL. |
| E3 | Strict JSON, a shape whose parser message DOES carry a position | Refused, and the location is still reported — the fix must not lose it. |
| E4 | A fault panda cannot locate | Refused, saying the file is malformed and that the location could not be determined. Never the parser's message. |
| E5 | TOML (codex) with a credential beside the fault | Measured by D5; behaviour stated rather than assumed. |
| E6 | JSONC-tolerant (opencode), same | Same. |
| E7 | A well-formed config holding a token | Unchanged: panda reads it and prints nothing (D6). |
| E8 | The error's `cause` chain | Carries no document text at any depth. |
| E9 | `panda doctor` / `init` / `ingest` on E1 | All three clean, driven through the binary — the three that leak today. |

---

## Code Map

- `packages/projection/src/formats.ts` — `nativeMalformed`, the strict-JSON
  branch of `objectRootOf` that feeds it, `TOML_STRATEGY.listEntries`'s prose
  echo, and the lenient branch's unguarded `parseTree` (Change Log 2).
- `packages/registry/src/store.ts` — the registry store parse failure.
- `packages/registry/src/bundle.ts` — the import parse failure.
- `packages/projection/src/{ledger,config-write}.ts` — brought under the rule.
- the gate of D3/D4, ONE gate over every document panda parses.

---

## Tasks & Acceptance

- [ ] The parser's message and the attached cause are gone
- [ ] A derived location replaces them, and survives where one exists
- [ ] The gate asserts absence from message AND stack
- [ ] The other two formats measured and their behaviour stated

**Acceptance Criteria:**

1. **The three verbs that leak today are clean, driven through the binary**, on
   the exact fixture that leaks at `4232e9c`. Its control in the same run: panda
   still names the file and still refuses, so "clean" is not "panda stopped
   looking".
2. **The value appears in neither the message nor the stack**, asserted
   separately — the stack half is what closes the `cause` path.
3. **The location survives** for a shape whose fault panda can locate, proven by
   a shape that reports a position today.
4. **Removing the redaction turns the gate red**, planted — a redaction with no
   failing test is the prose guarantee this repository exists to refuse.
5. **Every document panda parses is driven with the same planted credential,
   adjacent to the fault** — the three vendor formats, the registry store, a
   bundle — and none of them prints any part of it, in message or in stack.
6. **The registry store's leak is closed and proven at the binary**: `panda list`
   is the verb that leaks today and must come back clean, with panda still
   refusing and still naming the file as its control.
7. **The TOML prose echo is closed too**, and its control is the JSONC reporter
   for the same input, which already names the key and the type without the
   value.

---

## Ask First

- Any change to what panda does with a VALID config's contents.
- Any new error code, or any change to `projectionNativeMalformed`'s meaning.
- Dropping the location entirely rather than deriving one.

---

## Spec Change Log

0. Frozen at `4232e9c`. Written after the leak was reproduced through the shipped
   binary in three of four verbs, with a control proving panda had read the file.

1. **M5 was FALSE and the story WIDENS, because a half-closed leak is worse than
   an open one.** The implementer refused to widen without asking and filed a
   renegotiation; it was right, and the coordinator confirmed it by execution.

   **The author made the same measurement error twice in one session.** The first
   time, a `"--token"` string sat between the syntax fault and the credential, so
   the vendor-config probe read clean — caught, corrected, and the leak
   reproduced. The second time, the stray comma was placed at the start of
   `entries` with the credential far down the document — and that reading was
   written into this spec as a frozen measurement. V8's snippet is a **fixed
   window around the fault**, which M4 already stated on this page; a probe that
   puts the secret outside that window measures the window, not the code.

   Re-measured with the credential adjacent: `.panda/registry.json` leaks through
   `panda list`, `panda doctor` and `panda init` — and `list` is the verb M3 named
   as its clean control. `panda import` leaks the same way from a bundle.

   **THE RULE THIS STORY NOW CLOSES**, rather than the one site it started at:
   *no error panda raises about a document quotes that document's content.* Four
   sites, all the same class:
   - `packages/projection/src/formats.ts` — `nativeMalformed` (fixed).
   - `packages/registry/src/store.ts` — the registry store parse. This is THE
     document that holds `mcp-server` args, so it is the sharpest of the four.
   - `packages/registry/src/bundle.ts` — `panda import`.
   - `packages/projection/src/formats.ts`, `TOML_STRATEGY.listEntries` — a
     DIFFERENT mechanism and worth naming: not a parser message but **panda's own
     prose interpolating a raw source line**, `'…args' is spelled '[, "<token>"]'`.
     Its control is the JSONC reporter for the same input, which names the key and
     the type and prints nothing of the value. A rule about parser messages alone
     would have left this one open.

   Two further `{ cause }`-plus-`error.message` sites on panda's own documents
   (`projection/src/ledger.ts`, `projection/src/config-write.ts`) hold paths and
   hashes rather than args; measured, no leak, and they are brought under the same
   rule anyway rather than left as the next thing someone rediscovers.

   **The gate becomes one gate over every document panda parses**, not four
   patches with four tests. Same corpus discipline: for each document, a shape
   measured to leak AND a shape that reports a clean location.

2. **E4 turned out to be reachable rather than defensive, and the guard is the
   implementer's finding.** `jsonc-parser`'s `parseTree` RECURSES and throws
   `RangeError` past roughly 5,000 nesting levels, on documents V8 also rejects.
   Unguarded, the new location-deriving call would have replaced a coded
   `PandaError` with a bare `RangeError` — a regression introduced by the fix
   itself. Caught, and driven with a 20,000-deep document. The pre-existing
   lenient branch has the same unguarded hazard; it is in scope now that the
   story covers the rule rather than the site.

---

## Verification

_Empty until the work is done and verified by execution._

---

### Coordinator verification, on top of the implementer's

**The two fixtures that leaked at `4232e9c` are clean, re-run with the
coordinator's own drivers**, credential adjacent to the fault in both. The
vendor config through `doctor`/`init`/`ingest`/`list`, and `.panda/registry.json`
through `list`/`doctor`/`init` — the one my false M5 had declared safe. Controls
held in every run: panda still refuses, still names the file, still codes.

**A PLANT ON FOUR VERBS THE IMPLEMENTER'S REPORT DID NOT NAME.** It drove
`list`, `doctor`, `init`, `ingest` and `import`. The coordinator drove `export`,
`swap`, `status` and `remove` against a malformed registry store — `export` in
particular, because it READS the document that holds `mcp-server` args. Eight
combinations, all clean.

**And the control that makes it worth something:** the same plant with a SHORT
token, `sk-QQQ9`, because V8's window is a fixed span and a short value sits
wholly inside it where a long one shows only its head. Raw `JSON.parse` on that
input answers:

```
Unexpected token ',', "{"a":[,"sk-QQQ9"]}" is not valid JSON     quotes it whole: true
```

The underlying parser demonstrably hands back the ENTIRE value, and panda prints
none of it, across four verbs nobody had tested. That is a stronger statement
than any of the long-token runs, because with a long token a clean result is
partly V8's truncation doing the work.

**The dependency posture is unchanged and was checked, not assumed.**
`@panda/registry` gains `jsonc-parser`, which is not a new third-party
dependency: it is the SAME one `@panda/projection` already had, and the repo
still ships exactly ONE distinct external package across all twelve manifests.
The helper is duplicated rather than homed in `@panda/contracts` for a measured
reason — contracts has no third-party dependency and `proof:consumer-install`
fails a package that gains one by design — and the two copies cannot drift
because one gate drives both.

**The gate**: bytes 0, typecheck 12/12, lint 0, **1,543 tests green on Node 24
AND Node 26.8.1** across twelve packages (1,516 before), build 12/12, and
`proof:consumer-install` 10 passed / 1 skipped.

### What this story cost to learn, and it was mostly the author's

Three of the findings here are corrections to work done in this same session:

1. **M5 was a false negative I wrote into a frozen spec.** Twice in one session I
   placed the credential outside V8's snippet window and read the result as
   "clean" — once caught immediately, once frozen. M4, on the same page, already
   said the window is fixed. A probe that puts the secret outside the window
   measures the window.
2. **A vacuous clause that was green.** The implementer's first TOML test drove
   `target.claim({entryId: 'ctx'})` and asserted the report contained `ctx` — a
   value the test itself supplied, for a document the reader never opened. *A
   control that can be satisfied by the test's own input is not a control.*
3. **Nine hand-computed column numbers, all nine wrong, the code right every
   time.** Corrected from measured output rather than from arithmetic.

And one that is older: three M7.E clauses asserted that panda repeats the
document back — `line N column M` in V8's own spelling, and `toContain("'uvx'")`.
All three were revoked here, because asserting the parser's message reaches the
user is asserting the vehicle the credential travelled in.

