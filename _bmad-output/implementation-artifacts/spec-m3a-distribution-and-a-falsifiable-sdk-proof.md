---
title: 'Distribution, and an SDK proof that can fail'
type: 'feature'
created: '2026-08-26'
status: 'done'
review_loop_iteration: 1
baseline_commit: '5c36947'
context:
  - '{project-root}/_bmad-output/planning-artifacts/ROADMAP-02-the-container-and-the-promise.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-2-0-session-composition-through-the-kernel.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-2-7c-executor-selection-for-panda-run.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** FR-29's checkable sentence is *"anything the CLI can do, a third party must be able to do by importing packages, without `@panda/cli`."* The test that proves it runs **inside the workspace**, where pnpm resolves `workspace:*` and every package exports raw TypeScript. Outside it, nothing can be installed: all nine packages are `"private": true`, version `0.0.0`, `"exports": {".": "./src/index.ts"}`, and **no package has a build script**. The promise the product is named for is currently unfalsifiable — the one condition under which a claim can never be wrong.

**Approach:** an installable artifact, and a proof that installs it somewhere the workspace cannot help. The build is the compiler this repo already has: TypeScript 7.0.2 emits JavaScript, declarations and maps, and `rewriteRelativeImportExtensions` turns `./run-session.ts` into `./run-session.js` in the output while leaving `@panda/*` specifiers alone. No bundler and no new dependency.

**Source-first in the repo, dist-first in the tarball.** `publishConfig` overrides `exports` and `bin` only in the packed manifest; the workspace keeps pointing at `src`. That is not a convenience — the absence of a build step is what makes vitest, the type checker and the linter run against source today, and a story that forces a compile into the development loop would tax every story after it.

**What this deliberately does not decide.** Whether to publish to a registry. That is outward-facing and irreversible: it claims a name, fixes a license posture and cannot be taken back. This story makes the packages installable and proves it; choosing to publish stays with the owner.

## Boundaries & Constraints

**Always:** the FR-29 proof installs BUILT TARBALLS into a project OUTSIDE the workspace and runs a real session there, so it fails when the packaged artifact is wrong rather than when the monorepo is; the development loop is unchanged — `pnpm check` needs no build to typecheck, test or lint, and every existing test keeps passing unmodified; the emitted package is what the tarball exports, and the tarball's own manifest is asserted rather than assumed; every package that another package depends on is built, because a partial build produces a tarball that installs and then fails at import; declarations ship, so a consumer gets types; the build is reproducible from a clean checkout with one command.

**Ask First:** publishing to any registry; choosing a package name other than the current `@panda/*`; a license file or SPDX identifier; a version-bump or release-automation policy; removing `"private": true` (it blocks publish, not pack, so the proof does not need it gone).

**Never:** no bundler and no new build dependency — the compiler in the lockfile emits this; no second source of truth for the public surface (the tarball exports what the build emits, not a hand-written list); no proof that resolves through the workspace, a symlink, a `file:` path into the repo, or `pnpm link` — those are the failure this story exists to remove; no change to what any package exports today.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Build from clean | No `dist/` anywhere | One command emits JS, `.d.ts` and maps for every package | Non-zero on any package failing |
| Specifier rewriting | Source imports `./x.ts` | Emitted JS imports `./x.js`; `@panda/*` untouched | N/A |
| Dev loop untouched | `pnpm check` with no `dist/` | Typecheck, test and lint all pass exactly as today | N/A |
| Tarball manifest | A packed package | Its `exports` and `bin` point into `dist`; `workspace:*` replaced by a concrete version | N/A |
| Install outside the workspace | Tarballs installed into a temp project | A real session runs and returns the same envelope shape `panda run` prints | Coded errors surface |
| The binary | The packed CLI | `panda` resolves to emitted JavaScript with its shebang intact | N/A |
| Types reach a consumer | The installed package | `.d.ts` resolves; a type error in consumer code is caught | N/A |
| Partial build | One package's `dist/` missing | The proof fails loudly, naming the package | Not a silent pass |
| Stale build | `dist/` older than `src/` | The proof builds first, so it can never assert against stale output | N/A |
| Proof can fail | A deliberately broken export map | The consumer test goes red | Must be demonstrated |

</frozen-after-approval>

## Code Map

- `tsconfig.build.base.json` -- NEW: the emit configuration, separate from the no-emit development one
- `packages/*/tsconfig.build.json` -- NEW per package: `rootDir`, `outDir`, includes
- `packages/*/package.json` -- a `build` script, `"files": ["dist"]`, and an `exports` map whose `panda-source` condition points at `src` while `types`/`default` point into `dist` (Spec Change Log #13); the CLI's `bin` points at the emitted JavaScript
- `packages/*/vitest.config.ts` -- NEW per package: the `panda-source` condition for vitest, and `**/dist/**` back in the exclude list
- `scripts/clean-dist.mjs` -- NEW: `tsc` overwrites but never removes, so the build wipes `outDir` first
- `package.json` -- root `build`, `panda` and `proof:consumer-install` scripts; `check` stays build-free
- `.github/workflows/ci.yml` -- the build and the proof now run in CI, which nothing did before
- `packages/session/test/consumer-install.proof.ts` -- NEW: the out-of-workspace proof — build, pack, install into a temp project, run a session (see Spec Change Log #6 for why it is not at `test/consumer-install/`)
- `packages/session/vitest.consumer-install.config.ts` -- NEW: the only route to that file, so the default run cannot pick it up
- `.gitignore` -- already ignores `dist/`; `files` is what puts it in the tarball anyway (Spec Change Log #3)

## Tasks & Acceptance

**Execution:**
- [x] Emit configuration and per-package build, producing JavaScript and declarations
- [x] One export map, correct for any packer, that resolves to `src` in the workspace and `dist` everywhere else
- [x] The CLI binary emits with its shebang and resolves from the packed manifest
- [x] The out-of-workspace consumer proof: pack, install, run a real session, assert the envelope
- [x] Demonstrate the proof FAILS when the packaged artifact is wrong
- [x] Every matrix row; `pnpm check` green and build-free

**Acceptance Criteria:**
- Given a clean checkout, when the build runs, then every package emits JavaScript and declarations whose relative specifiers resolve
- And a project outside the workspace installs the tarballs and runs a session that returns the envelope `panda run` prints (FR-29). Scope, stated narrowly: the session runs with an injected fake spawner, an empty interceptor chain and no `ActionPolicy`, and `resolveExecutor` answers from the `defaults` layer because the temp project holds no configuration document. So the waterfall is proved REACHABLE and the layered read is exercised in its empty case; interception behaviour and layer precedence are proved by the in-workspace suites, not here
- And that proof goes red when the packaged artifact is wrong, demonstrated rather than asserted
- And `pnpm check` still passes with no build present, with every existing test unmodified

## Spec Change Log

Every entry below records what was MEASURED on this machine (Windows 11, Node
v24.14.1, pnpm 11.23.0 in-repo / 10.33.4 outside it, TypeScript 7.0.2), not what
was intended. The frozen block settled none of these.

**1. `allowImportingTsExtensions` stays ON in the build config.** The obvious
emit config turns it off, and that fails: every source file imports `./x.ts`, so
`tsc` reports TS5097 on all of them. Keeping it on alongside
`rewriteRelativeImportExtensions: true` is legal and is exactly what produces the
rewrite. Measured: `packages/session/dist/index.js` emits
`from './run-session.js'` and leaves `from '@panda/kernel'` untouched.

**2. `rootDir: "."` for `@panda/cli`, `rootDir: "src"` for the other eight.**
`bin/panda.ts` sits outside `src/` and imports `../src/run.ts`, so `rootDir:
"src"` cannot cover it. Two shapes were considered; moving the binary into `src`
was rejected because `eslint.config.js` pins `packages/cli/bin/**/*.ts` as its
own thin-binding scope and moving the file would move that rule for no gain. The
package root gives `dist/src/index.js` and `dist/bin/panda.js`. Measured on the
emitted binary: the first bytes are `#!/usr/bin/env node\n` (the compiler
preserves the shebang — verified with `od -c`, not assumed) and the line under it
is `import { runPanda } from '../src/run.js'`, which resolves from `dist/bin/`.

**3. `"files": ["dist"]` is load-bearing, and it is a TOP-LEVEL field.**
`.gitignore` already ignores `dist/`, and npm/pnpm fall back to `.gitignore` when
a package has no `files` and no `.npmignore` — so without this the tarball would
have shipped a manifest pointing at `dist` and no `dist` in it. Measured: `tar
-tzf panda-session-0.0.0.tgz` lists `package/dist/index.js`, `.d.ts`, and both
map kinds. It is a top-level field, which is now the only kind this repo
uses: `publishConfig` was removed entirely (#13).

**4. `pnpm -r build` sorts topologically, and NOTHING DEPENDS ON IT.**
Measured order from a clean tree: `kernel`, `contracts`, then
`registry`/`workspace-local`/`adapter-cli`, then `session`/`projection`, then
`environment`, then `cli`. Sorting is pnpm's default for recursive `run`.

CORRECTION — an earlier version of this entry presented that ordering as a
verified invariant. It is not one, and a later reader should not defend it.
Re-measured after #13: `@panda/session` builds from a clean tree with none of
its four dependencies built, exit 0, because the `panda-source` condition sends
the compiler at its dependencies' SOURCE rather than at their `dist`. The
ordering is real and free; it is not load-bearing, and no assertion rests on it.

**5. Declarations keep `.ts` specifiers, and they still resolve.**
`rewriteRelativeImportExtensions` rewrites JavaScript emit only:
`dist/index.d.ts` says `from './run-session.ts'` while `dist/index.js` says
`from './run-session.js'`. That looked like a defect and is not — a `.ts`
specifier inside a `.d.ts` is exempt from TS5097 and resolves to the sibling
`.d.ts`. Measured from a project outside the repo with plain `nodenext` and no
`allowImportingTsExtensions`: `tsc` exits 0, and the `@ts-expect-error` in the
consumer fixture is CONSUMED (an unused directive is itself an error), so the
declarations arrived as real types rather than degrading to `any`.

**6. The proof lives at `packages/session/test/consumer-install.proof.ts`, not
`test/consumer-install/`.** A repo-root vitest suite would need `vitest`,
`@types/node` and `typescript` as root devDependencies. The last one is the
blocker: the root manifest's own `$comment` calls `@typescript/typescript6`
load-bearing for typescript-eslint's peer resolution, that package supplies
`node_modules/.bin/tsc` at 6.0.3, and adding `typescript@~7.0.2` beside it
collides on that bin. The alternative — a root test file nothing typechecks —
is worse than a location change. Where it now sits, the proof FILE is typechecked by
`packages/session/tsconfig.json` (`include: ["src","test"]`), linted by
`eslint .` and runnable by wiring that already existed, and it sits beside
`consumer.test.ts`, the in-workspace proof it makes falsifiable. Stated exactly,
because an earlier version of this entry said "the work" and meant only half of
it: `vitest.consumer-install.config.ts` sits at the package ROOT, which no
`include` covers, so it is linted and never typechecked — the same as the nine
`vitest.config.ts` files and every other config in this repo. It imports nothing from any package, so AD-2 is
untouched: every `@panda/*` name in it is a directory to pack or a tarball to
read.

**7. The gate is a separate vitest config; an env flag is the opt-out only.**
AMENDED by #16 and #20 — there IS an env variable now, but it can only SKIP,
never enable, and CI runs the proof unconditionally. The file ends in
`.proof.ts`, which vitest's default `**/*.{test,spec}.*` include does not match,
so the default run cannot reach it at all; `vitest.consumer-install.config.ts`
names it explicitly and `pnpm proof:consumer-install` and the CI step call it.
Measured: `pnpm check` reports `packages/session — 4 test files, 62 tests`, the
same as before this story, and completes with no `dist/` present. A flag was
rejected as the ENABLING mechanism, and that reasoning was half right: a flag
nobody sets is a proof nobody runs, which is why #20 wired the CI step that
actually makes it run.

**8. The install resolves through `pnpm.overrides` + `file:` tarballs, offline.**
SUPERSEDED by #26 — the override half was silently ignored by pnpm 11 and broke
CI. The tarball-only, registry-free half survives; the mechanism changed.

The packed manifest carries `"@panda/contracts": "0.0.0"` — pnpm rewrote
`workspace:*` on pack, measured — and no registry has that version, so each
transitive `@panda/*` needs an override naming its tarball. The tarballs are
copied INTO the temp project and referenced relatively, so no `file:` path points
back into the repo. `pnpm install --ignore-workspace --offline` succeeds:
`@panda/session`'s whole subtree (contracts, kernel, workspace-local,
adapter-cli) has zero registry dependencies, so `--offline` is an assertion
rather than a convenience — it means nothing but the tarballs was resolved.
Measured `import.meta.resolve('@panda/session')` inside the consumer:
`file:///…/panda-installed-consumer-…/project/node_modules/.pnpm/@panda+session@file+tarballs+panda-session-0.0.0.tgz/node_modules/@panda/session/dist/index.js`.

**9. Tarballs are read by a small ustar reader, not by `tar`.** Shelling out was tried first and failed: the GNU `tar` on this PATH
reads `C:\Users\…` as a `host:path` remote spec and answers `Cannot connect to
C: resolve failed`, which made the assertion depend on which `tar` a machine has.
`node:zlib` plus 512-byte headers removes the external binary entirely.

**10. The CLI is asserted from its tarball rather than installed.**
`@panda/cli` → `@panda/environment` → `@panda/projection` → `jsonc-parser`, which
IS a registry dependency, so installing the CLI would need the network and make
the proof depend on a warm store. The claim in the matrix — the binary is emitted
JavaScript with its shebang intact and the packed manifest points at it — is
fully checkable from the tarball's own bytes, which is where a consumer gets it.

**11. Falsifiability was demonstrated twice, not asserted.** Both demonstrations
predate #13, so they name `publishConfig`; the export map they broke now lives in
the manifest itself, and #17 records the round-1 demonstrations against it.
(a) With `@panda/session`'s `publishConfig.exports["."]` repointed at
`./dist/entry.js` (a path the build does not emit), the proof went red with
`ERR_MODULE_NOT_FOUND … node_modules\@panda\session\dist\entry.js imported from
…\project\consumer.mjs`. Restored, it went green again. (The suite has since grown from 7 clauses to 8;
the current counts are in Verification.)
(b) With `"files"` deleted from `@panda/registry` — the partial-artifact case,
on a package `@panda/session` does not depend on, so the session still ran — the
per-package clause went red naming it: `@panda/registry does not ship
./dist/index.js, which its packed manifest points at`. That is also the direct
evidence for #3: remove `files` and `dist` leaves the tarball.

**12. `build` cleans its `outDir` first.** SUPERSEDED, and the original claim
was false: this entry used to say the clean step could wait and that "the proof
cannot be fooled by staleness regardless, because it runs the build itself".
Running a build removes nothing. Measured: a hand-written
`packages/registry/dist/deleted-module.js` survived `pnpm build` (exit 0) and
shipped in the tarball; renaming a module the export map points at leaves the old
emit in place, where it still resolves, installs and passes. `pnpm build` is now
`node ../../scripts/clean-dist.mjs && tsc -p tsconfig.build.json`; re-measured,
the same planted file is gone after one build.

### Review round 1 — three context-free reviewers, by execution

**13. `publishConfig` is gone; one export map with a custom condition replaces
it (HIGH-1).** `publishConfig.exports`/`bin` is a pnpm/yarn feature. Measured
with `npm pack` on the previous shape: npm warned `Unknown publishConfig config
"exports"`, shipped `"exports": "./src/index.ts"` (a file `files: ["dist"]` does
not include) and `"bin": "./bin/panda.ts"` (raw TypeScript whose relative import
is not shipped) — nine broken tarballs for anyone not using pnpm.

The real manifest now carries the truth for every packer:
`{"panda-source": "./src/index.ts", "types": "./dist/index.d.ts", "default":
"./dist/index.js"}`, and `bin` points at `./dist/bin/panda.js`. The workspace
keeps compiling and testing SOURCE because exactly three places set the
condition: `customConditions` in `tsconfig.base.json` (inherited by
`tsconfig.build.base.json`), `ssr.resolve.conditions` in each package's
`vitest.config.ts`, and `--conditions=panda-source` in the root `panda` script.

Measured after the change, with every `dist/` deleted: `pnpm check` exit 0,
byte-identical test counts in all nine packages, no build required. The frozen
block's escape hatch was therefore NOT taken. Re-measured with `npm pack`: the
`exports`/`bin` defect is gone and the warning with it.

Two things it does not fix, both stated rather than papered over:

- `npm pack` still emits `"@panda/contracts": "workspace:*"`. npm has no
  workspace protocol at all, so no manifest shape reaches it; only pnpm and yarn
  rewrite it, and pnpm does (measured: `0.0.0`). The proof now asserts this
  rather than assuming it (#17).
- `panda-source` names `./src/index.ts` in the SHIPPED manifest, and `src` is
  not in the tarball. It is a repository-private condition that only this repo's
  three call sites set, so nothing outside can resolve it; shipping `src` to make
  it resolvable would contradict the tarball being source-free.

**14. `pnpm exec panda` no longer works in the repo, and `pnpm panda` replaces it
(HIGH-1, consequence).** `bin` cannot carry conditions — it is a flat map — so
the workspace `bin` had to become `./dist/bin/panda.js`. Measured on a
fresh-install state with no `dist/`: `pnpm install` creates NO `panda` shim at
all (not even a dangling one), and `pnpm install --force` after a build does not
add it back either. So the root gained
`"panda": "node --conditions=panda-source packages/cli/bin/panda.ts"`, measured
working with no `dist/` present. Nothing in `pnpm check` executes the binary —
verified by grep across all nine test suites — so this is an ergonomics change,
not a gate change.

**15. `ssr.resolve.conditions`, not `resolve.conditions` (HIGH-1, mechanism).**
Setting `resolve: { conditions: ['panda-source'] }` alone was measured NOT to
work: `@panda/contracts` and `@panda/kernel` both failed with `Failed to resolve
entry for package`. Vitest 4 drives the node environment through the SSR
pipeline. `ssr: { resolve: { conditions: ['panda-source'] } }` alone fixes it,
and it ADDS rather than replaces — `jsonc-parser`, a real registry dependency of
`@panda/projection`, still resolves.

**16. A missing or broken pnpm now FAILS the proof (HIGH-2).** It used to skip
all seven assertions and exit 0, and the reason was a `console.warn` at
collection time that the reporter drops when every task in a file skips — so the
two green outcomes differed only by wall time. The probe QUESTION was already
right (it reads the exit status, not "did a shell start"); only the consequence
was wrong. It is now the first assertion inside `beforeAll`. Measured with a
`pnpm.CMD` shim that exits 1 placed first on PATH: `Test Files 1 failed`, exit 1,
and the message names the exit code, the output and the opt-out.
`PANDA_CONSUMER_INSTALL=0` is the only skip; it writes its reason with
`process.stderr.write` and leaves one running task behind so the run still exits
0 — measured. `passWithNoTests` was rejected for that job: it would also swallow
an `include` matching no file, a mistake this very config already made once.

**17. The proof walks the module graph inside each tarball, and reads the PACKED
manifest for all nine (HIGH-4, M1, M2, M3).** The old clause checked only the
entry points a manifest named, and only the WORKSPACE manifest for seven of the
nine. Four defects, one rewrite:

- `files: ["dist/index.js","dist/index.d.ts"]` on `@panda/registry` shipped an
  entry point re-exporting four modules the archive did not contain — a package
  that throws on the first line of its own import — and the proof passed 7/7. The
  graph is now walked from every target, following `./x.js` in JavaScript and
  `./x.ts` in declarations (`rewriteRelativeImportExtensions` rewrites JS emit
  only). Re-measured with the same mutation: red, naming all eight missing files
  and the entry each was reached from.
- The `types` condition was never read. Now it is. Measured with a `files` list
  carrying the complete JavaScript graph and no declarations: red on
  `@panda/registry does not ship package/dist/index.d.ts`.
- Manifests are read out of the tarballs, so a packer that stopped projecting the
  publish-time shape cannot pass — which is exactly what npm did (#13).
- Dependency ranges are checked against the packed versions, because the
  `pnpm.overrides` that keep the install offline resolve every `@panda/*` to a
  tarball whatever the range says. NOT DEMONSTRATED, and the reason is concrete:
  producing that drift needs a manifest whose `@panda/*` range no workspace
  package satisfies, and any such edit breaks `pnpm install` for the repository
  itself. The clause is exact-string equality (`ponytail:` documented in place),
  so it errs strict — a legitimate `workspace:^` would pack as `^0.0.0` and turn
  it red. Strict is the correct direction for a guard; a semver check earns its
  place when a versioning policy creates real ranges.

**18. The consumer typecheck runs strict (M4).** `skipLibCheck: false` and
`types: ["node"]`, with `@types/node` pinned to the exact version the repository
resolved (24.13.3) so the consumer install stays `--offline`. Measured: exit 0.
The requirement it makes visible is real — `@panda/contracts/dist/executor.d.ts`
needs an ambient `AbortSignal`, and with `skipLibCheck: false` and no
`@types/node` it fails `TS2304` — and it belongs in Verification, which is where
it now is.

WHAT COULD NOT BE DONE, said plainly: the reviewers asked that the typecheck also
DEPEND on the `types` condition. Under `nodenext` it cannot. TypeScript resolves
`default` to `dist/index.js` and then finds `dist/index.d.ts` beside it, so
removing the `types` condition entirely leaves the consumer typecheck green.
Measured. The condition is defended by #17's shipped-file walk instead, which is
a structural check and does not pretend to be a resolution one.

**19. Source maps dropped (HIGH-5).** 108 map files, 281,530 of 748,160
uncompressed bytes — 37.6% of the payload — every one naming `../src/*.ts`, which
`files: ["dist"]` does not ship. `declarationMap` and `sourceMap` are gone from
`tsconfig.build.base.json`; re-measured, the build emits 54 `.js` and 54 `.d.ts`
and nothing else. `ponytail:` upgrade path named in place — `sourceMap` +
`declarationMap` + `inlineSources: true`, which pays the bytes for something that
works.

**20. The build and the proof run in CI (HIGH-3).** `.github/workflows/ci.yml`
ran `pnpm install --frozen-lockfile` and `pnpm check` and nothing else, so a
`tsconfig.build.json` broken for any package landed green and the proof was
reachable only by hand. Both are now steps in the existing `gates` job, reusing
its install and the pnpm store the proof's `--offline` consumer install needs.
The earlier reasoning here — "a flag is a thing a later story can set wrong" —
was right about flags and answered the wrong risk: a flag that is never set is at
least reachable; a script no automation invokes is unreachable by default.

**21. The `dist` exclude is back in every vitest config (M6).** vitest 4 dropped
it from `defaultExclude`; 2 and 3 carried it. Nothing under any `src/` is a test
file today, so this changes no count — it stops the first colocated `*.test.ts`
anyone adds from being collected twice on every machine that has run a build.

**22. The installed consumer project is removed when the suite is green, kept
when it is not.** It used to leak into the OS temp directory unconditionally.
`beforeAll` flips a flag only after it completes and `afterEach` records any
failing task, so a setup that threw keeps its tree too. Measured: 0 directories
left after a green run, 1 after a red one.

**23. The consumer payload is delimited.** It was parsed as the last line of
merged stdout+stderr, one Node deprecation warning away from an opaque
`SyntaxError` inside `beforeAll` that would have read like a packaging defect. It
is now fenced between two markers, with its own assertion when the fence is
absent.

**24. NOT DONE — a `"./package.json"` export.** Three guard tests (`kernel`,
`session`, `environment`) assert `Object.keys(pkg.exports)` equals `['.']`
deliberately: `packages/kernel/test/guard.test.ts` says in place that the map is
what stops the surface pins from being bypassed by the manifest. Adding the entry
requires editing those tests, and this round's contract is that every existing
test passes unmodified. It needs the invariant's owner, not a patch.

**25. NOT DONE — stripping `devDependencies` and `scripts` from packed
manifests.** Measured harmless: a dependency's `devDependencies` are never
installed, and `build` is not a lifecycle script, so the unshipped
`tsconfig.build.json` it names is never reached. Removing them needs a pack-time
manifest rewrite, which is the exact class of packer-specific mechanism #13 just
deleted. It is publish-time cosmetics, and publishing is Ask-First.

### Review round 2 — CI, red on Linux only

**26. The consumer install was resolving through `pnpm.overrides`, which pnpm 11
does not read. The consumer now declares its whole `@panda/*` closure — five
direct `file:` dependencies — and installs them with npm.**

The symptom was `ERR_PNPM_NO_OFFLINE_META: Failed to resolve
@panda/adapter-cli@0.0.0 in package mirror …/registry.npmjs.org/@panda/adapter-cli.jsonl`,
on both Node 24 and 26, with `pnpm check` green on both — and passing on Windows.

IT IS NOT THE OPERATING SYSTEM. The temp project carried no `packageManager`
field, so corepack handed it whatever pnpm is installed globally: **10.33.4** on
this machine, and **11.23.0** on the runner, because `pnpm/action-setup@v4`
installs the version the repo's `packageManager` names. Measured by adding
`"packageManager": "pnpm@11.23.0"` to the same temp project on Windows, which
reproduced the CI error byte for byte and printed the reason pnpm had been
printing all along:

```
[WARN] The "pnpm" field in package.json is no longer read by pnpm.
The following keys were ignored: "pnpm.overrides".
```

So under pnpm 11 the overrides were dropped silently, the transitive
`@panda/adapter-cli@0.0.0` went looking for registry metadata, and `--offline`
refused. The proof's own `pnpm --version` probe read the REPOSITORY's pnpm —
11.23.0 — while the consumer install ran a different one. Nothing connected the
two, and nothing could have noticed.

WHAT THE `--offline` ASSERTION ACTUALLY PROVED, which is the lesson worth
keeping. `pnpm install --offline` exiting 0 is satisfied by two different
worlds: "every dependency came from a tarball", and "every dependency came from
a warm store this machine happened to have". The proof asserted the exit code
and never the shape, so it could not tell them apart — and under pnpm 10 the
overrides quietly made it the first while under pnpm 11 it needed the second.
The fix is structural rather than another assertion: the consumer project's
dependencies are now `file:` tarballs and NOTHING else, so there is no registry
package left for a store to have been warm about. A guard over the fixture this
file writes itself would assert nothing a reader could not already see.

THE DIRECT-DEPENDENCY SHAPE DOES NOT WORK UNDER pnpm, measured before switching:
with all five `@panda/*` declared as top-level `file:` dependencies and no
overrides at all, pnpm 11.23.0 still answers `ERR_PNPM_NO_OFFLINE_META: Failed
to resolve @panda/contracts@0.0.0`. pnpm does not satisfy a dependency's
registry-shaped `"0.0.0"` requirement from a top-level `file:` install of that
same version. npm does — measured on npm 11.11.0, `added 5 packages`, exit 0,
`--offline`, with the runtime session and the strict typecheck both green
afterwards.

So the consumer install moved to **npm**: pnpm produces the tarballs, npm is the
party that received them. That is the shape that works, and it is also the point
— the consumer half of a proof about distribution should not depend on this
workspace's own package manager, and npm ships with Node, so there is no second
binary to probe.

THE COST, stated rather than hidden: npm's flat `node_modules` is a weaker
isolation than pnpm's strict layout. Under pnpm, a consumer that installed only
`@panda/session` structurally could not resolve `@panda/contracts`, and that was
part of what the old shape proved. With every transitive declared directly —
which is what the fix requires under any package manager — that property is gone
regardless of which one installs. It is still pinned inside the workspace by
`packages/session/test/guard.test.ts` and by `consumer.test.ts`'s single-import
rule, and the consumer script executed here still imports `@panda/session` and
nothing else.

**27. The consumer typecheck installs no type package at all (amends #18).**
`@types/node` pinned at an exact version was the previous answer, and it brought
its own dependency: `undici-types`, which is not beside a hand-copied
`@types/node`, so a strict check failed with five `TS2307: Cannot find module
'undici-types'`. Measured instead: `lib: ["es2023", "dom"]` with `types: []` and
`skipLibCheck: false` compiles the consumer clean. The shipped declarations need
an ambient `AbortSignal` and nothing else outside `es2023` — that is a sharper
statement of the requirement than "install `@types/node`", and it is what lets
the consumer project hold `file:` dependencies exclusively (#26). The check is
still doing work: with `lib: ["es2023"]` alone it fails `TS2304: Cannot find
name 'AbortSignal'`.

**28. Linux says something about the CLI bin that Windows did not (amends
#14).** On Windows, a fresh install with no `dist/` simply produced no `panda`
shim. Measured in `podman run node:24-alpine`, `pnpm install --frozen-lockfile`
prints it twice, as a warning rather than a failure:

```
[WARN] Failed to create bin at /w/node_modules/.bin/panda.
ENOENT: no such file or directory, open '/w/packages/cli/dist/bin/panda.js'
```

The install still exits 0 and everything downstream is green, so this is noise
rather than breakage — but it is noise on every install, in CI included, and it
comes from the root `@panda/cli` devDependency whose only purpose was the
`pnpm exec panda` that #14 already retired. Removing that devDependency would
silence it and would change `pnpm-lock.yaml`; that is the owner's call, not a
patch to slip in here.

**29. Verified on Linux in a container, because the defect this round repaired
was invisible on Windows.** `podman run --rm -e CI=true node:24-alpine` over a
clean copy of the tree — Linux x86_64, Node v24.19.0, pnpm 11.23.0 (the major
that broke CI), npm 11.17.0:

```
OVL_INSTALL_EXIT=0   OVL_CHECK_EXIT=0   OVL_BUILD_EXIT=0   OVL_PROOF_EXIT=0
proof: Test Files 1 passed (1)   Tests 8 passed | 1 skipped (9)
```

`CI=true` is required or pnpm refuses to purge a modules directory with no TTY.
Copy the tree INTO the container (`cp -r /src /app`) rather than working in a
bind mount — see below.

TWO PRE-EXISTING TESTS FLAKED DURING THIS VERIFICATION. Neither is touched by
this story, both are timing-sensitive, and both are recorded here rather than
quietly re-run until green:

- `packages/projection/test/inspect.test.ts` — "agrees with apply about a file
  that moved under the merge" — failed in both runs done over a Windows-backed
  bind mount and PASSED on the container's own filesystem, plus every run on
  Windows. `hasFileChangedSince` detects a mid-merge rewrite by comparing
  `mtimeMs` and `size`; both writes in that test are `{ "numStartups": N }\n`,
  21 bytes each, so only the timestamp can carry the signal. Probed in that same
  container, writing 21 bytes twice back to back: on the container's `/tmp`
  (where the fixture lives, via `os.tmpdir()`) `mtimeMs` came back
  `1787729302141.4963` BOTH times, while the bind mount moved 13 ms. So a
  same-size rewrite inside one millisecond is undetectable by that check. Real,
  small, and owned by `@panda/projection`; the upgrade path is
  `stat(path, { bigint: true }).mtimeNs` or a content hash.
- `packages/registry/test/lock.test.ts` — "release never deletes a successor's
  lock" — failed once on Windows with `ENOENT` on the restored lock file, then
  passed 3/3 on re-run and in the full gate afterwards. A rename/restore race on
  a filesystem that briefly denies the path.

ONE WRONG THEORY, recorded so nobody re-measures it: line endings.
`core.autocrlf=true` here leaves some working-tree files CRLF, so a tar of the
working tree is not what CI checks out. Normalising every text file to LF
(leaving `packages/projection/test/goldens/**`, which `.gitattributes` marks
`-text`) changed nothing — the projection clause failed identically before and
after.

## Design Notes

**Why the compiler and not a bundler.** Verified before speccing: TypeScript 7.0.2 with `rewriteRelativeImportExtensions` emits exactly what is needed — `./run-session.js` from `./run-session.ts`, `@panda/kernel` left alone, declarations and maps beside them. A bundler would be a new dependency solving a problem the lockfile already solves, and it would flatten the package boundaries AD-2 exists to keep visible.

**Why the proof must leave the workspace.** A consumer test inside the repo resolves `@panda/session` through pnpm's workspace links no matter what the export map says. It cannot fail for the reason this story cares about. Installing a tarball into a directory outside the repo is the smallest thing that can.

**Why publishing is not in scope.** It is irreversible and it decides things this story has no business deciding — the name, the license, the versioning policy. Packing proves the artifact; publishing is a separate, human call.

**Deliberately not built.** No registry publish, no release automation, no version bumping, no license file, no changesets, no CI publish step.

## Verification

**Commands:**
- `pnpm check` -- expected: fully green, with no `dist/` required. Measured with every `dist/` deleted first: exit 0, and `packages/session` still reports 4 test files / 62 tests.
- `pnpm build` -- expected: every package emits JS, `.d.ts`, `.js.map` and `.d.ts.map` in dependency order. Measured: exit 0 from a clean tree.
- `pnpm proof:consumer-install` -- expected: builds, packs all nine, installs into a project under the OS temp directory and runs a real session there. Measured: 8 passed / 1 skipped, ~13s. It builds first, so it never needs `pnpm build` run beforehand. `PANDA_CONSUMER_INSTALL=0` skips it and says so on stderr; anything else wrong -- a missing pnpm included -- fails it.
- `pnpm panda -- <args>` -- runs the CLI from source with no build, via `--conditions=panda-source`. `pnpm exec panda` does NOT work in the repo (Spec Change Log #14).
- CI runs `pnpm check`, then `pnpm build`, then the proof, on Node 24 and 26.
- The producer half runs on pnpm (build, pack); the CONSUMER half installs with `npm install --offline` and only `file:` tarballs, so no store or cache needs to be warm anywhere (Spec Change Log #26).
- Verified on Linux as well as Windows, because the CI-only failure this replaced was invisible here: `podman run --rm -e CI=true -v <clean checkout>:/w -w /w node:24-alpine` with `corepack enable`, then `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm proof:consumer-install`. `CI=true` is needed or pnpm refuses to purge a modules directory without a TTY. Expect ONE red clause from `pnpm check` in a container that this story does not own and CI does not see — `packages/projection/test/inspect.test.ts`, explained in Spec Change Log #29.

**Stated limitations of the artifact, recorded rather than solved:**
- **Nothing installs by name.** All nine packages are `"private": true`, version `0.0.0` and unpublished, so a consumer must be handed all nine tarballs and wire every transitive `@panda/*` by hand -- which is what the proof's `pnpm.overrides` do. That is the direct, intended consequence of the frozen block's Ask-First on publishing, not a defect to fix here.
- **A strict consumer needs an ambient `AbortSignal`.** The shipped declarations use it and need nothing else outside `es2023`; either `@types/node` or the DOM lib supplies it. With neither, `@panda/contracts/dist/executor.d.ts` fails `TS2304` under `skipLibCheck: false` — measured. The proof compiles a consumer under exactly those strict settings, taking `AbortSignal` from `lib: ["es2023", "dom"]` and installing no type package at all.
- **`npm pack` still leaves `workspace:*` in dependencies.** npm has no workspace protocol; pnpm and yarn rewrite it, npm cannot. Pack with pnpm.
