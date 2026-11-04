// The Session socket (`docs/architecture/client-and-protocol.md`, ADR-0009): clients' hibernatable WebSockets to the Session
// DO, carrying `@cloudpid/protocol`'s Session messages. As in the socket glue of Cloudflare's `agents` pi example,
// watches live in memory and each socket's attachment names the conversations it watches, so an instance woken from
// hibernation restarts them, each with a fresh snapshot, on sockets that never closed.
import {
  type Annotation,
  type ApprovalRequest,
  type Catalog,
  type ChangeFile,
  type CommandOutcome,
  type CompareResult,
  type ComparisonSources,
  type RunDiff,
  ConversationId,
  decodeClientMessage,
  type FileMatches,
  type McpResourceMenu,
  type HistoryPage,
  type Navigated,
  type SessionTree,
  type ViewedFile,
  HEARTBEAT,
  type LiveViewLinks,
  type OwnerTabLinks,
  type OwnerTabListing,
  type ClientMessage,
  type McpAppEntry,
  type McpAppHtmlAnswer,
  type McpAppMounted,
  type McpAppRequestAnswer,
  type McpAppTool,
  type SentAppMessage,
  type McpTask,
  type McpWatchEntry,
  type McpResourcePreviewAnswer,
  type McpCompletion,
  type McpElicitationRequest,
  type McpSamplingRequest,
  type McpSamplingSessionGrant,
  type McpSignInRequest,
  type ServerMessage,
  ServerMessageJson,
  cleanPage,
  cleanText,
} from "@cloudpid/protocol";
import { parseModelId } from "@cloudpid/config";
import {
  SECRET_LIFETIME_MS,
  type SecretAsk,
  Secrets,
  type SecretsError,
} from "@cloudpid/extensions/secrets";
import { type ApprovalAsk, Approvals, type ApprovalsError } from "@cloudpid/extensions/approvals";
import {
  McpQuestions,
  McpSampling,
  McpQuestionsError,
  McpSignIns,
  type McpSignInsError,
} from "@cloudpid/extensions/mcp";
import {
  BrowserError,
  type BrowserHandoffRequest,
  BrowserHandoffs,
  BrowserPane,
  type OwnerTabDriver,
  OwnerTabDrivers,
} from "@cloudpid/extensions/browser";
import type { AgentChange } from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type * as Types from "effect/Types";
import { AnnotationStore } from "./annotations.ts";
import { type ChangesMessage, type ChangesUpdate, SessionChanges } from "./changes.ts";
import { SessionComparisons } from "./comparisons.ts";
import { SessionRuns } from "./runs.ts";
import { isWithdrawn, SessionError } from "./errors.ts";
import { SessionHost } from "./host.ts";
import { SessionReviews } from "./reviews.ts";
import { McpApps } from "./mcp-apps.ts";
import { McpWatches } from "./mcp-watches.ts";
import { McpResourcePreviews, type SpillRead } from "./mcp-resource-previews.ts";
import { socketCompletions } from "./mcp-completions.ts";
import { ViewedStore } from "./viewed.ts";

/**
 * The parts of a Durable Object's `ctx` the sockets use. Narrow on purpose, as `SessionStorage` is, so the module and
 * global declarations of the state both fit it.
 */
export type SocketState = {
  acceptWebSocket(ws: WebSocket): void;
  getWebSockets(): WebSocket[];
  setWebSocketAutoResponse(pair: WebSocketRequestResponsePair): void;
};

type ErrorMessage = Extract<ServerMessage, { type: "error" }>;

/**
 * What a socket keeps across hibernation: the conversations it watches, whether it watches the task graph, the
 * Session's usage and the Session's Changes, and the conversations whose Changes it watches (ADR-0024).
 */
const Attachment = Schema.Struct({
  watches: Schema.Array(ConversationId),
  taskGraph: Schema.optionalKey(Schema.Boolean),
  usage: Schema.optionalKey(Schema.Boolean),
  changes: Schema.optionalKey(Schema.Boolean),
  conversationChanges: ConversationId.pipe(Schema.Array, Schema.optionalKey),
  /** Whether the page said it is visible (`page_visible`); a page that has not said is not. */
  visible: Schema.optionalKey(Schema.Boolean),
});

type Attachment = typeof Attachment.Type;

const encodeMessage = Schema.encodeEffect(ServerMessageJson);

/** The `id` of a message that is not a valid command, so its error can answer it. */
const decodeCommandId = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ id: Schema.String })),
);

const decodeAttachment = Schema.decodeUnknownOption(Attachment);

export type SessionSocketsService = {
  /** Accept a new client and greet it: the result is the client's end, to answer the upgrade with. */
  readonly connect: Effect.Effect<WebSocket, SessionError>;
  /** Handle a message a client sent on `socket`. */
  readonly receive: (socket: WebSocket, message: string | ArrayBuffer) => Effect.Effect<void>;
  /** `socket` closed or failed: stop its watches. */
  readonly drop: (socket: WebSocket) => Effect.Effect<void>;
  /**
   * Close every client's socket, so each connects again and is greeted as the Session is now: a Fork or Clone's copy
   * ended, which its `hello` said was under way.
   */
  readonly greetAgain: Effect.Effect<void>;
  /** Tell every connected client which of the model and thinking level the Session picked, after a `configure` by other means. */
  readonly announcePicks: Effect.Effect<void>;
};

/** WebSocket's "Service Restart": the client connects again at once, as after any close but the Session's deletion. */
const SERVICE_RESTART_CLOSE_CODE = 1012;

/** The Session DO's client sockets. */
export class SessionSockets extends Context.Service<SessionSockets, SessionSocketsService>()(
  "@cloudpid/server/session/sockets/SessionSockets",
) {}

/** Send `message` on `socket`, unless it has closed. */
// @effect-diagnostics-next-line missingPipeableSignature:off -- a plain helper, not an Effect operator.
export const send = (socket: WebSocket, message: ServerMessage): Effect.Effect<void> =>
  encodeMessage(message).pipe(
    Effect.flatMap((text) =>
      Effect.try({
        try: () => socket.send(text),
        // The socket closed; its close event drops it.
        catch: () => undefined,
      }),
    ),
    Effect.ignore,
  );

/** The `secret_requests` message for `asks`. */
export const secretRequests = (asks: ReadonlyArray<SecretAsk>): ServerMessage => ({
  type: "secret_requests",
  lifetimeMinutes: SECRET_LIFETIME_MS / 60_000,
  requests: Arr.map(asks, (ask) => ({
    ...ask,
    // SAFETY: an ask's conversation is the asking call's, a pi-durable conversation ID.
    conversationId: ask.conversationId as ConversationId,
  })),
});

/**
 * The `browser_handoff_requests` message for `requests`, which every client is sent. It holds no Live View link: those
 * answer `live_view`, to the one client that asked.
 */
export const browserHandoffRequests = (
  requests: ReadonlyArray<BrowserHandoffRequest>,
): ServerMessage => ({
  type: "browser_handoff_requests",
  requests: Arr.map(requests, (request) => ({
    ...request,
    // SAFETY: a handoff's conversation is the asking call's, a pi-durable conversation ID.
    conversationId: request.conversationId as ConversationId,
  })),
});

/** The `owner_tabs` message for `tabs`, which every client is sent when one changes them. It holds no Live View link. */
export const ownerTabsMessage = (tabs: OwnerTabListing): ServerMessage => ({
  type: "owner_tabs",
  ...tabs,
});

/**
 * The `owner_tab_drivers` message for `drivers`, which every client is sent: which `browser` calls work in Owner tabs
 * now.
 */
export const ownerTabDriversMessage = (drivers: ReadonlyArray<OwnerTabDriver>): ServerMessage => ({
  type: "owner_tab_drivers",
  drivers,
});

/** The `mcp_elicitation_requests` message for `requests` and the servers declined for this Session, which every client is sent. */
// @effect-diagnostics-next-line missingPipeableSignature:off -- builds a message, not a combinator.
export const mcpElicitationRequests = (
  requests: ReadonlyArray<McpElicitationRequest>,
  declined: ReadonlyArray<string> = [],
): ServerMessage =>
  declined.length === 0
    ? { type: "mcp_elicitation_requests", requests }
    : { type: "mcp_elicitation_requests", requests, declined };

/** The `mcp_sampling_requests` message for `requests` and the Session's `grants`, which every client is sent. */
// @effect-diagnostics-next-line missingPipeableSignature:off -- builds a message, not a combinator.
export const mcpSamplingRequests = (
  requests: ReadonlyArray<McpSamplingRequest>,
  grants: ReadonlyArray<McpSamplingSessionGrant>,
): ServerMessage => ({ type: "mcp_sampling_requests", requests, grants });

/** The `mcp_sign_in_requests` message for `requests`, which every client is sent. */
export const mcpSignInRequests = (requests: ReadonlyArray<McpSignInRequest>): ServerMessage => ({
  type: "mcp_sign_in_requests",
  requests,
});

/**
 * The `approval_requests` message for `requests`, which every client is sent: each request as the card shows it, without
 * the value the call checks once approved.
 */
export const approvalRequests = (requests: ReadonlyArray<ApprovalAsk>): ServerMessage => ({
  type: "approval_requests",
  requests: Arr.map(requests, (request) => {
    const shown: Types.Mutable<ApprovalRequest> = {
      id: request.id,
      // SAFETY: a request's conversation is the asking call's, a pi-durable conversation ID.
      conversationId: request.conversationId as ConversationId,
      tool: request.tool,
      target: request.target,
      change: request.change,
      before: request.before,
      after: request.after,
      reason: request.reason,
    };

    if (request.notes !== undefined) shown.notes = request.notes;

    return shown;
  }),
});

/** The `annotations` message for `drafts`, which every client is sent whenever they change. */
export const annotationsMessage = (drafts: ReadonlyArray<Annotation>): ServerMessage => ({
  type: "annotations",
  annotations: drafts,
});

/** The `viewed` message for `viewed`, which every client is sent whenever the boxes change. */
export const viewedMessage = (viewed: ReadonlyArray<ViewedFile>): ServerMessage => ({
  type: "viewed",
  viewed,
});

/** What every `hello` says this Session takes (a client gates the commands and requests on them). */
const HELLO_FEATURES = {
  appViews: true,
  mcpTasks: true,
  attachedResources: true,
  resourcePreviews: true,
  appMessages: true,
  appContext: true,
  mcpDecline: true,
  mcpCompletions: true,
} as const;

/** The `mcp_app_tools` message for `tools`, which every client is sent after `hello` and whenever the inventory changes them. */
export const mcpAppToolsMessage = (tools: ReadonlyArray<McpAppTool>): ServerMessage => ({
  type: "mcp_app_tools",
  tools,
});

/** The `mcp_tasks` message for `tasks`, which every client is sent after `hello` and whenever the list changes. */
export const mcpTasksMessage = (tasks: ReadonlyArray<McpTask>): ServerMessage => ({
  type: "mcp_tasks",
  tasks,
});

/** Why an owner's cancel of an MCP task was not sent, by what it came to; `sent` and `already_sent` took. */
const MCP_TASK_CANCEL_REFUSALS = {
  failed: "The server could not be asked to cancel the task; try again",
  ended: "The task has ended",
  unknown: "The Session has no such MCP task",
} as const;

/** Why Keep the Container did not, by what it came to; `kept` took. */
const CONTAINER_KEEP_REFUSALS = {
  not_stdio: "Only a stdio server's task keeps a Container",
  ended: "The task has ended",
  unknown: "The Session has no such MCP task",
  failed: "The Container could not be kept; try again",
} as const;

/**
 * The answer to an owner's MCP task command that came to `outcome`: `null` when it is one of `took`, else the refusal's
 * words. The refusals are keyed by every outcome that did not take, so a new outcome nobody mapped is a type error and
 * never an answer of success.
 */
const ownerCommandAnswer = <Outcome extends string, Took extends Outcome>(
  operation: string,
  outcome: Outcome,
  took: ReadonlyArray<Took>,
  refusals: { readonly [Refused in Exclude<Outcome, Took>]: string },
): Effect.Effect<null, SessionError> => {
  const widened: ReadonlyArray<Outcome> = took;

  if (widened.includes(outcome)) return Effect.succeed(null);

  // SAFETY: `outcome` is none of `took`, which is what `refusals` is keyed by.
  const refused = outcome as Exclude<Outcome, Took>;

  return Effect.fail(SessionError.make({ operation, message: refusals[refused] }));
};

/** The `mcp_watches` message for `watches`, which every client is sent after `hello` and whenever a watch starts or ends. */
export const mcpWatchesMessage = (watches: ReadonlyArray<McpWatchEntry>): ServerMessage => ({
  type: "mcp_watches",
  watches,
});

/** The `mcp_apps` message for `conversationId`'s App calls, which each client watching it is sent. */
// @effect-diagnostics-next-line missingPipeableSignature:off -- a plain helper, not an Effect operator.
export const mcpAppsMessage = (
  conversationId: ConversationId,
  apps: ReadonlyArray<McpAppEntry>,
): ServerMessage => ({ type: "mcp_apps", conversationId, apps });

/**
 * The agent change a `configure` asks for: a field it leaves out is left out, as is. The socket's `configure` and the MCP
 * endpoint's (`SessionMethods.configure`) share it.
 */
export const agentChange = (
  message: Pick<Extract<ClientMessage, { type: "configure" }>, "model" | "thinkingLevel">,
): AgentChange => {
  const change: Types.Mutable<AgentChange> = {};

  if (message.model !== undefined) {
    change.model = message.model === null ? null : parseModelId(message.model);
  }

  if (message.thinkingLevel !== undefined) change.thinkingLevel = message.thinkingLevel;

  return change;
};

/**
 * What `update` is sent as to a watch of the Changes `conversationId` names, which the message names as the client
 * did: a list, or the `error` marked `changes` of a listing that failed.
 */
const changesUpdate = (
  update: ChangesUpdate,
  conversationId: ConversationId | undefined,
): ChangesMessage | ErrorMessage => {
  const message: ChangesMessage | ErrorMessage =
    update.kind === "changes"
      ? update.message
      : { type: "error", changes: true, message: update.message };

  return conversationId === undefined ? message : { ...message, conversationId };
};

/**
 * The `error` that ends the Changes watch `conversationId` names: its conversation is no agent's any more (a subagent
 * deleted), so the client drops it rather than watching it again.
 */
const changesEnded = (conversationId: ConversationId, message: string): ErrorMessage => ({
  type: "error",
  changes: true,
  ended: true,
  conversationId,
  message: `Changes watch of conversation ${conversationId} ended: ${message}`,
});

const readAttachment = (socket: WebSocket): Attachment =>
  Option.getOrElse(decodeAttachment(socket.deserializeAttachment()), () => ({ watches: [] }));

/** Record that `socket` watches `conversationId`, or no longer does. */
const setWatched = (socket: WebSocket, conversationId: ConversationId, watched: boolean) =>
  Effect.sync(() => {
    const attachment = readAttachment(socket);
    const others = Arr.filter(attachment.watches, (id) => id !== conversationId);

    socket.serializeAttachment({
      ...attachment,
      watches: watched ? Arr.append(others, conversationId) : others,
    } satisfies Attachment);
  });

/** The conversation an App record names, as the number's text it keeps. */
// SAFETY: a record's `conversation` is the text of the `ConversationId` it was made in.
const conversationOf = (text: string): ConversationId => Number(text) as ConversationId;

/** Record whether `socket`'s page is visible. */
const setVisible = (socket: WebSocket, visible: boolean) =>
  Effect.sync(() => {
    socket.serializeAttachment({ ...readAttachment(socket), visible } satisfies Attachment);
  });

/** Record that `socket` watches the task graph, or no longer does. */
const setGraphWatched = (socket: WebSocket, watched: boolean) =>
  Effect.sync(() => {
    socket.serializeAttachment({
      ...readAttachment(socket),
      taskGraph: watched,
    } satisfies Attachment);
  });

/** Record that `socket` watches the Session's usage, or no longer does. */
const setUsageWatched = (socket: WebSocket, watched: boolean) =>
  Effect.sync(() => {
    socket.serializeAttachment({
      ...readAttachment(socket),
      usage: watched,
    } satisfies Attachment);
  });

/** Record that `socket` watches the Changes `conversationId` names (none: the Session's), or no longer does. */
const setChangesWatched = (
  socket: WebSocket,
  conversationId: ConversationId | undefined,
  watched: boolean,
) =>
  Effect.sync(() => {
    const attachment = readAttachment(socket);

    if (conversationId === undefined) {
      socket.serializeAttachment({ ...attachment, changes: watched } satisfies Attachment);

      return;
    }

    const others = Arr.filter(attachment.conversationChanges ?? [], (id) => id !== conversationId);

    socket.serializeAttachment({
      ...attachment,
      conversationChanges: watched ? Arr.append(others, conversationId) : others,
    } satisfies Attachment);
  });

/** The key of a socket's task graph watch among its watches. */
const TASK_GRAPH = "task_graph";

/** The key of a socket's usage watch among its watches. */
const USAGE = "usage";

/** The key of a socket's watch of the Session's Changes among its watches. */
const CHANGES = "changes";

type WatchKey =
  | ConversationId
  | typeof TASK_GRAPH
  | typeof USAGE
  | typeof CHANGES
  | `${typeof CHANGES}:${number}`;

/** The key of a socket's watch of the Changes `conversationId` names (none: the Session's) among its watches. */
const changesKey = (conversationId: ConversationId | undefined): WatchKey =>
  conversationId === undefined ? CHANGES : `${CHANGES}:${conversationId}`;

/**
 * The Session's sockets over the object's `state`. Building it restarts the watches of sockets that outlived the last
 * instance, so build it once, from the object's constructor, before any socket event is handled.
 */
export const sessionSocketsLayer = (
  state: SocketState,
): Layer.Layer<
  SessionSockets,
  never,
  | SessionHost
  | SessionChanges
  | SessionComparisons
  | SessionRuns
  | Secrets
  | BrowserHandoffs
  | BrowserPane
  | OwnerTabDrivers
  | Approvals
  | McpQuestions
  | McpSampling
  | McpSignIns
  | AnnotationStore
  | ViewedStore
  | McpApps
  | McpWatches
  | McpResourcePreviews
  | SessionReviews
> =>
  Layer.effect(
    SessionSockets,
    Effect.gen(function* () {
      const host = yield* SessionHost;
      const changes = yield* SessionChanges;
      const comparisons = yield* SessionComparisons;
      const runs = yield* SessionRuns;
      const annotations = yield* AnnotationStore;
      const viewed = yield* ViewedStore;
      const mcpApps = yield* McpApps;
      const mcpWatches = yield* McpWatches;
      const resourcePreviews = yield* McpResourcePreviews;
      const reviews = yield* SessionReviews;
      const secrets = yield* Secrets;
      const handoffs = yield* BrowserHandoffs;
      const browserPane = yield* BrowserPane;
      const drivers = yield* OwnerTabDrivers;
      const approvals = yield* Approvals;
      const mcpQuestions = yield* McpQuestions;
      const mcpSampling = yield* McpSampling;
      const mcpSignIns = yield* McpSignIns;
      const scope = yield* Effect.scope;
      /** Each open socket's running watches, by conversation. */
      const watching = new Map<WebSocket, FiberMap.FiberMap<WatchKey>>();

      // Answered by the runtime, so a client's heartbeat never wakes a hibernated object.
      state.setWebSocketAutoResponse(
        new WebSocketRequestResponsePair(HEARTBEAT.request, HEARTBEAT.response),
      );

      const watchesOf = (socket: WebSocket) =>
        Effect.suspend(() => {
          const existing = watching.get(socket);

          if (existing !== undefined) return Effect.succeed(existing);

          return FiberMap.make<WatchKey>().pipe(
            Effect.tap((fibers) => Effect.sync(() => watching.set(socket, fibers))),
            Scope.provide(scope),
          );
        });

      /**
       * Stream `conversationId`'s events to `socket`, replacing a watch it already has, and resolve once its snapshot
       * is sent, or once a newer watch or the socket's close replaces it. The socket's attachment records the watch
       * before it starts, and a watch that fails drops it, so the attachment never names a watch no fiber runs. One
       * that fails after its snapshot tells the client, by `conversationId`.
       */
      const watch = (socket: WebSocket, conversationId: ConversationId) =>
        Effect.gen(function* () {
          const fibers = yield* watchesOf(socket);
          const started = yield* Deferred.make<void, SessionError>();
          let listsStarted = false;

          yield* setWatched(socket, conversationId, true);
          yield* host.events(conversationId).pipe(
            Stream.runForEach((events) =>
              send(socket, { type: "events", conversationId, events }).pipe(
                // After the first batch, the snapshot, so the client has the conversation before its list.
                Effect.andThen(
                  Effect.suspend(() => {
                    if (listsStarted) return Effect.void;

                    listsStarted = true;

                    return Effect.forkChild(streamTodos(socket, conversationId)).pipe(
                      Effect.andThen(Effect.forkChild(streamMcpApps(socket, conversationId))),
                      Effect.asVoid,
                    );
                  }),
                ),
                Effect.andThen(Deferred.succeed(started, undefined)),
              ),
            ),
            Effect.catch((error) =>
              setWatched(socket, conversationId, false).pipe(
                Effect.andThen(Deferred.fail(started, error)),
                Effect.flatMap((first) =>
                  first
                    ? Effect.void
                    : send(socket, { type: "error", conversationId, message: error.message }),
                ),
              ),
            ),
            Effect.onInterrupt(() => Deferred.succeed(started, undefined)),
            FiberMap.run(fibers, conversationId),
          );

          yield* Deferred.await(started);
        });

      /**
       * Stream `conversationId`'s Todo List to `socket`. It runs as a child of the conversation's watch, so it ends with
       * it: whenever the watch is replaced, unwatched, fails or its socket closes. The list is not what the watch is for:
       * one that fails does not end the conversation's watch. It is logged and the client is told, and keeps the last
       * list it was sent.
       */
      const streamTodos = (socket: WebSocket, conversationId: ConversationId) =>
        host.todos(conversationId).pipe(
          Stream.runForEach((tasks) => send(socket, { type: "todos", conversationId, tasks })),
          Effect.catch((error) =>
            Effect.logWarning("Todo List watch ended", error).pipe(
              Effect.andThen(
                send(socket, {
                  type: "error",
                  message: `Todo List updates stopped: ${error.message}`,
                }),
              ),
            ),
          ),
        );

      /**
       * Stream `conversationId`'s App calls to `socket`, as its Todo List is (`mcp_apps`): the list now, and again each time
       * a record is kept, evicted or copied. A child of the conversation's watch, so it ends with it; one that fails is
       * logged, and the client keeps the last list it was sent.
       */
      const streamMcpApps = (socket: WebSocket, conversationId: ConversationId) =>
        mcpApps.updates(conversationId).pipe(
          Stream.runForEach((apps) => send(socket, mcpAppsMessage(conversationId, apps))),
          Effect.catchCause((cause) => Effect.logWarning("App calls watch ended", cause)),
        );

      /**
       * Stream the task graph's summaries to `socket`, replacing a watch it already has. The first summary follows
       * shortly; a watch that fails is dropped and the client told.
       */
      const watchGraph = (socket: WebSocket) =>
        Effect.gen(function* () {
          const fibers = yield* watchesOf(socket);

          yield* setGraphWatched(socket, true);
          yield* host.taskGraph.pipe(
            Stream.runForEach((summary) => send(socket, { type: "task_graph", ...summary })),
            Effect.catch((error) =>
              setGraphWatched(socket, false).pipe(
                Effect.andThen(
                  send(socket, {
                    type: "error",
                    message: `Task graph watch ended: ${error.message}`,
                  }),
                ),
              ),
            ),
            FiberMap.run(fibers, TASK_GRAPH),
          );
        });

      const unwatchGraph = (socket: WebSocket) =>
        Effect.suspend(() => {
          const fibers = watching.get(socket);

          return (fibers === undefined ? Effect.void : FiberMap.remove(fibers, TASK_GRAPH)).pipe(
            Effect.andThen(setGraphWatched(socket, false)),
          );
        });

      /** Stream the Session's usage to `socket`, replacing a watch it already has; one that fails is dropped and the client told. */
      const watchUsage = (socket: WebSocket) =>
        Effect.gen(function* () {
          const fibers = yield* watchesOf(socket);

          yield* setUsageWatched(socket, true);
          yield* host.usage.pipe(
            Stream.runForEach((usage) => send(socket, { type: "usage", ...usage })),
            Effect.catch((error) =>
              setUsageWatched(socket, false).pipe(
                Effect.andThen(
                  send(socket, {
                    type: "error",
                    message: `Usage watch ended: ${error.message}`,
                  }),
                ),
              ),
            ),
            FiberMap.run(fibers, USAGE),
          );
        });

      const unwatchUsage = (socket: WebSocket) =>
        Effect.suspend(() => {
          const fibers = watching.get(socket);

          return (fibers === undefined ? Effect.void : FiberMap.remove(fibers, USAGE)).pipe(
            Effect.andThen(setUsageWatched(socket, false)),
          );
        });

      /**
       * The Workspace whose Changes `conversationId` names: the Session's own when it is undefined, else the one that
       * conversation works in (ADR-0024). A conversation that is neither a Session branch nor a subagent's fails.
       */
      const changesWorkspace = (conversationId: ConversationId | undefined) =>
        conversationId === undefined ? Effect.undefined : host.workspaceOf(conversationId);

      /**
       * Send `socket` the Changes `conversationId` names (none: the Session's), replacing that watch if it has it: the
       * last list at once if there is one, then each listing, which every client watching the same Workspace shares.
       * Each message names the conversation as the client did. A listing that fails tells the client, and the watch goes
       * on. A conversation's watch follows it to another Workspace, and ends, telling the client, once the conversation
       * is no agent's; one that is none already fails before anything is watched.
       */
      const watchChanges = (socket: WebSocket, conversationId: ConversationId | undefined) =>
        Effect.gen(function* () {
          yield* changesWorkspace(conversationId);

          const fibers = yield* watchesOf(socket);

          const updates: Stream.Stream<ChangesUpdate, SessionError> =
            conversationId === undefined
              ? changes.updates(undefined)
              : host
                  .workspaces(conversationId)
                  .pipe(Stream.switchMap((workspace) => changes.updates(workspace)));

          yield* setChangesWatched(socket, conversationId, true);
          yield* updates.pipe(
            Stream.runForEach((update) => send(socket, changesUpdate(update, conversationId))),
            Effect.catch((error) =>
              setChangesWatched(socket, conversationId, false).pipe(
                Effect.andThen(
                  conversationId === undefined
                    ? Effect.void
                    : send(socket, changesEnded(conversationId, error.message)),
                ),
              ),
            ),
            FiberMap.run(fibers, changesKey(conversationId)),
          );
        });

      const unwatchChanges = (socket: WebSocket, conversationId: ConversationId | undefined) =>
        Effect.suspend(() => {
          const fibers = watching.get(socket);

          return (
            fibers === undefined ? Effect.void : FiberMap.remove(fibers, changesKey(conversationId))
          ).pipe(Effect.andThen(setChangesWatched(socket, conversationId, false)));
        });

      const unwatch = (socket: WebSocket, conversationId: ConversationId) =>
        Effect.suspend(() => {
          const fibers = watching.get(socket);

          return fibers === undefined ? Effect.void : FiberMap.remove(fibers, conversationId);
        });

      // The completions of each socket (`mcp-completions.ts`): counted, in flight by `requestId`, and a newer request for a
      // form field ends the older one.
      const completions = socketCompletions(Date.now);

      /** One completion of a form field: its answer however it ends, which is never an error. Starts no Container. */
      const complete = (
        socket: WebSocket,
        message: Extract<ClientMessage, { type: "mcp_complete" }>,
      ) =>
        completions.complete(socket, message, (signal) =>
          host.mcpComplete({
            conversationId: message.conversationId,
            server: message.server,
            ref: message.ref,
            argument: message.argument,
            context: message.context,
            signal,
          }),
        );

      const command = (
        socket: WebSocket,
        message: ClientMessage,
      ): Effect.Effect<
        | { readonly submissionId: number }
        | Catalog
        | ChangeFile
        | CommandOutcome
        | CompareResult
        | ComparisonSources
        | RunDiff
        | FileMatches
        | McpResourceMenu
        | HistoryPage
        | SessionTree
        | Navigated
        | LiveViewLinks
        | OwnerTabLinks
        | OwnerTabListing
        | McpAppMounted
        | McpAppHtmlAnswer
        | McpAppRequestAnswer
        | McpResourcePreviewAnswer
        | McpCompletion
        | null,
        | SessionError
        | SecretsError
        | BrowserError
        | ApprovalsError
        | McpQuestionsError
        | McpSignInsError,
        // A command that holds something until its answer is sent (a large preview's decode slot) ends with the scope.
        Scope.Scope
      > => {
        switch (message.type) {
          case "tree":
            return host.tree;
          case "navigate": {
            const { type: _type, id: _id, ...request } = message;

            return host
              .navigate(request)
              .pipe(Effect.tap((navigated) => announceBranch(navigated.conversationId)));
          }

          case "switch_branch":
            return host
              .switchBranch(message.conversationId)
              .pipe(Effect.andThen(announceBranch(message.conversationId)), Effect.as(null));
          case "submit": {
            const {
              type: _type,
              id: _id,
              pages: refs,
              annotations: ids,
              mcpPrompt: picked,
              resources: attached,
              app: appMessages,
              ...typed
            } = message;

            // An MCP prompt is got when the message is admitted; the Secrets held are redacted from what it sends and
            // keeps. A Review's summary is its own message, which a prompt does not join.
            if (picked !== undefined && ids !== undefined) {
              return Effect.fail(
                SessionError.make({
                  operation: "submit",
                  message: "An MCP prompt cannot go with a Review",
                  code: "MCP_PROMPT_FAILED",
                  server: picked.server,
                }),
              );
            }

            // The MCP resources attached are read in the message's prepare step too, and a Review's summary is its own
            // message, which they do not join.
            if (attached !== undefined && attached.length > 0 && ids !== undefined) {
              return Effect.fail(
                SessionError.make({
                  operation: "submit",
                  message: "Attached MCP resources cannot go with a Review: remove them first",
                }),
              );
            }

            // The App messages are the owner's own words from a chip, and a Review's summary is its own message too.
            if (appMessages !== undefined && appMessages.length > 0 && ids !== undefined) {
              return Effect.fail(
                SessionError.make({
                  operation: "submit",
                  message: "App messages cannot go with a Review: send or discard them first",
                }),
              );
            }

            // The pages are read from the browser in the message's prepare step (outside the Session's lock, in its
            // conversation's line, and not again for a resent request), cleaned and then redacted of held Secrets before they are cut, stored, escaped or sent to
            // any client (so a Secret split by a character the cleaning drops is whole when redacted); one that is gone
            // fails the command, so the owner removes its chip, rather than going without it.
            const attachPages = secrets.refresh.pipe(
              Effect.andThen(browserPane.attach(refs ?? [])),
              Effect.map((pages) => secrets.redact(Arr.map(pages, (page) => cleanPage(page)))),
              Effect.mapError((error) =>
                SessionError.make({ operation: "submit", message: error.message }),
              ),
            );

            const withPages =
              refs === undefined || refs.length === 0 ? typed : { ...typed, attachPages };

            // What a server answers for a prompt or a resource is redacted of the Secrets held, as the rest of the message's text is.
            const redactor = secrets.refresh.pipe(
              Effect.as(<A>(value: A): A => secrets.redact(value)),
            );

            const withPagesAndPrompt =
              picked === undefined
                ? withPages
                : { ...withPages, mcpPrompt: { ref: picked, redact: redactor } };

            const withResources =
              attached === undefined || attached.length === 0
                ? withPagesAndPrompt
                : { ...withPagesAndPrompt, resources: { refs: attached, redact: redactor } };

            // What the Views offered goes as the owner's, from the chips they saw: cleaned and redacted of the Secrets held, and named
            // by the call's record, never by the message.
            const sentApps: Effect.Effect<ReadonlyArray<SentAppMessage>> =
              appMessages === undefined || appMessages.length === 0
                ? Effect.succeed([])
                : secrets.refresh.pipe(
                    Effect.andThen(mcpApps.serversOf(Arr.map(appMessages, (each) => each.callId))),
                    Effect.map((servers) =>
                      Arr.flatMap(appMessages, (each, index) => {
                        const text = secrets.redact(cleanText(each.text)).trim();

                        return text === ""
                          ? []
                          : [{ callId: each.callId, server: servers[index] ?? "", text }];
                      }),
                    ),
                  );

            // With drafts, it is a Review: its summary is what was typed.
            return sentApps.pipe(
              Effect.map((apps) =>
                apps.length === 0 ? withResources : { ...withResources, apps },
              ),
              Effect.flatMap((made) =>
                ids === undefined
                  ? host.submit(made)
                  : reviews.submit({ ...made, annotations: ids }),
              ),
              Effect.map((submissionId) => ({ submissionId })),
              // Stop withdrew it before it was placed: answered with `null`, which a client takes as it takes withdrawn
              // queued input, gone without a failure, for the owner to send again.
              Effect.catchIf(isWithdrawn, () => Effect.succeed(null)),
            );
          }

          case "abort": {
            const { type: _type, id: _id, ...options } = message;

            return host.abort(options).pipe(Effect.as(null));
          }

          case "catalog":
            return host.catalog(message.conversationId);
          case "files": {
            const { type: _type, id: _id, ...search } = message;

            return host.files(search);
          }

          // The `@` menu's MCP resources: the servers' lists, which start no Container.
          case "mcp_resource_menu":
            return host.resourceMenu(message.conversationId);

          // Answered to this socket alone, as every command is: the links are never stored or sent to other clients.
          case "live_view":
            return handoffs.liveView(message.requestId);

          // The Browser Pane's links, answered to this socket alone the same way. An Owner tab it opened is a use of the
          // browser: settling arms the wake for its idle close, which an idle Session would otherwise not have.
          case "owner_tab_view":
            return browserPane
              .view(message.open)
              .pipe(Effect.tap((links) => (links.opened ? settleInBackground : Effect.void)));

          // The Owner tabs hold no link, so a change goes to every client: a second device shows the tab the first
          // switched to, and sees the tabs it opened and closed.
          // Asked by a Pane in view with `watching`, the listing is its heartbeat: it holds the browser's idle close off. A
          // beat that set a close time where there was none arms the wake, which settling does.
          case "owner_tab_list":
            return message.watching === true
              ? browserPane.watchedTabs.pipe(
                  Effect.tap(({ arm }) => (arm ? settleInBackground : Effect.void)),
                  Effect.map(({ tabs }) => tabs),
                )
              : browserPane.tabs;
          case "owner_tab_open":
            return browserPane.open.pipe(
              Effect.tap(() => settleInBackground),
              Effect.tap(announceOwnerTabs),
            );
          case "owner_tab_show":
            return browserPane.show(message.ownerTabId).pipe(Effect.tap(announceOwnerTabs));
          case "owner_tab_close":
            return browserPane.close(message.ownerTabId).pipe(Effect.tap(announceOwnerTabs));

          case "command": {
            const { type: _type, id: _id, ...command } = message;

            return host.command(command);
          }

          case "history": {
            const { type: _type, id: _id, ...request } = message;

            return host.history(request);
          }

          case "configure":
            return host
              .configure(agentChange(message))
              .pipe(Effect.andThen(announcePicks), Effect.as(null));
          case "watch":
            return watch(socket, message.conversationId).pipe(Effect.as(null));
          case "unwatch":
            return unwatch(socket, message.conversationId).pipe(
              Effect.andThen(setWatched(socket, message.conversationId, false)),
              Effect.as(null),
            );
          case "watch_task_graph":
            return watchGraph(socket).pipe(Effect.as(null));
          case "unwatch_task_graph":
            return unwatchGraph(socket).pipe(Effect.as(null));
          case "watch_usage":
            return watchUsage(socket).pipe(Effect.as(null));
          case "unwatch_usage":
            return unwatchUsage(socket).pipe(Effect.as(null));
          case "watch_changes":
            return watchChanges(socket, message.conversationId).pipe(Effect.as(null));
          case "unwatch_changes":
            return unwatchChanges(socket, message.conversationId).pipe(Effect.as(null));
          case "refresh_changes":
            return changesWorkspace(message.conversationId).pipe(
              Effect.flatMap((workspace) => changes.refresh(workspace, message.manual === true)),
              Effect.as(null),
            );
          case "change_file": {
            const { type: _type, id: _id, conversationId, ...query } = message;

            return changesWorkspace(conversationId).pipe(
              Effect.flatMap((workspace) => changes.file(workspace, query)),
            );
          }

          case "comparison_sources":
            return comparisons.sources(message.pulls === true);
          case "compare": {
            if (message.source === "pull" && message.pull === undefined) {
              return Effect.fail(
                SessionError.make({
                  operation: "compare",
                  message: "A pull request Comparison names its pull request",
                }),
              );
            }

            return comparisons
              .compare({
                repo: message.repo,
                pull: message.source === "pull" ? message.pull : undefined,
                startContainer: message.startContainer === true,
                fetch: message.fetch === true,
              })
              .pipe(
                // The drafts on this branch or pull request are checked against the pair the client now sees, and a pull
                // request's Viewed boxes against its files' blobs, in the background.
                Effect.tap((result) =>
                  result.status === "ok"
                    ? Effect.forkIn(
                        Effect.all([
                          reviews.compared(result.comparison),
                          viewed.reset(result.comparison),
                        ]),
                        scope,
                      )
                    : Effect.void,
                ),
              );
          }

          case "comparison_file": {
            const { type: _type, id: _id, ...query } = message;

            return comparisons.file(query);
          }

          case "run_diff":
            return runs.diff;
          case "run_file": {
            const { type: _type, id: _id, ...query } = message;

            return runs.file(query);
          }

          case "secret_answer":
            return secrets
              .answer(message.request, message.values, message.keep)
              .pipe(Effect.as(null));
          case "approval_answer":
            return approvals
              .answer(message.request, {
                approve: message.approve,
                reason: message.reason,
              })
              .pipe(Effect.as(null));
          case "mcp_elicitation_answer":
            // The schema refuses a scope on any other action.
            if (message.scope !== undefined) {
              return mcpQuestions
                .declineScoped(message.request, message.scope)
                .pipe(Effect.as(null));
            }

            return mcpQuestions
              .answer(
                message.request,
                message.action === "accept"
                  ? { action: "accept", content: message.content ?? {} }
                  : { action: message.action },
              )
              .pipe(Effect.as(null));
          case "mcp_sampling_answer":
            return mcpQuestions
              .answerSampling(
                message.request,
                message.role === undefined
                  ? { choice: message.choice }
                  : { choice: message.choice, role: message.role },
              )
              .pipe(Effect.as(null));
          case "mcp_sampling_get":
            return mcpSampling.view(message.request).pipe(Effect.map((view) => view ?? null));
          case "mcp_watch_end":
            return mcpWatches
              .end({
                conversation: message.conversationId,
                server: message.server,
                uri: message.uri,
              })
              .pipe(Effect.as(null));
          case "mcp_elicitation_revoke":
            return mcpQuestions.revokeDeclined(message.server).pipe(Effect.as(null));
          case "mcp_sampling_revoke":
            return mcpQuestions.revokeSampling(message.server).pipe(Effect.as(null));
          case "mcp_sign_in_answer":
            return mcpSignIns.decline(message.request, message.reason).pipe(Effect.as(null));
          case "annotation_save":
            return reviews.save(message.annotation).pipe(Effect.as(null));
          case "annotation_delete":
            return annotations.delete(message.annotationId).pipe(Effect.as(null));
          case "mcp_app_mount":
            return mcpApps.mount(message.callId);
          case "mcp_app_html":
            // A running call's page, by its tool; an older client sends none, and the call's is the record's.
            if (message.tool !== undefined) {
              return mcpApps.pageOfTool(message.tool, message.callId ?? "");
            }

            if (message.callId !== undefined) return mcpApps.pageOf(message.callId);

            return message.hash === undefined
              ? Effect.succeed<McpAppHtmlAnswer>({
                  status: "missing",
                  message: "The message names neither a call nor a page",
                })
              : mcpApps.html(message.hash);
          case "page_visible":
            return setVisible(socket, message.visible).pipe(
              Effect.andThen(mcpApps.visibility(socket, message.visible)),
              Effect.as(null),
            );
          case "mcp_app_request":
            return mcpApps.request({
              view: socket,
              visible: readAttachment(socket).visible === true,
              callId: message.callId,
              requestId: message.requestId,
              method: message.method,
              params: message.params,
              // Only a stdio server's request asks: the Workspace its call's conversation works in.
              workspaceOf: (conversation) =>
                host.workspaceOf(conversationOf(conversation)).pipe(
                  Effect.map((workspace) => workspace?.object),
                  Effect.orElseSucceed(() => undefined),
                ),
            });
          case "mcp_resource_read":
            return (
              message.conversationId === undefined
                ? host.activeBranch
                : Effect.succeed(message.conversationId)
            ).pipe(
              Effect.flatMap((conversationId) =>
                resourcePreviews.resourcePreview({
                  socket,
                  visible: readAttachment(socket).visible === true,
                  conversation: String(conversationId),
                  server: message.server,
                  uri: message.uri,
                  path: message.path,
                  // Only a stdio server's read asks: the Workspace the conversation works in, whose Container it never starts.
                  workspaceOf: (conversation) =>
                    host.workspaceOf(conversationOf(conversation)).pipe(
                      Effect.map((workspace) => workspace?.object),
                      Effect.orElseSucceed(() => undefined),
                    ),
                  // A spill's file, from the Workspace of the conversation the card is in: never through the Container.
                  spill: (conversation, path, hold) =>
                    host
                      .spill(conversationOf(conversation), path, hold)
                      .pipe(Effect.orElseSucceed((): SpillRead => ({ kind: "missing" }))),
                }),
              ),
            );
          case "mcp_complete":
            return complete(socket, message);
          case "mcp_complete_cancel":
            return Effect.sync(() => {
              completions.cancel(socket, message.requestId);

              return null;
            });
          case "mcp_app_log":
            return mcpApps
              .log({
                view: socket,
                callId: message.callId,
                level: message.level,
                logger: message.logger,
                message: message.message,
              })
              .pipe(Effect.as(null));
          case "mcp_app_context":
            // Held pending in the Session; a busy conversation is then written them at its next boundary.
            return Effect.gen(function* () {
              let target: string | undefined;

              const answer = yield* mcpApps.contexts.hold({
                view: socket,
                callId: message.callId,
                text: message.text,
                where: (call) =>
                  host.appContextTarget(call, message.callId, message.conversationId).pipe(
                    Effect.tap((conversation) =>
                      Effect.sync(() => {
                        target = conversation;
                      }),
                    ),
                  ),
              });

              if (answer.status === "held" && target !== undefined) {
                yield* host.appContextHeld(conversationOf(target));
              }

              return answer;
            });
          case "mcp_app_cancel":
            return mcpApps.cancel(socket, message.callId, message.requestId).pipe(Effect.as(null));
          case "mcp_task_cancel":
            return host
              .mcpTaskCancel(message.task)
              .pipe(
                Effect.flatMap((took) =>
                  ownerCommandAnswer(
                    "mcp_task_cancel",
                    took,
                    ["sent", "already_sent"],
                    MCP_TASK_CANCEL_REFUSALS,
                  ),
                ),
              );
          case "container_keep":
            return host
              .mcpTaskKeep(message.task)
              .pipe(
                Effect.flatMap((kept) =>
                  ownerCommandAnswer("container_keep", kept, ["kept"], CONTAINER_KEEP_REFUSALS),
                ),
              );
          case "viewed_set":
            return viewed
              .set({ repo: message.repo, pull: message.pull, path: message.path }, message.blob)
              .pipe(Effect.as(null));
        }
      };

      const receive = (socket: WebSocket, data: string | ArrayBuffer) =>
        Effect.gen(function* () {
          const text = Predicate.isString(data) ? data : new TextDecoder().decode(data);
          const decoded = yield* Effect.result(decodeClientMessage(text));

          if (Result.isFailure(decoded)) {
            const unreadable: ErrorMessage = {
              type: "error",
              message: `Unreadable message: ${decoded.failure.message}`,
            };

            const id = decodeCommandId(text);

            return yield* send(
              socket,
              Option.isSome(id) ? { ...unreadable, id: id.value.id } : unreadable,
            );
          }

          const message = decoded.success;

          // What a command holds until its answer is sent is let go once it has been.
          yield* Effect.scoped(
            Effect.gen(function* () {
              const exit = yield* Effect.exit(command(socket, message));

              if (Exit.isSuccess(exit)) {
                if (message.id !== undefined) {
                  yield* send(socket, { type: "result", id: message.id, result: exit.value });
                }

                return;
              }

              const error = Exit.findErrorOption(exit);

              const failure: Types.Mutable<ErrorMessage> = {
                type: "error",
                message: Option.isSome(error) ? error.value.message : "Internal error",
              };

              // A refusal of a send that names an MCP prompt carries its code, for the composer to act on.
              if (Option.isSome(error) && Predicate.isTagged(error.value, "SessionError")) {
                if (error.value.code !== undefined) failure.code = error.value.code;

                if (error.value.server !== undefined) failure.server = error.value.server;
              }

              yield* Effect.logWarning(`Session command ${message.type} failed`, exit.cause);
              yield* send(
                socket,
                message.id === undefined ? failure : { ...failure, id: message.id },
              );
            }),
          );
        });

      const drop = (socket: WebSocket) =>
        Effect.suspend(() => {
          const fibers = watching.get(socket);

          watching.delete(socket);

          // The page went: what its App Views have in flight, and its previews, are cancelled.
          return mcpApps
            .endViews(socket)
            .pipe(
              Effect.andThen(resourcePreviews.endResourcePreviews(socket)),
              Effect.andThen(Effect.sync(() => completions.end(socket))),
              Effect.andThen(fibers === undefined ? Effect.void : FiberMap.clear(fibers)),
            );
        });

      /** Tell every connected client which Session branch is active now, so each watches it instead. */
      const announceBranch = (conversationId: ConversationId) =>
        Effect.forEach(
          state.getWebSockets(),
          (socket) => send(socket, { type: "active_branch", conversationId }),
          { discard: true },
        );

      /** Tell every connected client the Owner tabs of the Browser Pane, which one of them changed. */
      const announceOwnerTabs = (tabs: OwnerTabListing) =>
        Effect.forEach(state.getWebSockets(), (socket) => send(socket, ownerTabsMessage(tabs)), {
          discard: true,
        });

      /** In the background and best effort: an answer neither waits on the settle nor loses its result to it. */
      const settleInBackground = host.settle.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Settling after an Owner tab opened or watched failed", cause),
        ),
        Effect.forkIn(scope),
        Effect.asVoid,
      );

      /** Tell `socket`, or every connected client, which of the model and thinking level the Session picked. */
      const announcePicks = host.picks.pipe(
        Effect.flatMap((picks) =>
          Effect.forEach(state.getWebSockets(), (socket) =>
            send(socket, { type: "picked", ...picks }),
          ),
        ),
        Effect.asVoid,
      );

      /**
       * Tell every connected client the Session's MCP tasks whenever they change: one watch for the whole Session, begun
       * with the first client of an instance (a Session nobody looks at does not watch) and ended with its scope.
       */
      let followingMcpTasks = false;

      const followMcpTasks = Effect.suspend(() => {
        if (followingMcpTasks) return Effect.void;

        followingMcpTasks = true;

        return host.mcpTasks.pipe(
          Stream.runForEach((tasks) =>
            Effect.forEach(
              state.getWebSockets(),
              (socket) => send(socket, mcpTasksMessage(tasks)),
              {
                discard: true,
              },
            ),
          ),
          Effect.catch((error) => Effect.logWarning("Following the MCP tasks ended", error)),
          Effect.ensuring(Effect.sync(() => (followingMcpTasks = false))),
          Effect.forkIn(scope),
          Effect.asVoid,
        );
      });

      const connect = Effect.gen(function* () {
        // The default in force, so the client's first view shows what the next request runs on.
        yield* host.sync.pipe(
          Effect.catch((error) => Effect.logWarning("Syncing the agent on connect failed", error)),
        );

        // In the background: the notice of a held stop reaches the client through its watch, as any entry does.
        yield* host.showHeldStops.pipe(Effect.forkIn(scope));

        const root = yield* host.activeBranch;
        const copying = yield* host.copying;
        const { 0: client, 1: server } = new WebSocketPair();

        state.acceptWebSocket(server);
        server.serializeAttachment({ watches: [] } satisfies Attachment);
        yield* send(
          server,
          copying
            ? { type: "hello", root, copying, ...HELLO_FEATURES }
            : { type: "hello", root, ...HELLO_FEATURES },
        );
        yield* host.picks.pipe(
          Effect.flatMap((picks) => send(server, { type: "picked", ...picks })),
        );

        // Requests for Secrets outlive the sockets that saw them: a client that reconnects is shown them again.
        const asks = yield* secrets.pending;

        if (asks.length > 0) yield* send(server, secretRequests(asks));

        // So are Browser Handoffs, which wait for the owner for up to 30 minutes. Sent when none waits too, so a client
        // can tell "none waits" (a Live View Pane whose handoff is gone closes) from "not heard yet".
        yield* send(server, browserHandoffRequests(yield* handoffs.pending));

        // Which calls drive the owner's Owner tabs, an empty list too: a client that reconnects drops what it showed.
        yield* send(server, ownerTabDriversMessage(yield* drivers.current));

        // Approval requests wait with no deadline; sent when none waits too, so a client clears the cards it held.
        yield* send(server, approvalRequests(yield* approvals.pending));

        // MCP servers' questions live only as long as their calls wait; sent when none waits too, so a client clears the
        // cards it held.
        yield* send(
          server,
          mcpElicitationRequests(yield* mcpQuestions.pending, mcpQuestions.declinedServers()),
        );

        // MCP servers' Sampling requests live only as long as their calls wait too, and the Session's grants survive;
        // sent when none waits too, so a client clears the cards and the grants it held.
        yield* send(
          server,
          mcpSamplingRequests(
            yield* mcpQuestions.pendingSampling,
            yield* mcpQuestions.samplingGrants,
          ),
        );

        // The cards of a round kept for later may be of a server that was removed or changed while nobody looked (a round
        // holds no request on the host, which cannot tell the Session). Looked at in the background, as the client
        // connects, and never on a timer, which would keep this instance awake; a withdrawal reaches the client as any
        // answer does. A resume that follows a change the look misses is refused by the host, by the connection key.
        yield* mcpQuestions.lookAtRounds.pipe(Effect.forkIn(scope));

        // Sign-in requests have no deadline and survive an eviction; sent when none waits too, so a client clears the
        // cards it held.
        yield* send(server, mcpSignInRequests(yield* mcpSignIns.pending));

        // The Session's MCP tasks, an empty list too, so a client that reconnects drops one that ended meanwhile.
        yield* send(
          server,
          mcpTasksMessage(yield* host.mcpTaskList.pipe(Effect.orElseSucceed(() => []))),
        );
        yield* followMcpTasks;

        // The draft Annotations, an empty list too, so a client that reconnects drops the drafts deleted meanwhile.
        yield* send(server, annotationsMessage(yield* annotations.list));

        // The Viewed boxes, an empty list too, for the same reason.
        yield* send(server, viewedMessage(yield* viewed.list));

        // The inventory's App tools, an empty list too, so a client that reconnects drops one a server no longer has.
        yield* send(server, mcpAppToolsMessage(yield* mcpApps.tools));

        // The agent's Resource watches, an empty list too, so a client that reconnects drops one that ended meanwhile.
        yield* send(server, mcpWatchesMessage(yield* mcpWatches.list));

        // Where the Last run stands, null too, so a client that reconnects drops one that was replaced meanwhile.
        yield* send(server, { type: "last_run", lastRun: yield* runs.lastRun });

        return client;
      });

      // Sockets that outlived the last instance keep their watches, each from a fresh snapshot.
      if (state.getWebSockets().length > 0) yield* followMcpTasks;

      for (const socket of state.getWebSockets()) {
        if (readAttachment(socket).taskGraph === true) yield* watchGraph(socket);

        if (readAttachment(socket).usage === true) yield* watchUsage(socket);

        const { changes: sessionChanges, conversationChanges = [] } = readAttachment(socket);

        for (const conversationId of sessionChanges === true
          ? [undefined, ...conversationChanges]
          : conversationChanges) {
          yield* watchChanges(socket, conversationId).pipe(
            // Its conversation is gone (a subagent deleted meanwhile): the watch is dropped, and the client told.
            Effect.catch((error) =>
              setChangesWatched(socket, conversationId, false).pipe(
                Effect.andThen(
                  conversationId === undefined
                    ? Effect.void
                    : send(socket, changesEnded(conversationId, error.message)),
                ),
              ),
            ),
          );
        }

        for (const conversationId of readAttachment(socket).watches) {
          yield* watch(socket, conversationId).pipe(
            // The watch dropped itself, so the next instance does not retry it.
            Effect.catch((error) =>
              send(socket, { type: "error", conversationId, message: error.message }),
            ),
          );
        }
      }

      // Each client connects again, as after any close, and its `hello` says the Session as it is now.
      const greetAgain = Effect.forEach(
        state.getWebSockets(),
        (socket) =>
          Effect.try(() => socket.close(SERVICE_RESTART_CLOSE_CODE, "The session is ready")).pipe(
            Effect.ignore,
          ),
        { discard: true },
      );

      return { connect, receive, drop, greetAgain, announcePicks } satisfies SessionSocketsService;
    }),
  );
