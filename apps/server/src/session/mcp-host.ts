// The Session's side of its Environment's `McpHost` (`docs/architecture/mcp-in-a-session.md` → The `mcp` extension).
// (The `/mcp` endpoint's side of the Session is `./mcp.ts`.)
//
// - **`mcpHostClient`** is the live adapter of `McpHostClient`: the calls to the host object over Durable Object RPC
//   (`docs/architecture/mcp-connections.md` → RPC). Every answer is read with the shared readers, so one this build
//   cannot read, and a call that fails, is `HostFailed`: the `mcp` extension never fails for its host.
// - **`mcpRequestStart`** is the Session host's request start (`SessionHostOptions.requestStart`): `McpTools` asked for
//   the conversation's request, and when it built the `mcp` extension again, `codemode` with the servers as its
//   namespaces and `tool-search` built again with it, to be installed together.
import {
  type McpHostClientService,
  type McpToolsService,
  makeMcpTools,
} from "@cloudpid/extensions/mcp";
import { reloadToolSearch } from "@cloudpid/extensions/tool-search";
import {
  HostFailed,
  type McpHostRequest,
  type McpHostRequestHooks,
  type McpHostRequestResult,
  type McpRequestStart,
  type McpRequestStartResult,
  type McpServersRequest,
  type McpServersResult,
  readMcpHostRequestResult,
  readMcpRequestStartResult,
  readMcpServersResult,
} from "@cloudpid/mcp/types";
import type { ConversationId, Extension } from "@earendil-works/pi-durable";
import type { CodemodeNamespace } from "@earendil-works/pi-durable/codemode";
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { SessionSettingsValues } from "./settings.ts";

/**
 * The host object as the Session reaches it: its stub's methods, whose answers are read as wire values, and which fail
 * with `E` when the call does.
 */
export type McpHostStub<E> = {
  readonly requestStart: (
    input: McpRequestStart,
  ) => Effect.Effect<typeof McpRequestStartResult.Encoded, E>;
  readonly servers: (input: McpServersRequest) => Effect.Effect<typeof McpServersResult.Encoded, E>;
  readonly request: (
    input: McpHostRequest,
    hooks: McpHostRequestHooks,
  ) => Effect.Effect<typeof McpHostRequestResult.Encoded, E>;
};

/** A call to the host that failed, as the Session reads it. */
const failed =
  (what: string) =>
  <E>(cause: Cause.Cause<E>) =>
    Effect.succeed(
      HostFailed.make({ message: `The MCP host did not answer ${what}: ${Cause.pretty(cause)}` }),
    );

/**
 * `McpHostClient` over `host`, the stub of the Session's Environment's `McpHost`, found anew for each call. A request's
 * hooks go to the host as RPC stubs, which live as long as the call: the call is awaited for its whole length.
 */
export const mcpHostClient = <E>(host: () => McpHostStub<E>): McpHostClientService => ({
  requestStart: (input) =>
    Effect.suspend(() => host().requestStart(input)).pipe(
      Effect.map(readMcpRequestStartResult),
      Effect.catchCause(failed("requestStart")),
    ),
  servers: (input) =>
    Effect.suspend(() => host().servers(input)).pipe(
      Effect.map(readMcpServersResult),
      Effect.catchCause(failed("servers")),
    ),
  request: (input, hooks) =>
    Effect.suspend(() => host().request(input, hooks)).pipe(
      Effect.map(readMcpHostRequestResult),
      Effect.catchCause(failed("the request")),
    ),
});

export type McpRequestStartOptions = {
  /** The Session's name, its ID in the Registry; undefined when unknown, and then it has no MCP tools. */
  readonly session: string | undefined;
  /** The `McpHostClient` of Environment `environment`'s host. */
  readonly host: (environment: string) => McpHostClientService;
  /** The object of the Session's Workspace (`ws:<id>`), or null with none: then it has no MCP tools. */
  readonly workspace: Effect.Effect<string | null>;
  /**
   * A call to Workspace object `workspace` that marks it used (`noteSessionActivity`), awaited before any host call
   * that may reach the stdio bridge for it. Never fails: one that does is logged.
   */
  readonly ready: (workspace: string) => Effect.Effect<void>;
  /** `codemode` with `namespaces`, to install over the one installed. */
  readonly codemode: (namespaces: ReadonlyArray<CodemodeNamespace>) => Extension;
};

/** The Session host's MCP request start (`SessionHostOptions.requestStart`), with one `McpTools` for its Environment. */
export const mcpRequestStart = (options: McpRequestStartOptions) => {
  const held = new Map<string, McpToolsService>();

  /** The Session's `McpTools`, made once: its Environment never changes. */
  const toolsOf = (environment: string) => {
    const known = held.get(environment);

    if (known !== undefined) return known;

    const made = makeMcpTools(options.host(environment));

    held.set(environment, made);

    return made;
  };

  return (
    conversationId: ConversationId,
    installed: readonly Extension[],
    values: SessionSettingsValues,
  ): Effect.Effect<readonly Extension[]> =>
    Effect.gen(function* () {
      const { environment, servers } = values.mcp;

      // A Session in no Environment has no MCP host to ask.
      if (environment === null) return [];

      const tools = toolsOf(environment);
      const workspace = servers === 0 ? null : yield* options.workspace;
      const session = options.session ?? "";

      const built = yield* tools.requestStart({
        // Not read without servers, whose host is never asked.
        caller: { session, conversation: String(conversationId), workspace: workspace ?? "" },
        servers: workspace === null || options.session === undefined ? 0 : servers,
        offered: values.toolSearch.offered,
        ready: workspace === null ? Effect.void : options.ready(workspace),
      });

      if (Option.isNone(built)) return [];

      const mcp = built.value;
      const codemode = options.codemode(tools.namespaces());

      const others = Arr.map(installed, (each) =>
        each.name === mcp.name ? mcp : each.name === codemode.name ? codemode : each,
      );

      return [mcp, codemode, reloadToolSearch(others, values.toolSearch)];
    });
};
