import { configDefaults, defineConfig } from "vitest/config";

/**
 * Harness-level tests drive a real pi-durable Harness; under turbo's parallel CI runs they can exceed Vitest's 5 s default
 * without being stuck. Projects that do not merge the base (workerd ones) set it themselves.
 */
export const testTimeout = 30_000;

/** Shared Vitest base: each workspace package re-exports it from its own `vitest.config.ts`. */
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude],
    testTimeout,
  },
});
