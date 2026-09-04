import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { EXECUTOR_CATALOGUE } from '@panda/adapter-cli'
import { USAGE_ABSENCE_REASONS, isUsageReport, usageAbsence } from '@panda/contracts'
import type { UsageReport } from '@panda/contracts'

// The recorded side of Story M15.A's D7.
//
// A quota reading arrives DURING a real invocation, so a report that took one
// would cost the user the very thing it reports on — and would be unrunnable on
// exactly the day they most want it. So the run that already paid for the number
// writes it down, and the report reads what was written. Writing it costs
// nothing more, and the report answers instantly and offline.
//
// What is stored is an OBSERVATION, not a measurement panda owns: the vendor's
// own window names, the vendor's own numbers, plus the instant panda read them.
// A utilisation is only true as of its reading.

const STORE_VERSION = 1

/** Where the observations live: panda's own directory, one document. */
export function usageObservationsPath(homeDir: string = homedir()): string {
  return join(homeDir, '.panda', 'usage-observations.json')
}

export interface UsageStoreOptions {
  /** Root of the machine scope; `<homeDir>/.panda` is panda's own directory. */
  readonly homeDir?: string
}

interface StoredDocument {
  readonly version: number
  readonly reports: Record<string, UsageReport>
}

/**
 * What the document holds, keyed by executor id, or an empty map.
 *
 * Unreadable, unparseable, or stamped with a version this build does not speak
 * all mean the same thing here and it is not a failure: panda has no observation
 * to report, which `readUsageReports` already states as typed absence. This is a
 * CACHE of readings panda can take again by running; refusing to answer because
 * of it would be the report failing over its own bookkeeping.
 */
async function readStored(path: string): Promise<Record<string, UsageReport>> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return {}
  }
  const document = parsed as Partial<StoredDocument> | null
  if (document === null || typeof document !== 'object' || document.version !== STORE_VERSION) return {}
  const reports = document.reports
  if (reports === null || typeof reports !== 'object') return {}
  const kept: Record<string, UsageReport> = {}
  for (const [executorId, report] of Object.entries(reports)) {
    // Per ENTRY, not per document: one record panda can no longer understand
    // must not throw away the others beside it.
    if (isUsageReport(report) && report.executorId === executorId) kept[executorId] = report
  }
  return kept
}

/**
 * Writes down what one run observed, replacing that executor's previous reading.
 *
 * One reading per executor and no history: the question `panda status` answers is
 * "how much is left", which only the NEWEST reading answers. A log of past
 * utilisations is a different feature, and nothing reads it.
 *
 * ponytail: read-modify-write, not atomic. Two `panda run` invocations finishing
 * in the same instant can lose one of the two observations, which costs a stale
 * row until the next run. Upgrade path: write to a sibling temp file and rename,
 * the way `@panda/projection` writes ledgers, if concurrent runs become normal.
 */
export async function recordUsageObservation(report: UsageReport, options: UsageStoreOptions = {}): Promise<void> {
  const path = usageObservationsPath(options.homeDir)
  const reports = { ...(await readStored(path)), [report.executorId]: report }
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify({ version: STORE_VERSION, reports }, null, 2)}\n`, 'utf8')
}

/**
 * One report per executor panda ships, in catalogue order. Reads only; it
 * invokes nothing and writes nothing (D6/D7).
 *
 * Three answers, and every one of them is TYPED (AD-5). There is deliberately no
 * fourth answer in which a row is blank or reads `0`: a zero for an executor
 * panda cannot measure is worse than no row, because it looks like a measurement
 * that was taken.
 */
export async function readUsageReports(options: UsageStoreOptions = {}): Promise<readonly UsageReport[]> {
  const stored = await readStored(usageObservationsPath(options.homeDir))
  return [...EXECUTOR_CATALOGUE.entries()].map(([executorId, shipped]) => {
    // Derived from the trait record rather than from a list of executor names
    // written beside it — the parallel-name-list defect this repo has already
    // shipped once. An executor gains a quota row by declaring a surface.
    if (shipped.traits.output.usageWindows === undefined) {
      return usageAbsence(
        executorId,
        USAGE_ABSENCE_REASONS.noUsageSurface,
        `executor '${executorId}' publishes no usage surface in its output, so panda has no reading to report for it`,
      )
    }
    return (
      stored[executorId] ??
      usageAbsence(
        executorId,
        USAGE_ABSENCE_REASONS.notObserved,
        // Deliberately does NOT open with panda's own name. The sentence is a
        // template literal, and packages/cli/test/printed-commands.test.ts reads
        // an opening backtick followed by that name as a COMMAND — so a sentence
        // beginning with it is scanned as a verb that does not exist. Measured:
        // the earlier wording turned this into a fabricated two-word command and
        // reddened that invariant.
        //
        // The command this DOES name is backticked on purpose, so the same
        // invariant dispatches it and E4's exit cannot rot into prose.
        `no usage reading has been recorded for '${executorId}' yet; \`panda run "<prompt>" --executor ${executorId}\` records one`,
      )
    )
  })
}
