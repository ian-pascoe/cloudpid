import * as Cloudflare from "alchemy/Cloudflare";
import { WORKSPACE_BINDING } from "./binding.ts";
import type { Workspace } from "./Workspace.ts";

/**
 * The Worker that hosts the Workspace DO, one object per Workspace slug. It has no public URL: Session DOs reach it
 * through a Durable Object binding.
 */
export const Workspaces = Cloudflare.Worker("Workspaces", {
  main: new URL("./worker.ts", import.meta.url).href,
  compatibility: { date: "2026-08-31" },
  workersDev: false,
  env: {
    [WORKSPACE_BINDING]: Cloudflare.DurableObject<Workspace>("Workspace"),
    LOADER: Cloudflare.WorkerLoader(),
  },
});
