import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProjectionConfigTarget, ProjectionMaterialiseTarget } from '@panda/contracts'
import {
  CLAUDE_MCP_TARGET_ID,
  CLAUDE_SKILLS_TARGET_ID,
  CODEX_CONFIG_TARGET_ID,
  CODEX_SKILLS_TARGET_ID,
  OPENCODE_CONFIG_TARGET_ID,
  OPENCODE_SKILLS_TARGET_ID,
  createClaudeMcpTarget,
  createClaudeSkillsTarget,
  createCodexConfigTarget,
  createCodexSkillsTarget,
  createOpenCodeConfigTarget,
  createOpenCodeSkillsTarget,
} from '@panda/projection'

// Which executors this machine has, and where panda projects into each of them.
//
// DETECTION IS FILESYSTEM EVIDENCE, NEVER A PROBE. An executor counts as
// present when a configuration location it reads exists on disk. Running its
// binary would be slower, can hang, and has side effects panda has no business
// causing — and it answers a different question than the one being asked, which
// is "does this machine have a configuration for this executor to read". Every
// path consulted is reported with its verdict, so a user who disagrees with the
// answer can see exactly what was looked at rather than being told a conclusion.
//
// ponytail: filesystem evidence has a known ceiling — an executor INSTALLED but
// never run has no configuration yet and reads as absent, and an executor
// uninstalled after it ran reads as present. Both are visible in the reported
// evidence rather than hidden behind a verdict. Upgrade path: probing the binary,
// which is Ask-First in this story's Boundaries because it is slow, can hang, and
// has side effects (deferred-work.md).
//
// WHERE PANDA WRITES IS NOT DECIDED HERE. correction-01 governs that, and this
// file only repeats its verified locations: `machineConfig` mirrors each
// target's own `defaultPath` (asserted against the shipped traits in
// `test/executors.test.ts`, so the two cannot drift), and `projectConfig` exists
// only where correction-01 verified a project-scope location — Claude Code's
// `<project>/.mcp.json`, which is the same `{mcpServers}` shape with an injected
// path, and OpenCode's `opencode.json`, which correction-01 names without
// pinning a directory precisely because it is read from the project root too.
// Codex has no project-scope configuration, so panda invents none: `project
// init` reports it as skipped rather than writing somewhere Codex never reads.
//
// SKILLS are a second surface with the same rule and a harder proof. Each
// `machineSkills` root mirrors the skills target's own `defaultRoot` — asserted
// against the SHIPPED trait records in `test/skills.test.ts`, which is the link
// that makes the live proof carry: that proof measures `defaultRoot`, panda
// writes at `machineSkills(homeDir)`, and without an assertion tying the two
// strings together the chain from "the binary confirmed this location" to "this
// is where panda writes" is broken. Every one of the three roots was verified BY
// EXECUTION against the real binary under an injected
// home — see the comment on `@panda/projection`'s `targets/skills.ts` for what
// each executor was asked and what it answered. An executor with no verified
// root would carry `machineSkills: undefined` and go on reporting its skills
// unprojectable; that branch is exercised at project scope, where none of the
// three has a verified location because materialising into a project is
// Ask-First in this story's Boundaries.

/**
 * One filesystem location consulted for an executor, and what was found.
 *
 * `exists` is deliberately THREE-valued. Collapsing "panda could not look" into
 * "absent" makes the no-executor exit tell a user that nothing is installed
 * when the truth is that a permission error, a dangling link or an ELOOP stopped
 * the check — and it fails in the direction that hides a config panda would
 * otherwise have written to.
 */
export interface EvidencePath {
  readonly path: string
  /** true present · false definitively absent · undefined could not determine. */
  readonly exists: boolean | undefined
  /** errno behind an `undefined` verdict; absent otherwise. */
  readonly error?: string
}

export interface ExecutorDetection {
  readonly executorId: string
  /** The projection target this executor is served by, present or not. */
  readonly targetId: string
  /** True only where an evidence path was OBSERVED to exist. Nothing else sets it. */
  readonly present: boolean
  readonly evidence: readonly EvidencePath[]
}

export interface ExecutorProfile {
  readonly executorId: string
  readonly targetId: string
  /** Consulted in order; any hit makes the executor present. */
  readonly evidencePaths: (homeDir: string) => readonly string[]
  readonly machineConfig: (homeDir: string) => string
  /** Absent when the vendor has no verified project-scope configuration. */
  readonly projectConfig: ((projectDir: string) => string) | undefined
  readonly createTarget: (filePath: string) => ProjectionConfigTarget
  /**
   * The skills root panda has VERIFIED this executor reads, or `undefined`.
   *
   * Undefined is the honest answer, not a gap: an executor whose skills
   * location panda has not proven by running the real binary reports its skills
   * unprojectable, exactly as before this story. There is no project-scope
   * entry here at all for the same reason — materialising into a project scope
   * is Ask-First in this story's Boundaries, so `panda project init` reports
   * skills unprojectable rather than inventing a second location.
   */
  readonly machineSkills: ((homeDir: string) => string) | undefined
  readonly skillsTargetId: string | undefined
  readonly createSkillsTarget: ((rootPath: string) => ProjectionMaterialiseTarget) | undefined
}

export const EXECUTOR_PROFILES: readonly ExecutorProfile[] = [
  {
    executorId: 'claude-code',
    targetId: CLAUDE_MCP_TARGET_ID,
    // `~/.claude` is the directory Claude Code creates for itself; `~/.claude.json`
    // is the file it reads MCP servers from. Either one is evidence it has run
    // here. The home directory itself is deliberately not evidence — it exists on
    // every machine and would make detection answer "yes" unconditionally.
    evidencePaths: (homeDir) => [join(homeDir, '.claude.json'), join(homeDir, '.claude')],
    machineConfig: (homeDir) => join(homeDir, '.claude.json'),
    projectConfig: (projectDir) => join(projectDir, '.mcp.json'),
    createTarget: (filePath) => createClaudeMcpTarget({ filePath }),
    machineSkills: (homeDir) => join(homeDir, '.claude', 'skills'),
    skillsTargetId: CLAUDE_SKILLS_TARGET_ID,
    createSkillsTarget: (rootPath) => createClaudeSkillsTarget({ rootPath }),
  },
  {
    executorId: 'codex',
    targetId: CODEX_CONFIG_TARGET_ID,
    // ponytail: no `projectConfig`, because Codex reads MCP servers from
    // `~/.codex/config.toml` alone — correction-01 verified no project-scope
    // location, and panda does not invent one. Consequence, reported per run
    // rather than silent: `panda project init` cannot bind Codex to a project.
    // Upgrade path: a verified per-project Codex config, if Codex grows one.
    evidencePaths: (homeDir) => [join(homeDir, '.codex', 'config.toml'), join(homeDir, '.codex')],
    machineConfig: (homeDir) => join(homeDir, '.codex', 'config.toml'),
    projectConfig: undefined,
    createTarget: (filePath) => createCodexConfigTarget({ filePath }),
    machineSkills: (homeDir) => join(homeDir, '.codex', 'skills'),
    skillsTargetId: CODEX_SKILLS_TARGET_ID,
    createSkillsTarget: (rootPath) => createCodexSkillsTarget({ rootPath }),
  },
  {
    executorId: 'opencode',
    targetId: OPENCODE_CONFIG_TARGET_ID,
    evidencePaths: (homeDir) => [
      join(homeDir, '.config', 'opencode', 'opencode.json'),
      join(homeDir, '.config', 'opencode'),
    ],
    machineConfig: (homeDir) => join(homeDir, '.config', 'opencode', 'opencode.json'),
    projectConfig: (projectDir) => join(projectDir, 'opencode.json'),
    createTarget: (filePath) => createOpenCodeConfigTarget({ filePath }),
    machineSkills: (homeDir) => join(homeDir, '.config', 'opencode', 'skills'),
    skillsTargetId: OPENCODE_SKILLS_TARGET_ID,
    createSkillsTarget: (rootPath) => createOpenCodeSkillsTarget({ rootPath }),
  },
]

async function evidenceFor(path: string): Promise<EvidencePath> {
  try {
    await stat(path)
    return { path, exists: true }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    // ENOENT and ENOTDIR are the two definitive absences: the path is not there,
    // or a component of it is a file. Every other errno — EACCES, EPERM, ELOOP,
    // an unreadable home — is panda unable to LOOK, which is a different fact
    // and is reported as one.
    if (code === 'ENOENT' || code === 'ENOTDIR') return { path, exists: false }
    return { path, exists: undefined, error: code ?? String(error) }
  }
}

/**
 * Every executor panda knows about, whether it was found, and the exact paths
 * consulted for each. Returns the FULL catalogue on purpose: a run that detects
 * nothing has to be able to tell the user what was looked for and where, and a
 * list that omitted the misses could not.
 */
export async function detectExecutors(homeDir: string): Promise<ExecutorDetection[]> {
  return await Promise.all(
    EXECUTOR_PROFILES.map(async (profile) => {
      const evidence = await Promise.all(profile.evidencePaths(homeDir).map(evidenceFor))
      return {
        executorId: profile.executorId,
        targetId: profile.targetId,
        present: evidence.some((candidate) => candidate.exists === true),
        evidence,
      }
    }),
  )
}
