import { homedir } from 'node:os'
import { PANDA_ERROR_CODES, PandaError } from '@panda/contracts'
import type { IngestOutcome } from '@panda/contracts'
import { ProjectionLedger, SKILL_ENTRY_FILE } from '@panda/projection'
import { createMachineMcpSource, createMachineSkillsSource, ingestProviders } from '@panda/registry'
import type {
  McpSourceDropped,
  McpSourceExclusion,
  McpSourceWarning,
  SkillsSourceWarning,
} from '@panda/registry'
import { EXECUTOR_PROFILES } from './executors.ts'
import { scopeDirectory, storeFor } from './init.ts'

// `panda ingest`'s capability half: the first production caller of
// `ingestProviders`, and — since M11.A — the first production caller to supply
// `toolProviders`, a port that shipped finished with no implementation at all.
//
// THIS FILE EXISTS BECAUSE NEITHER SOURCE CAN REACH ITS OWN PRECONDITIONS.
// `@panda/registry` sits BELOW `@panda/projection` in AD-2's topology, so the
// filesystem `SkillSource` can know neither what the projection calls a skill's
// entry file nor which paths panda's ownership ledger already claims, and the
// `ToolProvider` can know neither which vendor documents to read nor how to read
// one. All of it comes from here, where both packages are already declared
// dependencies — this is the wiring tier, and wiring is all this does.
//
// THE HAZARD IT CLOSES, and the reason a naive read would be wrong in both
// halves: panda PROJECTS skills INTO `~/.claude/skills` and MCP servers INTO
// `~/.claude.json`. Reading either reads panda's own output, so without the
// ledger every run would grow the registry with a copy of its own projection and
// the second run would differ from the first. That makes the ledger a
// PRECONDITION rather than a refinement — ONE read, covering both origins, before
// a single location of either kind is opened: a ledger panda cannot read is a
// refusal, not a degraded run.

/** Which skill candidate the ingest looked at and did not contribute, and why. */
export type MachineSkillsSkip = SkillsSourceWarning

/** Which server candidate the ingest looked at and did not contribute, and why. */
export type MachineMcpSkip = McpSourceWarning

export interface IngestMachineOptions {
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

/** The mcp-server half of one run, beside the skills half it shares a call with. */
export interface MachineMcpIngest {
  /** The verified vendor config locations consulted, in profile order. */
  readonly configPaths: readonly string[]
  /** Candidates skipped: unreadable, an unusable id, or an ambiguous one. */
  readonly skipped: readonly MachineMcpSkip[]
  /**
   * Servers left alone because panda's own ledger claims them (D3), each paired
   * with the `nativeLocation` that ledger record renders. The location is
   * REPORTED and is deliberately not the match key: it is a rendering of the
   * `targetId` and `entryId` that are, and matching on a rendering is how two
   * answers come to differ.
   */
  readonly ownedByPanda: readonly OwnedMcpEntry[]
  /** Vendor keys the registry envelope cannot carry, per ingested server (D10). */
  readonly dropped: readonly McpSourceDropped[]
}

export type OwnedMcpEntry = McpSourceExclusion

export interface MachineIngest {
  readonly homeDir: string
  /** The machine registry document the run wrote to, or would have. */
  readonly registryPath: string
  /** The verified skills roots consulted, in the order the profiles declare. */
  readonly roots: readonly string[]
  readonly dryRun: boolean
  readonly outcome: IngestOutcome
  /** Skill candidates skipped: not a skill, an unusable id, or an ambiguous one. */
  readonly skipped: readonly MachineSkillsSkip[]
  /** Skill directories left alone because panda's own ledger claims them (D3). */
  readonly ownedByPanda: readonly string[]
  /** The other half of the same run, reported so neither can go silent. */
  readonly mcpServers: MachineMcpIngest
}

/**
 * Puts the skills and the MCP servers already on this machine into the machine
 * registry, in ONE two-phase run over both origins.
 *
 * Additive, exactly as both ports document: an entry an origin stops listing is
 * left in the registry untouched, and nothing is ever removed. Pruning is a
 * separate decision and is deliberately not made here.
 */
export async function ingestMachine(options: IngestMachineOptions = {}): Promise<MachineIngest> {
  const dryRun = options.dryRun === true
  // The same trust boundary every other machine-scope command applies, and the
  // same `homedir()` call: a second spelling of "the home directory" is how two
  // commands come to disagree about which registry they are talking about.
  const home = await scopeDirectory('the home directory', options.homeDir ?? homedir())

  const ledger = new ProjectionLedger({ homeDir: home })
  const read = await ledger.read()
  if (read.state === 'unreadable') {
    // BEFORE the roots or the vendor documents are even listed, let alone
    // written. Without the ledger panda cannot tell its own projections apart
    // from your skills and your servers, and ingesting panda's own output is
    // worse than not ingesting at all — so this is a refusal rather than a run
    // that proceeds with a weaker guarantee.
    throw new PandaError(
      PANDA_ERROR_CODES.projectionLedgerUnavailable,
      // Deliberately not opened with the word `panda`: `test/printed-commands.ts`
      // treats a backtick-quoted string that starts that way as a COMMAND, and
      // this is a sentence.
      `refusing to ingest without the ownership ledger, because without it panda cannot tell its own projections from your skills and servers: ${read.warnings.map((warning) => warning.detail).join('; ')}`,
    )
  }
  const ownedPaths = read.records.flatMap((record) =>
    (record.ownedPaths ?? []).map((owned) => owned.path),
  )
  // ONE ledger read serves both origins. `targetId` + `entryId` is the match
  // key; the `nativeLocation` beside it is carried into the report only.
  const ownedEntries = read.records.map((record) => ({
    targetId: record.targetId,
    entryId: record.entryId,
    nativeLocation: record.nativeLocation,
  }))

  // `machineSkills` and `machineConfig`, and nothing else. Every one of these was
  // verified by running the real binary under an injected home; an executor whose
  // skills location panda has NOT proven carries `undefined` and contributes no
  // root, which is the honest answer rather than a location panda invented.
  const roots = EXECUTOR_PROFILES.flatMap((profile) =>
    profile.machineSkills === undefined ? [] : [profile.machineSkills(home)],
  )
  const locations = EXECUTOR_PROFILES.map((profile) => {
    const filePath = profile.machineConfig(home)
    return { targetId: profile.targetId, filePath, read: async () => await profile.readMcpEntries(filePath) }
  })

  const skills = createMachineSkillsSource({ roots, entryFileName: SKILL_ENTRY_FILE, ownedPaths })
  const servers = createMachineMcpSource({ locations, ownedEntries })
  const store = storeFor('machine', home, home)
  try {
    // ONE call, both origins, one `dryRun`. Splitting it would give the two
    // halves two chances to disagree about a store they both write to.
    const outcome = await ingestProviders(store, {
      toolProviders: [servers],
      skillSources: [skills],
      dryRun,
    })
    return {
      homeDir: home,
      registryPath: store.storePath('global'),
      roots,
      dryRun,
      outcome,
      skipped: [...skills.warnings],
      ownedByPanda: [...skills.excluded],
      mcpServers: {
        configPaths: locations.map((location) => location.filePath),
        skipped: [...servers.warnings],
        // Already whole: the source echoes back the ledger record it matched,
        // so the location reported beside an exclusion is by construction the
        // one that caused it, with no second lookup that could miss.
        ownedByPanda: [...servers.excluded],
        dropped: [...servers.dropped],
      },
    }
  } finally {
    await store.dispose()
  }
}
