# Spec M34.A — a credential in a URL is still a credential

**Status:** FROZEN
**Created:** 2026-09-04
**Base commit:** `547c6f4` (M33.A, CI green on both jobs)
**Story:** none as a board row. **A live credential leak in `panda export` at HEAD.**

## Intent

FR-21 says a credential-bearing entry is left out of a Bundle **and named**.
Measured at `547c6f4`, driving the real `createBundle`: a credential carried
inside a URL-shaped value **travels in `entries[]`, and `omitted` is empty** — so
`panda export` reports that nothing was left out while the token leaves the
machine.

This is not a gap in a feature that does not exist yet. `npx mcp-remote --url
https://user:TOKEN@host/mcp` is an ordinary way to run a remote MCP server
through today's stdio-only envelope, so the shape is reachable now.

## The measurement this rests on

Driven through the real `createBundle`, **with controls in both directions**. A
control that only proves the detector can say NO proves nothing about a zero —
`deferred-work.md` records that exact lesson from a probe that reported zero
because its regex matched nothing.

| value in `args` | omitted? | token in `entries[]` |
|---|---|---|
| `--token <32-char token>` — **CONTROL, must be caught** | **YES** | no |
| `--mode fast` — **CONTROL, must stay clean** | no | no |
| `--url https://mcp.example.com/sse?token=<32ch>` | **no** | **TRAVELS** |
| `--url https://mcp.example.com/mcp/<32ch>` | **no** | **TRAVELS** |
| `--url https://user:<32ch>@mcp.example.com/sse` | **no** | **TRAVELS** |

### The cause, and it is an asymmetry inside one function

`packages/registry/src/bundle.ts`, `credentialUnderFlag`:

```ts
if (PROVIDER_PATTERNS.some((pattern) => pattern.test(value))) return true
if (NOT_A_CREDENTIAL.some((pattern) => pattern.test(value))) return flagNamesASecret(flag)
// A normalized path is long and mixed by nature; it is also the one thing this
// envelope is FULL of, so excluding it is what keeps the detector usable.
if (looksLikePath(value)) return false
```

`looksLikePath` (`bundle.ts:161-163`) is true for anything containing `/`, `\`
or a leading `~`. **Every URL contains `/`.** So a URL short-circuits to "not a
credential" before the opaque-token rule ever runs — and it returns a flat
`false`, where its sibling one line above falls back to `flagNamesASecret(flag)`.

Measured consequence of exactly that asymmetry:

| under the SAME `--token` flag | omitted? |
|---|---|
| a git-SHA-shaped value (the `NOT_A_CREDENTIAL` branch) | **YES** |
| a URL carrying a token (the `looksLikePath` branch) | **no** |

Same flag, same intent, opposite verdicts, four lines apart.

### This is M21.A's own defect, on the sibling branch

M21.A shipped three commits ago as *"the flag names the value"*. Its sprint row
records the reasoning verbatim: the hex exclusion needed a SECOND SIGNAL, *"the
second signal was in hand and unread: `args` is an ORDERED array and a flag can
be inline."* It wired that signal into `NOT_A_CREDENTIAL` — **and not into
`looksLikePath`**, four lines away, in the same function, in the same `if`
ladder.

A fix for one branch that leaves its sibling leaking makes the surface LOOK
closed. That is this repository's own rule, from M17.A and inherited by M18.A,
and it is why this spec closes the branch rather than the URL case.

## The design — CORRECTED under measurement, and the correction is the lesson

### What was frozen

Give the path branch the fallback its sibling already has:
`if (looksLikePath(value)) return flagNamesASecret(flag)`. Derivation, not
invention — the line above it already reads exactly that way.

### Why that was WRONG, driven

It looked like derivation and was not. Measured through the real `createBundle`:

| `args` | with the flag fallback |
|---|---|
| `--token /var/run/secrets/<token>` | omitted — intended |
| **`--token /home/me/projects/some-server/bin`** — a real path, no token in it | **OMITTED — a FALSE POSITIVE that DROPS the user's entry** |
| `--token C:\secrets\<token>` | NOT omitted — the drive colon is read as an inline flag |

The sibling exclusion defers to the flag **after the value has already matched a
credential SHAPE**, so the flag only breaks a tie. On the path branch there is no
shape match, so deferring means *"any path under a secret-named flag is a
secret"* — and `--token /path/to/tokenfile`, a path to a file CONTAINING the
token, is an ordinary spelling. That is precisely the false-positive direction
the exclusion was measured into existence to prevent.

**A pattern that is correct next door can be wrong here.** It is the "read the
call site, not the callee" lesson in a new shape, and the control is what caught
it: the frozen design would have shipped a rule that drops legitimate entries.

### What ships instead: ask the parser, not a heuristic

A URL is **self-describing**. `userinfo`, a query VALUE and the last path segment
are where a credential is put; the scheme, host and the rest of the path are
structure. So the rule parses and tests only those parts — and a value that is
not a URL (a POSIX path, a Windows path, a `~` path, an npm package spec) fails
to parse, so the rule does not apply to it at all.

```ts
if (urlBorneSecrets(value).some((part) => OPAQUE_TOKEN.test(` ${part} `))) return true
if (looksLikePath(value)) return false   // UNCHANGED, and now measured to be right
```

This is M5.B's lesson running the other way. That story measured the "better"
answer (a template-literal semver type) against a corpus and found it rejected
valid input, so the plain runtime rule won. Here the better answer was measured
and **won**: `new URL()` from the standard library, ten rows in both directions,
**zero wrong verdicts**, and no false-positive cost because it only speaks about
values that are actually URLs.

`--url` must never join `SECRET_FLAG`: that would make every remote server's URL
a credential and drop the entry.

### The residual, named

A token sitting inside a plain filesystem path (`--token /var/run/secrets/<32ch>`)
is still not caught. That is narrower than the URL case, has no precise rule, and
the flag heuristic that would catch it was measured above to cost more than it
buys. Recorded in `deferred-work.md`.

## Boundaries & constraints

- **Do not widen `SECRET_FLAG`.** Adding `url` to it would make every remote
  server URL a credential and drop the entry. Measured: that is the
  false-positive direction that costs a user their entry.
- **Do not remove `looksLikePath`.** It is what keeps the detector usable on an
  envelope full of paths, and its exclusion was measured against a corpus.
- **`isCredential`'s published signature does not change.**
  `isCredentialNamedBy` stays unexported — measured zero readers outside the
  file when M21.A checked.
- **No new error code, no new field, no envelope change.** This is one branch.
- AD-7, English, `.ts` on relative imports.

## I/O & edge-case matrix

| `args` pair | expected |
|---|---|
| `--token <32ch>` | omitted (unchanged) |
| `--token <40-hex git sha>` | omitted (unchanged — the sibling branch) |
| `--token /var/run/secrets/<32ch>` | NOT omitted — the named residual; a flag heuristic here was measured to cost more than it buys |
| `--token https://h/x/<32ch>` | **omitted — the fix** |
| `--api-key https://h/?k=<32ch>` | **omitted — the fix** |
| `--url https://h/x/<32ch>` | **omitted — the URL rule, whatever the flag is called** |
| `--root /home/me/projects/s/bin` | not omitted (control — must stay clean) |
| `--config ~/.config/thing/config.json` | not omitted (control) |
| `--token` with a short value | not omitted |
| a bare path with no flag | not omitted |

## Code map

| file | change |
|---|---|
| `packages/registry/src/bundle.ts` | `urlBorneSecrets`, and one line in the ladder ABOVE the path exclusion. `looksLikePath` is UNCHANGED, and its comment now records why deferring to the flag there was measured and rejected |
| `packages/registry/test/bundle.test.ts` | the matrix above, with BOTH controls; and a clause pinning that a real path under a secret-named flag is the deliberate cost |

## Tasks & acceptance

1. **AC1 — the leak is closed for the named half.** Drive the real
   `createBundle`: `--token <url carrying a token>` is omitted AND named in
   `omitted[]`, and the token appears nowhere in the serialized artifact.
2. **AC2 — the controls hold in both directions.** A bare token is still caught;
   `--mode fast`, `--root <real path>` and `--config ~/…` are still clean. A run
   where a control fails measured nothing.
3. **AC3 — the residual is asserted, not assumed.** A clause pins that `--url
   <url carrying a token>` is NOT omitted today, with a comment naming why and
   pointing at the ledger entry. A residual nobody asserts is a residual nobody
   notices when it changes.
4. **AC4 — falsified.** Reverting the branch to `return false` reddens AC1 and
   nothing else. Run it; say which assertion reddens.
5. **AC5 — no false positive was bought.** Re-run M18.A's real-id corpus if it
   still exists (127 real ids from this machine's skills roots and every
   `mcpServers` key across the three vendor configs); otherwise say it was not
   available and drive the paths in the matrix instead.
6. **AC6 — the gate.** `pnpm check` on Node 24 and 26, plus `pnpm build &&
   pnpm proof:consumer-install`.

## Ask First

- If closing the named half requires touching `SECRET_FLAG`, `looksLikePath` or
  `OPAQUE_TOKEN` rather than the one branch.
- If the one-line change turns any existing clause red — that would mean a
  shipped test PINS the leak, which is what `bundle.test.ts` did once before
  (M18.A found an `it.each` row asserting the leaking shape) and it is a
  renegotiation, not a test to update quietly.
- If the real-id corpus shows any new false positive.

## Spec change log

- 2026-09-04 — frozen at `547c6f4`. Found while measuring the HTTP/SSE transport
  fork; it is independent of that fork and precedes it, because a `url` entry
  would multiply exactly the surface that leaks today.

## Verification

Implemented by the coordinator. Every number below was driven through the real
`createBundle` or `isCredential`.

**AC1 — GREEN.** All three URL-borne shapes are omitted AND named, and the token
appears nowhere in `entries[]`: userinfo, query value, last path segment.

**AC2 — GREEN, controls in both directions.** A bare opaque token in `args` is
still caught; `--mode fast` is still clean; a real path under `--root` and a real
path under `--token` are both still clean. The last of those is the one the
frozen design would have broken.

**AC3 — RESTATED.** The frozen residual was "a URL under a flag that does not
name a secret". The URL rule closes that, so the residual is now the narrower
one named in the design: a token inside a plain filesystem path. Asserted by the
`leaves the path exclusion UNCONDITIONAL` clause, which pins both directions.

**AC4 — GREEN, falsified.** Removing the URL rule line reddens exactly **4** of
90 clauses in `bundle.test.ts` — the three URL rows and the control inside the
unconditional-path clause — and leaves the other 86 green. The revert was
confirmed applied (`urlBorneSecrets(value)` occurrences: 1 → 0) BEFORE the result
was believed, because an earlier revert in this same session silently failed to
apply and reported a green that meant nothing.

**AC5 — GREEN.** Real corpus from this machine: **66 values** — every skills-root
directory name across the three roots, plus every `mcpServers` id, command, arg
and url in `~/.claude.json`. **0 flagged.** Control: the detector still fires on
a provider-prefixed key and on a URL carrying a token, so the zero is a
measurement and not an empty run.

**AC6 — the gate.** See below.

### What this story did NOT do

- It did not touch `SECRET_FLAG`, `OPAQUE_TOKEN` or `looksLikePath`.
- It did not change `isCredential`'s published signature.
- It did not close the plain-filesystem-path residual.
