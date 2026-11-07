// What the Server Worker's deploy bundles and uploads beside its code, in a module of its own that imports nothing, so
// that the startup budget (`scripts/startup.mjs`, `docs/development/workers.md` → Startup) bundles and runs the Worker
// as the deploy does: `worker.ts` deploys with this compatibility, and `worker-init.ts` provides exactly these Durable
// Objects, whose classes alchemy's generated entry exports by name.

/** The Server Worker's compatibility (`worker.ts`); alchemy adds its default flags to it. */
export const SERVER_COMPATIBILITY = { date: "2026-08-31" } as const;

/** The Durable Object classes the Server Worker hosts (`worker-init.ts` provides their Layers), by the name each is exported under. */
export const SERVER_DURABLE_OBJECTS = ["Session", "Registry", "McpHost", "Trigger"] as const;

/** One of {@link SERVER_DURABLE_OBJECTS}. */
export type ServerDurableObject = (typeof SERVER_DURABLE_OBJECTS)[number];
