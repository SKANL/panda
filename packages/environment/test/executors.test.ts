import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { CLAUDE_MCP_TRAITS, CODEX_CONFIG_TRAITS, OPENCODE_CONFIG_TRAITS } from '@panda/projection'
import { describe, expect, it } from 'vitest'
import { EXECUTOR_PROFILES, detectExecutors } from '../src/executors.ts'

/**
 * The catalogue repeats each target's machine-scope path so it can be resolved
 * against an injected home directory, which the traits' module-level
 * `defaultPath` cannot do. A repeated constant is a constant that drifts, and
 * the failure it drifts into is this epic's signature one: panda writing into a
 * file the vendor never opens. So the repetition is pinned against the shipped
 * traits themselves rather than against a transcription of them.
 */
describe('the executor catalogue cannot drift from the shipped projection traits', () => {
  it('resolves each machine-scope path to the target default it mirrors', () => {
    const declared = new Map([
      [CLAUDE_MCP_TRAITS.targetId, CLAUDE_MCP_TRAITS.defaultPath],
      [CODEX_CONFIG_TRAITS.targetId, CODEX_CONFIG_TRAITS.defaultPath],
      [OPENCODE_CONFIG_TRAITS.targetId, OPENCODE_CONFIG_TRAITS.defaultPath],
    ])
    expect(EXECUTOR_PROFILES.map((profile) => profile.targetId).sort()).toEqual([...declared.keys()].sort())
    for (const profile of EXECUTOR_PROFILES) {
      expect(profile.machineConfig(homedir()), profile.executorId).toBe(declared.get(profile.targetId))
    }
  })

  it('builds a target that writes to the path it was given, not to the trait default', () => {
    for (const profile of EXECUTOR_PROFILES) {
      const target = profile.createTarget(join('somewhere', 'else.cfg'))
      expect(target.targetId).toBe(profile.targetId)
      expect(target.filePath).toBe(join('somewhere', 'else.cfg'))
    }
  })
})

describe('detection is filesystem evidence, and reports it', () => {
  it('finds nothing on a machine with nothing, and still names every path it looked at', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'panda-detect-'))
    const detected = await detectExecutors(homeDir)
    expect(detected.map((detection) => detection.executorId)).toEqual(['claude-code', 'codex', 'opencode'])
    for (const detection of detected) {
      expect(detection.present).toBe(false)
      expect(detection.evidence.length).toBeGreaterThan(0)
      for (const evidence of detection.evidence) {
        expect(evidence.exists).toBe(false)
        expect(evidence.path.startsWith(homeDir)).toBe(true)
      }
    }
  })

  it('counts an executor present on any one of its evidence paths, and says which', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'panda-detect-'))
    // Claude Code that has run but never written its MCP file; Codex found by
    // the config file itself. Two different shapes of the same evidence rule.
    await mkdir(join(homeDir, '.claude'), { recursive: true })
    await mkdir(join(homeDir, '.codex'), { recursive: true })
    await writeFile(join(homeDir, '.codex', 'config.toml'), '', 'utf8')

    const detected = await detectExecutors(homeDir)
    const claude = detected.find((detection) => detection.executorId === 'claude-code')
    expect(claude?.present).toBe(true)
    expect(claude?.evidence).toEqual([
      { path: join(homeDir, '.claude.json'), exists: false },
      { path: join(homeDir, '.claude'), exists: true },
    ])
    expect(detected.find((detection) => detection.executorId === 'codex')?.present).toBe(true)
    expect(detected.find((detection) => detection.executorId === 'opencode')?.present).toBe(false)
  })

  it('never treats the home directory itself as evidence', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'panda-detect-'))
    for (const profile of EXECUTOR_PROFILES) {
      expect(profile.evidencePaths(homeDir)).not.toContain(homeDir)
    }
  })
})

describe('detection distinguishes "absent" from "could not look"', () => {
  it('reports a path it could not check as undetermined, with the errno, and not as absent', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'panda-detect-'))
    // A symlink cycle: ELOOP. It stands in for the class — EACCES on a locked
    // home, EPERM, an unreadable mount — where stat fails for a reason that is
    // NOT "the path is not there". Collapsing those into `false` makes panda
    // tell a user nothing is installed when panda could not look.
    await symlink(join(homeDir, '.claude2'), join(homeDir, '.claude'))
    await symlink(join(homeDir, '.claude'), join(homeDir, '.claude2'))

    const claude = (await detectExecutors(homeDir)).find((item) => item.executorId === 'claude-code')
    expect(claude?.present).toBe(false)
    const cycled = claude?.evidence.find((item) => item.path === join(homeDir, '.claude'))
    expect(cycled?.exists).toBeUndefined()
    expect(cycled?.error).toBe('ELOOP')
    // And a genuinely missing sibling is still definitively absent.
    expect(claude?.evidence.find((item) => item.path.endsWith('.claude.json'))?.exists).toBe(false)
  })

  it('treats ENOTDIR as definitive absence: a file where a directory should be', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'panda-detect-'))
    // `~/.config` is a FILE, so `~/.config/opencode/opencode.json` cannot exist.
    await writeFile(join(homeDir, '.config'), 'not a directory', 'utf8')
    const opencode = (await detectExecutors(homeDir)).find((item) => item.executorId === 'opencode')
    expect(opencode?.present).toBe(false)
    for (const item of opencode?.evidence ?? []) expect(item.exists).toBe(false)
  })

  it('pins the evidence path VALUES for every executor, not just the one with fixtures', async () => {
    const homeDir = join('any', 'home')
    // Asserted against literals rather than against detection's own output: a
    // test that parses the paths back out of the result proves only that the
    // code agrees with itself, which is how a wrong path stays green.
    expect(EXECUTOR_PROFILES.map((profile) => [profile.executorId, ...profile.evidencePaths(homeDir)])).toEqual([
      ['claude-code', join(homeDir, '.claude.json'), join(homeDir, '.claude')],
      ['codex', join(homeDir, '.codex', 'config.toml'), join(homeDir, '.codex')],
      [
        'opencode',
        join(homeDir, '.config', 'opencode', 'opencode.json'),
        join(homeDir, '.config', 'opencode'),
      ],
    ])
    expect(EXECUTOR_PROFILES.map((profile) => profile.projectConfig?.(join('any', 'project')))).toEqual([
      join('any', 'project', '.mcp.json'),
      undefined,
      join('any', 'project', 'opencode.json'),
    ])
  })
})
