// The Session's side of its Environment's `McpHost` (`docs/architecture/mcp-in-a-session.md` → The `mcp` extension).
// (The `/mcp` endpoint's side of the Session is `./mcp.ts`.)
//
// - **`mcpHostClient`** is the live adapter of `McpHostClient`: the calls to the host object over Durable Object RPC
//   (`docs/architecture/mcp-connections.md` → RPC). Every answer is read with the shared readers, so one this build
//   cannot read is `HostFailed`; a `requestStart` or `servers` call that fails is `HostFailed` too, and a `request` whose
//   RPC breaks is `HostLost`, which a `tools/call` reads as maybe run. What failed is logged, never told the model.
// - **`kvMcpToolsStore`** keeps what the installed MCP tools were built from in the Session's storage, so an object that
//   starts again installs the very same tools before anything resumes.
// - **`sessionMcp`** is the Session host's `mcp` option (`SessionHostMcp`): `McpTools` for the Session's Environment, its
//   request start (the Workspace marked used first), and its reinstall of `mcp`, `codemode` with the servers as its
//   namespaces, and `tool-search`, together.
import {
  makeMcpTools,
  type McpHostClientService,
  type McpToolsService,
  type McpToolsStore,
} from "@cloudpid/extensions/mcp";
import { reloadToolSearch } from "@cloudpid/extensions/tool-search";
import {
  HostFailed,
  type McpHostRequestResult,
  type McpRequestStartResult,
  type McpServersResult,
  readMcpHostRequestResult,
  readMcpRequestStartResult,
  readMcpServersResult,
} from "@cloudpid/mcp/types";
import { HostLost } from "@cloudpid/extensions/mcp";
import type { ConversationId, Extension } from "@earendil-works/pi-durable";
import type { CodemodeNamespace } from "@earendil-works/pi-durable/codemode";
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { SessionHostMcp } from "./host.ts";
import type { SessionSettingsValues } from "./settings.ts";

/** What each of `McpHostClient`'s methods is answered on the wire, before the shared readers. */
type McpHostAnswers = {
  readonly requestStart: typeof McpRequestStartResult.Encoded;
  readonly servers: typeof McpServersResult.Encoded;
  readonly request: typeof McpHostRequestResult.Encoded;
};

/** The host object as the Session reaches it: `McpHostClient`'s methods, answered on the wire, failing with `E`. */
export type McpHostStub<E> = {
  readonly [K in keyof McpHostClientService]: (
    ...args: Parameters<McpHostClientService[K]>
  ) => Effect.Effect<McpHostAnswers[K], E>;
};

/** A host stub whose methods answer with Promises, as a Durable Object stub's do. */
export type McpHostPromises = {
  readonly [K in keyof McpHostClientService]: (
    ...args: Parameters<McpHostClientService[K]>
  ) => Promise<McpHostAnswers[K]>;
};

/** `host`, a stub that answers with Promises, as one whose calls fail as values. */
export const promisedMcpHost = (host: McpHostPromises): McpHostStub<Cause.UnknownError> => ({
  requestStart: (input) => Effect.tryPromise(() => host.requestStart(input)),
  servers: (input) => Effect.tryPromise(() => host.servers(input)),
  request: (input, hooks) => Effect.tryPromise(() => host.request(input, hooks)),
});

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
 * read whole or not at all.
 */
// @effect-diagnostics-next-line missingPipeableSignature:off -- a store over two values, not a combinator.
export const kvMcpToolsStore = (kv: McpToolsKv, environment: string): McpToolsStore => {
  const countKey = `mcp-tools:${environment}`;
  const partKey = (index: number) => `${countKey}:${index}`;

  return {
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
  /** The object of the Session's Workspace (`ws:<id>`), or null with none: then it has no MCP tools. */
  readonly workspace: Effect.Effect<string | null>;
  /** A call to Workspace object `workspace` that marks it used (`noteSessionActivity`). */
  readonly ready: (workspace: string) => Effect.Effect<void, Cause.UnknownError>;
  /** `codemode` with `namespaces`, to install over the one installed. */
  readonly codemode: (namespaces: ReadonlyArray<CodemodeNamespace>) => Extension;
};

/** The Session host's MCP tools (`SessionHostOptions.mcp`), with one `McpTools` for the Session's Environment. */
export const sessionMcp = (options: SessionMcpOptions): SessionHostMcp<never> => {
  const held = new Map<string, McpToolsService>();

  /** The Session's `McpTools`, made once, from what was kept: its Environment never changes. */
  const toolsOf = (environment: string) => {
    const known = held.get(environment);

    if (known !== undefined) return known;

    const made = makeMcpTools(options.host(environment), kvMcpToolsStore(options.kv, environment));

    held.set(environment, made);

    return made;
  };

  /**
   * The Workspace marked used before any host call, tried twice: false when it never answered, and the request start
   * then calls nothing (`docs/architecture/mcp-in-a-session.md` → Request start).
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

  const start = (
    conversationId: ConversationId,
    window: string,
    values: SessionSettingsValues,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const { environment, servers } = values.mcp;

      // A Session in no Environment has no MCP host to ask.
      if (environment === null) return;

      const workspace = servers === 0 ? null : yield* options.workspace;

      yield* toolsOf(environment).requestStart({
        // Not read without servers, whose host is never asked. A subagent's conversation calls for the Session's own
        // Workspace too, as its calls do: right until stdio servers run in a Subagent Workspace (#460, #462).
        caller: {
          session: options.session ?? "",
          conversation: String(conversationId),
          workspace: workspace ?? "",
        },
        window,
        servers: workspace === null || options.session === undefined ? 0 : servers,
        offered: values.toolSearch.offered,
        ready: workspace === null ? Effect.succeed(true) : readied(workspace),
      });
    });

  const reinstall = (
    installed: readonly Extension[],
    values: SessionSettingsValues,
  ): readonly Extension[] => {
    const { environment } = values.mcp;

    if (environment === null) return [];

    const built = toolsOf(environment).reinstall(values.toolSearch.offered);

    if (Option.isNone(built)) return [];

    const { mcp, namespaces } = built.value;
    const codemode = options.codemode(namespaces);

    const others = Arr.map(installed, (each) =>
      each.name === mcp.name ? mcp : each.name === codemode.name ? codemode : each,
    );

    return [mcp, codemode, reloadToolSearch(others, values.toolSearch)];
  };

  return { start, reinstall };
};
