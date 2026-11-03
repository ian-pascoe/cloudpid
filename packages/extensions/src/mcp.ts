// The `mcp` extension (`docs/architecture/mcp-in-a-session.md` → The `mcp` extension, Exposure; ADR-0030): one Session
// extension built from the Environment's MCP inventory, whose tools each call `McpHost.request({ op: "tools/call" })`.
// The Session reaches the host only through `McpHostClient` (`./mcp/client.ts`), whose live adapter is
// `apps/server/src/session/mcp-host.ts` and whose in-memory fake is `./mcp.testing.ts`. The tools themselves are
// `./mcp/tools.ts`, their Exposure `./mcp/exposure.ts`, and what the model gets for a call `./mcp/result.ts`.
//
// **`McpTools`** is what a Session holds of its MCP tools, for its runtime, in two steps:
//
// - **`requestStart`**, in each owner message's prepare step: the host calls (skipped when the Environment has no MCP
//   servers) that find what the tools are built from, the newest inventory the host answered. A start that ends early
//   (the host failed, the Workspace did not answer, a Stop) leaves what it had. Each `servers` read takes a number as it
//   is sent, and an answer is kept only when its number is above the one kept, so of two starts in flight the later
//   read wins, whichever answers last.
// - **`reinstall`**, under the Session's one install lock: the `mcp` extension and the servers as `codemode` namespaces
//   to install (with `tool-search`) when what they are built from, with the offered tools, changed since the last
//   install; none otherwise. It builds nothing until the host lists the features the tools use (`MCP_TOOL_FEATURES`), so
//   an older host means no MCP tools, never a failure. The build is pure, so building over unchanged tools gives
//   byte-identical declarations.
//
// What an install was built from is kept (`McpToolsStore`), only what the build reads (`McpBuildServer`), so an object
// that starts again installs the very same tools before anything resumes, without asking the host: a resumed Run, a
// resumed call and the next request see the declarations the Context Window was shown. The store also keeps each
// conversation's last opened Context Window, so `windowOpened` is sent once per window across restarts.
// @effect-diagnostics missingPipeableSignature:off -- builders over plain values.
import type { McpCaller, McpRequestStart } from "@cloudpid/mcp/types";
import type { Extension } from "@earendil-works/pi-durable";
import type { CodemodeNamespace } from "@earendil-works/pi-durable/codemode";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type { Mutable } from "effect/Types";
import { McpHostClient, type McpHostClientService } from "./mcp/client.ts";
import { mayBeDirect } from "./mcp/exposure.ts";
import {
  emptyMcpExtension,
  McpBuildServer,
  mcpExtension,
  mcpNamespaces,
  type McpToolOptions,
} from "./mcp/tools.ts";

export { HostLost, McpHostClient, type McpHostClientService } from "./mcp/client.ts";

export { mayBeDirect } from "./mcp/exposure.ts";

export {
  createMcpQuestions,
  MCP_QUESTION_RECORDS,
  MCP_QUESTION_RENOTIFY_MS,
  McpQuestions,
  mcpQuestionsLayer,
  McpQuestionsError,
  type McpQuestionAsk,
  type McpQuestionOutcome,
  type McpQuestionRecord,
  type McpQuestionsOptions,
  type McpQuestionsService,
  type McpQuestionShown,
  type McpQuestionStorage,
} from "./mcp/questions.ts";

export {
  emptyMcpExtension,
  extensionName,
  MCP_CALL_SLACK_MS,
  type McpBuild,
  McpBuildServer,
  type McpCallOrigin,
  mcpExtension,
  mcpNamespaces,
  type McpToolOptions,
} from "./mcp/tools.ts";

/**
 * The host's features the tool declarations use: none are built until the host lists both (`mcp.md` → Deploys). The
 * host's own list is `MCP_HOST_FEATURES` (`@cloudpid/mcp/types`); a feature it adds reaches the tools once named here.
 */
export const MCP_TOOL_FEATURES: ReadonlyArray<string> = ["inventory", "call"];

/** How long a Session's first request waits for servers with no inventory whose tools may be `direct`: 10 s. */
export const MCP_WAIT_MS = 10_000;

/**
 * What the tools are built from: the inventory's version and servers (what the build reads of them, `McpBuildServer`),
 * the features listed, and who calls.
 */
const McpInventory = Schema.Struct({
  version: Schema.String,
  features: Schema.Array(Schema.String),
  servers: Schema.Array(McpBuildServer),
  origin: Schema.Struct({
    session: Schema.optionalKey(Schema.String),
    workspace: Schema.optionalKey(Schema.String),
  }),
});

type McpInventory = typeof McpInventory.Type;

const McpInventoryJson = Schema.fromJsonString(McpInventory);

const decodeKept = Schema.decodeUnknownOption(McpInventoryJson);

/** An inventory as the tools are built from it: decoding drops all the build does not read. */
const projected = Schema.decodeUnknownOption(McpInventory);

const encodeKept = Schema.encodeUnknownOption(McpInventoryJson);

/**
 * Where a Session keeps what its installed MCP tools were built from, as text: none when it has no MCP tools. A text
 * this build cannot read is no tools kept. It also keeps, by conversation, the Context Window whose first request
 * start last asked the host, so `windowOpened` is sent once per window whatever restarts come between.
 */
export type McpToolsStore = {
  readonly load: () => string | undefined;
  readonly save: (text: string | undefined) => void;
  readonly window: (conversation: string) => string | undefined;
  readonly openWindow: (conversation: string, window: string) => void;
};

/** A store that keeps nothing across runtimes. */
export const memoryMcpToolsStore = (): McpToolsStore => {
  let kept: string | undefined;
  const windows = new Map<string, string>();

  return {
    load: () => kept,
    save: (text) => {
      kept = text;
    },
    window: (conversation) => windows.get(conversation),
    openWindow: (conversation, window) => {
      windows.set(conversation, window);
    },
  };
};

/** What a request start needs to know. */
export type McpRequestStartInput = {
  /**
   * The conversation the request is for, the Session, and its Workspace (`ws:<id>`): the tools it builds make their
   * calls for the Session and its Workspace. Not read when there are no servers.
   */
  readonly caller: McpCaller;
  /**
   * The conversation's Context Window: its head marker's entry. The first request start in a window sets
   * `windowOpened` (the store keeps which window that was, across restarts).
   */
  readonly window: string;
  /** How many MCP servers the Environment's set has, as the Session's Settings last said. */
  readonly servers: number;
  /** `tools.offered`, which says which servers may have a `direct` tool to wait for. */
  readonly offered: ReadonlyArray<string>;
  /**
   * A call to the caller's Workspace, awaited before any host call that may reach the bridge for it: a fresh Workspace
   * marks itself then, so the host reads its `no_workspace` as destroyed only when it is
   * (`docs/architecture/mcp-in-a-session.md` → The `mcp` extension, Request start). False when the Workspace did not
   * answer: the start then calls nothing, and the tools stay as they were built.
   */
  readonly ready: Effect.Effect<boolean>;
};

/** What a reinstall installs: the `mcp` extension, and the servers for `codemode`'s namespaces. */
export type McpReinstall = {
  readonly mcp: Extension;
  readonly namespaces: ReadonlyArray<CodemodeNamespace>;
};

/** What a Session holds of its MCP tools, for its runtime. */
export type McpToolsService = {
  /** A request start's host calls: what the tools are built from, the newest the host answered. Never fails. */
  readonly requestStart: (input: McpRequestStartInput) => Effect.Effect<void>;
  /**
   * What to install for `offered` when it, or what the tools are built from, changed since the last install; none
   * otherwise. Run under the Session's install lock, with the settings in force.
   */
  readonly reinstall: (offered: ReadonlyArray<string>) => Option.Option<McpReinstall>;
};

/** The key of a Session with no MCP tools: no servers, or a host that offers none. */
const NONE = "none";

/** What an install is built from, as one key: equal keys build byte-identical extensions. */
const keyOf = (inventory: McpInventory | undefined, offered: ReadonlyArray<string>) =>
  inventory === undefined
    ? NONE
    : JSON.stringify([inventory.version, offered, inventory.features, inventory.origin]);

/**
 * The Session's `McpTools` over `client`, starting from what `store` kept of the last install, if anything: the first
 * `reinstall` installs it again.
 */
export const makeMcpTools = (
  client: McpHostClientService,
  store: McpToolsStore = memoryMcpToolsStore(),
  options: McpToolOptions = {},
): McpToolsService => {
  let saved = store.load();

  /** What the tools are built from, the newest read; undefined for none. */
  let latest: McpInventory | undefined = Option.getOrUndefined(
    saved === undefined ? Option.none() : decodeKept(saved),
  );

  // A text kept with more than the build reads (an older build's) is written again without it.
  const rewritten = latest === undefined ? undefined : Option.getOrUndefined(encodeKept(latest));

  if (rewritten !== saved) {
    store.save(rewritten);
    saved = rewritten;
  }

  /** The number of the read `latest` came from; the next read to be sent takes `taken + 1`. */
  let kept = 0;
  let taken = 0;

  /** The key of what is installed; nothing is before the first `reinstall`. */
  let installed: string | undefined;

  /** Keep `next`, read as number `read`, unless a later read was kept. */
  const keep = (read: number, next: McpInventory | undefined) => {
    if (read <= kept) return;

    kept = read;
    latest = next;
  };

  /** The servers a first request waits for: those with no inventory yet whose tools may be `direct`. */
  const waitFor = (offered: ReadonlyArray<string>) =>
    Effect.map(client.servers({ parts: [] }), (answer) =>
      Predicate.isTagged(answer, "HostFailed")
        ? []
        : Arr.map(
            Arr.filter(
              answer.servers,
              (server) => server.discoveredAt === undefined && mayBeDirect(server, offered),
            ),
            (server) => server.name,
          ),
    );

  const requestStart: McpToolsService["requestStart"] = Effect.fn("mcp.tools.request_start")(
    function* (input: McpRequestStartInput) {
      // No servers and no Resource watch: the host is never woken, and a set that emptied drops its tools.
      if (input.servers === 0) return keep(++taken, undefined);

      // The Workspace did not answer: no host call before it has.
      if (!(yield* input.ready)) return;

      const known = latest?.version;
      const wanted = known === undefined ? yield* waitFor(input.offered) : [];
      const { conversation } = input.caller;
      const opening = store.window(conversation) !== input.window;

      const start: Mutable<McpRequestStart> = { caller: input.caller };

      if (opening) start.windowOpened = true;

      if (known !== undefined) start.known = known;

      if (wanted.length > 0) {
        start.waitFor = wanted;
        start.waitMs = MCP_WAIT_MS;
      }

      const started = yield* client.requestStart(start);

      // A host that failed keeps the tools built: a request start never fails for it.
      if (Predicate.isTagged(started, "HostFailed")) return;

      if (opening) store.openWindow(conversation, input.window);

      const features = Arr.filter(MCP_TOOL_FEATURES, (each) => started.features.includes(each));

      if (features.length < MCP_TOOL_FEATURES.length) return keep(++taken, undefined);

      const origin: Mutable<McpInventory["origin"]> = {};

      if (input.caller.session !== "") origin.session = input.caller.session;

      if (input.caller.workspace !== "") origin.workspace = input.caller.workspace;

      const unchanged =
        latest !== undefined &&
        started.version === latest.version &&
        Arr.join(latest.features, "\n") === Arr.join(features, "\n") &&
        latest.origin.session === origin.session &&
        latest.origin.workspace === origin.workspace;

      // What the tools are built from is current as of this answer: a read sent before it never lands over it.
      if (unchanged) return keep(++taken, latest);

      const read = ++taken;
      const inventory = yield* client.servers({ parts: ["tools", "instructions"] });

      if (Predicate.isTagged(inventory, "HostFailed")) return;

      const next = projected({
        version: inventory.version,
        features,
        servers: inventory.servers,
        origin,
      });

      // An answer the build cannot read keeps the tools built, as a failed read does.
      if (Option.isSome(next)) keep(read, next.value);
    },
  );

  const reinstall: McpToolsService["reinstall"] = (offered) => {
    const key = keyOf(latest, offered);

    // Nothing installed yet and nothing to install: the extensions the Session started with are these.
    if (key === (installed ?? NONE)) {
      installed = key;

      return Option.none();
    }

    installed = key;

    const text = latest === undefined ? undefined : Option.getOrUndefined(encodeKept(latest));

    if (text !== saved) {
      store.save(text);
      saved = text;
    }

    return Option.some(
      latest === undefined
        ? { mcp: emptyMcpExtension, namespaces: [] }
        : {
            mcp: mcpExtension({ servers: latest.servers, offered }, client, latest.origin, options),
            namespaces: mcpNamespaces(latest.servers),
          },
    );
  };

  return { requestStart, reinstall };
};

/** The Session's MCP tools, for its runtime. */
export class McpTools extends Context.Service<McpTools, McpToolsService>()(
  "@cloudpid/extensions/mcp/McpTools",
) {}

/** `McpTools` over the Session's `McpHostClient`, keeping nothing across runtimes. */
export const mcpToolsOf = Effect.map(McpHostClient, (client) => makeMcpTools(client));
