// The two places a harness tool is served from (`docs/architecture/mcp-endpoint.md` → Environment and Settings tools →
// Names and surfaces): a Session's own tools, and the MCP endpoint. Only `effect` and `@cloudpid/config` may be imported
// below `harness-tools/`, so that McpWorker can import the declarations without pi-durable (`packages/protocol/.oxlintrc.json`).
// @effect-diagnostics missingPipeableSignature:off

/**
 * Where a tool is served: `session` is the in-session tool, whose text and values stay as they were before the
 * endpoint served it (the prompt cache and `tool_search` read them); `endpoint` is `/mcp`.
 */
export type Surface = "session" | "endpoint";

/** Whom a tool's words call whoever reads and reverts its changes on the owner's pages. */
export type Who = "user" | "owner";

/** The user in a Session's words, the owner in the endpoint's (which never says "user"). */
export const whoWords = (surface: Surface): Who => (surface === "session" ? "user" : "owner");

/**
 * Why a core refused a call, which the endpoint's dispatcher maps to its error codes (`mcp-endpoint.md` → The
 * dispatcher): `not_found` (an id or name that names nothing), `invalid_argument` (an argument that cannot be
 * served), `unsupported` (a change the endpoint does not make: a Limit, or a call a later stage serves; nothing was
 * changed: the dispatcher answers it before it claims anything, and a core gives it behind that) and `unavailable` (a
 * refusal that heals: a try again later may be made, its message says so; a change made without asking that the Registry
 * found widening in its transaction is one). A refusal without a code is `unavailable` to
 * the caller too, with a fixed sentence in place of its own.
 */
export type HarnessErrorCode = "not_found" | "invalid_argument" | "unsupported" | "unavailable";

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

/** W·idem: a write that a repeat with the same arguments leaves as it is (a set), reaching nothing outside cloudpid. */
export const WRITE_IDEMPOTENT: HarnessAnnotations = {
  readOnlyHint: false,
  idempotentHint: true,
  destructiveHint: false,
  openWorldHint: false,
};

/** D·idem: a write that narrows or takes something away (an unset), which a repeat leaves as it is. */
export const DESTRUCTIVE_IDEMPOTENT: HarnessAnnotations = {
  readOnlyHint: false,
  idempotentHint: true,
  destructiveHint: true,
  openWorldHint: false,
};

/**
 * W: a write that a repeat may change again (a reset, a move among keys, a new Environment, a Build asked for, an ask
 * for the owner's Approval, which a repeat may ask again), reaching nothing outside cloudpid.
 */
export const WRITE: HarnessAnnotations = {
  readOnlyHint: false,
  idempotentHint: false,
  destructiveHint: false,
  openWorldHint: false,
};

/** W, open-world: a write that reaches GitHub to fetch what it keeps (a Skill install or update). */
export const WRITE_OPEN: HarnessAnnotations = {
  readOnlyHint: false,
  idempotentHint: false,
  destructiveHint: false,
  openWorldHint: true,
};

/**
 * D: a destructive write that a repeat may not leave as it is (a removal that falls back to another, a Skill removed,
 * whose repeat is refused).
 */
export const DESTRUCTIVE: HarnessAnnotations = {
  readOnlyHint: false,
  idempotentHint: false,
  destructiveHint: true,
  openWorldHint: false,
};

/** W·idem, open: an idempotent write that reaches the MCP servers (`settings_mcp_reload`). */
export const WRITE_IDEMPOTENT_OPEN: HarnessAnnotations = {
  readOnlyHint: false,
  idempotentHint: true,
  destructiveHint: false,
  openWorldHint: true,
};
