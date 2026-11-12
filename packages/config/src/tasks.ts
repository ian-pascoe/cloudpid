// Every workspace package's `typecheck` and `test` tasks for Vite+'s task runner (`vp run`; docs/adr/0055-vite-plus-
// and-pnpm.md). Each package's `vite.config.ts` passes them to `run.tasks`. Tasks, not `package.json` scripts, so they are
// cached and say which environment variables a test reads: a cached task runs in a clean environment, with only the
// variables its `cache` names.
import type { UserConfig } from "vite-plus";

type Tasks = NonNullable<NonNullable<UserConfig["run"]>["tasks"]>;

/**
 * Variables that change what a test checks, so a change to one misses the cache: under `CI`, the Container's scripts'
 * tests never skip for a missing Linux tool; `MODEL_PROXY_URL`, `WEB_TOOLS_LIVE` and `VISUAL_LIBS_CHECK` switch on the
 * live tests; `UPDATE_SNAPSHOT=1` rewrites the harness snapshot.
 */
const testEnv = ["CI", "MODEL_PROXY_URL", "WEB_TOOLS_LIVE", "VISUAL_LIBS_CHECK", "UPDATE_SNAPSHOT"];

export const tasks = {
  // tsrs with the Effect language service's diagnostics (docs/adr/0028-bun-for-installs-and-scripts-and-tsrs-for-
  // typecheck.md), which `vp check`'s type-aware lint does not run.
  typecheck: "effect-tsgo tsrs",
  test: {
    // Vitest's own command, not `vp test`: `vp run` runs a `vp test` in its own process, with the Vitest of whichever
    // `vp` started it, and a `vp` other than the project's (mise's `npm:vite-plus`) gives the workerd projects a second
    // Vitest, which `@cloudflare/vitest-plugin`'s worker cannot reach (`Cannot read properties of undefined (reading
    // 'config')`). `vitest` is the root's, the same copy `vite-plus` re-exports.
    command: "vitest run",
    cache: {
      env: testEnv,
      // Every other variable reaches the tests (the live tests' keys, `PATH`'s tools) without keying the cache.
      untrackedEnv: ["*"],
    },
  },
} satisfies Tasks;
