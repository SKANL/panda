# Spec M39.B — The packed consumer floor is measured separately

Status: FROZEN after approval. Changes go in the Spec Change Log, never silently.
**Story:** proves consumer runtime compatibility from the artifacts a consumer
actually installs, without confusing it with panda's source/developer floor.

## Intent

Build and pack once on Node 24, then install and execute only packed tarballs on
candidate Node versions. The smoke must use plain Node ESM and npm so pnpm,
Vitest, TypeScript, workspace links, and repository `.ts` files cannot answer
for the consumer.

## Boundaries & Constraints

- `scripts/publishable-packages.json` is the single machine-readable roster of
  publishable package directories.
- The plain JavaScript smoke runner accepts a tarball directory, installs the
  packed packages into a temporary project outside the repository, imports every
  installed public package entrypoint, explicitly checks the
  `@skanl/panda-contracts` and `@skanl/panda-session` surfaces, and executes the
  installed CLI with `--version`.
- CI builds and packs on Node 24, then runs exactly Node 20, Node 22.13.0, Node
  22.18.0, and Node 24 as consumer candidates with npm engine-strict disabled.
- Release reuses the same manifest, pack helper, and smoke runner.
- The selected consumer floor is `>=20`, based on local execution of the packed
  artifacts on Node 20.20.0. CI must still reproduce the candidate matrix before
  treating that local measurement as a release-level result.

## Acceptance

1. The Vitest consumer proof reads the shared roster and no longer owns a
   duplicate publishable-package list.
2. The plain smoke runner fails on install, missing public exports, or CLI
   `--version` failure; it never skips an error.
3. The CI candidate matrix and Node 24 artifact job use the shared runner and
   contain no second package roster or smoke implementation.
4. `versions.test.ts` parses the workflow's actual job/matrix structure and
   fails when declared floors or candidate versions drift.
5. Deferred work records the local Node 20 evidence, closes the floor decision,
   and keeps CI replication as the remaining follow-up.

## Code Map

- `scripts/publishable-packages.json` — publishable directory roster.
- `scripts/pack-publishable.mjs` — Node 24 artifact packer.
- `scripts/consumer-smoke.mjs` — dependency-free plain Node consumer check.
- `packages/session/test/consumer-install.proof.ts` — in-repo proof consuming
  the shared roster.
- `.github/workflows/ci.yml` and `.github/workflows/release.yml` — build/pack
  and smoke integration.
- `packages/contracts/test/versions.test.ts` — drift gates.

## Spec Change Log

- 2026-09-11: local packed-artifact smoke passed on Node v20.20.0, v22.13.0,
  v22.18.0, and v24.14.1 after importing every publishable package entrypoint.
  The selected consumer floor is now `>=20`; CI still must reproduce the exact
  matrix. Publishable package manifests use `>=20`; the root developer/build
  floor remains `>=24`.
