import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/** The Worker's tests run inside workerd, against its real entry and Durable Object. */
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
  test: { include: ["src/**/*.test.ts"] },
});
