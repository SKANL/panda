import type { StandardSchemaIssue } from './standard-schema'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export function issue(message: string): StandardSchemaIssue {
  return { message }
}
