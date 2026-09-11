---
title: 'technical research: distribution and engineering surfaces'
type: 'technical'
topic: 'DeepSeek Harness release, test, TypeScript, documentation, and repository-surface contracts'
decision: 'What distribution and engineering mechanisms are available as measured prior art, and where panda has no corresponding surface'
source: 'DeepSeek Harness origin/master c291e796 and panda current source'
status: complete
preset: 'standard'
created: '2026-09-11'
updated: '2026-09-11'
validation: measured
claims_verified: 22
claims_unverified: 3
extends: 'deepseek-harness-the-last-nine-groups-2026-09-04'
---

# Distribution and engineering surfaces

## Executive summary

Current DeepSeek Harness is not merely a package corpus: it has an executable release pipeline, split test strategy, explicit TypeScript project boundaries, documentation budgets, and a three-file translation contract. The current `origin/master` counts are `native=78`, `python=37`, `apps=456`, `website=8`, `docs=375`, `.zh.md=1440`, and `.i18n.yaml=1437`. Panda has zero corresponding native/python/apps/website/docs/i18n surfaces in its tracked tree, but that is a scope difference—not a defect by itself.

## Measured evidence

- Release metadata and scripts are at `deepseek-harness@origin/master:package.json:45-90,140-176`. Release validation packs and checks layout at `deepseek-harness@origin/master:.github/workflows/release.yml:80-107`; publishing is at `deepseek-harness@origin/master:.github/workflows/release-publish.yml:120-131`; Python wheels are built, installed, smoke-tested, validated, and hashed at `deepseek-harness@origin/master:.github/workflows/python-release.yml:25-75,78-175`.
- Tests are split into thread-safe and process-bound projects, with fork pools, explicit include/exclude rules, and V8 coverage at `deepseek-harness@origin/master:vitest.config.ts:158-220`. The two-phase TypeScript build and strict project references are at `deepseek-harness@origin/master:tsconfig.json:1-14`, `deepseek-harness@origin/master:tsconfig.base.json:5-35`, and `deepseek-harness@origin/master:docs/development.md:52-82`.
- The i18n contract defines three-file pairs, hashes, structural checks, exclusions, and gate behavior at `deepseek-harness@origin/master:docs/i18n/README.md:7-57`; executable word-count budgets and their verifier are at `deepseek-harness@origin/master:docs/AGENTS.md:47-57`.
- Current upstream counts are recorded in the independent verification (`C:\code\panda\.scratch\research-pass-2026-09-11\verification.md:45-55`). The earlier `51/36/325/8/360` and `1286/1283` counts are stale and must not be reused.
- Two textual zeros are scoped and controlled: `check:ci:artifacts` and `publish:npm-baseline` have no non-`package.json` references, while positive controls `check:all` and `verify-cordis-api` have six and thirteen such references respectively (`C:\code\panda\.scratch\research-pass-2026-09-11\verification.md:49-55`).
- Panda has zero tracked files in the corresponding surface inventory and zero `.zh.md`/`.i18n.yaml`; the controls are existing panda TypeScript/package surfaces (`C:\code\panda\packages\kernel\test\guard.test.ts:1-12`, `C:\code\panda\packages\contracts\test\topology.test.ts:1-12`, `C:\code\panda\packages\session\test\consumer-install.proof.ts:1-12`) plus the sentinel `__NO_SUCH_SURFACE__` (`C:\code\panda\.scratch\research-pass-2026-09-11\verification.md:63-68`).

## Controls and classification

| Finding | Classification | Evidence and control |
|---|---|---|
| DSH release, process-bound test, split TypeScript, i18n, and doc-budget machinery | mechanism | Executable workflows/configuration cited above. |
| Panda lacks these DSH distribution surfaces | gap / scoped absence | Positive panda package controls and sentinel control prevent treating a broken query as zero. |
| Zero non-package references for two DSH scripts | refusal | Positive references for `check:all` and `verify-cordis-api` prove the query distinguishes unused textual references from documented commands. |
| Panda's current package/consumer proof discipline | panda-ahead / adjacent mechanism | Existing package guards and consumer-install proof remain the relevant panda gates; this note does not claim DSH parity is required. |

These findings are research inputs only. They do not create a frozen specification, implementation task, or sprint entry. No code was changed.

## What this note did not open

It did not open every DSH package implementation, run a release or publish, execute the Python wheel workflow, or decide whether panda should acquire i18n, website, Python, or multi-runtime distribution surfaces. It did not treat counts as product requirements, and it did not inspect untracked/user-modified instruction files as current upstream source.
