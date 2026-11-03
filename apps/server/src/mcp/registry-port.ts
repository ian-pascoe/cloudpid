// The Registry as `McpHost` sees it (`docs/architecture/mcp-connections.md` → RPC, host → Registry): the set's pull and
// the `${NAME}` values of a server, over the Registry DO in this script, or a fake. A value is never logged or stored.
import type { McpServerSetAnswer, McpServerValuesAnswer } from "@cloudpid/mcp/types";
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
};

/** The Registry, as the host sees it: the Registry DO, or a fake. */
export class McpRegistryPort extends Context.Service<McpRegistryPort, McpRegistryPortService>()(
  "@cloudpid/server/mcp/registry-port/McpRegistryPort",
) {}
