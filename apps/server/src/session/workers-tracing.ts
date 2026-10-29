// Workers' tracing API alone, for `Session.ts` to import when an object is built (docs/architecture/operations.md →
// Telemetry). A module of its own because the type of a dynamic import of all of `cloudflare:workers` is the whole
// module's, whose RPC types TypeScript 7.1 finds infinitely circular there.
export { tracing } from "cloudflare:workers";
