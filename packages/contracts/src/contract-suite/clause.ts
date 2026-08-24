// Clause-decomposed contract harness. Each clause is an independently runnable,
// nameable check; the aggregate runner executes every clause (one clause's crash
// never hides another's verdict) and reports EVERY violated clause by name.

export const DEFAULT_CLAUSE_TIMEOUT_MS = 30_000

export interface ClauseOutcome {
  readonly ok: boolean
  readonly detail?: string
}

export function pass(): ClauseOutcome {
  return { ok: true }
}

export function failWith(detail: string): ClauseOutcome {
  return { ok: false, detail }
}

export interface Clause<TSubject> {
  readonly name: string
  readonly check: (subject: TSubject) => Promise<ClauseOutcome>
}

export interface ClauseViolation {
  readonly clause: string
  readonly detail: string
}

export interface ClauseResult {
  readonly clause: string
  readonly passed: boolean
  readonly detail?: string
  readonly durationMs: number
}

export interface SuiteReport {
  readonly suite: string
  readonly clauses: readonly string[]
  readonly passed: boolean
  readonly outcomes: readonly ClauseResult[]
  readonly violations: readonly ClauseViolation[]
}

export interface RunOptions {
  /** Per-clause time budget; expiry yields a named `<clause> (timeout)` violation. */
  readonly timeoutMs?: number
}

export function describeThrown(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

async function raceTimeout(
  attempt: Promise<ClauseOutcome>,
  timeoutMs: number,
  onTimeout: () => ClauseOutcome,
): Promise<ClauseOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      attempt,
      new Promise<ClauseOutcome>((resolve) => {
        timer = setTimeout(() => resolve(onTimeout()), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export async function runClauses<TSubject>(
  suite: string,
  clauses: readonly Clause<TSubject>[],
  subject: TSubject,
  options?: RunOptions,
): Promise<SuiteReport> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_CLAUSE_TIMEOUT_MS
  const outcomes: ClauseResult[] = []
  const violations: ClauseViolation[] = []
  for (const clause of clauses) {
    const startedAt = Date.now()
    let timedOut = false
    let outcome: ClauseOutcome
    try {
      outcome = await raceTimeout(clause.check(subject), timeoutMs, () => {
        timedOut = true
        return failWith(`clause exceeded the ${timeoutMs}ms time budget`)
      })
    } catch (error) {
      outcome = failWith(describeThrown(error))
    }
    const reportedName = timedOut ? `${clause.name} (timeout)` : clause.name
    const durationMs = Date.now() - startedAt
    outcomes.push({
      clause: reportedName,
      passed: outcome.ok,
      detail: outcome.ok ? outcome.detail : (outcome.detail ?? 'clause failed without detail'),
      durationMs,
    })
    if (!outcome.ok) {
      violations.push({
        clause: reportedName,
        detail: outcome.detail ?? 'clause failed without detail',
      })
    }
  }
  return {
    suite,
    clauses: clauses.map((clause) => clause.name),
    passed: violations.length === 0,
    outcomes,
    violations,
  }
}
