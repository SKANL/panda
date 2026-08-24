# Input Reconciliation: PRD vs Source Documents

PRD under review: `prd-panda-2026-08-23/prd.md` (2026-08-23)
Inputs reconciled:

1. `briefs/brief-panda-2026-08-21/brief.md`
2. `briefs/brief-panda-2026-08-21/addendum.md`
3. `research/technical-workers-workflows-agent-orchestration-2026-08-23/research.md`

Method: every requirement, insight, constraint, and qualitative commitment in the inputs checked for a home in the PRD (FR, NFR, Non-Goal, Success Metric, Resolved Decision, or explicit out-of-scope). Severities: **BLOCKER** (must fix before UX/architecture phases), **HIGH**, **LOW**.

---

## 1. brief.md

### GAPS

- **GAP B1 — HIGH — "Models" as a swappable axis is silently dropped.** The Executive Summary promises everything swappable: "executors, **models**, tools, MCPs, skills, plugins — even memory and the development methodology." The PRD covers executor/memory/tool/skill/method swap but contains no FR, glossary entry, or profile field making model selection/configuration a first-class, swappable Registry item. Model tier appears only inside the deferred v-next worker-class card (constraint 6). If model swappability is meant to ride on Profiles/projection data, that must be stated; today it reads as dropped.
- **GAP B2 — LOW — Open-source commitment dropped.** Brief: "It is open source for everyone and dogfooded daily by its author." The PRD never mentions licensing, open-source distribution, or repo posture. For a platform whose moat is "contract ownership plus dogfooding" and whose success signal is external implementers (SM-3), license/distribution is a product decision the PRD should own (even as an explicit deferral).
- **GAP B3 — LOW — Long-term platform signals narrowed.** Brief defines three directional signals: (a) outsider-implemented adapter/provider, (b) **at least one third-party product built on the kernel**, (c) community adoption lagging indicators (third-party issues, external contributors). PRD SM-3 keeps only (a); (b) and (c) vanished from §7.
- **GAP B4 — LOW — S4 exit criterion quietly redefined.** Brief S4: "export on machine A, import on machine B, re-project — **S1–S3 pass untouched**." PRD S4 weakens this to "doctor clean except pending secrets," and SM-1 only asserts S1–S4 "pass end-to-end" without the compositional guarantee that portability preserves S1–S3 behavior. The stronger original claim is the actual thesis test.
- **GAP B5 — LOW — Segment list thinned.** Brief names three segments in fit order (teams standardizing tooling, harness builders using the kernel as a platform, startups building on the SDK). PRD §2 keeps teams socially and collapses builders/startups into an implied platform story. Acceptable compression, but harness-builders-as-audience informed several contract decisions and should stay visible.

### COVERED

Tool fragmentation / lock-in / device-portability pains (§1, F3, F6) · canonical registry with global/project/agent scopes (FR-11) · projection engine with per-agent + shared tooling (FR-12/13) · memory-as-contract (F4) · methodology-as-plugin (F7, FR-28) · concurrent worktrees day one (FR-19) · Workers & Workflows v-next positioning (Non-Goals) · abstract workspace handle from day one (Glossary Workspace, FR-17) · official method plugins immediately post-v1 (§6.2) · SDK-first/headless (§1) · dogfooding as CI test (SM-2) · S1–S3 verbatim (§7) · vision language including "Rent the agents. Own the environment." (§1) · out-of-v1 list (terminal UI, orchestration, fleet routing, sandboxing, SSH, kanban — §5/§6.2 match the brief exactly).

---

## 2. addendum.md

### GAPS

- **GAP A1 — HIGH — Design constraints 1–4 are not carried as binding forward constraints.** The addendum states the eight research-grounded constraints "**bind the PRD and architecture**." Constraints 1–4 govern the Workers & Workflows layer (v-next): (1) single-writer enforced default with parallel-writes opt-in per node, (2) deterministic workflows by default / judgment in specific nodes, (3) state lives in the environment (files/git canonical; framework state is projection), (4) durability contract = four converged primitives over a TypeScript-native headless engine. The PRD's only home for them is Non-Goals' "design informed by research" — a phrase that carries none of the content. RD-1's rationale gestures at the single-writer doctrine, and RD-2 captures environment-persistence for Workspaces, but as *decided rationale*, not as requirements any downstream Workers/Workflows design must satisfy. These four will silently evaporate between PRD and future architecture unless recorded as forward-binding constraints (even in a "Constraints inherited by v-next" subsection).
- **GAP A2 — HIGH — Budget governance in hooks, not prompts (constraint 5 / research rec 7) dropped from v1.** Research rec 7 explicitly says it "Feeds: Architecture, **PRD** (cost controls)". The PRD's only cost control is the ≤4KB handoff-size NFR — a format budget, not governance. Nothing requires token budgets, loop caps, or fan-out limits to be enforceable at the kernel tool-call layer. Even in v1 (no workflows yet), the kernel executes tool calls; the PRD should either state the enforcement point exists in v1 or record it as a mandated v-next kernel capability. Today it is simply gone.
- **GAP A3 — LOW — Portable worker-class card (constraint 6 / research rec 5) reduced to a slogan.** Rec 5 also "Feeds: **PRD** (portability)": define the card combining an A2A-style capability surface with harness frontmatter fields (description-for-routing, tool allowlist, model tier, executor binding, workspace policy). The PRD keeps only "window open for the portable worker-class standard nobody has claimed" in Why Now — the market framing survived; the design obligation did not. Should appear wherever v-next portability commitments live.
- **GAP A4 — LOW — Secret opt-in channel unspecified.** Addendum: secrets "never travel in the export bundle by default — separate **opt-in channel** required." PRD FR-21 omits secrets (good) and §10 secures logs/bundles, but the deliberate opt-in escape hatch is never modeled — §6.2's "secret vault integrations beyond opt-in passthrough" implies passthrough exists without any FR defining when/how. Either specify or make the omission explicit.
- **GAP A5 — LOW — Operational hygiene notes dropped:** (a) staleness re-check of harness version claims due September 2026 (research Refresh work order) — PRD §9 carries the hook-stability assumption and mitigation but not the scheduled re-validation; (b) naming-collision check of "panda" before public launch. Neither blocks anything; both belong in a follow-ups/risk line.

### COVERED

Two kinds of swappability / in-process-plugin vs out-of-process-adapter boundary (Glossary: Executor "Never a Plugin; always adapted"; FR-9 contract tests per adapter address projection-drift liability) · abstract workspace handle, never bare cwd (FR-17 opaque handle) · machine-path normalization at write time (Portability NFR, FR-21) · projection drift monitored via contract suite (FR-9) + runtime detection (FR-14 doctor) · quota awareness with Orca-style read-only posture and ToS gray zones flagged-not-assumed (RD-4, FR-27, incl. "never automates around vendor limits") · context non-portability → panda-owned durable state, agents stateless (RD-2) with compressed handoffs as token-efficiency mechanism (Token-efficiency NFR) · prior-art table (consumed via reference digests cited in §0; differentiators visible in §1/§13) · constraint 7 Spec-Kit shape + enforcement hooks (RD-3: manifest+commands+activation pair; hooks justified by swap semantics) · constraint 8 own-thin-kernel-fail-loudly (FR-1 fail-fast soft-consumed services, typed errors, cycle rejection; §12 zero-runtime-deps kernel).

---

## 3. research.md (recommendations 1–8 + cross-dimension insights)

### GAPS

- **GAP R1 — HIGH — Rec 2 (single-writer enforced default) present only as RD-1 rationale prose.** Same substance as GAP A1 item 1, listed separately because rec 2 targets Architecture workflow-engine semantics: parallel intelligence native, parallel writers opt-in per node. The PRD records the doctrine but assigns it no forward home. Without it, the v-next workflow primitive could be designed symmetrically.
- **GAP R2 — HIGH — Rec 3 (durability four primitives) absent.** Step journal, durable step results, durable timers/wait-for-event, replay determinism with idempotency — plus the TanStack-Workflow-style bring-your-own-store implementation stance — appear nowhere. This is the single most concrete architecture-ready deliverable of the research run.
- **GAP R3 — HIGH — Rec 7 (budget governance in hooks) absent from PRD despite being explicitly addressed *to* the PRD.** Same as GAP A2; the research recommendation's feed-target mapping is the clearest evidence of a silent drop rather than deliberate scoping.
- **GAP R4 — LOW — Cross-dimension insight 3 (verification in code, not verifier agents) not carried.** Merge-point quality gates in code vs rubber-stamping reviewer agents is a named design rule for v-next workflows; only traceable via the addendum's compressed restatement.
- **GAP R5 — LOW — Supporting operational findings with no landing spot:** HITL approval boundaries placed before non-idempotent actions (rec for workflow gates); failure-attribution via full execution traces (partially absorbed into the Observability NFR for v1, but the attribution motivation is lost); "no reproducible SWE benchmarks — design for reversibility" caveat; research open questions (warm/pooled worker demand; MethodPlugin hook ergonomics needing prototyping against 2–3 real methodologies — RD-3 answers with a freeze rule but not the validation plan).

### COVERED

Rec 1 converged worker shape (deferred to v-next Non-Goal + §13 convergence framing) · rec 4 environment-as-state (RD-2 for Workspaces; registry-as-source-of-truth philosophy echoed in §1/F3) · rec 5 gap identification (§13 Why Now, though the card design obligation is GAP A3) · rec 6 Spec Kit shape + enforcement hooks (RD-3) · rec 8 thin-kernel/loud-failure checklist (FR-1, §12) · Cordis critique (absorbed into FR-1 consequences and Observability NFR "adopted invariant from dsh study") · ephemeral-instance/hybrid-state verdict (RD-2, with revisit condition) · token-economics-dictate-architecture thesis (Token-efficiency NFR + counter-metric SM-C2 spirit) · contrary evidence honored (RD-1 permits multi-intelligence; PRD does not overcorrect into anti-multi-agent) · staleness map (see GAP A5a — dates not carried, content otherwise respected).

---

## Summary Verdict

The PRD is faithful on everything v1-shaped: contracts, adapters, registry/projection, portability, quotas/ToS posture, secret handling, kernel philosophy. The systematic drop pattern is **qualitative and forward-binding material**: (a) research recommendations that targeted the PRD by name (rec 7 cost controls, rec 5 worker-card portability) were not translated into requirements or recorded obligations; (b) the four v-next-binding design constraints (single-writer, deterministic-default, environment-state, durability quartet) survive only as scattered rationale prose behind "design informed by research"; (c) the brief's "models are swappable" promise lost its referent. None of these break v1 scope, but A1/R1/R2 (and A2/R3 for the PRD-addressed rec 7) should be fixed before the architecture phase consumes this PRD.
