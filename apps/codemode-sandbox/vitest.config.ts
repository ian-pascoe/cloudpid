import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { testTimeout } from "@cloudpid/config/vitest";
import { defineConfig } from "vite-plus";

/**
 * The Worker's tests run inside workerd, against its real entry and Durable Object. They do not merge the shared base, so
 * they take its timeout themselves rather than Vitest's 5 s default, which a loaded CI runner can pass (#632).
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/worker.ts",
      miniflare: {
        compatibilityDate: "2026-08-31",
        // pi-codemode's QuickJS engine is a `.wasm` import, which Wrangler compiles by default.
        modulesRules: [{ type: "CompiledWasm", include: ["**/*.wasm"] }],
        durableObjects: { CODEMODE_SANDBOX: { className: "CodemodeSandbox", useSQLite: true } },
      },
    }),
  ],
  test: { include: ["src/**/*.test.ts"], testTimeout },
});
