import { homedir } from 'node:os'
import { PANDA_ERROR_CODES, PandaError } from '@panda/contracts'
import type { IngestOutcome } from '@panda/contracts'
import { ProjectionLedger, SKILL_ENTRY_FILE } from '@panda/projection'
import { createMachineSkillsSource, ingestProviders } from '@panda/registry'
import type { SkillsSourceWarning } from '@panda/registry'
import { EXECUTOR_PROFILES } from './executors.ts'
import { scopeDirectory, storeFor } from './init.ts'

// `panda ingest`'s capability half: the first production caller of
// `ingestProviders`, which shipped finished with none.
//
// THIS FILE EXISTS BECAUSE THE SOURCE CANNOT REACH ITS OWN PRECONDITIONS.
// `@panda/registry` sits BELOW `@panda/projection` in AD-2's topology, so the
// filesystem `SkillSource` can know neither what the projection calls a skill's
// entry file nor which paths panda's ownership ledger already claims. Both come
// from here, where both packages are already declared dependencies — this is the
// wiring tier, and wiring is all this does.
//
// THE HAZARD IT CLOSES, and the reason a naive directory read would be wrong:
// panda PROJECTS skills INTO `~/.claude/skills`. Reading that directory reads
// panda's own output, so without the ledger every run would grow the registry
// with a copy of its own projection and the second run would differ from the
// first. That makes the ledger a PRECONDITION rather than a refinement: a ledger
// panda cannot read is a refusal, not a degraded run.

/** Which candidate the ingest looked at and did not contribute, and why. */
export type MachineSkillsSkip = SkillsSourceWarning

export interface IngestMachineSkillsOptions {
  /** Defaults to the OS home directory, like every other machine-scope command. */
  readonly homeDir?: string
  /**
   * Decide everything a writing run decides and write nothing.
   *
   * Forwarded to the ONE `ingestProviders` call rather than answered by a second
   * pass here: a preview computed by different code than the write is a preview
   * that can lie.
   */
  readonly dryRun?: boolean
}

export interface MachineSkillsIngest {
  readonly homeDir: string
  /** The machine registry document the run wrote to, or would have. */
  readonly registryPath: string
  /** The verified roots consulted, in the order the executor profiles declare. */
  readonly roots: readonly string[]
  readonly dryRun: boolean
  readonly outcome: IngestOutcome
  /** Candidates skipped: not a skill, an unusable id, or an ambiguous one. */
  readonly skipped: readonly MachineSkillsSkip[]
  /** Directories left alone because panda's own ledger claims them (D3). */
  readonly ownedByPanda: readonly string[]
}

/**
 * Puts the skills already on this machine into the machine registry.
 *
 * Additive, exactly as the `SkillSource` port documents: an entry an origin
 * stops listing is left in the registry untouched, and nothing is ever removed.
 * Pruning is a separate decision and is deliberately not made here.
 */
export async function ingestMachineSkills(
  options: IngestMachineSkillsOptions = {},
): Promise<MachineSkillsIngest> {
  const dryRun = options.dryRun === true
  // The same trust boundary every other machine-scope command applies, and the
  // same `homedir()` call: a second spelling of "the home directory" is how two
  // commands come to disagree about which registry they are talking about.
  const home = await scopeDirectory('the home directory', options.homeDir ?? homedir())

  const ledger = new ProjectionLedger({ homeDir: home })
  const read = await ledger.read()
  if (read.state === 'unreadable') {
    // BEFORE the roots are even listed, let alone written. Without the ledger
    // panda cannot tell its own projections apart from a user's skills, and
    // ingesting panda's own output is worse than not ingesting at all — so this
    // is a refusal rather than a run that proceeds with a weaker guarantee.
    throw new PandaError(
      PANDA_ERROR_CODES.projectionLedgerUnavailable,
      // Deliberately not opened with the word `panda`: `test/printed-commands.ts`
      // treats a backtick-quoted string that starts that way as a COMMAND, and
      // this is a sentence.
      `refusing to ingest without the ownership ledger, because without it panda cannot tell its own projections from your skills: ${read.warnings.map((warning) => warning.detail).join('; ')}`,
    )
  }
  const ownedPaths = read.records.flatMap((record) =>
    (record.ownedPaths ?? []).map((owned) => owned.path),
  )

  // `machineSkills`, and nothing else. Every one of these was verified by running
  // the real binary under an injected home; an executor whose skills location
  // panda has NOT proven carries `undefined` and contributes no root, which is
  // the honest answer rather than a location panda invented.
  const roots = EXECUTOR_PROFILES.flatMap((profile) =>
    profile.machineSkills === undefined ? [] : [profile.machineSkills(home)],
  )

  const source = createMachineSkillsSource({ roots, entryFileName: SKILL_ENTRY_FILE, ownedPaths })
  const store = storeFor('machine', home, home)
  try {
    const outcome = await ingestProviders(store, { skillSources: [source], dryRun })
    return {
      homeDir: home,
      registryPath: store.storePath('global'),
      roots,
      dryRun,
      outcome,
      skipped: [...source.warnings],
      ownedByPanda: [...source.excluded],
    }
  } finally {
    await store.dispose()
  }
}
