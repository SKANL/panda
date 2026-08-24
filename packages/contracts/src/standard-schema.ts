// Canonical in-repo Standard Schema v1 surface. @panda/contracts has zero runtime
// dependencies, so the spec's interfaces are reproduced structurally here; schema
// libraries (Zod 4, Valibot, ...) interoperate through `~standard` without this
// package depending on any of them.

export interface StandardSchemaIssue {
  readonly message: string
}

export type StandardSchemaResult<Output = unknown> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: readonly StandardSchemaIssue[] }

export interface StandardSchemaV1<Output = unknown> {
  readonly '~standard': {
    readonly version: 1
    readonly validate: (value: unknown) => StandardSchemaResult<Output> | Promise<StandardSchemaResult<Output>>
  }
}

export function defineStandardSchema<Output>(
  validate: (value: unknown) => StandardSchemaResult<Output>,
): StandardSchemaV1<Output> {
  return { '~standard': { version: 1, validate } }
}
