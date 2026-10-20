import { configDefaults, defineConfig } from "vitest/config";

/** Shared Vitest base: each workspace package re-exports it from its own `vitest.config.ts`. */
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude],
  },
});
// x
