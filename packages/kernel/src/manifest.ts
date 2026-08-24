import { ManifestInvalidError } from './errors'

// Validation performs no I/O in kernel-owned code: no fs, network, env reads, or dynamic imports.
// Plugin-supplied Standard Schema validators necessarily execute plugin code; their side effects are
// the plugin's responsibility.

export interface ServiceConsumption {
  readonly service: string
  readonly mode: 'hard' | 'soft'
}

export interface StandardSchemaIssue {
  readonly message: string
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
  // Intentionally loose for now: any non-empty trimmed string. Semver enforcement arrives with the
  // MethodPlugin contract in a later story.
  readonly version: string
  readonly provides: readonly string[]
  readonly consumes: readonly ServiceConsumption[]
  readonly configSchema: StandardSchemaV1Like
}

const CONFIG_PROBE = Symbol('panda-config-probe')

function fail(field: string, reason: string): never {
  throw new ManifestInvalidError(`invalid plugin manifest: '${field}' ${reason}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

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

function requireField<T>(manifest: Record<string, unknown>, field: string, check: (value: unknown) => value is T, description: string): T {
  const value = manifest[field]
  if (value === undefined) fail(field, 'is required')
  if (!check(value)) fail(field, `must be ${description}`)
  return value
}

function rejectDuplicateServices(services: readonly string[], field: string): void {
  const seen = new Set<string>()
  for (const service of services) {
    if (seen.has(service)) fail(field, `must not declare service '${service}' more than once`)
    seen.add(service)
  }
}

export function validateManifest(input: unknown): PluginManifest {
  if (!isRecord(input)) fail('manifest', 'must be an object')

  const id = requireField(input, 'id', isNonEmptyString, 'a non-empty trimmed string').trim()
  const version = requireField(input, 'version', isNonEmptyString, 'a non-empty trimmed string').trim()

  const rawProvides = requireField(input, 'provides', (value): value is string[] => Array.isArray(value), 'an array of service names')
  for (const service of rawProvides) {
    if (!isNonEmptyString(service)) fail('provides', 'entries must be non-empty trimmed strings')
  }
  rejectDuplicateServices(rawProvides.map((service) => service.trim()), 'provides')

  const rawConsumes = requireField(input, 'consumes', (value): value is unknown[] => Array.isArray(value), 'an array of service consumptions')
  const consumedServices: string[] = []
  const consumes = rawConsumes.map((entry): ServiceConsumption => {
    if (!isRecord(entry)) fail('consumes', 'entries must be objects')
    const service = entry['service']
    if (!isNonEmptyString(service)) fail('consumes', "entries must have a non-empty trimmed string 'service'")
    const mode = entry['mode']
    if (!isServiceMode(mode)) fail('consumes', "entries must have a mode of 'hard' or 'soft'")
    consumedServices.push(service.trim())
    return { service: service.trim(), mode }
  })
  rejectDuplicateServices(consumedServices, 'consumes')

  const configSchema = input['configSchema']
  if (configSchema === undefined) fail('configSchema', 'is required')
  if (!isStandardSchemaV1Like(configSchema)) {
    fail('configSchema', 'must be a Standard Schema v1 object (~standard with version 1 and a validate function)')
  }
  let probeResult: { then?: unknown }
  try {
    probeResult = configSchema['~standard'].validate(CONFIG_PROBE) as { then?: unknown }
  } catch (error) {
    throw new ManifestInvalidError(`invalid plugin manifest: 'configSchema' must validate without throwing`, { cause: error })
  }
  if (typeof probeResult.then === 'function') fail('configSchema', 'must validate synchronously')

  return {
    id,
    version,
    provides: rawProvides.map((service) => service.trim()),
    consumes,
    configSchema,
  }
}
