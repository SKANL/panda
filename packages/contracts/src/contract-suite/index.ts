export {
  type Clause,
  type ClauseOutcome,
  type ClauseResult,
  type ClauseViolation,
  type RunOptions,
  type SuiteReport,
  DEFAULT_CLAUSE_TIMEOUT_MS,
} from './clause'
export {
  CONTRACT_PROBE_REQUEST,
  CONTRACT_PROBE_WORKSPACE_HANDLE,
  EXECUTOR_CLAUSES,
  EXECUTOR_SUITE,
} from './executor-clauses'
export { WORKSPACE_CLAUSES, WORKSPACE_SUITE } from './workspace-clauses'

import { runClauses } from './clause'
import { EXECUTOR_CLAUSES, EXECUTOR_SUITE } from './executor-clauses'
import { WORKSPACE_CLAUSES, WORKSPACE_SUITE } from './workspace-clauses'
import type { ExecutorAdapter } from '../executor'
import type { RunOptions, SuiteReport } from './clause'
import type { WorkspaceProvider } from '../workspace'

// Aggregate runners: execute every clause and report each violation by name.
// A partially-implemented adapter fails naming EVERY violated clause.

export function runExecutorContractSuite(adapter: ExecutorAdapter, options?: RunOptions): Promise<SuiteReport> {
  return runClauses(EXECUTOR_SUITE, EXECUTOR_CLAUSES, adapter, options)
}

export function runWorkspaceContractSuite(provider: WorkspaceProvider, options?: RunOptions): Promise<SuiteReport> {
  return runClauses(WORKSPACE_SUITE, WORKSPACE_CLAUSES, provider, options)
}
