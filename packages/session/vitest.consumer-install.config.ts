import { defaultExclude, defineConfig } from 'vitest/config'

// The only way to reach `test/consumer-install.proof.ts`. It is deliberately a
// SEPARATE config rather than an env flag inside the default run: the proof
// builds, packs and installs the whole workspace, and a flag is something a
// future story can set wrong and never notice. A file the default `include`
// cannot match is a gate with no switch to get wrong.
//
// `pnpm proof:consumer-install` at the repo root is what runs it.
export default defineConfig({
  test: {
    exclude: [...defaultExclude, '**/dist/**'],
    include: ['test/consumer-install.proof.ts'],
    // The build alone can take a minute from cold; everything expensive happens
    // once, in `beforeAll`.
    hookTimeout: 900_000,
    testTimeout: 300_000,
  },
})
