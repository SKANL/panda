import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  PANDA_ERROR_CODES,
  PandaError,
  activateMethod,
  validateMethodPlugin,
  type MethodActivation,
  METHOD_CONFIG_KEY,
  type MethodPlugin,
} from '@panda/contracts'

// The method half of panda's own selection space (FR-28 / UJ-3).
//
// A method is NOT registry vocabulary. `packages/contracts/src/registry.ts`
// defines that vocabulary as "every word here reaches an executor ... exactly
// the two kinds the projection layer renders", and a method reaches no
// executor: panda mounts it in its own process. So the selection lives beside
// the executor selection in `<scope>/.panda/config.json`, and this file is what
// turns that string into something mounted.
//
// This is also the ONLY dynamic import in panda, and it is here rather than in
// the kernel because the kernel refuses to be a loader in writing
// (`packages/kernel/src/manifest.ts`: "no fs, network, env reads, or dynamic
// imports"). Consumer tier owns loading; the kernel owns lifecycle.

/**
 * What `import()` is actually given, resolved from the USER's directory.
 *
 * `import(specifier)` resolves relative to the module that calls it, so a
 * dot-relative specifier handed straight over searched `packages/session/src/` —
 * meaning no relative specifier could ever work, which is the ordinary way a
 * local method is named. Found by running the binary while this package's suite
 * was green, because every test passed a `file://` URL and sidestepped
 * resolution.
 *
 * The example is DESCRIBED rather than written out, and that is not fussiness:
 * `relativeSpecifiers` in `test/consumer-install.proof.ts` regexes raw source
 * for a dot-relative specifier and does not strip comments, so a literal one in
 * this JSDoc becomes a phantom import the packed `.d.ts` "reaches" and the
 * tarball cannot contain. It failed CI on both jobs exactly that way, which is
 * the same shape as the doc comment that tripped M5.A's printed-command scan.
 *
 * A relative path is resolved against `baseDir` and handed over as a file URL.
 * A BARE specifier goes through `createRequire(baseDir)`, so a method installed
 * in the user's project is found there rather than in panda's own
 * `node_modules`; if that throws — an ESM-only package with no CJS-resolvable
 * entry — the bare specifier is passed through unchanged, which at least gives
 * such a package a path instead of a guaranteed refusal.
 */
function resolveFrom(specifier: string, baseDir: string): string {
  if (specifier.startsWith('.')) return pathToFileURL(resolve(baseDir, specifier)).href
  if (specifier.startsWith('file:')) return specifier
  try {
    return pathToFileURL(createRequire(join(baseDir, 'panda.method.js')).resolve(specifier)).href
  } catch {
    return specifier
  }
}

/** A specifier that could not be loaded, named so the message is actionable. */
function unloadable(specifier: string, detail: string, cause?: unknown): PandaError {
  return new PandaError(
    PANDA_ERROR_CODES.configurationUnusable,
    `panda could not load the method '${specifier}': ${detail}`,
    cause === undefined ? undefined : { cause },
  )
}

/**
 * A module's method export, whichever way its author shipped it.
 *
 * `default` first, then the namespace itself: a TypeScript author writes
 * `export default`, and a CommonJS interop build hangs the same object off
 * `module.exports`. Unwrapping BOTH is what cordis's loader does for the same
 * reason, and getting it wrong reads to the author as "panda rejected my valid
 * plugin" rather than as an interop detail.
 */
function unwrap(namespace: unknown): unknown {
  if (namespace === null || typeof namespace !== 'object') return namespace
  const withDefault = namespace as { default?: unknown }
  return withDefault.default ?? namespace
}

/**
 * Loads a MethodPlugin from a module specifier and validates it against the
 * published contract.
 *
 * The specifier is STORED verbatim — it may be a relative path or a bare package
 * name, and normalising it would corrupt the second kind — but it is RESOLVED
 * against `baseDir` before `import()` sees it (see {@link resolveFrom}), because
 * a specifier the user wrote means what it means where the user is standing.
 * `baseDir` defaults to `process.cwd()`; every caller in panda passes the
 * directory it was pointed at explicitly.
 *
 * Validation goes through `validateMethodPlugin` rather than a second copy of
 * the rules, which is what makes M5.B's "every violation, not the first"
 * guarantee reach an author here.
 *
 * A specifier that will not resolve is a CODED refusal, never an empty result:
 * a broken selection that behaved like "no method selected" would run a
 * different methodology than the one configured without saying so, which is the
 * failure story 2.7c removed for `executor`.
 */
export async function resolveMethod(specifier: string, baseDir?: string): Promise<MethodPlugin> {
  const trimmed = specifier.trim()
  if (trimmed.length === 0) {
    throw unloadable(specifier, 'it is blank; a method is named by a module specifier')
  }
  let namespace: unknown
  try {
    namespace = (await import(resolveFrom(trimmed, baseDir ?? process.cwd()))) as unknown
  } catch (error) {
    throw unloadable(trimmed, error instanceof Error ? error.message : String(error), error)
  }
  // Validation failures keep the contract's OWN code and message — an author
  // debugging their manifest needs `PANDA_METHOD_INVALID_PLUGIN` and the full
  // violation list, not this file's wrapper around it.
  return validateMethodPlugin(unwrap(namespace))
}

/**
 * Refuses to MOUNT a selection the `project` layer decided.
 *
 * `panda run` used to import and EXECUTE a module named by the
 * `.panda/config.json` of the directory it was run in. Driven against a temp
 * project holding a `hostile.mjs` whose only statement is a `writeFileSync`:
 * the run exited 2 and the file existed, while the same project with no
 * `method` key left it unwritten. Clone a repository, run panda inside it, and
 * you have run its author's code.
 *
 * A module cannot be inspected without being LOADED, so neither validation nor
 * reordering can prevent this — `validateMethodPlugin` already refuses the
 * manifest, and the top-level statements have run by then. The deciding LAYER is
 * the only fact available before the import, and it is enough to separate a
 * choice from an arrival: `global` is the machine owner's own document, `agent`
 * is one a host handed over programmatically and is therefore that host's own
 * code, and `project` is the one that travels with a clone.
 *
 * SECOND LINE OF DEFENCE SINCE M30.D, AND STILL LOAD-BEARING. The ordinary path
 * no longer reaches this clause: `seedExecutorConfig` drops a `method` key from
 * a project document READ FROM DISK, so composition yields the next layer and
 * the run says what it declined. That was the fix for a refusal wider than its
 * threat — driven, a project key stopped the run whatever else was configured,
 * so a clone denied service to the machine owner's own selection.
 *
 * But a SUPPLIED kernel owns its configuration (`run-session.ts:51`) and never
 * reaches admission, so a host that seeds its own `project` layer arrives here.
 * Driven, not assumed: with this clause deleted that path RESOLVES — the module
 * is imported and the run returns ok. `kernel-composition.test.ts` pins it by
 * the side effect, because the first version of that clause asserted only the
 * error code and stayed green with the guard deleted.
 *
 * AND AD-5 DOES NOT SAY WHAT THIS COMMENT USED TO SAY IT SAID. It read "REFUSED
 * rather than ignored, per AD-5", treating the rule as a binary. AD-5 is typed
 * absence over silence — unavailable is not failed — so its opposite of IGNORED
 * is TYPED AND REPORTED, not FATAL. Only the silent skip would violate it, which
 * is why admission reports what it dropped instead of dropping it quietly.
 *
 * THE PLACEMENT IS THE GUARANTEE. This must be called between `selectMethod`
 * and `resolveMethod`. After the import there is nothing left to prevent, and a
 * check moved there would still pass its own test — which is why the test for
 * it is falsified by moving it, not only by deleting it.
 *
 * WHAT THIS DOES NOT DO, AND THE REASON CHANGED AFTER IT WAS DRIVEN: honour a
 * project selection panda ITSELF wrote via `project swap method`. That was
 * recorded here as merely deferred — "needs ownership tracking on config writes"
 * — and the roadmap ordered it first because it "removes a restriction rather
 * than adding a mechanism". Both sentences are wrong.
 *
 * An ownership record would prove panda wrote the NAME. The danger is the module
 * BYTES, which no record covers and which any `git pull` replaces — and AD-6's
 * records authorise REMOVAL (`ownedPaths` is "what makes a record authority for a
 * removal"), never EXECUTION. Reading one here would also need
 * `@panda/session -> @panda/projection`, an edge `packages/session/test/guard.test.ts`
 * pins closed. So it is a mechanism, and it is a trust store wearing an ownership
 * record's clothes; the honest version of it is the deferred per-directory trust
 * decision, not a rider on this guard.
 *
 * What IS still open, and it is smaller and realer: this refusal is fatal, so a
 * cloned repository carrying a `method` key denies service to a method the
 * machine's owner selected for themselves. Falling back to the next layer and
 * SAYING so would fix that — it renegotiates E1's frozen exit code, which is a
 * story rather than a rider. Recorded in `deferred-work.md`.
 */
export function assertMethodMayMount(selected: { readonly specifier: string; readonly layer: string }): void {
  if (selected.layer === 'project') {
    throw new PandaError(
      PANDA_ERROR_CODES.configurationUnusable,
      `the 'project' layer selects the method '${selected.specifier}', and panda will not import a module a project directory named: running it is running that project's code. That key is a RECOMMENDATION and adopting it is yours to do. Remove 'method' from this project's '.panda/config.json' — this refusal stands while it is there, even for a method you selected machine-wide — then run \`panda swap method ${selected.specifier}\` from this directory`,
    )
  }
  // A RELATIVE SPECIFIER IN A MACHINE-WIDE DOCUMENT IS NOT A SELECTION.
  //
  // `runSession` resolves the specifier against the RUN's cwd regardless of
  // which layer decided it, so `"method": "./mine.mjs"` in `~/.panda/config.json`
  // means "whatever `./mine.mjs` is in whatever directory you are standing in" —
  // a wildcard over every repository on the machine.
  //
  // Driven, with a control: standing in a directory carrying only a `mine.mjs`
  // and NO `.panda` config at all, the module's top-level code RAN; the same
  // directory with an empty HOME did not. So the selection caused it, and this is
  // WIDER than the hole the clause above closes — that one needs the hostile
  // repository to carry a config, this needs only a file with the right name.
  //
  // REFUSED rather than resolved against the home directory. Resolving would
  // silently change what an existing selection means; refusing says the true
  // thing, which is that the selection never named a file. An absolute path and
  // a package specifier both still work, and the clause that proves this did not
  // simply remove the feature asserts exactly that.
  const relative = ['./', '../', '.\\', '..\\'].some((prefix) => selected.specifier.startsWith(prefix))
  if (selected.layer !== 'project' && relative) {
    throw new PandaError(
      PANDA_ERROR_CODES.configurationUnusable,
      `the '${selected.layer}' layer selects the method '${selected.specifier}', and a relative specifier there names no file: panda resolves it against the directory you run in, so it would mean a different module in every project. Name it by ABSOLUTE path, or by package specifier`,
    )
  }
}

/**
 * The method a composed configuration selects, with the layer that decided it —
 * the same shape and the same `dump()` read `selectExecutor` uses, so the two
 * selections cannot disagree about what a layer means.
 *
 * THIS BLOCK USED TO SIT ABOVE `assertMethodMayMount`'s OWN JSDoc, so it bound to
 * nothing: measured on the emitted surface, `dist/methods.d.ts` declared
 * `selectMethod` with no documentation at all, and the guard's text cited "`selectMethod`'s
 * own rule right below" for a rule that documented nothing and did not ship.
 *
 * `undefined` is the ORDINARY state in v1 and is not a failure: PRD §6.2 places
 * methodologies post-v1, so most runs select none and must cost nothing. A
 * selection that is present but not a usable string IS a failure, because a
 * `method: 42` silently ignored is a run using a different methodology than the
 * document names.
 *
 * It never sees a `project` layer from a document panda read: `seedExecutorConfig`
 * drops that key before composition, which is what keeps `dump()` honest about
 * the layer panda acted on.
 */
export function selectMethod(config: {
  dump(): readonly { readonly path: readonly string[]; readonly value: unknown; readonly layer: string }[]
}): { readonly specifier: string; readonly layer: string } | undefined {
  const decided = config
    .dump()
    .find((entry) => entry.path.length === 1 && entry.path[0] === METHOD_CONFIG_KEY)
  if (decided === undefined) return undefined
  if (typeof decided.value !== 'string' || decided.value.trim().length === 0) {
    throw new PandaError(
      PANDA_ERROR_CODES.configurationUnusable,
      `'${METHOD_CONFIG_KEY}' must be a module specifier naming a MethodPlugin, but the '${decided.layer}' layer holds ${JSON.stringify(decided.value)}`,
    )
  }
  return { specifier: decided.value.trim(), layer: decided.layer }
}

/**
 * Mounts `incoming`, unmounting `outgoing` first — FR-28's ordering, and the
 * only place it is provable.
 *
 * The outgoing teardown is AWAITED TO SETTLEMENT before the incoming hook is
 * called. Not "started before": a swap that overlapped them would let a
 * methodology's templates be removed while the next one's were being written,
 * and the two orders are indistinguishable from the outside until they collide.
 *
 * A failed teardown REFUSES the swap instead of mounting the incoming anyway.
 * A half-swapped environment is worse than a refused one, because nothing
 * reports it: the outgoing believes it is unmounted, the incoming was never
 * asked, and the next run inherits both beliefs.
 *
 * `outgoing` is `undefined` at a session start, which is the ordinary case.
 */
export async function swapMethod(
  outgoing: MethodActivation | undefined,
  incoming: MethodPlugin,
): Promise<MethodActivation> {
  // Deliberately NOT wrapped: `deactivate()` already raises
  // `PANDA_METHOD_HOOK_FAILED` naming the method and the hook, which is exactly
  // what a caller needs to know WHICH half failed. Re-coding it here would
  // replace that with this function's own vocabulary and lose the half.
  if (outgoing !== undefined) await outgoing.deactivate()
  return await activateMethod(incoming)
}
