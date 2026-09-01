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
 * `import(specifier)` resolves relative to the module that calls it, so a bare
 * `await import('./tdd.mjs')` here searched `packages/session/src/` — meaning no
 * relative specifier could ever work, which is the ordinary way a local method
 * is named. Found by running the binary while this package's suite was green,
 * because every test passed a `file://` URL and sidestepped resolution.
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
 * The method a composed configuration selects, with the layer that decided it —
 * the same shape and the same `dump()` read `selectExecutor` uses, so the two
 * selections cannot disagree about what a layer means.
 *
 * `undefined` is the ORDINARY state in v1 and is not a failure: PRD §6.2 places
 * methodologies post-v1, so most runs select none and must cost nothing. A
 * selection that is present but not a usable string IS a failure, because a
 * `method: 42` silently ignored is a run using a different methodology than the
 * document names.
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
