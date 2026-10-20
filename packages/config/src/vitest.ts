import { configDefaults, defineConfig } from "vitest/config";

/** Shared Vitest base: each workspace package re-exports it from its own `vitest.config.ts`. */
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude],
    // Harness-level tests drive a real pi-durable Harness; under turbo's parallel CI runs they can exceed Vitest's
    // 5 s default without being stuck.
    testTimeout: 30_000,
  },
});
