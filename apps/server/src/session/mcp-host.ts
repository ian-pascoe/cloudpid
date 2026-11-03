// The Session's side of its Environment's `McpHost` (`docs/architecture/mcp-in-a-session.md` → The `mcp` extension).
// (The `/mcp` endpoint's side of the Session is `./mcp.ts`.)
//
// - **`mcpHostClient`** is the live adapter of `McpHostClient`: the calls to the host object over Durable Object RPC
//   (`docs/architecture/mcp-connections.md` → RPC). Every answer is read with the shared readers, so one this build
//   cannot read is `HostFailed`; a `requestStart` or `servers` call that fails is `HostFailed` too, and a `request` whose
//   RPC breaks is `HostLost`, which a `tools/call` reads as maybe run. What failed is logged, never told the model.
// - **`kvMcpToolsStore`** keeps what the installed MCP tools were built from in the Session's storage, so an object that
//   starts again installs the very same tools before anything resumes, and each conversation's last opened Context
//   Window, so `windowOpened` is sent once per window across evictions.
// - **`sessionMcp`** is the Session host's `mcp` option (`SessionHostMcp`): `McpTools` for the Session's Environment, its
//   request start (the Workspace looked up and marked used first; either failing keeps the tools built), and its
//   reinstall of `mcp`, `codemode` with the servers as its namespaces, and `tool-search`, together; and the notices that
//   the `mcp_servers` listing changed (`@cloudpid/extensions/mcp`: `bind` gives `McpTools` the Session's Harness to write
//   them to, `notify` is a conversation's check at its request start).
import {
  HostLost,
  makeMcpTools,
  type McpHostClientService,
  type McpNotices,
  type McpQuestionsService,
  type McpSignInsService,
  type McpToolOptions,
  type McpToolsService,
  type McpToolsStore,
} from "@cloudpid/extensions/mcp";
import { reloadToolSearch } from "@cloudpid/extensions/tool-search";
import {
  HostFailed,
  type McpApplyResult,
  type McpHostRequestResult,
  type McpRequestStartResult,
  type McpServersResult,
  readMcpApplyResult,
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
import type { Mutable } from "effect/Types";
import type { SessionHostMcp, SessionHostMcpBuild } from "./host.ts";
import type { SessionSettingsValues } from "./settings.ts";

/** What each of `McpHostClient`'s methods is answered on the wire, before the shared readers. */
export type McpHostAnswers = {
  readonly requestStart: typeof McpRequestStartResult.Encoded;
  readonly servers: typeof McpServersResult.Encoded;
  readonly apply: typeof McpApplyResult.Encoded;
  readonly request: typeof McpHostRequestResult.Encoded;
};

/** The host object as the Session reaches it: `McpHostClient`'s methods, answered on the wire, failing with `E`. */
export type McpHostStub<E> = {
  readonly [K in keyof McpHostClientService]: (
    ...args: Parameters<McpHostClientService[K]>
  ) => Effect.Effect<McpHostAnswers[K], E>;
};

/** A call to the host that failed, logged with its cause: `HostFailed`, with a message that names only the call. */
const failed =
  (what: string) =>
  <E>(cause: Cause.Cause<E>) =>
    Effect.logWarning(`The MCP host did not answer ${what}`, cause).pipe(
      Effect.as(HostFailed.make({ message: `The MCP host did not answer ${what}` })),
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
  apply: (input) =>
    Effect.suspend(() => host().apply(input)).pipe(
      Effect.map(readMcpApplyResult),
      Effect.catchCause(failed("apply")),
    ),
  request: (input, hooks) =>
    Effect.suspend(() => host().request(input, hooks)).pipe(
      Effect.map(readMcpHostRequestResult),
      Effect.catchCause((cause) =>
        Effect.logWarning("The MCP host's end of a request was lost", cause).pipe(
          Effect.as(HostLost.make({ message: "The MCP host's end of the request was lost" })),
        ),
      ),
    ),
});

/** The Session storage the store keeps its text in. */
export type McpToolsKv = {
  readonly get: <T>(key: string) => T | undefined;
  readonly put: <T>(key: string, value: T) => void;
  readonly delete: (key: string) => boolean;
};

/** The most characters a stored value holds: an inventory over it is kept in parts. */
const PART_LENGTH = 256 * 1024;

/**
 * A store in `kv` for Environment `environment`'s MCP tools: the text in parts of at most `PART_LENGTH` characters
 * under `mcp-tools:<environment>:<n>`, with their count under `mcp-tools:<environment>`, written last, so a text is
 * read whole or not at all; and each conversation's last opened Context Window under
 * `mcp-window:<environment>:<conversation>`; and the hash of the listing the last completed broadcast of notices told
 * every conversation of, under `mcp-broadcast:<environment>`.
 */
// @effect-diagnostics-next-line missingPipeableSignature:off -- a store over two values, not a combinator.
export const kvMcpToolsStore = (kv: McpToolsKv, environment: string): McpToolsStore => {
  const countKey = `mcp-tools:${environment}`;
  const partKey = (index: number) => `${countKey}:${index}`;
  const windowKey = (conversation: string) => `mcp-window:${environment}:${conversation}`;
  const broadcastKey = `mcp-broadcast:${environment}`;

  return {
    broadcast: () => kv.get<string>(broadcastKey),
    broadcasted: (hash) => kv.put(broadcastKey, hash),
    window: (conversation) => kv.get<string>(windowKey(conversation)),
    openWindow: (conversation, window) => kv.put(windowKey(conversation), window),
    load: () => {
      const count = kv.get<number>(countKey);

      if (count === undefined) return undefined;

      const parts = Arr.makeBy(count, (index) => kv.get<string>(partKey(index)));

      return Arr.every(parts, (part) => part !== undefined) ? Arr.join(parts, "") : undefined;
    },
    save: (text) => {
      const old = kv.get<number>(countKey) ?? 0;

      kv.delete(countKey);

      for (let index = 0; index < old; index++) kv.delete(partKey(index));

      if (text === undefined) return;

      const count = Math.ceil(text.length / PART_LENGTH);

      for (let index = 0; index < count; index++) {
        kv.put(partKey(index), text.slice(index * PART_LENGTH, (index + 1) * PART_LENGTH));
      }

      kv.put(countKey, count);
    },
  };
};

export type SessionMcpOptions = {
  /** The Session's name, its ID in the Registry; undefined when unknown, and then it has no MCP tools. */
  readonly session: string | undefined;
  /** The `McpHostClient` of Environment `environment`'s host. */
  readonly host: (environment: string) => McpHostClientService;
  /** Where the Session keeps what its MCP tools were built from. */
  readonly kv: McpToolsKv;
  /**
   * The object of the Session's Workspace (`ws:<id>`), or null with none: then it has no MCP tools. A lookup that fails
   * keeps the tools as they were built.
   */
  readonly workspace: Effect.Effect<string | null, Cause.UnknownError>;
  /** A call to Workspace object `workspace` that marks it used (`noteSessionActivity`). */
  readonly ready: (workspace: string) => Effect.Effect<void, Cause.UnknownError>;
  /** `codemode` with `namespaces`, to install over the one installed. */
  readonly codemode: (namespaces: ReadonlyArray<CodemodeNamespace>) => Extension;
  /** The Session's MCP questions: with them, a Legacy server's elicitation form is shown to the owner. */
  readonly questions?: McpQuestionsService;
  /** The Session's Sign-in requests: with them, the build registers `mcp_sign_in_ask` when the set has a server that can need one. */
  readonly signIns?: McpSignInsService;
};

/** The Session host's MCP tools (`SessionHostOptions.mcp`), with one `McpTools` for the Session's Environment. */
export const sessionMcp = (options: SessionMcpOptions): SessionHostMcp<never> => {
  let held: { readonly environment: string; readonly tools: McpToolsService } | undefined;

  /** Where the notices are written, once the host's Harness is open. */
  let notices: McpNotices | undefined;

  /**
   * The Workspace marked used before any host call, tried twice: false when it never answered, and the request start
   * then calls nothing (`docs/architecture/mcp-in-a-session.md` → Request start), nor a call to a stdio server.
   */
  const readied = (workspace: string) =>
    options.ready(workspace).pipe(
      Effect.retry({ times: 1 }),
      Effect.as(true),
      Effect.catchCause((cause) =>
        Effect.logWarning(
          "The Workspace did not answer before an MCP request start; the MCP tools stay as they were",
          cause,
        ).pipe(Effect.as(false)),
      ),
    );

  /**
   * The Session's `McpTools`, made once, from what was kept: its Environment never changes. A call to a stdio server marks
   * the Workspace of the conversation that calls (its Subagent Workspace's, or the Session's) used first.
   */
  const toolsOf = (environment: string) => {
    if (held?.environment === environment) return held.tools;

    const toolOptions: Mutable<McpToolOptions> = {
      ready: (workspace) => Effect.runPromise(readied(workspace)),
      environment,
    };

    if (options.questions !== undefined) toolOptions.questions = options.questions;

    if (options.signIns !== undefined) toolOptions.signIns = options.signIns;

    const tools = makeMcpTools(
      options.host(environment),
      kvMcpToolsStore(options.kv, environment),
      toolOptions,
    );

    if (notices !== undefined) tools.bindNotices(notices);

    held = { environment, tools };

    return tools;
  };

  /** A request start that cannot be made: the tools stay as they were built, and why is logged. */
  const skipped = (why: string, cause?: Cause.Cause<unknown>) =>
    Effect.logWarning(
      `${why} before an MCP request start; the MCP tools stay as they were`,
      ...(cause === undefined ? [] : [cause]),
    );

  const start = (
    conversationId: ConversationId,
    window: string,
    values: SessionSettingsValues,
  ): Effect.Effect<void> => {
    const { environment, servers } = values.mcp;

    // A Session in no Environment has no MCP host to ask.
    if (environment === null) return Effect.void;

    const startFor = (workspace: string | null) =>
      toolsOf(environment).requestStart({
        // Not read without servers, whose host is never asked. A subagent's conversation asks as the Session's own: the
        // inventory is the Environment's, shared (D13); its calls name its own Subagent Workspace (`McpToolOptions.ready`).
        caller: {
          session: options.session ?? "",
          conversation: String(conversationId),
          workspace: workspace ?? "",
        },
        window,
        servers: workspace === null ? 0 : servers,
        offered: values.toolSearch.offered,
        ready: workspace === null ? Effect.succeed(true) : readied(workspace),
      });

    if (servers === 0) return startFor(null);

    // Not knowing who the Session is, or where its Workspace is, is a failure, not "no servers": nothing built is
    // dropped for it.
    if (options.session === undefined) return skipped("The Session's name is unknown");

    return options.workspace.pipe(
      Effect.asSome,
      Effect.catchCause((cause) =>
        skipped("The Session's Workspace is unknown", cause).pipe(Effect.as(Option.none())),
      ),
      Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: startFor })),
    );
  };

  const reinstall = (
    installed: readonly Extension[],
    values: SessionSettingsValues,
  ): SessionHostMcpBuild<never> => {
    const { environment } = values.mcp;

    if (environment === null) return { extensions: [], announce: Effect.void };

    const built = toolsOf(environment).reinstall(values.toolSearch.offered);

    if (Option.isNone(built)) return { extensions: [], announce: Effect.void };

    const { mcp, namespaces } = built.value;
    const codemode = options.codemode(namespaces);

    const others = Arr.map(installed, (each) =>
      each.name === mcp.name ? mcp : each.name === codemode.name ? codemode : each,
    );

    return {
      extensions: [mcp, codemode, reloadToolSearch(others, values.toolSearch)],
      announce: built.value.announce,
    };
  };

  const bind = (next: McpNotices) => {
    notices = next;
    held?.tools.bindNotices(next);
  };

  const notify = (conversationId: ConversationId, values: SessionSettingsValues) => {
    const { environment } = values.mcp;

    return environment === null ? Effect.void : toolsOf(environment).notify(conversationId);
  };

  return { start, reinstall, bind, notify };
};
