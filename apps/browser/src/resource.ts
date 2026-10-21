import { WORKER_OBSERVABILITY } from "@cloudpid/telemetry/observability";
import * as Cloudflare from "alchemy/Cloudflare";
import { BROWSER_HOST_BINDING } from "./binding.ts";

/**
 * The Worker that hosts the browser host Durable Object, one object per Session (ADR-0007). It is a Worker of its own
 * because `agents/browser`'s tool keeps its runs in a facet of the object that hosts it, which the Worker must export
 * (`CodemodeRuntime`), and alchemy's Effect Workers, like the Server Worker, export only their Effect-defined classes.
 * It has the Browser Run binding (`BROWSER`) and a Worker Loader (`LOADER`), where the model's CDP code runs. It has no
 * public URL: `workersDev` is off and it declares no routes, so the only way in is the Durable Object binding the
 * Server Worker declares with this Worker's name.
 */
export const Browsers = Cloudflare.Worker("Browsers", {
  main: new URL("./worker.ts", import.meta.url).href,
  compatibility: { date: "2026-08-31", flags: ["nodejs_compat"] },
  workersDev: false,
  observability: WORKER_OBSERVABILITY,
  env: {
    [BROWSER_HOST_BINDING]: Cloudflare.DurableObject("BrowserHost"),
    BROWSER: Cloudflare.Browser(),
    LOADER: Cloudflare.WorkerLoader(),
  },
});
