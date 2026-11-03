// The `mcp` extension (`docs/architecture/mcp-in-a-session.md` → The `mcp` extension, Exposure; ADR-0030): one Session
// extension built from the Environment's MCP inventory, whose tools each call `McpHost.request({ op: "tools/call" })`, and
// whose resource tools (`./mcp/resources.ts`) list and read resources through the same `request`.
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
//   an older host means no MCP tools, never a failure; the resource tools also need `resources`
//   (`MCP_OPTIONAL_TOOL_FEATURES`), and a host without it gets the other tools only. The build is pure, so building over unchanged tools gives
//   byte-identical declarations.
//
// **The `mcp_servers` section and its notices** (`./mcp/servers.ts`, `./mcp/notices.ts`): every build carries the section,
// which reads the newest listing once per Context Window (frozen, so the prompt never changes within it). A conversation
// is told once of each change to the listing it was shown, in two ways. `notify`, after a request start's install, tells
// the starting conversation before its message is placed, and, when the listing changed since the last time, every other
// conversation too: an idle one (a subagent's, another branch's) gets its notice at once, so no model call of it sees
// the changed declarations without it; a busy one gets it at its next boundary. And each later request of any
// conversation asks again, which tells a busy one the broadcast could not reach in time, or after a restart. Nothing is
// told before a listing is known (a Session that has built none), so a Session without MCP servers pays nothing. A
// conversation asked about is remembered as up to date until the listing changes or its section is shown again.
//
// What an install was built from is kept (`McpToolsStore`), only what the build reads (`McpBuildServer`), so an object
// that starts again installs the very same tools before anything resumes, without asking the host: a resumed Run, a
// resumed call and the next request see the declarations the Context Window was shown. The store also keeps each
// conversation's last opened Context Window, so `windowOpened` is sent once per window across restarts.
// @effect-diagnostics missingPipeableSignature:off -- builders over plain values.
import type { McpCaller, McpRequestStart } from "@cloudpid/mcp/types";
import type { McpAppHtmlAnswer } from "@cloudpid/protocol";
import type { ConversationId, Extension } from "@earendil-works/pi-durable";
import type { CodemodeNamespace } from "@earendil-works/pi-durable/codemode";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type { Mutable } from "effect/Types";
import { McpHostClient, type McpHostClientService } from "./mcp/client.ts";
import { isReachable, mayBeDirect } from "./mcp/exposure.ts";
import { type McpNotices } from "./mcp/notices.ts";
import {
  EMPTY_LISTING,
  introFeaturesOf,
  type McpIntroFeatures,
  type McpListing,
  mcpListing,
  mcpServersSectionOf,
} from "./mcp/servers.ts";
import { signsIn } from "./mcp/sign-in-tool.ts";
import { MCP_RESOURCE_FEATURE } from "./mcp/resources.ts";
import { appToolsOf } from "./mcp/app-tools.ts";
import { appHtmlOf, MCP_APP_FEATURE, type McpAppHtmlInput } from "./mcp/apps.ts";
import { McpBuildServer, mcpExtension, mcpNamespaces, type McpToolOptions } from "./mcp/tools.ts";

export { HostLost, McpHostClient, type McpHostClientService } from "./mcp/client.ts";

export { mayBeDirect } from "./mcp/exposure.ts";

export { appToolsOf } from "./mcp/app-tools.ts";

export { MCP_APP_FEATURE, type McpAppHtmlInput, type McpAppRecorder } from "./mcp/apps.ts";

export {
  createMcpSignIns,
  MCP_SIGN_IN_TOOL,
  McpSignIns,
  McpSignInsError,
  type McpSignInAsk,
  type McpSignInOutcome,
  type McpSignInsOptions,
  type McpSignInsRegistry,
  type McpSignInsService,
  type McpSignInStorage,
} from "./mcp/sign-in.ts";

export {
  MCP_STREAM_SLOT_WAIT_MS,
  readStreamed,
  type Streamed,
  type StreamLimits,
} from "./mcp/stream.ts";

export {
  createMcpQuestions,
  MCP_QUESTION_RECORDS,
  MCP_QUESTION_RENOTIFY_MS,
  McpQuestions,
  McpQuestionsError,
  type McpQuestionAsk,
  type McpQuestionOutcome,
  type McpQuestionRecord,
  type McpQuestionsOptions,
  type McpQuestionsService,
  type McpQuestionStorage,
} from "./mcp/questions.ts";

export {
  EMPTY_LISTING,
  emptyMcpExtension,
  type McpListing,
  mcpListing,
  mcpServersNotice,
  mcpServersSection,
} from "./mcp/servers.ts";

export { type McpCheckResult, type McpNotices, mcpNotices } from "./mcp/notices.ts";

export {
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

/**
 * The features the tools may use when the host lists them, and do without when it does not: the resource tools need
 * `resources` (`./mcp/resources.ts`), and a host without it gets every other tool as before, none of these; an App
 * tool's call reads `app.htmlHash` of its answer, and `mcp_app_html` is served, only with `app_html` (`./mcp/apps.ts`).
 */
export const MCP_OPTIONAL_TOOL_FEATURES: ReadonlyArray<string> = [
  MCP_RESOURCE_FEATURE,
  MCP_APP_FEATURE,
];

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
  /** The hash of the listing the last completed broadcast told every conversation of; none before the first. */
  readonly broadcast: () => string | undefined;
  readonly broadcasted: (hash: string) => void;
};

/** A store that keeps nothing across runtimes. */
export const memoryMcpToolsStore = (): McpToolsStore => {
  let kept: string | undefined;
  const windows = new Map<string, string>();
  let broadcast: string | undefined;

  return {
    broadcast: () => broadcast,
    broadcasted: (hash) => {
      broadcast = hash;
    },
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
  /**
   * Tell every conversation of the Session of the listing this build has, when it changed since they were last asked:
   * the notices are written (queued behind a busy Run's boundary) before the caller installs the build, so no model call
   * sees the new declarations before the notice that explains them. Never fails; not interrupted.
   */
  readonly announce: Effect.Effect<void>;
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
  /**
   * The page of an App record's `htmlHash`, served through the host's `ui/html` only when the host listed `app_html` at the
   * last request start (`docs/architecture/mcp-apps.md` → Declaring and reading Apps). Never fails.
   */
  readonly appHtml: (input: McpAppHtmlInput) => Effect.Effect<McpAppHtmlAnswer>;
  /** Where notices are written: bound by the Session host once its Harness is open, before anything runs. */
  readonly bindNotices: (notices: McpNotices) => void;
  /**
   * Tell `conversation` of the listing as it is if its section was shown another, and finish a broadcast that failed
   * (a request start's check, outside any lock: it never fails, and a failure is logged and tried again by the next).
   */
  readonly notify: (conversation: ConversationId) => Effect.Effect<void>;
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

  /** The newest listing: what the section shows when it is read, and what a notice tells. */
  let current: McpListing = EMPTY_LISTING;

  /** The tools of the newest build the intro may name. */
  let features: McpIntroFeatures = introFeaturesOf([]);

  /** Whether a build has given a listing: before, `current` is no listing, and no conversation is told of it. */
  let listed = false;

  /** Whether the listing changed since every conversation was last asked, and how many changes there have been. */
  let changed = false;
  let changes = 0;

  let notices: McpNotices | undefined;

  /** The hash of the listing each conversation is known to have been told, until it changes or the section shows anew. */
  const told = new Map<ConversationId, string>();

  /** The conversations whose context showed no section when asked, until the section is shown anew in them. */
  const unshown = new Set<ConversationId>();

  /** How many times each conversation's section was shown anew, so an answer that is older than that is not kept. */
  const shownCount = new Map<ConversationId, number>();

  /** One broadcast at a time: the next finds the conversations told by the one before. */
  const broadcasting = Semaphore.makeUnsafe(1);

  /**
   * Ask each of `conversations` whether it was shown `current`, writing its notice if not, and keep what is learned.
   * False when the check could not be made for some: logged, and tried again by the next request of that conversation.
   */
  const ask = (conversations: ReadonlyArray<ConversationId>): Effect.Effect<boolean> => {
    const listing = current;
    const sink = notices;
    const due = Arr.filter(conversations, (each) => told.get(each) !== listing.hash);

    if (sink === undefined || !listed || due.length === 0) return Effect.succeed(true);

    const counted = Arr.map(due, (each) => shownCount.get(each) ?? 0);

    return Effect.tryPromise(() => sink.check({ conversations: due, listing, features })).pipe(
      Effect.flatMap((results) =>
        Effect.forEach(results, (result) => {
          if (result.outcome === "failed") {
            return Effect.logWarning(
              "The MCP servers notice could not be written",
              result.error,
            ).pipe(Effect.as(false));
          }

          return Effect.sync(() => {
            if (result.outcome === "current") {
              told.set(result.conversation, listing.hash);
            } else if (
              result.outcome === "unshown" &&
              (shownCount.get(result.conversation) ?? 0) ===
                counted[due.indexOf(result.conversation)]
            ) {
              unshown.add(result.conversation);
            }

            return true;
          });
        }),
      ),
      Effect.map((each) => Arr.every(each, Boolean)),
      Effect.catchCause((cause) =>
        Effect.logWarning("The MCP servers notice could not be written", cause).pipe(
          Effect.as(false),
        ),
      ),
    );
  };

  /** Ask whether `conversation` was shown `current`, writing its notice if not. */
  const check = (conversation: ConversationId) =>
    Effect.suspend(() => {
      unshown.delete(conversation);

      return Effect.asVoid(ask([conversation]));
    });

  /**
   * Ask every conversation of the Session that may have been shown a listing, once for each change of it. Not
   * interrupted, so a Stop of the message that ran it never leaves the rest untold; `changed` holds until all were asked,
   * so a broadcast that failed is run again by the next request.
   */
  const broadcast: Effect.Effect<void> = Effect.suspend(() => {
    const sink = notices;

    if (sink === undefined || !listed || !changed) return Effect.void;

    return broadcasting
      .withPermit(
        Effect.suspend(() => {
          if (!changed) return Effect.void;

          const at = changes;

          return Effect.tryPromise(() => sink.conversations()).pipe(
            Effect.flatMap((all) => ask(Arr.filter(all, (each) => !unshown.has(each)))),
            Effect.tap((done) =>
              Effect.sync(() => {
                if (done && changes === at) {
                  changed = false;
                  store.broadcasted(current.hash);
                }
              }),
            ),
            Effect.asVoid,
            Effect.catchCause((cause) =>
              Effect.logWarning(
                "The conversations of the Session could not be told of the MCP servers",
                cause,
              ),
            ),
          );
        }),
      )
      .pipe(Effect.uninterruptible);
  });

  /** The section, shared by every build: it reads the newest listing, and hears of each request that finds it shown. */
  const section = mcpServersSectionOf({
    listing: () => current,
    features: () => features,
    shownAnew: (conversation) => {
      told.delete(conversation);
      unshown.delete(conversation);
      shownCount.set(conversation, (shownCount.get(conversation) ?? 0) + 1);
    },
    stillShown: (conversation) => check(conversation),
  });

  const sectionOptions: McpToolOptions = { ...options, sections: [section] };

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

  /** What a request start reads: it keeps the newest inventory it can, and may leave the tools as they are. */
  const readInventory = Effect.fn("mcp.tools.read_inventory")(function* (
    input: McpRequestStartInput,
  ) {
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

    const required = Arr.filter(MCP_TOOL_FEATURES, (each) => started.features.includes(each));

    if (required.length < MCP_TOOL_FEATURES.length) return keep(++taken, undefined);

    const features = [
      ...required,
      ...Arr.filter(MCP_OPTIONAL_TOOL_FEATURES, (each) => started.features.includes(each)),
    ];

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
      // Whether each entry can need a sign-in is read here, from the entry, which the kept build never holds.
      servers: Arr.map(inventory.servers, (server) => ({
        ...server,
        signIn: signsIn(server.server),
      })),
      origin,
    });

    // An answer the build cannot read keeps the tools built, as a failed read does.
    if (Option.isSome(next)) keep(read, next.value);
  });

  /** A server of `before` the tools no longer reach in `after`: switched off, hidden or removed. */
  const unreachable = (before: McpInventory | undefined, after: McpInventory | undefined) =>
    Arr.filterMap(before?.servers ?? [], (server) => {
      if (!isReachable(server)) return Result.failVoid;

      const now = Arr.findFirst(after?.servers ?? [], (each) => each.name === server.name);

      return Option.isSome(now) && isReachable(now.value)
        ? Result.failVoid
        : Result.succeed(server.name);
    });

  const requestStart: McpToolsService["requestStart"] = Effect.fn("mcp.tools.request_start")(
    function* (input: McpRequestStartInput) {
      const before = latest;

      yield* readInventory(input);

      // A question a server waits on for a call is withdrawn when the server is switched off, hidden or removed.
      const { questions, signIns } = options;

      for (const name of unreachable(before, latest)) {
        const why = `${name} was switched off, hidden or removed`;

        if (questions !== undefined) yield* questions.withdrawServer(name, why);

        if (signIns !== undefined) yield* signIns.withdrawServer(name, why);
      }

      // A completion that was never carried here (an older deploy, a host's `working` report) is caught up now.
      if (signIns !== undefined) yield* signIns.recheck;
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

    // The App tools the build declares, for the clients' `mcp_app_tools`: told when they change.
    options.apps?.setTools(latest === undefined ? [] : appToolsOf(latest.servers));

    const text = latest === undefined ? undefined : Option.getOrUndefined(encodeKept(latest));

    if (text !== saved) {
      store.save(text);
      saved = text;
    }

    // The extension keeps its section when the servers go: a conversation shown a listing is told none is left.
    const built: McpReinstall =
      latest === undefined
        ? {
            mcp: mcpExtension({ servers: [], offered }, client, {}, sectionOptions),
            namespaces: [],
            announce: broadcast,
          }
        : {
            mcp: mcpExtension(
              { servers: latest.servers, offered, features: latest.features },
              client,
              latest.origin,
              sectionOptions,
            ),
            namespaces: mcpNamespaces(latest.servers),
            announce: broadcast,
          };

    const listing = mcpListing(latest?.servers ?? [], offered);

    // The first listing of an object is a change only if the last broadcast that completed told another (a wake with
    // the kept listing told reads no conversation; one a crash cut off finishes it).
    if (listed ? listing.hash !== current.hash : listing.hash !== store.broadcast()) {
      changed = true;
      changes += 1;
    }

    listed = true;
    current = listing;
    features = introFeaturesOf(Arr.map(built.mcp.tools ?? [], (tool) => tool.name));

    return Option.some(built);
  };

  return {
    requestStart,
    reinstall,
    appHtml: (input) =>
      appHtmlOf(
        client,
        latest?.features.includes(MCP_APP_FEATURE) === true,
        latest?.origin ?? {},
        input,
      ),
    bindNotices: (next) => {
      notices = next;
    },
    notify: (conversation) => Effect.andThen(check(conversation), broadcast),
  };
};

/** The Session's MCP tools, for its runtime. */
export class McpTools extends Context.Service<McpTools, McpToolsService>()(
  "@cloudpid/extensions/mcp/McpTools",
) {}

/** `McpTools` over the Session's `McpHostClient`, keeping nothing across runtimes. */
export const mcpToolsOf = Effect.map(McpHostClient, (client) => makeMcpTools(client));
