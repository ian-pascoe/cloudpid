// The Registry as `McpHost` sees it (`docs/architecture/mcp-connections.md` → RPC, host → Registry): the set's pull,
// the `${NAME}` values of a server, and an MCP sign-in's access token and the transitions the host reports
// (`docs/architecture/mcp-sign-in.md` → Tokens reach the host object), over the Registry DO in this script, or a fake.
// A value or a token is never logged or stored.
import type {
  McpAccessTokenAnswer,
  McpAccessTokenInput,
  McpAuthReport,
  McpAuthReportAnswer,
  McpServerSetAnswer,
  McpServerValuesAnswer,
} from "@cloudpid/mcp/types";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** The Registry could not be asked (an RPC failure, or an answer this build cannot read). */
export class McpRegistryUnavailable extends Schema.TaggedError<
  McpRegistryUnavailable,
  { readonly brand: unique symbol }
>()("McpRegistryUnavailable", { message: Schema.String }) {}

export type McpRegistryPortService = {
  /**
   * The Environment's current set unless the host holds it (`heldHash`; undefined: it holds none, which is the empty
   * set), which runs the Registry's look at the Repos' `.pi/mcp.json` when it is due.
   */
  readonly serverSet: (input: {
    readonly environment: string;
    readonly heldHash: string | undefined;
  }) => Effect.Effect<McpServerSetAnswer, McpRegistryUnavailable>;
  /**
   * `server`'s `env` and `headers` with every `${NAME}` resolved, when the Registry holds it under `conn`; the names
   * that resolved to nothing are `missing`. Held in memory for the call only.
   */
  readonly serverValues: (input: {
    readonly environment: string;
    readonly server: string;
    readonly conn: string;
  }) => Effect.Effect<McpServerValuesAnswer, McpRegistryUnavailable>;
  /**
   * The access token `server`'s sign-in holds for `environment`, or why there is none; `stale` is the token a server
   * just refused. The answer is for the host's memory only.
   */
  readonly accessToken: (
    input: McpAccessTokenInput,
  ) => Effect.Effect<McpAccessTokenAnswer, McpRegistryUnavailable>;
  /** A transition the host saw: a 401, a 403 for more scope, or a server that works again. */
  readonly reportAuth: (
    report: McpAuthReport,
  ) => Effect.Effect<McpAuthReportAnswer, McpRegistryUnavailable>;
};

/** The Registry, as the host sees it: the Registry DO, or a fake. */
export class McpRegistryPort extends Context.Service<McpRegistryPort, McpRegistryPortService>()(
  "@cloudpid/server/mcp/registry-port/McpRegistryPort",
) {}
