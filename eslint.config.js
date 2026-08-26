import eslint from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/',
      '**/dist/',
      '**/coverage/',
      '.git/',
      // Local tool index, like .scratch/: git-excluded, ships its own `*`
      // .gitignore, and is not project source.
      '.gitnexus/',
      '.scratch/',
      '_bmad/',
      '_bmad-output/',
    ],
  },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['**/*.config.{js,ts}', 'scripts/**/*.mjs'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // Repo-wide, because a cross-package RELATIVE import needs no manifest entry
    // and therefore no dependency test can see it. A working composition was
    // planted in @panda/cli through `../../workspace-local/src/index.ts` with the
    // whole gate green; this is the rule that rejects it, and it holds the same
    // line for every package (AD-2: the topology is manifests, not paths).
    files: ['packages/*/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: String.raw`^\.\.[\\/]\.\.`,
              message:
                'cross-package imports must use the workspace package name, never a relative path out of the package (AD-2)',
            },
          ],
        },
      ],
    },
  },
  {
    // `@panda/cli` is argv, formatting and exit codes. It has no business
    // touching the filesystem AT ALL — every path it names is handed to a
    // capability package, and the two it depends on do the reading.
    //
    // This is the structural half of the thin-binding pin. A reviewer planted a
    // complete, faithful executor-selection capability inside `run.ts` — its own
    // `['claude-code','codex','opencode']` literal list, its own layered file
    // reads, its own coded throws — deleted `resolveExecutor` from the imports,
    // and the WHOLE gate stayed green: the existing pin watches the dependency
    // list and `@panda/*` import specifiers, and owning selection needs neither,
    // only `node:fs/promises` and `node:path`. Config-driven selection cannot be
    // reimplemented here without a filesystem read, so forbidding the read is
    // what closes it — a text scan for composition vocabulary was already tried
    // and deleted on review for being evadable.
    //
    // The `../..` clause is repeated because a `no-restricted-imports` block
    // scoped to these files REPLACES the repo-wide one rather than adding to it.
    files: ['packages/cli/src/**/*.ts', 'packages/cli/bin/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'node:fs', message: '@panda/cli reads no files; the capability packages do (thin-binding pin)' },
            { name: 'node:fs/promises', message: '@panda/cli reads no files; the capability packages do (thin-binding pin)' },
            { name: 'fs', message: '@panda/cli reads no files; the capability packages do (thin-binding pin)' },
            { name: 'fs/promises', message: '@panda/cli reads no files; the capability packages do (thin-binding pin)' },
          ],
          patterns: [
            {
              regex: String.raw`^\.\.[\\/]\.\.`,
              message:
                'cross-package imports must use the workspace package name, never a relative path out of the package (AD-2)',
            },
            {
              // The thin-binding pin, made STRUCTURAL. It has now been defeated
              // twice by the same shape of move and never by a new idea: Story
              // 2.0 by relative cross-package imports (closed by the clause
              // above), and Story M3.B by RE-EXPORT — `@panda/session` briefly
              // re-exported `createKernel` and both plugin factories, and a
              // complete working session composition was planted in
              // `packages/cli/src/` importing only `@panda/session`, with
              // eslint, tsc and all 53 CLI assertions green. The dependency
              // test watches the manifest and the specifier scan watches the
              // package NAME; neither can see a capability that arrived through
              // a package the CLI is allowed to import.
              //
              // So the restriction is on the NAMES, from any `@panda/*` module.
              // Which package re-exports them stops mattering, which is the
              // property the two previous versions lacked.
              group: ['@panda/*'],
              importNames: [
                'createKernel',
                'createSessionKernel',
                'createExecutorPlugin',
                'createWorkspacePlugin',
                'createExecutorAdapter',
                'seedExecutorConfig',
                'selectExecutor',
                'EXECUTOR_CATALOGUE',
                'EXECUTOR_SERVICE',
                'WORKSPACE_SERVICE',
              ],
              message:
                '@panda/cli composes nothing: it may not hold a kernel, mount a plugin, resolve a service or build an adapter, whichever package re-exports the capability (thin-binding pin, AD-2)',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/kernel/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@panda/contracts', '@panda/contracts/*'],
              message: 'the kernel never imports @panda/contracts (AD-1)',
            },
            {
              regex: String.raw`^\.\.[\\/]\.\.`,
              message:
                'relative imports must stay inside @panda/kernel; cross-package imports are forbidden (AD-1)',
            },
          ],
        },
      ],
    },
  },
)
