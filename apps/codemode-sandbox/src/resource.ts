import * as Cloudflare from "alchemy/Cloudflare";
import { CODEMODE_SANDBOX_BINDING } from "./binding.ts";
import { compiledWasm } from "./wasm.ts";

/**
 * The Worker that hosts the codemode sandbox Durable Object, one object per Session. It is a Worker of its own so a
 * script runs in another isolate than the Session DO that asked for it (ADR-0005). It has no public URL: `workersDev`
 * is off and it declares no routes, so the only way in is the Durable Object binding the Server Worker declares with
 * this Worker's name.
 */
export const CodemodeSandboxes = Cloudflare.Worker("CodemodeSandboxes", {
  main: new URL("./worker.ts", import.meta.url).href,
  compatibility: { date: "2026-08-31" },
  workersDev: false,
  // pi-codemode's QuickJS engine is a `.wasm` import that Workers need as a compiled module.
  build: { input: { plugins: [compiledWasm()] } },
  env: {
    [CODEMODE_SANDBOX_BINDING]: Cloudflare.DurableObject("CodemodeSandbox"),
  },
});
