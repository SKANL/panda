# Version/Reality Check — Architecture Spine (Panda v1)

- **Reviewed:** `ARCHITECTURE-SPINE.md` (draft, 2026-08-24)
- **Scope:** every committed technology decision in the Stack section, verified against live web sources as of Aug 2026
- **Verdict:** ✅ **PASS** — all eight committed technology claims are factually accurate as of Aug 2026; no asserted-from-training-data errors found. Minor precision gaps noted below (none blocking).

---

## Claim-by-claim verification

### 1. TypeScript 7.0.x (native compiler) — ✅ CONFIRMED

- TypeScript 7.0 GA was announced **July 8, 2026** (Microsoft DevBlogs, "Announcing TypeScript 7.0"). Native Go port, ~8–12x faster full builds.
- Current npm version: **7.0.2** (published 2026-08-20). `typescript` package now ships the native `tsc` directly.
- Beta 2026-04-21, RC 2026-06-18 — timeline matches the spine's recency.
- **Nuance the spine omits:** TS 7.0 ships **no programmatic API**; the API returns in **TS 7.1** (expected ~Nov 2026 on the 3–4 month cadence). Anything importing `require('typescript')` against 7.0 gets almost nothing (`version` fields only).
- **Migration gotchas worth knowing at build time:** native 7 rejects `baseUrl` in tsconfig and forbids `esModuleInterop: false`.

### 2. typescript-eslint incompatibility + `@typescript/typescript6` alias — ✅ CONFIRMED

- Confirmed incompatible: `typescript-eslint@8.63.0` publishes peer range `typescript >=4.8.4 <6.1.0` — npm install fails with ERESOLVE against TS 7, and forcing it crashes inside `@typescript-eslint/typescript-estree`. Tracked in typescript-eslint issue **#12518** (closed as blocked-on-TS-side; fix lands when TS 7.1 ships its API).
- The `@typescript/typescript6` package exists and is Microsoft's official compatibility package: provides a `tsc6` executable and re-exports the TS 6.0 API. The npm-alias pattern in the spine matches upstream guidance exactly:
  ```json
  {
    "@typescript/native": "npm:typescript@^7.0.2",
    "typescript": "npm:@typescript/typescript6@^6.0.2"
  }
  ```
- **Precision gap (low severity):** the spine lists "TypeScript (lint tooling peer, aliased)" and separately "TypeScript (compiler/typecheck) 7.0.x", which implies two deps — correct — but never spells out that aliasing `typescript` → `@typescript/typescript6` leaves you with **only `tsc6`**; the second alias (`@typescript/native`) is required to restore the `tsc` binary. Worth one line at build time.
- **Seam worth naming:** editor type-aware lint runs against TS 6 while CI typechecks run native TS 7 — a type rejected by 7 can show green in the editor until CI catches it (documented by teams running this split).

### 3. Node.js ≥ 24 LTS ("Krypton") — ✅ CONFIRMED

- Node 24 entered **LTS on 2025-10-28** with codename **Krypton** (nodejs.org release blog v24.11.0). Latest line: **24.19.0 'Krypton' (LTS)**, published 2026-08-03.
- Status per nodejs/Release schedule: **Active LTS**, maintenance starts 2026-10-20, EOL 2028-04-30. Node 26 is Current (becomes Active LTS 2026-10-28) — so the spine's CI plan "Node 24 (+26 canary)" is coherent today and ages well into October.

### 4. pnpm 11.x features — ✅ CONFIRMED

- pnpm 11.0 released **2026-04-28**. Both claimed defaults are real and documented:
  - `minimumReleaseAge` defaults to **`1440`** (1 day) — newly published packages aren't resolved for 24h.
  - `blockExoticSubdeps` defaults to **`true`**.
- Also relevant defaults from the same release: `strictDepBuilds: true`, `verifyDepsBeforeRun: install`, `allowBuilds` replacing the old build-dependency settings, `.npmrc` restricted to auth/registry-only settings (all other config must move to `pnpm-workspace.yaml`). Requires Node 22+; pnpm itself is now pure ESM.
- **Practical interaction:** the 1-day `minimumReleaseAge` default will delay fresh releases of first-party deps (e.g., brand-new patch versions) — fine for this project, but don't be surprised when a same-day release isn't resolvable.

### 5. Zod 4 stability + Standard Schema v1 — ✅ CONFIRMED

- **Zod 4 is stable** and production-ready (zod.dev/v4); Zod 4 is now exported from the `zod` package root (since `zod@^4`, root flip announced 2025-07-08 note on the versioning page).
- **Standard Schema v1** exists exactly as described: single `StandardSchemaV1` interface (`~standard.props` with `version: 1`, `vendor`, `validate`, optional `types`), spec at standardschema.dev, types-only npm package `@standard-schema/spec`, implemented by Zod/Valibot/ArkType. Stable — spec authors commit to no breaking changes without a major bump.
- The spine's convention "schemas cross Contract boundaries as Standard Schema v1 objects; Zod allowed inside implementations/tests only" is well supported: accepting Standard Schemas makes them part of your public API, while the vendor library stays an implementation detail.

### 6. Vitest 4 schemaMatching — ✅ CONFIRMED

- `expect.schemaMatching(StandardSchemaV1)` shipped in **Vitest 4.0** (announced 2025-10-22) as an asymmetric matcher validating values against any Standard Schema v1 object. Documented in vitest.dev/api/expect.html; current line is 4.1.x (v4.1.7 referenced in docs). Works inside `toEqual`, `toStrictEqual`, `toMatchObject`, spy assertions, etc. Sync schemas only — async-schema use throws.
- This pairs cleanly with the spine's Standard-Schema-at-boundaries convention for contract-test suites.

### 7. ESLint 10 — ✅ CONFIRMED

- ESLint 10 exists and is the **Current** line since **2026-02-06**. Latest: **v10.9.0** (2026-08-21). ESLint v9 reached EOL **2026-08-06** — so committing to ESLint 10 is mandatory, not optional, for a new project starting now.

### 8. @changesets/cli maintained/current — ✅ CONFIRMED, with a freshness flag

- Actively maintained: `@changesets/cli@2.31.1` (2026-07-15), then a major: **Changesets v3 announced 2026-08-11** — `@changesets/cli@3.0.0` (2026-08-11), `3.0.1` (2026-08-19).
- **Flag:** the spine says "(verify current at bootstrap)" — good instinct — but as of *now* the answer already changed under it: **v3 just shipped two weeks ago**. It is **ESM-only** and requires Node `^22.11 || ^24 || >=26` (compatible with the spine's Node 24 floor, but a hard constraint if the floor ever drops). Bootstrap should target **v3**, not v2-era config patterns.

---

## Things in the spine that could go stale and weren't pinned

| Item | Risk | Recommendation |
| --- | --- | --- |
| **TS 7.1 API landing (~Nov 2026)** | Retires the entire TS6-alias workaround; typescript-eslint gains native TS 7 support | Add a spine note: re-evaluate lint-vs-compiler split when TS 7.1 ships; expect the dual-compiler setup to be temporary |
| **Node 26 → Active LTS (2026-10-28)** | Within weeks, the "+26 canary" lane becomes an LTS peer | Harmless; revisit the CI matrix after Oct 2026 |
| **pnpm 11 breaking-config conventions** | `.npmrc` auth-only, `pnpm-workspace.yaml` as canonical settings home, `allowBuilds` map | Ensure the repo seed/config layering (AD-9) anticipates pnpm settings living in `pnpm-workspace.yaml`, not `.npmrc` |
| **Changesets v3 transition** | v2→v3 is days old; docs/tutorials online still describe v2 | Pin `@changesets/cli@^3` explicitly at bootstrap rather than relying on the spine's generic "verify" note |
| **ESLint flat-config assumptions** | ESLint 9/10 dropped legacy config entirely | Non-issue if the project never knew eslintrc; just don't import legacy configs |

## Items checked and found accurate beyond the Stack table

- Deployment envelope claim "CI runs contract suites on Node 24 (+26 canary)" — consistent with Node release schedule.
- No other version-pinned claims exist in the spine; AD-1..AD-9 are architectural rules independent of vendor versions, correctly free of stale specifics.

---

*Sources: Microsoft TypeScript DevBlog (TS 7.0 GA, 2026-07-08), npm `typescript@7.0.2`, typescript-eslint #12518, nodejs.org previous-releases + nodejs/node releases, pnpm 11.0 release blog + pnpm.io/supply-chain-security, zod.dev/v4 + standardschema.dev, vitest.dev blog v4.0 + expect API docs, eslint.org version-support + v10.9.0 release notes, changesets.dev "Announcing Changesets v3" + GitHub releases.*
