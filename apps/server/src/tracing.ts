// Workers' tracing API for the objects that build their `Telemetry` from it (`Session`, `McpHost`; docs/architecture/
// operations.md → Telemetry).
import type { WorkersTracing } from "@cloudpid/telemetry";

/**
 * Workers' tracing API (`cloudflare:workers`), where the runtime has one. It is read when an object is built, not when
 * the module loads: the stack imports the objects' modules under Node, which has no such module.
 */
export const workersTracing = (): Promise<WorkersTracing | undefined> =>
  import("./workers-tracing.ts").then(
    (workers) => workers.tracing,
    () => undefined,
  );
