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
