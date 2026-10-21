// What a Worker of the stack sets as its `observability` (alchemy's `WorkerProps`): logs with invocation logs, and traces.
// Traces are what carry the custom spans the Session DO makes (`workersTracer`) and the runtime's own for fetches,
// bindings and RPC, so a Worker that a Session's request reaches has them on as well, to join the same trace.
//
// Head sampling is left at Cloudflare's default of 1: this is one owner's agent, and a run's trace is worth having whole.

/** The `observability` prop of every Worker in the stack. */
export const WORKER_OBSERVABILITY = {
  enabled: true,
  logs: { enabled: true, invocationLogs: true },
  traces: { enabled: true },
};
