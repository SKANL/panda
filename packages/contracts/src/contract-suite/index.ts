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

import { runClauses } from './clause.ts'
import { EXECUTOR_CLAUSES, EXECUTOR_SUITE } from './executor-clauses.ts'
import { WORKSPACE_CLAUSES, WORKSPACE_SUITE } from './workspace-clauses.ts'
import type { ExecutorAdapter } from '../executor.ts'
import type { RunOptions, SuiteReport } from './clause.ts'
import type { WorkspaceProvider } from '../workspace.ts'

// Aggregate runners: execute every clause and report each violation by name.
// A partially-implemented adapter fails naming EVERY violated clause.

export function runExecutorContractSuite(adapter: ExecutorAdapter, options?: RunOptions): Promise<SuiteReport> {
  return runClauses(EXECUTOR_SUITE, EXECUTOR_CLAUSES, adapter, options)
}

export function runWorkspaceContractSuite(provider: WorkspaceProvider, options?: RunOptions): Promise<SuiteReport> {
  return runClauses(WORKSPACE_SUITE, WORKSPACE_CLAUSES, provider, options)
}
