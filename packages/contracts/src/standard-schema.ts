// Canonical in-repo Standard Schema v1 surface. @skanl/panda-contracts has zero runtime
// dependencies, so the spec's interfaces are reproduced structurally here; schema
// libraries (Zod 4, Valibot, ...) interoperate through `~standard` without this
// package depending on any of them.

export interface StandardSchemaIssue {
  readonly message: string
  /**
   * Where in the validated value the issue is, as Standard Schema defines it.
   *
   * DUPLICATED with `packages/kernel/src/manifest.ts`, deliberately and for the
   * same reason the semver pattern is: AD-1 forbids the kernel a runtime
   * dependency on this package. Panda's own schemas are hand-written and bake
   * the coordinate into the message (`artifacts[0]`), so they carry none; a
   * third party's Zod or Valibot schema populates it, and since M7.C the kernel
   * APPLIES a plugin's schema, which is what gives this field a reader.
   */
  readonly path?: readonly (string | number)[]
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
