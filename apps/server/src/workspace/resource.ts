import { sandboxImageContext } from "@cloudpid/sandbox-image";
import * as Cloudflare from "alchemy/Cloudflare";
import { SANDBOX_CONTAINER, WORKSPACE_BINDING } from "./binding.ts";
import type { Workspace } from "./Workspace.ts";

/**
 * The sandbox image (`apps/sandbox-image`) as a Container the Workspace DO schedules itself: the object picks the image
 * and the instance size when it starts the Container (`schedulingPolicy: "durable_object"`, ADR-0004), so neither is
 * declared here. The image is built from the Dockerfile, and reaches the object as `ctx.container.images.Sandbox`.
 */
export const Sandbox = Cloudflare.Container(SANDBOX_CONTAINER, {
  schedulingPolicy: "durable_object",
  context: sandboxImageContext,
});

/**
 * The Worker that hosts the Workspace DO, one object per Workspace slug. It has no public URL: Session DOs reach it
 * through a Durable Object binding.
 */
export const Workspaces = Cloudflare.Worker("Workspaces", {
  main: new URL("./worker.ts", import.meta.url).href,
  compatibility: { date: "2026-08-31" },
  workersDev: false,
  env: {
    [WORKSPACE_BINDING]: Cloudflare.DurableObject<Workspace>("Workspace", {
      containers: [Sandbox],
    }),
    LOADER: Cloudflare.WorkerLoader(),
  },
});
