---
title: 'technical research: Workers & Workflows agent orchestration for panda'
type: 'technical'
topic: 'Workers & Workflows agent orchestration for panda'
decision: 'How panda designs its Workers/Workflows layer and MethodPlugin axis, grounded in current multi-agent orchestration practice'
source: 'native web fan-out'
status: complete
preset: 'standard'
validation: 'normal'
created: '2026-08-23'
updated: '2026-08-23'
claims_verified: 9
claims_unverified: 5
---

# Technical Research: Workers & Workflows Agent Orchestration for Panda

## Executive Summary

The evidence says: **build panda's Workers/Workflows layer around single-writer execution with intelligence-only side agents, deterministic workflows by default, and environment-as-state** — and the "worker class over swappable executors" abstraction panda wants has no existing precedent, which is both the opportunity and the burden.

Three findings drive this:

1. **The industry converged on one worker taxonomy.** Every major harness (Claude Code, GitHub Copilot, CrewAI, OpenAI, MS Agent Framework) independently landed on declarative file-based *types* + ephemeral per-task *instances* running in isolated worktrees [13]. Panda's Worker concept should adopt this shape, not invent a new one.
2. **Parallel writers are the documented failure mode; parallel intelligence is the win.** Cognition's 2026 position: writes stay single-threaded; extra agents contribute as clean-context reviewers, advisors, and managers ("map-reduce-and-manage") [2]. Anthropic's numbers explain why: multi-agent costs ~15× chat tokens and coding parallelizes worse than research [1].
3. **Durability is a solved contract worth copying, not reinventing.** Four primitives converge across engines: step journal, durable step results, durable timers/wait-for-event, replay determinism [4] — and TypeScript-native options are mature [5].

Biggest caveat: there are **no reproducible token/latency/reliability benchmarks for long-running SWE tasks** comparing orchestration styles — all hard numbers come from research workloads or self-reported postmortems. Design for reversibility.

## Dimension 1 — Worker/role taxonomies in production

**Type vs instance:** Claude Code defines subagent types as markdown files (`.claude/agents/`) with frontmatter: name, description-for-routing, tool allowlist, model tier, permission mode, MCP servers, max turns, skills, memory [14]. GitHub Copilot custom agents use Markdown+YAML profiles in `.github/agents/` with repo/org/enterprise scopes; assignment instantiates the type [15]. OpenAI Agents SDK keeps types in code (name+instructions+tools+model) with handoffs for composition [16]. MS Agent Framework separates agents from graph workflows — roles wired by topology, not baked into declarations [17].

**Coding-role decompositions in practice:** planner/architect → implementer → reviewer → tester (+release ops) dominates practitioner accounts; rules that recur: the reviewer must not share context with the writer, implementers run in isolated worktrees, escalation starts at Planner-Executor before any swarm [18][19]. Production pattern sets include spec-bounded task decomposition, coordinator/specialist/verifier splits, per-task model routing, quality gates at merge [20].

**Portability:** A2A v1.0's Agent Card standardizes *external* interface discovery (name, capabilities, skills) but deliberately excludes internal prompts/tool grants/model routing; no standard covers portable internal agent-class definitions [9]. This is the gap panda's portable worker-class card would fill.

## Dimension 2 — Workflow orchestration patterns

**Style:** For coding specifically, single-writer linear flow with shared context beat multi-agent crews in the most-cited account [21]; Anthropic's long-running SWE harness keeps state in the environment (feature list file, git history, progress file) rather than framework state objects, one feature per session with end-to-end self-verification [3]. Deterministic control flow with typed shared state beats LLM-driven routing on cost — code edges burn zero tokens per handover [22].

**State model economics:** agent-to-agent message passing is the expensive pattern; shared state is the cheap one. Third-party (low-confidence) benchmarks peg explicit-graph routing at ~2k tokens/step vs ~3.5k (CrewAI) and ~8k (AutoGen) [23].

**Durability contract:** four primitives converge: step journal/event history; durable step results (never re-run completed side effects); durable sleep/timers + wait-for-external-event; replay determinism with idempotency. "Session memory is not durable execution." Engines split full-replay vs journal/memoization [4]. TypeScript-native runtimes are mature: Inngest, Cloudflare Workflows, Lambda Durable Functions, Vercel Workflow DevKit, Restate TS, DBOS-TS, TanStack Workflow (headless, bring-your-own store) [5]. LangGraph's own docs warn checkpoints don't make nodes safe — code before an interrupt may re-execute on resume; the node boundary must be engineered as the replay boundary [24].

**Human-in-the-loop:** two dominant gates: graph interrupts (persisted state, resume from checkpoint) and signal-based waits (pause indefinitely without compute); both require approval boundaries placed before non-idempotent actions [25].

## Dimension 3 — Precedents: roles-over-swappable-executors + methodology-as-plugin

**Roles over swappable executors: absence confirmed across the surveyed space.** Vibe Kanban treats CLIs as swappable executors but roles are emulated via `append_prompt` strings — not first-class [26]. The Engineer abstracts lifecycle phases (audit trail, retries, cost tracking apply to any backing CLI via `AgentAdapter`) but not role semantics [27]. Orch abstracts invocation only [28]. **No surveyed project defines portable role definitions decoupled from the backing CLI** [10]. Panda's opening is real; so is the burden — nothing to copy here.

**Methodology-as-plugin:** Spec Kit ships the strongest precedent — `extensions/` directory with `extension.yml` manifest, command templates, slash-command surfacing, 40+ community extensions [29]. BMAD v6 is module/config-driven (`_cfg/agents/` persistence), a file-contract approach rather than code-level plugin API [30]. OpenSpec is artifact-level convention without enforcement; manual drift is the dominant complaint [31].

**Kernel precedent (Cordis):** forkable DI contexts, reversible effects with reverse-order teardown, typed service registry — powering Koishi (~4yrs) and DeepSeek Harness [32]. The critique matters more than the API: 4.x still RC, ~97.6% commits from one maintainer, DeepSeek vendors a pinned fork after disposal/race/deadlock bugs, silently-PENDING plugins when injections miss. Lesson: own the kernel, keep it thin, design injection failures loudly [11].

## Dimension 4 — Operational reality and failures

**Documented failure modes:** parallel-writer agents make conflicting implicit decisions; the fix pattern is full trace sharing and single-threaded writes [21]. Cognition's 2026 update narrows what works: reviewer/smart-friend/manager patterns where agents contribute intelligence while one agent writes; making manager-child coordination feel coherent took heavy context engineering, and cross-agent communication "doesn't happen by default because models weren't trained for it" [2]. An unattended overnight multi-agent run surfaced 12 failure modes including silent partial failures trusted downstream, recursive hook chains without stop conditions, and overlapping audits producing false agreement (secondhand postmortem) [34].

**Cost anatomy:** an orchestrator burned 1–2M Opus tokens/task through stacked multipliers (frontier-model-by-default ×1.7, cold-cache writes per subagent ~×12, 5+ agents/task, unbounded review loops = 100–300× baseline); the fix was budget enforcement in PreToolUse hooks, not prompts — "a budget rule in a prompt is a preference" [7]. Where money goes: redundant re-reads and cache misses — five reviewers re-reading one PR cost $1.32 naive vs $0.49 with shared-prefix caching; a 109-agent audit spent 9.3M tokens with 77% being cache reads and 79% of agents doing verification fan-out with a 6% kill rate [8]. Harness subtraction: cutting sequential multi-role down to one delivery agent + independent final review cut tokens 31.8M→5.9M per issue with no observed quality regression [12]. The MAST study reports 41–86.7% failure rates across 1,600+ traces of 7 frameworks (secondary citation, unverified) [6].

**Debugging:** failure attribution is the core pain; full execution traces improve attribution accuracy up to 76.5% over output-only traces (TraceElephant, ACL 2026) [35]. Practitioner when-NOT-to-split checklist converges across sources: shared state or ordering → single context; if knowing A's result changes B, don't split; router over hierarchy unless genuinely breadth-first; price coordination first; verification at merge points in code, not verifier agents that learn to rubber-stamp [33].

**Dimension stop: coverage** — questions answered; remaining leads (MAST primary, Librarian paper) logged as open-question routes.

## Cross-dimension insights

1. **The convergence + absence combo is the thesis validated.** Taxonomy converged everywhere (D1), durability converged everywhere (D2), yet nobody composed them over swappable executors (D3). The composition is the product.
2. **Token economics dictate architecture, not features.** D4's failure catalog (coordination chatter, redundant re-reads, unbounded loops) and D2's deterministic-vs-LLM-routing economics point to the same constraint: the workflow engine must make the cheap path (deterministic edges, shared state, cache-friendly prefixes) the default path.
3. **Verification belongs in code, not in verifier agents.** Independent convergence: rubber-stamp rates (14% pre-hardening), verification fan-out with 6% kill rate burning 79% of audit tokens [33], and the "quality gates at merge" production pattern [20] all say: merge-point checks in code; agents review, gates enforce.

## Contrary evidence

- **Cognition's partial reversal cuts against pure single-agent minimalism**: multi-agent *does* work when writes stay single-threaded and extra agents contribute intelligence only — Devin Review catches ~2 bugs/PR (~58% severe) even on Devin's own PRs [2]. Panda should not read the failure literature as "never multi-agent", but as "multi-intelligence, single-pen".
- **"Harness subtraction" contradicts richer taxonomies**: cutting a sequential multi-role harness to one delivery agent + independent final review cut tokens 31.8M→5.9M per issue with no observed quality regression [12] (small n, self-reported). Every default role beyond implementer+reviewer needs to earn its tokens.

## Recommendations

Bound to the decision and downstream artifacts:

1. **Adopt the converged worker shape**: declarative file-based worker-class definitions (description-for-routing, tool allowlist, model tier, executor binding, workspace policy) + ephemeral instances per task. Feeds: PRD (Worker feature), Architecture (worker-class schema). Confidence: high [13][14][15].
2. **Make single-writer the enforced default**: workflow primitives express parallel *intelligence* (reviewers, advisors, managers) natively but parallel *writers* require explicit opt-in per node. Feeds: Architecture (workflow engine semantics). Confidence: high [1][2][21].
3. **Design the durability contract as the four converged primitives**, implemented over a TypeScript-native headless option (TanStack Workflow-style bring-your-own-store fits panda's swappable ethos). Feeds: Architecture (Workflow primitive). Confidence: high [4][5].
4. **State lives in the environment**: files/git as canonical state; framework state is projection, not truth — consistent with panda's registry-as-source-of-truth philosophy. Feeds: Architecture. Confidence: high [3].
5. **Worker classes carry an executor binding as data, not identity**: the portable-role-card gap is real [9][10]; define panda's card combining A2A-style capability surface with harness frontmatter fields. Feeds: PRD (portability), Architecture (card schema). Confidence: high on gap, medium on card design (no precedent to copy).
6. **MethodPlugin follows Spec Kit's extension shape** (manifest + commands + templates), not BMAD's config-persistence approach; add enforcement hooks where OpenSpec lacks them. Feeds: Architecture (MethodPlugin contract). Confidence: medium-high [29][30][31].
7. **Budget governance in hooks, not prompts**: token budgets, loop caps, and fan-out limits enforced at the kernel tool-call layer. Feeds: Architecture, PRD (cost controls). Confidence: medium-high [7][33].
8. **Own the kernel, keep it thin, fail loudly on missing services** — Cordis's critique list is the checklist of what not to do. Feeds: Architecture. Confidence: high [11].

## Open questions

1. Do reproducible SWE-task orchestration benchmarks exist outside gated/vendor channels? *(Would take: waiting for JATIR-class peer-reviewed work or running panda's own bench.)*
2. Is there real demand for warm/pooled worker instances, or is ephemeral-per-task sufficient? *(No production evidence found either way.)*
3. Exact plugin-API ergonomics: does MethodPlugin need lifecycle hooks or is manifest+commands enough? *(Would take: prototyping against 2-3 real methodologies.)*

## Source appendix

| # | Supports | Publisher | Pub date | Accessed | Conf |
|---|---|---|---|---|---|
| [1] | Multi-agent token multiplier | [Anthropic Engineering](https://www.anthropic.com/engineering/multi-agent-research-system) | 2025-06 | 2026-08-23 | high |
| [2] | Single-writer + intelligence patterns | [Cognition](https://cognition.ai/blog/multi-agents-working/) | 2026-04-22 | 2026-08-23 | verified this run |
| [3] | Environment-as-state harness | [Anthropic Engineering](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) | 2025-11-26 | 2026-08-23 | high |
| [4] | Durability four primitives | [Zylos Research](https://zylos.ai/research/2026-04-24-durable-execution-agent-runtimes) | 2026-04-24 | 2026-08-23 | high |
| [5] | TS-native durable runtimes | [Reptile Haus](https://reptile.haus/journal/durable-execution-ai-agents-temporal-restate-inngest-2026/) / [TanStack Workflow](https://github.com/TanStack/workflow) | 2026-04 | 2026-08-23 | high |
| [6] | MAST failure rates | arXiv:2503.13657 (via secondary citation) | 2025 | 2026-08-23 | low-medium |
| [7] | Token burn postmortem | [DEV Community](https://dev.to/akashy/my-agent-orchestrator-burned-1-2m-opus-tokens-per-task-heres-the-postmortem-2k7g) | 2026-08-04 | 2026-08-23 | medium-high |
| [8] | Cache/token waste anatomy | mainbranch.dev + DEV Community | 2026-05/06 | 2026-08-23 | medium-high |
| [9] | A2A card excludes internals | [A2A protocol](https://a2a-protocol.org/latest/topics/agent-discovery/) | 2026-03 | 2026-08-23 | high |
| [10] | No portable roles precedent | Survey: [the-engineer](https://github.com/FarzamMohammadi/the-engineer), cline/kanban, vibe-kanban configs, orch | 2026 | 2026-08-23 | high (absence) |
| [11] | Cordis abstractions + critique | [Floatboat](https://floatboat.ai/blog/cordis-plugin-framework) / [Zhichai](https://zhichai.net/en/topic/178633545) | 2026-08 | 2026-08-23 | medium-high |
| [12] | Harness subtraction result | [MultiAgentAI blog](https://blog.multiagentai.co/agents/harness-subtraction/) | 2026-07-22 | 2026-08-23 | medium |
| [13] | Type+instance convergence | [Claude Code docs](https://code.claude.com/docs/en/sub-agents) / [GitHub docs](https://docs.github.com/en/copilot/concepts/agents/cloud-agent/about-custom-agents) / OpenAI SDK docs | current | 2026-08-23 | high |
| [14] | Claude Code subagent frontmatter | [code.claude.com](https://code.claude.com/docs/en/sub-agents) | current | 2026-08-23 | high |
| [15] | Copilot custom agents | [docs.github.com](https://docs.github.com/en/copilot/concepts/agents/cloud-agent/about-custom-agents) | current | 2026-08-23 | high |
| [16] | OpenAI Agents SDK handoffs | [openai.github.io](https://openai.github.io/openai-agents-python/handoffs/) | current | 2026-08-23 | high |
| [17] | MAF agents-vs-workflows split | nerova.ai comparison | 2026-07-13 | 2026-08-23 | medium |
| [18] | Role decomposition + isolation rules | agitech.group | 2026-07-09 | 2026-08-23 | medium |
| [19] | Escalation minimalism | Augment Code guide (quoting Comet.ml) | 2026-07-13 | 2026-08-23 | medium |
| [20] | Parallel-coder production patterns | [Zylos Research](https://zylos.ai/en/research/2026-04-02-agentic-coding-production-q1-2026-landscape/) | 2026-04-02 | 2026-08-23 | medium |
| [21] | Don't build multi-agents (original) | [Cognition](https://cognition.com/blog/dont-build-multi-agents) | 2025-06-12 | 2026-08-23 | high |
| [22] | Deterministic edges vs LLM routing | neelmishra.github.io engineering blog | 2025-2026 | 2026-08-23 | medium |
| [23] | Per-step routing token benchmarks | aidevdayindia.org (methodology unpublished) | 2026-05-14 | 2026-08-23 | low |
| [24] | Checkpoint ≠ node safety | LangChain docs (via Zylos) | 2026-04 | 2026-08-23 | high |
| [25] | HITL gating patterns | Zylos Research + others | 2025-2026 | 2026-08-23 | high |
| [26] | Vibe Kanban executor/profiles.json contract | isomoes.github.io + urgood2/vibe-kanban-config | 2026-01 | 2026-08-23 | high |
| [27] | The Engineer AgentAdapter | github.com/FarzamMohammadi/the-engineer | 2026-03 | 2026-08-23 | high |
| [28] | Orch invocation-only abstraction | github.com/manikDH/coding_agent_orchestrator | undated | 2026-08-23 | medium |
| [29] | Spec Kit extension system | hiddedesmet.com | 2026-04-08 | 2026-08-23 | high |
| [30] | BMAD v6 module surface | BMad-CORE v6 README (github) | undated | 2026-08-23 | medium-high |
| [31] | OpenSpec non-blocking verification | codemyspec.com | 2026-06-03 | 2026-08-23 | medium-high |
| [32] | Cordis core abstractions | floatboat.ai | 2026-08-14 | 2026-08-23 | high |
| [33] | Rubber-stamp + audit waste numbers | dev.to/ayoubzulfiqar + agenticlab.sunilprakash.com | 2026-01/06 | 2026-08-23 | medium-high |
| [34] | Overnight multi-agent postmortem, 12 failure modes | ralphworkflow.com | 2026-06-03 | 2026-08-23 | medium (secondhand) |
| [35] | Trace attribution accuracy benchmark | ACL Anthology (2026.acl-long.912) | 2026-07 | 2026-08-23 | high |

## Staleness map

Fastest-aging claims (re-check dates):

- **≤ 2026-09**: version claims on Claude Code/Copilot/OpenAI SDK agent-type fields [13][14][15][16] — harnesses ship weekly
- **≤ 2026-11**: ecosystem signals — TS-native durable runtime maturity [5], A2A registry developments [9], Spec Kit extension counts [29]
- **≤ 2027-02**: landscape claims — orchestrator project landscape [10], Cordis stability status [11]
- **Stable ≥ 2 yrs**: durability four primitives [4], HITL gating patterns [25]

Earliest re-check: **September 2026** (harness version fields). Refresh handles these.
