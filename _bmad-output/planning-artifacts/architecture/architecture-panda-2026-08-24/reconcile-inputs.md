# Input Reconciliation — Panda v1 Architecture Spine

Reviewed: ARCHITECTURE-SPINE.md (architecture-panda-2026-08-24) against:
- **IN-A**: `prd-panda-2026-08-23/prd.md` (final, 2026-08-23)
- **IN-B**: `briefs/brief-panda-2026-08-21/addendum.md` — esp. "Research-Grounded Design Constraints" (8 constraints)

Method: every PRD FR/NFR/RD checked for an architectural home (AD / convention / Capability-map row / Deferred entry with reason). Each of the 8 design constraints classified honored / explicitly-bound-later / conflict. Quiet, tone-level requirements were inspected specifically — those are the ones that die silently.

---

## IN-A — PRD (prd-panda-2026-08-23)

### GAPS

**GAP-A1 [blocker-for-epics] Budget-governance location has no architectural home (PRD §10 "Budget governance location", = Addendum Constraint 5).**
The PRD states token budgets, loop caps, and fan-out limits are enforced "at the Kernel tool-call layer (hooks), never by prompt instruction." The spine contains no tool-call hook layer, no interception seam, no budget surface anywhere — not in AD-1 (generic kernel), not in the seven Contracts, not in Deferred. This is exactly the quiet constraint class that gets dropped: nothing in the FR list forces it, yet the PRD declares the eight constraints "explicitly normative for architecture." Consequence if unfixed: the Kernel epic ships a container with no interception point, and adding one later breaks every plugin's assumptions (the precise mistake Constraint 5 warns against). Required: either a kernel hook/interceptor seam AD (v1, even if unused) or an explicit Deferred entry naming the reserved seam.

**GAP-A2 [high] Constraints 1–2 (single-writer execution default; deterministic workflows by default) have no reserved seam — only Constraint 4 got one.**
PRD §10 marks constraints 1–4 as normative for architecture now. The spine honors #4 cleanly (Deferred: durability engine, four-primitive seam fixed). But #1 and #2 appear nowhere: AD-4's write serialization is *storage-level* (one writer per store), which is a different concern than the *workflow-level* single-writer execution default (parallel intelligence, parallel writes opt-in per node) and deterministic-edge-vs-LLM-node routing. No Deferred entry reserves the seam, no AD states the principle. Risk: v-next orchestration lands with parallel-write affordances baked into contracts that assumed nothing.

**GAP-A3 [high] FR-10 Liveness detection hierarchy is homeless.**
Hooks injected into the Executor's native config (where supported), passive PTY/OSC fallback, screen scraping prohibited — no AD governs this, and the Capability-map row for F2 cites only AD-3/AD-6/AD-7 + traits-as-data. This is not just an implementation detail: hook injection *writes into vendor configs*, which collides with AD-9's ownership-sentinel regime and AD-4's "all persistent mutations flow through owning components." Nothing reconciles "adapter injects liveness hooks" with "projections are the only writer of panda-owned vendor-config content."

**GAP-A4 [high] Security NFR: unsafe credential-reuse refusal path has no home (PRD §10 Security, second clause).**
"Credential-reuse modes deemed unsafe for the detected environment are refused at config time unless explicitly opted in via flag (testable: refusal path returns typed error)." No AD, convention, or map entry covers environment detection or config-time refusal. Testable behavior with no owning component.

**GAP-A5 [low] Lifecycle mechanics stated in FR-2/FR-3 exceed what the spine pins down.**
Reverse-registration-order teardown, double-dispose no-op, and validate-then-commit swap semantics are implied by AD-5 ("owns lifecycle") and AD-8 (swap as lifecycle transition) but stated nowhere as rules. Low because they're kernel-internal and testable from the FR text; still worth one line in an AD to survive PRD-fade.

**GAP-A6 [low] Write-time path normalization dropped (Addendum firm decision vs PRD §10 Portability).**
The brief's firm decision says machine-specific paths are normalized "in the canonical registry **at write time**"; the spine's only normalization guarantee is Bundle export (FR-21 surface). Export-time-only normalization reintroduces machine-specific paths into Registry state — contradicting the input's stronger rule. One convention line fixes it.

**GAP-A7 [low] Component homes unstated for: `doctor` (drift-comparison engine — which package?), FR-27 quota surfacing (which port surface carries usage probes?), FR-28 swap persistence (where does the active-method selection live across processes?).**
All three are reachable by composition, but none has a named owner in the Structural Seed or map.

**GAP-A8 [low] Node version contradiction: PRD §12 says Node LTS ≥22; spine Stack mandates ≥24 (Krypton).**
Likely deliberate tightening (changesets peer range supports it), but it silently overrides an input without a word. State it as an intentional supersession or align.

### COVERED (verified homes)

- **FR-1** manifest/hard-soft consumption/cycle rejection → AD-1, AD-5 (cycle-naming detail rides FR text; acceptable).
- **FR-4** scoped event bus → AD-8 (scopes enumerated identically).
- **FR-5** layered config + inspectable dump + no narrower-writes-wider → AD-9 verbatim.
- **FR-6/7/8/9** normalized execution, three adapters, traits-as-data, contract suite → Capability map F2 row, Structural Seed, deployment envelope (CI contract runs).
- **FR-11..FR-14, FR-13b/c** scoped registry, idempotent sentinel projection (AD-9 grammar, byte-preserving foreign content in AD-4), per-target isolation (ports + AD-2), ToolProvider/SkillSource among the seven Contracts, drift detection (AD-4 doctor mention + AD-9 unknown-sentinel→Drift).
- **FR-15/16** append-only provenance memory → AD-4 + map row citing RD-1; memory-fs/memory-sqlite in seed.
- **FR-17..FR-20** workspace contract, owned worktrees (AD-6 creation-of-record, retired names, recovery sweep), concurrency (AD-4 machine-scoped lock), safe disposal (AD-6 sweep; trash-rename specifics ride FR text).
- **FR-21/22** bundle export/import, secret exclusion → AD-3 + cross-cutting convention ("secrets never logged/bundled") + map F6.
- **FR-23/28** MethodPlugin contract, hot-swap ordering → map F7, AD-8 transition ordering, RD-3 alignment.
- **FR-24..FR-26** CLI command surface → map F8 + seed.
- **RD-1..RD-4** all four resolved decisions trace: RD-1→AD-4/map, RD-2→ephemeral-executor model consistent with AD-6 handles, RD-3→F7, RD-4→Deferred ("quota-aware routing… RD-4 bounds v1").
- **NFR observability** → strengthened by AD-4 (kernel-owned log before plugins, fixed failure policy).
- **NFR reliability** (atomic crash-safe projection) → AD-4 temp-file+rename pure-function rule.
- **§11 versioning** (contracts version together, suite-per-contract, CI) → AD-2 + deployment envelope.
- **§12 performance budgets** → referenced from map F8 row.
- **Non-goals §5** → respected; nothing in the spine smuggles them back (shell/quota-routing/vault correctly in Deferred with reasons).

---

## IN-B — Brief Addendum (esp. Research-Grounded Design Constraints)

Per-constraint verdict:

| # | Constraint | Verdict |
| --- | --- | --- |
| 1 | Single-writer enforced default | **PARTIAL / GAP** — storage-level serialization only (AD-4); workflow-level default nowhere, no reserved seam. See GAP-A2. |
| 2 | Deterministic workflows by default | **DROPPED** — no seam, no Deferred entry. See GAP-A2. |
| 3 | State canonical in the environment | **HONORED** — AD-4 (Registry = truth, projections derived), reinforced by AD-2 runtime-consumption rule. |
| 4 | Durability = four primitives over TS-native BYO-store engine | **HONORED / bound later** — Deferred entry fixes the exact seam named. Model deferral. |
| 5 | Budget governance in hooks, not prompts | **DROPPED ENTIRELY** — see GAP-A1. Worst finding of this review. |
| 6 | Worker-class converged taxonomy card ("unclaimed ground — design deliberately") | **NOT BOUND FOR LATER** — RD-2 covers ephemeral-instance/worktree half; the declarative worker-card design obligation appears in neither map nor Deferred. Should be a Deferred entry ("worker-class card design — v-next, deliberate design required"), else it defaults to accidental imitation later. |
| 7 | MethodPlugin follows Spec Kit extension shape (+ enforcement hooks OpenSpec lacks) | **COVERED with caveat** — RD-3 = manifest + commands + artifact conventions + activation hook pair; the caveat: whether the two-hook pair satisfies "add enforcement hooks OpenSpec lacks" is asserted, not argued. One sentence of rationale in RD-3's successor docs closes it. |
| 8 | Own the kernel, thin, fail loudly (Cordis critique checklist) | **HONORED** — AD-1 (zero-dep generic kernel), AD-5 (fail loudly, contained plugin failures). Checklist governance items (single-maintainer, RC churn) are process concerns, correctly out of spine scope. |

Other addendum inputs:

- **Two kinds of swappability** — HONORED structurally: Executors are never plugins (glossary + AD-3 out-of-process), boundary made explicit day one (seven ports, AD-2 topology). This is the addendum's architecture-critical warning and the spine takes it seriously.
- **Abstract workspace handle (firm decision)** — HONORED: opaque handle (FR-17), SSH provider deferred with contract-already-wide rationale, container isolation deferred without prejudice (assumption §9 preserved).
- **Portability caveats (firm decision)** — PARTIAL: secret exclusion + opt-in channel covered (conventions + Deferred vault entry); **write-time path normalization dropped** → GAP-A6.
- **Projection-drift risk (monitored)** — HONORED: contract suites in CI + FR-14 drift detection + AD-9 sentinel-version classification.
- **Quota-awareness risk (monitored)** — HONORED: RD-4 read-only surfacing, Deferred routing policies, "flag, don't assume" ToS stance preserved.
- **Context non-portability / stateless workers** — HONORED: AD-4 canonical-state doctrine + token-efficiency handoff convention direction (though the ≤4KB handoff budget itself lives only in the PRD; acceptable, it's a product number).

---

## Summary of findings

The spine is strong on everything loud (state ownership, projection safety, error/event discipline, versioning) and drops exactly the quiet class predicted:

1. **[blocker-for-epics]** Constraint 5 — no budget/hook seam in the kernel. Must be added (or explicitly deferred with a reserved seam) before Kernel epics.
2. **[high]** Constraints 1–2 — workflow-level single-writer + determinism-by-default principles absent; only constraint 4 earned a Deferred seam.
3. **[high]** FR-10 liveness hierarchy homeless; conflicts unresolved with AD-4/AD-9 writer-exclusivity when adapters inject hooks into vendor configs.
4. **[high]** Credential-reuse config-time refusal path (testable NFR) has no owning component.
5. **[low cluster]** write-time path normalization dropped; doctor/quota-surface/swap-persistence homes unnamed; FR-2/3 lifecycle mechanics unpinned; Node ≥22 vs ≥24 silent override; constraint 6 worker-card missing from Deferred.
