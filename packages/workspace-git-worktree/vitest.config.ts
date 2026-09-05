import { defaultExclude, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // vitest 4 dropped `**/dist/**` from `defaultExclude` (2 and 3 carried it).
    exclude: [...defaultExclude, '**/dist/**'],
    // EVERY test in this package drives the real `git` binary — that is the
    // point of the package, and it is not the exception here, it is the rule.
    // One `git worktree add` costs a few hundred milliseconds on Windows, the
    // contract suite runs eight clauses that each spawn several, and under
    // `pnpm check` all the packages run at once. Measured past the 5s default
    // there while passing comfortably alone, which is the shape of a timeout
    // that is too tight rather than a test that is too slow.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
  // `@skanl/panda-*` resolves to SOURCE inside this repository through one custom
  // export condition, the same name `tsconfig.base.json` sets. Under `ssr`, not
  // `resolve`: vitest 4 drives the node environment through the SSR pipeline.
  ssr: { resolve: { conditions: ['panda-source'] } },
})
