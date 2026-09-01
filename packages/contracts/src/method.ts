import { PandaError, PANDA_ERROR_CODES } from './errors.ts'
import { defineStandardSchema } from './standard-schema.ts'
import type { StandardSchemaIssue, StandardSchemaResult, StandardSchemaV1 } from './standard-schema.ts'
import { isNonEmptyString, isRecord, issue } from './validation.ts'

// The MethodPlugin Contract (FR-23 / RD-3): the surface a third party writes a
// methodology against, without touching panda internals.
//
// RD-3 caps this surface at THREE parts and no more: a declarative manifest
// (identity, phases, artifact conventions), command definitions, and EXACTLY TWO
// lifecycle hooks — `onActivate` and `onDeactivate`. The PRD's words are "no
// further hooks until a second real methodology implementation demands them", so
// a third hook is out of scope here even when it looks obviously useful.
//
// Reference documentation for authors: `packages/contracts/METHOD-PLUGIN.md`.
// Everything an author needs is meant to be in that file and in the types below;
// anything they can only learn by reading THIS file is a publication defect.

// The recommended semver.org pattern, verbatim.
//
// DUPLICATED, deliberately: `packages/kernel/src/manifest.ts` enforces the same
// rule on a `PluginManifest.version` and carries its own copy, because AD-1
// forbids the kernel a runtime dependency on anything, `@panda/contracts`
// included. `test/method.test.ts` asserts the two copies agree on every string
// in a shared corpus, so they cannot drift silently.
export const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/

/**
 * `major.minor.patch`, optionally `-prerelease` and `+build`. Leading zeros, a
 * `v` prefix, ranges (`^1.0.0`) and dist-tags (`latest`) are all NOT semver:
 * NFR-8 versions every Contract together under one semver major, and a version
 * that cannot be ordered against another cannot participate in that policy.
 */
export function isSemver(value: unknown): value is string {
  return typeof value === 'string' && SEMVER_PATTERN.test(value)
}

/** One step of the methodology, in declaration order. Order IS the phase order. */
export interface MethodPhase {
  readonly id: string
  readonly description?: string
}

/**
 * Whether `value` is a path a methodology may declare for an artifact: relative
 * to the project root, on every platform, and unable to climb above it.
 *
 * Published alongside {@link isSemver} for the same reason — an author checks a
 * path before shipping instead of learning the rule from a rejection.
 *
 * A PURE STRING predicate: no `node:path`, no filesystem. A manifest is authored
 * once and consumed everywhere, so the verdict must not depend on the platform
 * the validator happens to run on — `node:path` on POSIX calls `C:\Windows` a
 * perfectly good relative filename, and the same manifest would then mean two
 * different things on two machines.
 *
 * The separator is `/` on EVERY platform, and a backslash is rejected outright
 * rather than translated. `docs\plan.md` is a nested file on Windows and a
 * single flat filename on POSIX: accepting it would publish a contract whose
 * meaning depends on the reader, which is the exact "kept syntactically, broken
 * in substance" failure this contract exists to make impossible. The cost is
 * recorded in `deferred-work.md`: a POSIX filename containing a literal
 * backslash cannot be declared.
 */
export function isProjectRelativePath(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false
  if (value.includes('\u0000')) return false // truncates in syscalls; written as the escape (check-source-bytes)
  if (value.includes('\\')) return false // separator ambiguity, see above
  if (value.startsWith('/')) return false // POSIX-absolute, and `//server/share` with it
  if (/^[A-Za-z]:/.test(value)) return false // `C:\`, `c:/` and drive-relative `C:x` alike
  if (value.startsWith('~')) return false // a leading '~' is a reserved marker here (normalizeRegistryEntryPaths)

  // Resolve '.' and '..' by walking segments. `..` inside the base is legal —
  // `a/b/../../c` names `c` — so only a climb PAST the base is an escape, and a
  // path that resolves to nothing (`a/..`) names the project root rather than an
  // artifact. Rejecting the legal middle case would block honest manifests,
  // which is its own defect.
  const resolved: string[] = []
  for (const segment of value.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (resolved.length === 0) return false
      resolved.pop()
      continue
    }
    resolved.push(segment)
  }
  return resolved.length > 0
}

/**
 * An artifact CONVENTION: what the methodology produces and where it lands.
 * `path` is required because a declared artifact with no location states nothing
 * a tool or a human could act on. It is a convention, not a claim that the file
 * exists — but it IS enforced to be project-relative by
 * {@link isProjectRelativePath}, because this is the field artifacts are later
 * materialised from and a rule stated only in prose is not a rule.
 *
 * Panda validates it and stores it verbatim; normalising it is a
 * materialisation decision, and no materialiser exists yet.
 */
export interface MethodArtifact {
  readonly id: string
  readonly path: string
  /** The phase that produces it. Must name a phase this manifest declares. */
  readonly phase?: string
}

/** A command the methodology offers. `id` is its identity and must be unique. */
export interface MethodCommand {
  readonly id: string
  readonly summary?: string
  /** The phase it belongs to. Must name a phase this manifest declares. */
  readonly phase?: string
}

/**
 * The activation half of RD-3's pair. Takes no argument on purpose: what panda
 * would hand a method on activation belongs to the method-swap command (FR-28 /
 * Story 5.4 — a verb the binary does NOT have yet, which is why it is not spelled
 * out here), and inventing a context object now would decide that question before
 * the story that owns it. Async is allowed — a methodology that materialises
 * templates does I/O.
 */
export type MethodActivateHook = () => void | Promise<void>

/** The deactivation half. Same shape, and required whenever `onActivate` is present. */
export type MethodDeactivateHook = () => void | Promise<void>

/** The declarative half: everything a MethodPlugin states about itself. */
export interface MethodManifest {
  readonly id: string
  /**
   * Semver. See {@link isSemver}. Enforced by the VALIDATOR, not by this type:
   * the only type-level spelling available is `` `${number}.${number}.${number}` ``,
   * which was measured to accept `01.0.0`, `-1.0.0` and `1e3.0.0` and to REJECT
   * `1.0.0-rc.1` and `1.0.0+build.5`. A type that breaks the build of an author
   * publishing a legitimate prerelease is worse than no type at all.
   */
  readonly version: string
  readonly description?: string
  readonly phases: readonly MethodPhase[]
  readonly artifacts: readonly MethodArtifact[]
  readonly commands: readonly MethodCommand[]
  /** The one namespace open to payloads panda does not define. */
  readonly extensions?: Readonly<Record<string, unknown>>
}

/**
 * RD-3's pair rule, as a type: both hooks or neither, never one.
 *
 * `?: undefined` rather than `?: never`, so the type answers exactly what the
 * validator answers — the runtime rule is `value['onActivate'] !== undefined`,
 * which accepts an explicitly-undefined hook. A neater-looking `never` would
 * make the compiler and the validator disagree about the same manifest, and two
 * disagreeing authorities on one rule is worse than one.
 */
export type MethodHookPair =
  | { readonly onActivate?: undefined; readonly onDeactivate?: undefined }
  | { readonly onActivate: MethodActivateHook; readonly onDeactivate: MethodDeactivateHook }

/**
 * A MethodPlugin IS its manifest plus the hook pair — one object, one validator,
 * the way the kernel's `PluginManifest` carries its `configSchema`.
 *
 * The pair rule lives in the TYPE as well as the validator because it is the
 * rule this contract's documentation warns hardest about, and a guarantee only
 * prose enforces is the defect this contract exists to stop shipping. A
 * half-pair was always rejected at runtime; now it never compiles.
 */
export type MethodPlugin = MethodManifest & MethodHookPair

// Same discipline as the registry envelope (`registry.ts`): unknown keys at the
// root are REJECTED, and provider-specific payloads have exactly one home, the
// reserved `extensions` namespace. Published so an author can enumerate the
// envelope without reading this file.
export const METHOD_PLUGIN_ROOT_KEYS: readonly string[] = [
  'id',
  'version',
  'description',
  'phases',
  'artifacts',
  'commands',
  'onActivate',
  'onDeactivate',
  'extensions',
]

const PHASE_KEYS: readonly string[] = ['id', 'description']
const ARTIFACT_KEYS: readonly string[] = ['id', 'path', 'phase']
const COMMAND_KEYS: readonly string[] = ['id', 'summary', 'phase']

/**
 * The unknown-key rule, applied to the root AND to every collection item.
 *
 * Nested items get NO `extensions` escape hatch of their own — the root's is the
 * single reserved namespace — so a misspelled `descripton` on a phase is a
 * rejection rather than a field that silently does nothing. That is one level
 * beyond the envelope the registry guards, and it is deliberate: a collection
 * item dropped for a typo is the "kept syntactically, broken in substance"
 * failure this contract exists to make impossible.
 */
function unknownKeyIssues(value: Record<string, unknown>, known: readonly string[], where: string): StandardSchemaIssue[] {
  const allowed = new Set(known)
  return Object.keys(value)
    .filter((key) => !allowed.has(key))
    .map((key) =>
      issue(
        `'${key}' is not allowed on ${where}; it carries ${known.map((field) => `'${field}'`).join(', ')}` +
          (where === 'the method plugin root'
            ? ", and payloads panda does not define belong under the reserved 'extensions' namespace"
            : ''),
      ),
    )
}

function optionalNonEmptyString(value: Record<string, unknown>, key: string, where: string, issues: StandardSchemaIssue[]): void {
  if (value[key] !== undefined && !isNonEmptyString(value[key])) {
    issues.push(issue(`'${key}' must be a non-empty string when present on ${where}`))
  }
}

function optionalHook(value: Record<string, unknown>, key: string, issues: StandardSchemaIssue[]): void {
  if (value[key] !== undefined && typeof value[key] !== 'function') {
    issues.push(issue(`'${key}' must be a function when present`))
  }
}

/**
 * Validates one collection and returns the ids it declared, in order, so the
 * caller can resolve cross-references without walking the array a second time.
 * Duplicate ids are rejected the way the kernel rejects a duplicate service: an
 * identity that names two things names neither.
 */
function collectionIssues(
  raw: unknown,
  field: string,
  keys: readonly string[],
  requiredStrings: readonly string[],
  optionalStrings: readonly string[],
  issues: StandardSchemaIssue[],
  pathFields: readonly string[] = [],
): string[] {
  if (raw === undefined) {
    issues.push(issue(`'${field}' is required (declare an empty array if the method has none)`))
    return []
  }
  if (!Array.isArray(raw)) {
    issues.push(issue(`'${field}' must be an array`))
    return []
  }
  const ids: string[] = []
  const seen = new Set<string>()
  raw.forEach((item, index) => {
    const where = `${field}[${index}]`
    if (!isRecord(item)) {
      issues.push(issue(`${where} must be an object`))
      return
    }
    for (const key of requiredStrings) {
      if (!isNonEmptyString(item[key])) issues.push(issue(`'${key}' must be a non-empty string on ${where}`))
    }
    for (const key of optionalStrings) optionalNonEmptyString(item, key, where, issues)
    // Inside the SAME pass, so every bad path in the collection lands in the
    // same list: a per-field early return would report the first and hide the
    // second, and this contract promises every violation, not the first.
    // Guarded on `isNonEmptyString` so a missing path reports "required" once
    // rather than twice in two different vocabularies.
    for (const key of pathFields) {
      const declared = item[key]
      if (isNonEmptyString(declared) && !isProjectRelativePath(declared)) {
        issues.push(
          issue(
            `'${key}' must be a project-relative path on ${where}: '/' separators, no leading '/', drive letter, '~' or backslash, and it must not climb above the project root; got ${JSON.stringify(declared)}`,
          ),
        )
      }
    }
    issues.push(...unknownKeyIssues(item, keys, where))
    const id = item['id']
    if (isNonEmptyString(id)) {
      if (seen.has(id)) issues.push(issue(`${field} declares '${id}' more than once; an id identifies exactly one entry`))
      seen.add(id)
      ids.push(id)
    }
  })
  return ids
}

function phaseReferenceIssues(
  raw: unknown,
  field: string,
  phaseIds: readonly string[],
  issues: StandardSchemaIssue[],
): void {
  if (!Array.isArray(raw)) return
  raw.forEach((item, index) => {
    if (!isRecord(item)) return
    const phase = item['phase']
    if (isNonEmptyString(phase) && !phaseIds.includes(phase)) {
      issues.push(
        issue(
          `${field}[${index}] names phase '${phase}', which this manifest does not declare` +
            (phaseIds.length === 0 ? ' (it declares no phases)' : `; declared phases: ${phaseIds.join(', ')}`),
        ),
      )
    }
  })
}

/** Every way a value fails the MethodPlugin contract. Empty means it passes. */
export function methodPluginIssues(value: unknown): StandardSchemaIssue[] {
  if (!isRecord(value)) return [issue('method plugin must be an object')]
  const issues: StandardSchemaIssue[] = []

  if (!isNonEmptyString(value['id'])) issues.push(issue("'id' must be a non-empty string"))

  const version = value['version']
  if (version === undefined) {
    issues.push(issue("'version' is required"))
  } else if (!isSemver(version)) {
    issues.push(
      issue(
        `'version' must be a semver version (major.minor.patch, optional -prerelease and +build); got ${JSON.stringify(version)}`,
      ),
    )
  }

  optionalNonEmptyString(value, 'description', 'the method plugin root', issues)

  const phaseIds = collectionIssues(value['phases'], 'phases', PHASE_KEYS, ['id'], ['description'], issues)
  collectionIssues(value['artifacts'], 'artifacts', ARTIFACT_KEYS, ['id', 'path'], ['phase'], issues, ['path'])
  collectionIssues(value['commands'], 'commands', COMMAND_KEYS, ['id'], ['summary', 'phase'], issues)
  phaseReferenceIssues(value['artifacts'], 'artifacts', phaseIds, issues)
  phaseReferenceIssues(value['commands'], 'commands', phaseIds, issues)

  optionalHook(value, 'onActivate', issues)
  optionalHook(value, 'onDeactivate', issues)
  // RD-3 says the PAIR. A mount with no unmount is what FR-28's swap cannot
  // undo, and an unmount with no mount is a disposer for something that was
  // never registered — the matrix names the first direction, and the second is
  // the same half-pair seen from the other side.
  const hasActivate = value['onActivate'] !== undefined
  const hasDeactivate = value['onDeactivate'] !== undefined
  if (hasActivate !== hasDeactivate) {
    const present = hasActivate ? 'onActivate' : 'onDeactivate'
    const missing = hasActivate ? 'onDeactivate' : 'onActivate'
    issues.push(issue(`'${present}' is declared without '${missing}'; the lifecycle hooks are a pair or neither`))
  }

  const extensions = value['extensions']
  if (extensions !== undefined && !isRecord(extensions)) {
    issues.push(issue("'extensions' must be an object when present"))
  }

  issues.push(...unknownKeyIssues(value, METHOD_PLUGIN_ROOT_KEYS, 'the method plugin root'))
  return issues
}

/** Programmatic validation: raises a coded {@link PandaError} on any violation. */
export function validateMethodPlugin(value: unknown): MethodPlugin {
  const issues = methodPluginIssues(value)
  if (issues.length > 0) {
    throw new PandaError(
      PANDA_ERROR_CODES.methodInvalidPlugin,
      `invalid method plugin: ${issues.map((entry) => entry.message).join('; ')}`,
    )
  }
  return value as MethodPlugin
}

export const METHOD_PLUGIN_SCHEMA: StandardSchemaV1<MethodPlugin> = defineStandardSchema(
  (value): StandardSchemaResult<MethodPlugin> => {
    const issues = methodPluginIssues(value)
    return issues.length > 0 ? { issues } : { value: value as MethodPlugin }
  },
)

/**
 * A mounted method. The handle IS the disposer, mirroring the kernel's
 * register-with-disposer rule: whoever activated is the one who can deactivate,
 * and nothing else can deactivate a method that never activated.
 */
export interface MethodActivation {
  readonly id: string
  /** Runs `onDeactivate` at most once. Every later call is a no-op. */
  deactivate(): Promise<void>
}

function hookFailure(id: string, hook: 'onActivate' | 'onDeactivate', cause: unknown): PandaError {
  return new PandaError(
    PANDA_ERROR_CODES.methodHookFailed,
    `method '${id}' failed in '${hook}': ${cause instanceof Error ? cause.message : String(cause)}`,
    { cause },
  )
}

/**
 * Validates, then mounts. Returns the handle that unmounts it.
 *
 * A throwing `onActivate` leaves nothing half-mounted: this raises
 * `PANDA_METHOD_HOOK_FAILED` naming the method and the hook, and no handle
 * exists, so `onDeactivate` can never run for an activation that did not happen.
 * Undoing whatever the hook did before it threw is the hook's own business —
 * panda cannot know what it started.
 */
export async function activateMethod(plugin: unknown): Promise<MethodActivation> {
  const method = validateMethodPlugin(plugin)
  try {
    await method.onActivate?.()
  } catch (error) {
    throw hookFailure(method.id, 'onActivate', error)
  }

  let deactivated = false
  return {
    id: method.id,
    async deactivate(): Promise<void> {
      // Flipped BEFORE the hook runs, not after: the kernel marks a plugin
      // `disposed` even when its disposer threw, so a failed teardown is never
      // retried into a second run. Setting it synchronously also makes two
      // concurrent calls collapse to one.
      if (deactivated) return
      deactivated = true
      try {
        await method.onDeactivate?.()
      } catch (error) {
        throw hookFailure(method.id, 'onDeactivate', error)
      }
    },
  }
}
