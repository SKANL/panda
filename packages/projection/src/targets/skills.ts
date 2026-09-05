import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type {
  ProjectionMaterialiseEntry,
  ProjectionMaterialiseFile,
  ProjectionMaterialisePlan,
  ProjectionMaterialiseRequest,
  ProjectionMaterialiseTarget,
  ProjectionSkip,
} from '@skanl/panda-contracts'

// Skills materialisation, one trait record per executor.
//
// A skill is a directory `<root>/<id>/SKILL.md`, and all three shipped
// executors read exactly that shape. VERIFIED BY EXECUTION against each real
// binary, not by reading a document — `test/skills-discovery.live.test.ts`
// plants a skill through panda under an injected home and then asks the
// executor itself what it found:
//
//   claude-code  `<home>/.claude/skills`
//                measured by pointing `ANTHROPIC_BASE_URL` at a local stub and
//                reading the request claude sends: the planted skill is in its
//                own `available skills` block. The executor declares what it
//                discovered, so nothing is inferred.
//   codex        `<home>/.codex/skills`
//                measured with `codex debug prompt-input`, which renders the
//                model-visible prompt and names the planted SKILL.md by path.
//   opencode     `<home>/.config/opencode/skills`
//                measured with `opencode debug skill`, which lists every skill
//                it can see with the absolute location it loaded each from.
//                Note the PLURAL directory name; `skill` is the command, not
//                the folder.
//
// What is deliberately NOT here: OpenCode's `skills.paths[]`. Story 2.9's
// inherited criteria named "a directory plus its `skills.paths[]` entry", and
// the installed `opencode.json` has no `skills` key at all — OpenCode finds this
// root by convention. Writing that key would be panda inventing vocabulary at a
// location the vendor does not read, which is the whole of correction-01.
//
// Panda COPIES; it never authors. A registry skill entry carries `entryPath`, a
// POINTER, and what that points at is placed verbatim.

/** The file name every one of the three executors requires. */
export const SKILL_ENTRY_FILE = 'SKILL.md'

export interface SkillsTargetTraits {
  readonly targetId: string
  /** Absolute machine-scope root, used when the caller injects none. */
  readonly defaultRoot: string
}

export interface SkillsTargetOptions {
  /** Overrides the trait record's defaultRoot (default roots are injectable). */
  readonly rootPath?: string
}

export const CLAUDE_SKILLS_TARGET_ID = 'claude-skills'
export const CODEX_SKILLS_TARGET_ID = 'codex-skills'
export const OPENCODE_SKILLS_TARGET_ID = 'opencode-skills'

export const CLAUDE_SKILLS_TRAITS: SkillsTargetTraits = {
  targetId: CLAUDE_SKILLS_TARGET_ID,
  defaultRoot: join(homedir(), '.claude', 'skills'),
}

export const CODEX_SKILLS_TRAITS: SkillsTargetTraits = {
  targetId: CODEX_SKILLS_TARGET_ID,
  defaultRoot: join(homedir(), '.codex', 'skills'),
}

export const OPENCODE_SKILLS_TRAITS: SkillsTargetTraits = {
  targetId: OPENCODE_SKILLS_TARGET_ID,
  defaultRoot: join(homedir(), '.config', 'opencode', 'skills'),
}

/**
 * Whether an id can be one directory name under the root.
 *
 * A registry id is an arbitrary non-empty string, and this is the projection
 * that turns one into a PATH. Without this, `../../.ssh` in an id would make
 * panda write — and later delete — outside the root it owns. The engine repeats
 * the containment check on the resolved path; this one exists so the entry is
 * REPORTED with a reason rather than failing the whole target.
 */
function isSafeSegment(id: string): boolean {
  // The dot-only case covers `.`, `..` and `...`: the first two are the obvious
  // traversal, and the third reached the engine's containment guard as a THROWN
  // target failure, so one oddly named skill unmaterialised every skill for
  // that executor instead of being reported as one entry.
  return /^[A-Za-z0-9._-]+$/.test(id) && !/^[.]+$/.test(id)
}

/** A source panda can see and still cannot materialise; reported, never guessed at. */
class SourceUnusable extends Error {}

async function collectFiles(directory: string, prefix: string): Promise<ProjectionMaterialiseFile[]> {
  const files: ProjectionMaterialiseFile[] = []
  // Sorted, so the same source tree always plans in the same order and the tree
  // hash of an unchanged skill is stable across runs and machines.
  const listing = [...(await readdir(directory, { withFileTypes: true }))].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )
  for (const item of listing) {
    const source = join(directory, item.name)
    // `stat`, not the dirent's own kind: a symlink inside a skill is followed,
    // because copying what a link points at is what "copy this tree" means. The
    // DESTINATION is always built from the root and the relative path, so a link
    // aimed anywhere can still only land inside panda's own directory.
    const stats = await stat(source)
    if (stats.isDirectory()) {
      files.push(...(await collectFiles(source, `${prefix}/${item.name}`)))
    } else if (stats.isFile()) {
      files.push({ relativePath: `${prefix}/${item.name}`, sourcePath: resolve(source) })
    }
  }
  return files
}

/**
 * The files one registry entry contributes.
 *
 * `entryPath` is documented as the skill's ENTRY FILE, and a file is placed as
 * the `SKILL.md` every executor looks for — panda renames the destination, it
 * never rewrites the content. A directory is copied whole, because a real skill
 * keeps references beside its entry file and copying only one of them would
 * materialise something that half works.
 */
async function filesFor(entryPath: string, id: string): Promise<readonly ProjectionMaterialiseFile[]> {
  const source = resolve(entryPath)
  const stats = await stat(source)
  if (stats.isFile()) return [{ relativePath: `${id}/${SKILL_ENTRY_FILE}`, sourcePath: source }]
  if (!stats.isDirectory()) {
    throw new SourceUnusable(`'${entryPath}' is neither a file nor a directory`)
  }
  return await collectFiles(source, id)
}

export function createSkillsTargetFromTraits(
  traits: SkillsTargetTraits,
  options: SkillsTargetOptions = {},
): ProjectionMaterialiseTarget {
  const rootPath = options.rootPath ?? traits.defaultRoot
  return {
    kind: 'materialise',
    targetId: traits.targetId,
    rootPath,
    async plan(request: ProjectionMaterialiseRequest): Promise<ProjectionMaterialisePlan> {
      const skills = [...request.entries.skill].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      const entries: ProjectionMaterialiseEntry[] = []
      const skipped: ProjectionSkip[] = []
      for (const entry of skills) {
        const reason = (detail: string): void => {
          skipped.push({ entryId: entry.id, reason: detail })
        }
        if (!isSafeSegment(entry.id)) {
          reason(
            `'${entry.id}' cannot be a directory name under '${rootPath}', so panda will not materialise it`,
          )
          continue
        }
        const entryPath = entry.entryPath
        if (entryPath === undefined) {
          reason(`the skill entry declares no entryPath, so there is nothing to copy into '${rootPath}'`)
          continue
        }
        let files: readonly ProjectionMaterialiseFile[]
        try {
          files = await filesFor(entryPath, entry.id)
        } catch (error) {
          const detail =
            error instanceof SourceUnusable
              ? error.message
              : `'${entryPath}' cannot be read (${(error as NodeJS.ErrnoException)?.code ?? 'unknown error'})`
          reason(`${detail}; nothing was materialised for '${entry.id}'`)
          continue
        }
        // A tree with no SKILL.md is a tree no executor discovers. Writing it
        // would be the inertness correction-01 exists to prevent, so it is
        // reported instead — panda does not author the missing file either.
        if (!files.some((file) => file.relativePath.endsWith(`/${SKILL_ENTRY_FILE}`))) {
          reason(
            `'${entryPath}' holds no ${SKILL_ENTRY_FILE}, so no executor would discover it; panda will not invent one`,
          )
          continue
        }
        entries.push({ entryId: entry.id, location: entry.id, files })
      }
      return { entries, presentEntryIds: skills.map((entry) => entry.id), skipped }
    },
  }
}

export function createClaudeSkillsTarget(options: SkillsTargetOptions = {}): ProjectionMaterialiseTarget {
  return createSkillsTargetFromTraits(CLAUDE_SKILLS_TRAITS, options)
}

export function createCodexSkillsTarget(options: SkillsTargetOptions = {}): ProjectionMaterialiseTarget {
  return createSkillsTargetFromTraits(CODEX_SKILLS_TRAITS, options)
}

export function createOpenCodeSkillsTarget(options: SkillsTargetOptions = {}): ProjectionMaterialiseTarget {
  return createSkillsTargetFromTraits(OPENCODE_SKILLS_TRAITS, options)
}
