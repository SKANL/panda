# panda — Codex kickoff prompt

Open Codex **with `C:\code\panda` as the working directory**. Paste everything
below the line as the first message. It supersedes the old
"session cwd is camtom-dev-3" framing in `SESSION-HANDOFF.md` § 0.

---

## 0. Where you are

The project is `C:\code\panda` and it **is** your working directory. There is no
other repository in play: panda no longer borrows anything from any `camtom-*`
checkout. The BMAD skills live at `C:\code\panda\.claude\skills\bmad-*` (49 of
them, local tooling, kept out of git via `.git/info/exclude`) and the BMAD
install is `C:\code\panda\_bmad\`.

Two read-only checkouts outside the repo are inputs to this session, never write
targets: `C:\code\cordis` and `C:\code\deepseek-harness`.

Before `git add`, run `git status --porcelain` and read it. Stage explicit
paths — never `git add -A`. Untracked `rtk/`, `.scratch/`, `.claude/skills/` are
excluded on purpose. Scratch files go to `C:\code\panda\.scratch\`.

## 1. Read these before acting

- `AGENTS.md` — the real rules file (architecture rules and the gate that
  enforces each one). `CLAUDE.md` only points at it.
- `_bmad-output/SESSION-HANDOFF.md` — the long-form record of what was learned
  and paid for. **§ 8 "State at handoff" is STALE** (it names `5743438`; `main`
  has moved on through the M38.A work). Treat every state claim in it as a
  hypothesis and re-measure. § 3 (tool traps), § 5 (architecture rules) and § 7
  (lessons) are still current and are the valuable part.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — story states, and
  read the trailing comments. **This board has lied three times** about states
  its own rows contradicted. Recount by reading rows and by running the binary,
  never by reading a header.
- `_bmad-output/planning-artifacts/research/` — five research notes, four of
  which are the prior art for this session (§ 3 below).
- `_bmad-output/implementation-artifacts/deferred-work.md` — append-only ledger.
  Read it before claiming something is missing.

Re-derive the current state yourself before planning anything:

```bash
git log --oneline -10
git status --porcelain
gh run list --limit 5 --json headSha,name,status,conclusion   # match the SHA yourself
```

`gh run list --commit <sha>` returns a **false empty** for commits that have
runs. Do not use it.

## 2. Refresh the two upstream checkouts first

Both clones were measured at fixed commits and are probably behind. Bring them
current and record the delta before mining anything, because a research note
that cites `path:line` against a moved tree is worse than no note.

```bash
git -C C:/code/cordis fetch --all --tags && git -C C:/code/cordis log --oneline -5
git -C C:/code/deepseek-harness fetch --all --tags && git -C C:/code/deepseek-harness log --oneline -5
```

Prior notes measured **cordis at `0027892`** and **deepseek-harness at
`4e84901`**. For each repo:

1. Pull (fast-forward only; these are read-only mirrors, never commit into them).
2. `git diff --stat <old-sha>..HEAD` and read it. Name, in the new note, which
   packages moved and whether any `path:line` a prior note cites still resolves.
3. Re-index both: `codegraph status` / `codegraph sync` (or `codegraph index`
   only if the index is corrupt), `gitnexus status` then `gitnexus analyze .`,
   and rebuild graphify if the tree moved materially.
4. If a prior finding's cited line has moved or disappeared, say so explicitly.
   A silently re-anchored citation is the defect class this repo exists to hunt.

## 3. What has already been mined — do not re-open it

Four notes, all `validation: measured`, all with verified claim counts:

| note | scope it closed |
|---|---|
| `cordis-spatiotemporal-composability-2026-09-01` | all nine cordis packages, eight lenses; decision: **take the ideas, refuse the dependency**; produced M7.A–M7.E |
| `deepseek-harness-the-product-layer-2026-09-02` | ~10 of DSH's ~50 package groups, six lenses |
| `deepseek-harness-the-unopened-half-2026-09-03` | ~30 of 50: workspace/sandbox/subprocess/shell/fs, boot/bundle/preset/sdk/host, context/compaction/spill/todo/plan, guard/identity/credentials/api/acp, plus the engineering machinery |
| `deepseek-harness-the-last-nine-groups-2026-09-04` | hooks, settings, typert, test-support, experimental, subagent, skill, mcp, util |

Each note names its own limits in its closing section. **Read those sections
first and derive this session's scope by subtraction**, the way the 09-03 and
09-04 notes derived theirs — with a control for every zero.

## 4. The mission for this session

Go deeper, and go where the four notes did not.

**Axis A — what changed upstream.** Everything new since `0027892` / `4e84901`
is unmined by construction. Read the new commits as *decisions*: what did they
fix, what did the fix reveal about the model, and does panda have the same hole?

**Axis B — the surfaces nobody opened.** Candidates, each to be confirmed absent
from all four notes with a control before being opened:

- **Distribution and release**: DSH's `lefthook.yml`, release workflow, tag and
  changeset flow, `patches/`, `vendor/`, `THIRD_PARTY_NOTICES.md`. This is the
  exact ground panda's M38.A "the substrate becomes installable" work sits on,
  and it is where prior art is worth the most right now.
- **The test strategy as an artifact**: DSH carries eight `vitest.*.config.ts`
  files (e2e, snapshot, web, web-stress, web-perf, expected…) and a
  `snapshots/` tree. Panda has one shape of suite plus live tests. What does a
  53×-larger harness split, and why?
- **The typecheck strategy**: a 35 KB `tsconfig.base.json`, plus host/client
  splits. Panda's is 908 bytes.
- **`native/`, `python/`, `apps/`, `website/`, `docs/`** — none of these is a
  package group any prior note enumerated.
- **The documentation contract**: the published reference at
  <https://deepseek-harness.github.io/deepseek-harness/en/reference/> versus what
  the source actually does. Panda's own rule is *"if an author has to guess,
  panda did not publish a contract, it published a puzzle"* — measure whether
  DSH keeps that promise and how it is gated.
- **i18n as an engineering problem** (`*.i18n.yaml`, `*.zh.md`): a mechanism for
  keeping two renderings of one document from drifting. Panda has no equivalent
  and may not need one — a measured negative result is a real result.
- **The paper, <https://arxiv.org/pdf/2608.25512>**: prior notes cite it. Read
  the sections the cordis note did not use, especially anything formal about
  effect reversal and coeffect propagation, and check each against panda's
  kernel.
- **Process, not code**: how do these projects review, gate and decide? Their
  `AGENTS.md` files, CI gates, coverage and doc gates, and their issue/PR
  discussions are prior art for panda's own working loop.

**Axis C — the point of all of it.** Every finding must land as one of four
things, and the note says which:

1. a measured gap in panda with a `path:line` on both sides,
2. a self-contained mechanism worth taking, with the smallest version that works,
3. a decision **settled against building** by measured absence, or
4. a place panda is measurably ahead — recorded so nobody re-opens it.

Nothing ships from a note straight into code. A finding becomes a frozen spec
first (§ 6 of `SESSION-HANDOFF.md`), or it becomes a `deferred-work.md` entry.

## 5. Method, and the two rules that cost the most here

- **Dispatch lenses as subagents**, one narrow scope each, each forbidden to
  assert anything about panda it has not measured *in panda* with a control.
- **A subagent reports a MECHANISM correctly and a CONCLUSION wrongly.** Of
  twenty findings from the first four cordis lenses, four did not survive
  re-reading at the line. Re-verify every "panda has / lacks" verdict yourself,
  at the line, before it enters a note.
- **Follow a lens's THREAD even when its verdict dies.** The eighth cordis lens
  reported a misleading error message; there was no message, the real defect was
  silent config corruption, strictly worse. That became M7.E.
- **A ZERO without a control means "I did not look."** Before believing any zero,
  run the same query against something you KNOW exists.
- **Read the call site, not the callee.** Three stories running, never once found
  by reading — always by driving the binary and reading the output file.
- `rtk` collapses function bodies in `head`/`grep` output: use `rtk proxy <cmd>`,
  `cat`, `sed -n`, or ripgrep directly.

## 6. Gates, before anything is committed

```bash
pnpm check                                  # bytes + typecheck + lint + tests; ABORTS at the first failing package
pnpm build && pnpm proof:consumer-install   # the OTHER half; CI runs it and `pnpm check` does not
```

`pnpm check` is `bytes && typecheck && test && lint` — lint runs LAST, so a run
that dies on a test never lints. `pnpm --filter` does not work here (node_modules
junctions); run a package's suite from inside it with
`./node_modules/.bin/vitest run`. Exclude live suites with `**/*live.test.ts` —
no dot; the repo has both `x.live.test.ts` and `x-live.test.ts` naming.

Check both Node versions before pushing (CI runs the floor, 22 LTS head, 24, and
a 26 canary). Then push and verify CI's `conclusion` against the exact SHA.

## 7. Output of this session

- One research note per axis under
  `_bmad-output/planning-artifacts/research/<slug>-<date>/research.md`, with the
  frontmatter shape the existing four use (`status`, `validation: measured`,
  `claims_verified`, `claims_unverified`, and an `extends:` naming what it
  builds on and what it does not cover).
- A closing section naming what this note did NOT open, so the next pass can
  derive its scope by subtraction.
- Any finding that becomes work: a frozen spec, registered in
  `sprint-status.yaml`. Anything deliberately not built: a `deferred-work.md`
  entry with its upgrade path.
- All artifacts, code, comments and commit messages in **English**. Talk to me in
  Rioplatense Spanish.

Start by reading `AGENTS.md` and the four research notes' closing sections, then
tell me the scope you derived by subtraction and what you plan to open — and
stop there for my go-ahead before dispatching any lens.
