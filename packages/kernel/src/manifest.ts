import { ManifestInvalidError } from './errors.ts'

// Validation performs no I/O in kernel-owned code: no fs, network, env reads, or dynamic imports.
// Plugin-supplied Standard Schema validators necessarily execute plugin code; their side effects are
// the plugin's responsibility.

export interface ServiceConsumption {
  readonly service: string
  readonly mode: 'hard' | 'soft'
}

export interface StandardSchemaIssue {
  readonly message: string
  /**
   * Where in the validated value the issue is, as Standard Schema defines it.
   *
   * Panda's own schemas are hand-written and bake the coordinate into the
   * message (`artifacts[0]`), so they carry none. A third party plugging in Zod
   * or Valibot produces a populated one, and since M7.C the kernel APPLIES a
   * plugin's schema — so this is the field that keeps `expected number` from
   * being the whole story when forty keys could have produced it.
   */
  readonly path?: readonly (string | number)[]
}

/** One issue as an author reads it, with its coordinate when the schema gave one. */
export function renderIssue(issue: StandardSchemaIssue): string {
  return issue.path === undefined || issue.path.length === 0
    ? issue.message
    : `${issue.message} (at ${issue.path.join('.')})`
}

export type StandardSchemaResult<Output = unknown> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: readonly StandardSchemaIssue[] }

export interface StandardSchemaV1Like<Output = unknown> {
  readonly '~standard': {
    readonly version: 1
    readonly validate: (value: unknown) => StandardSchemaResult<Output> | Promise<StandardSchemaResult<Output>>
  }
}

export interface PluginManifest {
  readonly id: string
  // Semver, enforced: `major.minor.patch` with optional `-prerelease` and `+build`, leading zeros
  // rejected, no `v` prefix, no ranges. Surrounding whitespace is trimmed before the check, so
  // '\t1.0.0 ' stores '1.0.0'. NFR-8 versions every Contract together under one semver major, and a
  // manifest whose version cannot be ordered against another cannot participate in that policy.
  readonly version: string
  readonly provides: readonly string[]
  readonly consumes: readonly ServiceConsumption[]
  /**
   * The plugin's own configuration schema, APPLIED by the kernel (since M7.C)
   * rather than merely probed for shape.
   *
   * The kernel validates `config.resolve()[manifest.id]` — a plugin's subtree is
   * its OWN ID, which is not a new convention but the one all three shipped
   * plugins already spelled out by hand — and hands the factory the result's
   * `value` as `ActivationContext.settings`, so defaults and transforms a schema
   * supplies actually reach the plugin. Issues fail the plugin to start, before
   * the factory body runs.
   *
   * STRICTNESS IS YOURS, not the kernel's. A schema that accepts `undefined`
   * makes configuration optional; one that accepts unknown keys tolerates a
   * forward-looking document. The kernel imposes no policy of its own — it only
   * enforces the one you wrote.
   */
  readonly configSchema: StandardSchemaV1Like
}

const CONFIG_PROBE = Symbol('panda-config-probe')

/** One violation, in the single sentence this validator has always produced. */
function issueText(field: string, reason: string): string {
  return `invalid plugin manifest: '${field}' ${reason}`
}

/**
 * The issues found so far, for the ONE call in flight.
 *
 * Module-scoped and cleared at entry rather than threaded through nine helpers:
 * `validateManifest` is synchronous by contract (`is synchronous and never
 * returns a promise` is a pinned test) and the kernel never validates two
 * manifests at once, so there is no interleaving for a shared buffer to lose.
 * The moment either of those stops being true this has to become a parameter.
 */
let collected: string[] = []

/**
 * A FIELD-level violation: recorded, and validation walks on.
 *
 * This is the one to reach for by default. Use {@link fail} instead exactly when
 * the code below your check dereferences the value you just rejected — that is
 * the rule, not a judgement call.
 */
function collect(field: string, reason: string): void {
  collected.push(issueText(field, reason))
}

/**
 * A STRUCTURAL violation: the code after this point cannot run, so it throws.
 *
 * Reach for this only when the value you rejected is dereferenced below — a
 * manifest that is not an object, a `consumes` entry that is not an object, an
 * absent `configSchema` whose `~standard` is read four lines later. Making those
 * collect instead would turn a coded refusal into a raw `TypeError` (AD-7).
 *
 * It carries everything collected BEFORE it, so hitting a wall does not throw
 * away what the kernel had already found.
 */
function fail(field: string, reason: string): never {
  const message = issueText(field, reason)
  const issues = [...collected, message]
  throw new ManifestInvalidError(issues.length === 1 ? message : issues.join('; '), { issues })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

// The recommended semver.org pattern, verbatim. Written out rather than approximated because the
// approximations differ exactly where it matters: `1.2` (too few parts), `v1.0.0` (prefix) and
// `01.0.0` (leading zero) are the strings a hand-rolled `\d+\.\d+\.\d+` lets through.
//
// DUPLICATED, deliberately: `@panda/contracts` enforces the same rule on a MethodPlugin's `version`
// and carries its own copy, because AD-1 forbids this package a runtime dependency on anything —
// `@panda/contracts` included. `packages/contracts/test/method.test.ts` asserts the two agree on
// every string, so the copies cannot drift silently.
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/

function isServiceMode(value: unknown): value is ServiceConsumption['mode'] {
  return value === 'hard' || value === 'soft'
}

function isStandardSchemaV1Like(value: unknown): value is StandardSchemaV1Like {
  if (!isRecord(value)) return false
  const standard = value['~standard']
  return (
    isRecord(standard) &&
    standard.version === 1 &&
    typeof standard.validate === 'function'
  )
}

/**
 * Reads a field, or COLLECTS why it could not be read and returns `undefined`.
 *
 * The predecessor threw on the first bad field, which is why a manifest with a
 * bad `id` and a bad `version` cost two runs. Returning `undefined` is what lets
 * validation walk the rest of the manifest; the `required()` guard below is what
 * keeps that from reaching the returned object.
 */
function readField<T>(
  manifest: Record<string, unknown>,
  field: string,
  check: (value: unknown) => value is T,
  description: string,
): T | undefined {
  const value = manifest[field]
  if (value === undefined) {
    collect(field, 'is required')
    return undefined
  }
  if (!check(value)) {
    collect(field, `must be ${description}`)
    return undefined
  }
  return value
}

function collectDuplicateServices(services: readonly string[], field: string): void {
  const seen = new Set<string>()
  for (const service of services) {
    if (seen.has(service)) collect(field, `must not declare service '${service}' more than once`)
    seen.add(service)
  }
}

/** Throws every collected issue as one rejection, or returns if there are none. */
function throwCollected(): void {
  if (collected.length === 0) return
  const issues = [...collected]
  throw new ManifestInvalidError(issues.length === 1 ? issues[0]! : issues.join('; '), { issues })
}

/**
 * Narrows a value that `throwCollected()` has already proven present.
 *
 * Unreachable by construction: every path that leaves one of these `undefined`
 * called `collect`, and `throwCollected()` threw on anything collected. It is a
 * coded refusal rather than a `!` assertion so that a future edit which adds a
 * path leaving a field undefined WITHOUT collecting fails loudly and says which
 * invariant broke, instead of putting `undefined` into a validated manifest.
 */
function required<T>(value: T | undefined, field: string): T {
  if (value === undefined) {
    throw new ManifestInvalidError(issueText(field, 'failed validation without recording why'))
  }
  return value
}

export function validateManifest(input: unknown): PluginManifest {
  // Reset at entry, not at exit: an earlier call that threw leaves its issues
  // behind, and inheriting them would report another manifest's mistakes.
  collected = []

  if (!isRecord(input)) fail('manifest', 'must be an object')

  const id = readField(input, 'id', isNonEmptyString, 'a non-empty trimmed string')
  const version = readField(input, 'version', isNonEmptyString, 'a non-empty trimmed string')
  if (version !== undefined && !SEMVER_PATTERN.test(version.trim())) {
    collect('version', `must be a semver version (major.minor.patch, optional -prerelease and +build); got '${version.trim()}'`)
  }

  const rawProvides = readField(input, 'provides', (value): value is string[] => Array.isArray(value), 'an array of service names')
  if (rawProvides !== undefined) {
    if (rawProvides.some((service) => !isNonEmptyString(service))) {
      collect('provides', 'entries must be non-empty trimmed strings')
    }
    collectDuplicateServices(
      rawProvides.filter(isNonEmptyString).map((service) => service.trim()),
      'provides',
    )
  }

  const rawConsumes = readField(input, 'consumes', (value): value is unknown[] => Array.isArray(value), 'an array of service consumptions')
  const consumes: ServiceConsumption[] = []
  const consumedServices: string[] = []
  for (const entry of rawConsumes ?? []) {
    // STRUCTURAL: `entry['service']` is read on the next line.
    if (!isRecord(entry)) fail('consumes', 'entries must be objects')
    const service = entry['service']
    const mode = entry['mode']
    if (!isNonEmptyString(service)) collect('consumes', "entries must have a non-empty trimmed string 'service'")
    if (!isServiceMode(mode)) collect('consumes', "entries must have a mode of 'hard' or 'soft'")
    // A malformed entry contributes no service name: reporting it as a duplicate
    // as well would be one mistake counted twice.
    if (!isNonEmptyString(service) || !isServiceMode(mode)) continue
    consumedServices.push(service.trim())
    consumes.push({ service: service.trim(), mode })
  }
  if (rawConsumes !== undefined) collectDuplicateServices(consumedServices, 'consumes')

  const configSchema = input['configSchema']
  // STRUCTURAL, both of them: `configSchema['~standard'].validate` is called
  // below, and on `undefined` or a non-schema that is a raw TypeError rather
  // than a coded refusal (AD-7).
  if (configSchema === undefined) fail('configSchema', 'is required')
  if (!isStandardSchemaV1Like(configSchema)) {
    fail('configSchema', 'must be a Standard Schema v1 object (~standard with version 1 and a validate function)')
  }
  let probeResult: { then?: unknown }
  try {
    probeResult = configSchema['~standard'].validate(CONFIG_PROBE) as { then?: unknown }
  } catch (error) {
    throw new ManifestInvalidError(issueText('configSchema', 'must validate without throwing'), { cause: error })
  }
  // Collectable: the probe already ran, so nothing below depends on this.
  if (typeof probeResult.then === 'function') collect('configSchema', 'must validate synchronously')

  throwCollected()

  return {
    id: required(id, 'id').trim(),
    version: required(version, 'version').trim(),
    provides: required(rawProvides, 'provides').map((service) => service.trim()),
    consumes,
    configSchema,
  }
}

