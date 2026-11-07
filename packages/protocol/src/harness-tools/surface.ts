// The two places a harness tool is served from (`docs/architecture/mcp-endpoint.md` → Environment and Settings tools →
// Names and surfaces): a Session's own tools, and the MCP endpoint. Only `effect` and `@cloudpid/config` may be imported
// below `harness-tools/`, so that McpWorker can import the declarations without pi-durable (`packages/protocol/.oxlintrc.json`).
// @effect-diagnostics missingPipeableSignature:off

/**
 * Where a tool is served: `session` is the in-session tool, whose text and values stay as they were before the
 * endpoint served it (the prompt cache and `tool_search` read them); `endpoint` is `/mcp`.
 */
export type Surface = "session" | "endpoint";

/**
 * Why a core refused a call, which the endpoint's dispatcher maps to its error codes (`mcp-endpoint.md` → The
 * dispatcher): `not_found` (an id or name that names nothing) and `invalid_argument` (an argument that cannot be
 * served). A refusal without a code is `unavailable` to the caller.
 */
export type HarnessErrorCode = "not_found" | "invalid_argument";

/** The annotations `tools/list` shows (`mcp-endpoint.md` → The tools: RO). */
export type HarnessAnnotations = {
  readonly readOnlyHint: boolean;
  readonly idempotentHint: boolean;
  readonly destructiveHint: boolean;
  readonly openWorldHint: boolean;
};

/** RO: a read that changes nothing and reaches nothing outside cloudpid. */
export const READ_ONLY: HarnessAnnotations = {
  readOnlyHint: true,
  idempotentHint: true,
  destructiveHint: false,
  openWorldHint: false,
};
