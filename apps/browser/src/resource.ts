import { WORKER_OBSERVABILITY } from "@cloudpid/telemetry/observability";
import * as Cloudflare from "alchemy/Cloudflare";
import type { Input } from "alchemy/Input";
import { BROWSER_HOST_BINDING, PREVIEW_WORKSPACES_BINDING } from "./binding.ts";

/** What the browser Worker is declared with: the Workspaces Worker's script name, an Output so that Worker deploys first. */
export type BrowsersOptions = { readonly workspaces: Input<string> };

/**
 * The Worker that hosts the browser host Durable Object, one object per Session (ADR-0007). It is a Worker of its own
 * because `agents/browser`'s tool keeps its runs in a facet of the object that hosts it, which the Worker must export
 * (`CodemodeRuntime`), and alchemy's Effect Workers, like the Server Worker, export only their Effect-defined classes.
 * It has the Browser Run binding (`BROWSER`) and a Worker Loader (`LOADER`), where the model's CDP code runs, and the
 * Workspace DO namespace of the Workspaces Worker (`WORKSPACES`), which the Container previews' entrypoint hands each
 * request to (ADR-0023). It has no public URL: `workersDev` is off and it declares no routes, so the only ways in are
 * the Durable Object binding the Server Worker declares with this Worker's name and the routes of the browsers it
 * acquires.
 */
export const Browsers = ({ workspaces }: BrowsersOptions) =>
  Cloudflare.Worker("Browsers", {
    main: new URL("./worker.ts", import.meta.url).href,
    compatibility: { date: "2026-08-31", flags: ["nodejs_compat"] },
    workersDev: false,
    observability: WORKER_OBSERVABILITY,
    env: {
      [BROWSER_HOST_BINDING]: Cloudflare.DurableObject("BrowserHost"),
      [PREVIEW_WORKSPACES_BINDING]: Cloudflare.DurableObject("Workspace", {
        scriptName: workspaces,
      }),
      BROWSER: Cloudflare.Browser(),
      LOADER: Cloudflare.WorkerLoader(),
    },
  });
