---
title: 'Native config projection with a durable ownership ledger'
type: 'feature'
created: '2026-08-25'
status: 'done'
review_loop_iteration: 1
baseline_commit: '653fee2'
context:
  - '{project-root}/_bmad-output/planning-artifacts/architecture/architecture-panda-2026-08-24/correction-01-native-projection.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-2-2-projection-engine-with-sentinel-grammar-claude-target.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-2-3-codex-and-opencode-targets-via-trait-data.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** the shipped projection writes panda's own vocabulary into a reserved namespace. Verified against all three CLIs: none of them reads it. Claude Code's `settings.json` has no `mcpServers` key at all; OpenCode drops the namespace at decode; Codex takes foreign sub-keys into two tables it owns, so its documented `--strict-config` flag makes the user's whole `config.toml` fail to load. The machinery is sound; the output is fiction.

**Approach:** keep the machinery, replace the output. Targets render each registry entry in the executor's OWN schema at the location that executor actually reads. Panda's ownership of what it wrote moves to a durable panda-side ledger — the mechanism AD-6 already mandates for materialised entities — so nothing panda writes has to carry a marker a vendor schema could reject. This story covers ONE concept end to end: **MCP servers**, the only concept all three executors natively express. Skills (materialisation) and unprojectable tools are Stories 2.9 and 2.10.

**Verified target schemas (do not re-derive from memory):**
- Claude Code — MCP servers are NOT in `settings.json`. User scope: `mcpServers` in `~/.claude.json`. Project scope: `mcpServers` in `<project>/.mcp.json`. Entry shape `{type:'stdio', command, args, env}`.
- OpenCode — `opencode.json`, key `mcp.<id>`, shape `{type:'local', command: string[], environment?, enabled?}`. `command` is ARGV; there is no `args` field.
- Codex — `~/.codex/config.toml`, table `[mcp_servers.<id>]` (snake_case), fields `command`, `args`, `env`.

## Boundaries & Constraints

**Always:** panda writes ONLY fields the vendor's own schema defines, in the vendor's own vocabulary, at the location that vendor reads; the resulting file survives the vendor's STRICTEST validation mode, not merely its default; foreign content is preserved byte-for-byte and projecting twice is byte-identical; ownership of every written entry is recorded in a durable panda-side ledger (target, file, native location, content hash) written atomically before the projection is considered complete; drift is a ledger-versus-disk comparison that distinguishes edited / removed-by-user / never-written; a panda-written entry a user has edited is REPORTED and never silently overwritten; an entry the ledger does not claim is never touched; per-target failure isolation is preserved.

**Ask First:** writing to `~/.claude.json` beyond its `mcpServers` key (it is Claude's own state file, not a panda surface); any automatic removal of an entry panda did not write.

**Never:** no reserved `panda` namespace as a delivery mechanism; no marker key injected inside a vendor structure to prove ownership; no writing into a vendor-owned table with fields the vendor does not declare; no best-effort approximation for a concept the target cannot express (that is Story 2.10); no skills or hooks in this story.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Claude user scope | MCP entry, `~/.claude.json` present with foreign state | `mcpServers.<id> = {type:'stdio', command, args, env}`; every other byte identical | Coded per-target error |
| OpenCode | MCP entry, `opencode.json` with comments | `mcp.<id> = {type:'local', command:[bin, ...args]}`; argv joined, NO `args` field emitted | Coded per-target error |
| Codex strict mode | MCP entry, `config.toml` | `[mcp_servers.<id>]` with `command`/`args`/`env` only; file loads under `--strict-config` | Coded per-target error |
| Vendor schema conformance | Any written document | Every key panda wrote is a key that vendor's schema declares, asserted mechanically | Test failure |
| Second projection | Unchanged registry | Byte-identical output; nothing written | N/A |
| User edited a panda entry | Ledger hash ≠ disk | Reported as drift naming the entry; NOT overwritten | Drift entry |
| User removed a panda entry | In ledger, absent on disk | Reported as removed-by-user; not silently re-added | Drift entry |
| Entry left the registry | In ledger, gone from registry | Exactly the ledger-recorded region removed; foreign bytes untouched | Coded per-target error |
| Foreign entry with the same id | Present on disk, absent from ledger | Never touched; reported as a collision panda will not resolve | Drift entry |
| Ledger missing or corrupt | Fresh machine, or damaged file | Treated as "panda has written nothing"; nothing is removed on that basis | Typed warning |

</frozen-after-approval>

## Code Map

- `packages/contracts/src/projection.ts` -- REPLACE the owned-subtree vocabulary with the native-entry contract: what a target is asked to place, the ledger record shape, and the drift vocabulary (edited / removed-by-user / foreign-collision)
- `packages/projection/src/ledger.ts` -- NEW: the durable ownership ledger (atomic write, same discipline as the registry store)
- `packages/projection/src/formats.ts` -- RETAIN the offset-based JSONC splice and the atomic write; retarget it from a reserved ROOT key to an arbitrary native KEY PATH, and replace the TOML delimited-block strategy with native table emission
- `packages/projection/src/targets/*.ts` -- trait records carrying each executor's verified native location and entry shape
- `packages/projection/src/owned-subtree.ts` -- DELETE (its vocabulary is the thing being corrected)
- `packages/projection/test/` -- vendor-schema conformance assertions, byte-preservation and idempotence clauses retargeted, ledger-driven drift cases

## Tasks & Acceptance

**Execution:**
- [x] Native-entry contract + ledger record shape in contracts; retire the owned-subtree vocabulary
- [x] Ownership ledger with atomic writes and a corrupt/missing-file policy
- [x] Retarget the JSONC splice to a native key path; native TOML table emission replacing the delimited block
- [x] Three trait records against the verified schemas above
- [x] Ledger-driven drift: edited, removed-by-user, foreign-collision, and registry-removal cleanup
- [x] Vendor-schema conformance tests + every matrix row

**Acceptance Criteria:**
- Given a Registry holding an MCP server entry, when projection runs, then each executor receives it in that executor's own vocabulary at the location that executor reads
- And `codex --strict-config` loads the resulting `config.toml` without error
- And foreign content is preserved byte-for-byte and projecting twice is byte-identical
- And ownership is recorded in a durable panda-side ledger; a user-edited entry is reported as drift and never silently overwritten

## Spec Change Log

- **Review, "not found" is not "free" (patch, USER-DATA):** the TOML locator matched a table by exact line string, so five valid spellings of a table panda should recognise — padded brackets, a quoted key, a trailing comment, an inline table, a `[mcp_servers]` member — were invisible, and panda APPENDED a second definition of the same table. Redefining a table is a hard TOML parse error: the user's whole `config.toml` stops loading, in DEFAULT mode. This was the exact catastrophe correction-01 exists to eliminate, reintroduced through another door. Fixed by a bounded key canonicaliser plus two new strategy members (`containerConflict`, `entryConflict`) that report `foreign-collision` and write nothing wherever panda cannot PROVE the location is free. A valid-but-unusable shape now raises `PANDA_PROJECTION_NATIVE_UNCLAIMABLE` instead of telling the user their intact file is malformed.
- **Review, a failed ledger read destroyed the ledger (patch, USER-DATA):** verified end to end — one transient read failure made `read()` return empty, every entry then reported `foreign-collision` and contributed no record, and the engine wrote `{"records": []}` over the top. Every entry panda had ever written, in every config, became unowned forever with no re-adopt path. Under-claiming on READ is recoverable; PERSISTING that under-claim is terminal. `read()` now returns `absent | readable | unreadable` and the engine skips every ledger write for the run when the state is unreadable. Partial damage keeps the valid records and warns with the dropped count.
- **Review, removal authority came from the wrong place (patch, USER-DATA):** an mcp-server still in the registry but whose optional `command` was absent got DELETED from the user's config and reported merely as "skipped" — while the docs promised skipping meant "reported rather than approximated". Removal now keys off every id the registry holds, not the renderable subset: an entry panda cannot render is reported and left alone.
- **Review, AD-2 violation for zero benefit (patch):** `@skanl/panda-projection` had taken a RUNTIME dependency on `@skanl/panda-registry` to borrow `acquireLock` — a two-hop edge, since registry depends on the kernel, so a third party installing only the projection package pulled in the canonical Registry store and the microkernel. AD-2 names exactly that ("contract consumers forced to install the kernel"). The lock also bought nothing: it wrapped only `atomicWriteText` while the real read-modify-write window ran from `read()` to `write()`. Replaced with an in-process serialised, MERGE-based `update(scope, records)` that only ever touches its own target+file scope, so a cross-process race degrades to a recoverable under-claim instead of a lost claim. The borrowed lock also leaked `PANDA_REGISTRY_*` codes out of a projection API (AD-7); a test now asserts no registry code can surface from a projection key.
- **Review, formatting was treated as an edit (patch):** the content hash covered raw EOL and indentation, so git `autocrlf`, an editor save or Prettier flipped every entry to `edited` — after which panda refuses to touch any of them. For `~/.claude.json`, a file Claude Code itself rewrites, that is not a corner case. The hash is now taken over a canonical form contributed per strategy.
- **Review, the byte-preservation proof could pass vacuously (patch):** a zero-width span left by a removal satisfied the enclosing-span predicate and suppressed the insertion's own span, so panda rewrote an entry while reporting it owned zero bytes. Removal splices no longer push a span, and the clause suite gained a re-projection case that exercises the records-non-empty path the original proof never reached.
- **Review, the verification apparatus itself (patch):** `defaultPath` was asserted by BASENAME, so moving Codex to `~/.config/codex/` would have kept the suite green while panda wrote into a file the vendor never opens — this story's own failure mode, one directory up. Now asserted in full. More importantly the vendor schema table was a transcription of OUR spec, with both sides of every equality living in our repo: it could rot in step with the code. Three verbatim vendor excerpts are now vendored with their commit pins, `declaredKeys` is EXTRACTED from them rather than transcribed, `SHIPPED_TRAITS` is derived from the package's own exports, and an env-gated differential test runs the real `codex --strict-config` — asserting a control config is REJECTED before asserting panda's loads, so the check is proven capable of failing.
- **Honest gap recorded:** Claude Code is closed source, so its entry keys rest on published documentation with no commit to pin. The fixture says so and the suite asserts `documentationOnly: true`, keeping the weaker evidence visible rather than disguised. Only Codex exposes a config-validation flag that runs without a session, so Claude and OpenCode conformance rests on the vendored schemas alone.
- **Repo hygiene (patch):** `ledger.ts` twice acquired literal NUL bytes as a field separator. A NUL makes git and grep treat a source file as BINARY — no diff, no blame, and a grep over it silently returns nothing instead of failing, which is how a defect hides. Escaped, and a byte scan wired into `pnpm check` so it cannot recur. The scan caught itself on its first run.

## Design Notes

**Why a ledger instead of a sentinel.** A marker inside a vendor structure fails three ways at once: a JSON array entry has nowhere to put one, a directory of files has nowhere to put one, and a vendor with strict validation rejects it as an unknown field. AD-6 already had the answer for materialised entities — ownership is a durable record written at creation, never inferred — and projection simply never applied it. The ledger is also strictly more informative than a marker: it can tell "the user edited this" from "the user deleted this" from "panda never wrote it", which a marker's presence or absence cannot.

**Why MCP servers alone.** They are the one concept all three executors express natively, so one story proves the corrected model across all three targets without also carrying materialisation (2.9) or the unprojectable path (2.10). Splitting on the concept rather than on the executor is what keeps each story's acceptance criteria checkable against a real schema.

**TOML without a block.** `[mcp_servers.<id>]` tables may be defined anywhere in a TOML document, so panda appends one table per entry rather than managing a delimited region. Duplicate definition of the SAME table is the error to avoid, which is exactly what the ledger tracks. This also removes the top-level-key collision that made the old block harmful.

**Strict mode is the bar.** Tolerance by default is not tolerance. A projection that only works while the user avoids a documented flag is an outage panda installed on their machine.

## Verification

**Commands:**
- `pnpm check` -- expected: fully green
- Vendor conformance is asserted in-repo against the schemas above; any live-binary check stays env-gated and out of `pnpm check`
