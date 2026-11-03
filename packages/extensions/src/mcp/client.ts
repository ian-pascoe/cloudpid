// `McpHostClient`, the Environment's `McpHost` as a Session reaches it (`docs/architecture/mcp-connections.md` → RPC, The
// Session side). Its live adapter is `apps/server/src/session/mcp-host.ts`; its in-memory fake is `../mcp.testing.ts`.
import type {
  McpApply,
  McpApplyResult,
  McpHostRequest,
  McpHostRequestHooks,
  McpHostRequestResult,
  McpRequestStart,
  McpRequestStartResult,
  McpServersRequest,
  McpServersResult,
} from "@cloudpid/mcp/types";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * The Session's end of a request lost: the RPC to the host broke, or no answer came within the call's timeout and its
 * slack. Never crosses the edge; a `tools/call` so cut may have run (`docs/architecture/mcp.md` → Deploys: `host_lost`).
 */
export const HostLost = Schema.TaggedStruct("HostLost", { message: Schema.String });

export type HostLost = typeof HostLost.Type;

/**
 * `McpHost` as a Session calls it. Never fails: a host that answers with something this build cannot read, or whose
 * `requestStart`, `servers` or `apply` call fails, is `HostFailed` (`readMcpRequestStartResult`, `readMcpServersResult`,
 * `readMcpApplyResult`, `readMcpHostRequestResult`), and a `request` whose RPC breaks is `HostLost`. What failed is logged, never told the
 * model.
 */
export type McpHostClientService = {
  readonly requestStart: (input: McpRequestStart) => Effect.Effect<McpRequestStartResult>;
  readonly servers: (input: McpServersRequest) => Effect.Effect<McpServersResult>;
  /**
   * The pushes (`apply`): the set the Registry computed, and `{ kind: "reload" }`. The Session carries the pushes of its own
   * changes to the MCP set (`settings_mcp_*`: `docs/architecture/mcp-configuration.md` → From the Registry to the host), since
   * the Registry never calls out. A host that does not know the kind answers `HostUnsupported`, and one that cannot be reached
   * or whose answer cannot be read `HostFailed` (`readMcpApplyResult`).
   */
  readonly apply: (input: McpApply) => Effect.Effect<McpApplyResult>;
  /** A request with its hooks; the effect lasts as long as the request, so the hooks' stubs do too. */
  readonly request: (
    input: McpHostRequest,
    hooks: McpHostRequestHooks,
  ) => Effect.Effect<McpHostRequestResult | HostLost>;
};

/** The Environment's `McpHost`, as the Session's `mcp` extension reaches it. */
export class McpHostClient extends Context.Service<McpHostClient, McpHostClientService>()(
  "@cloudpid/extensions/mcp/client/McpHostClient",
) {}
