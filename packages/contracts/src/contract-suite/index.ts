export {
  type Clause,
  type ClauseOutcome,
  type ClauseResult,
  type ClauseViolation,
  type RunOptions,
  type SuiteReport,
  DEFAULT_CLAUSE_TIMEOUT_MS,
} from './clause.ts'
export {
  CONTRACT_PROBE_REQUEST,
  CONTRACT_PROBE_WORKSPACE_HANDLE,
  EXECUTOR_CLAUSES,
  EXECUTOR_SUITE,
} from './executor-clauses.ts'
export { WORKSPACE_CLAUSES, WORKSPACE_SUITE } from './workspace-clauses.ts'
export { MEMORY_CLAUSES, MEMORY_SUITE, type MemoryContractHarness } from './memory-clauses.ts'

import { runClauses } from './clause.ts'
import { EXECUTOR_CLAUSES, EXECUTOR_SUITE } from './executor-clauses.ts'
import { MEMORY_CLAUSES, MEMORY_SUITE } from './memory-clauses.ts'
import { WORKSPACE_CLAUSES, WORKSPACE_SUITE } from './workspace-clauses.ts'
import type { ExecutorAdapter } from '../executor.ts'
import type { RunOptions, SuiteReport } from './clause.ts'
import type { MemoryContractHarness } from './memory-clauses.ts'
import type { WorkspaceProvider } from '../workspace.ts'

// Aggregate runners: execute every clause and report each violation by name.
// A partially-implemented adapter fails naming EVERY violated clause.

export function runExecutorContractSuite(adapter: ExecutorAdapter, options?: RunOptions): Promise<SuiteReport> {
  return runClauses(EXECUTOR_SUITE, EXECUTOR_CLAUSES, adapter, options)
}

export function runWorkspaceContractSuite(provider: WorkspaceProvider, options?: RunOptions): Promise<SuiteReport> {
  return runClauses(WORKSPACE_SUITE, WORKSPACE_CLAUSES, provider, options)
}

/**
 * The memory runner folds the harness's `providerName` into every violation
 * detail. FR-16 ships TWO providers against ONE clause array, so a red clause
 * that does not say which provider broke is a report the reader has to guess at.
 */
export async function runMemoryContractSuite(
  harness: MemoryContractHarness,
  options?: RunOptions,
): Promise<SuiteReport> {
  const report = await runClauses(MEMORY_SUITE, MEMORY_CLAUSES, harness, options)
  const name = (detail: string): string => `[${harness.providerName}] ${detail}`
  return {
    ...report,
    outcomes: report.outcomes.map((outcome) =>
      outcome.passed || outcome.detail === undefined ? outcome : { ...outcome, detail: name(outcome.detail) },
    ),
    violations: report.violations.map((violation) => ({ ...violation, detail: name(violation.detail) })),
  }
}
