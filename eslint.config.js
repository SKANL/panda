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
