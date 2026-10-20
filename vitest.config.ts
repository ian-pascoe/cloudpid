import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // `.repos/` holds read-only reference clones with their own suites.
    exclude: [...configDefaults.exclude, ".repos/**", "tools/oxlint/anti-slop/**"],
    passWithNoTests: true,
  },
});
