// The Session socket (`docs/spec.md` → Client and protocol, ADR-0009): clients' hibernatable WebSockets to the Session
// DO, carrying `@cloudpid/protocol`'s Session messages. As in the socket glue of Cloudflare's `agents` pi example,
// watches live in memory and each socket's attachment names the conversations it watches, so an instance woken from
// hibernation restarts them, each with a fresh snapshot, on sockets that never closed.
import {
  type Annotation,
  type Catalog,
  type ChangeFile,
  type CommandOutcome,
  type CompareResult,
  type ComparisonSources,
  ConversationId,
  decodeClientMessage,
  type FileMatches,
  type HistoryPage,
  type Navigated,
  type SessionTree,
  type ViewedFile,
  HEARTBEAT,
  type LiveViewLinks,
  type OwnerTabLinks,
  type OwnerTabListing,
  type ClientMessage,
  type ServerMessage,
  ServerMessageJson,
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
import { SessionError } from "./errors.ts";
import { SessionHost } from "./host.ts";
import { SessionReviews } from "./reviews.ts";
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

/**
 * The `approval_requests` message for `requests`, which every client is sent: each request as the card shows it, without
 * the value the call checks once approved.
 */
export const approvalRequests = (requests: ReadonlyArray<ApprovalAsk>): ServerMessage => ({
  type: "approval_requests",
  requests: Arr.map(requests, (request) => ({
    id: request.id,
    // SAFETY: a request's conversation is the asking call's, a pi-durable conversation ID.
    conversationId: request.conversationId as ConversationId,
    tool: request.tool,
    target: request.target,
    change: request.change,
    before: request.before,
    after: request.after,
    reason: request.reason,
  })),
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

/** The agent change a `configure` asks for: a field it leaves out is left out, as is. */
const agentChange = (message: Extract<ClientMessage, { type: "configure" }>): AgentChange => {
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
  | Secrets
  | BrowserHandoffs
  | BrowserPane
  | OwnerTabDrivers
  | Approvals
  | AnnotationStore
  | ViewedStore
  | SessionReviews
> =>
  Layer.effect(
    SessionSockets,
    Effect.gen(function* () {
      const host = yield* SessionHost;
      const changes = yield* SessionChanges;
      const comparisons = yield* SessionComparisons;
      const annotations = yield* AnnotationStore;
      const viewed = yield* ViewedStore;
      const reviews = yield* SessionReviews;
      const secrets = yield* Secrets;
      const handoffs = yield* BrowserHandoffs;
      const browserPane = yield* BrowserPane;
      const drivers = yield* OwnerTabDrivers;
      const approvals = yield* Approvals;
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
          let todosStarted = false;

          yield* setWatched(socket, conversationId, true);
          yield* host.events(conversationId).pipe(
            Stream.runForEach((events) =>
              send(socket, { type: "events", conversationId, events }).pipe(
                // After the first batch, the snapshot, so the client has the conversation before its list.
                Effect.andThen(
                  Effect.suspend(() => {
                    if (todosStarted) return Effect.void;

                    todosStarted = true;

                    return Effect.forkChild(streamTodos(socket, conversationId)).pipe(
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
        | FileMatches
        | HistoryPage
        | SessionTree
        | Navigated
        | LiveViewLinks
        | OwnerTabLinks
        | OwnerTabListing
        | null,
        SessionError | SecretsError | BrowserError | ApprovalsError
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
            const { type: _type, id: _id, pages: refs, annotations: ids, ...typed } = message;

            // The pages are read from the browser as the message is admitted (in arrival order, and not again for a
            // resent request), redacted of held Secrets before they are stored, escaped or sent to any client; one that
            // is gone fails the command, so the owner removes its chip, rather than going without it.
            const attachPages = secrets.refresh.pipe(
              Effect.andThen(browserPane.attach(refs ?? [])),
              Effect.map((pages) => secrets.redact(pages)),
              Effect.mapError((error) =>
                SessionError.make({ operation: "submit", message: error.message }),
              ),
            );

            const prompt =
              refs === undefined || refs.length === 0 ? typed : { ...typed, attachPages };

            // With drafts, it is a Review: its summary is what was typed.
            return (
              ids === undefined
                ? host.submit(prompt)
                : reviews.submit({ ...prompt, annotations: ids })
            ).pipe(Effect.map((submissionId) => ({ submissionId })));
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
          case "annotation_save":
            return reviews.save(message.annotation).pipe(Effect.as(null));
          case "annotation_delete":
            return annotations.delete(message.annotationId).pipe(Effect.as(null));
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
          const exit = yield* Effect.exit(command(socket, message));

          if (Exit.isSuccess(exit)) {
            if (message.id !== undefined) {
              yield* send(socket, { type: "result", id: message.id, result: exit.value });
            }

            return;
          }

          const error = Exit.findErrorOption(exit);

          const failure: ErrorMessage = {
            type: "error",
            message: Option.isSome(error) ? error.value.message : "Internal error",
          };

          yield* Effect.logWarning(`Session command ${message.type} failed`, exit.cause);
          yield* send(socket, message.id === undefined ? failure : { ...failure, id: message.id });
        });

      const drop = (socket: WebSocket) =>
        Effect.suspend(() => {
          const fibers = watching.get(socket);

          watching.delete(socket);

          return fibers === undefined ? Effect.void : FiberMap.clear(fibers);
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

      const connect = Effect.gen(function* () {
        // The default in force, so the client's first view shows what the next request runs on.
        yield* host.sync.pipe(
          Effect.catch((error) => Effect.logWarning("Syncing the agent on connect failed", error)),
        );

        const root = yield* host.activeBranch;
        const copying = yield* host.copying;
        const { 0: client, 1: server } = new WebSocketPair();

        state.acceptWebSocket(server);
        server.serializeAttachment({ watches: [] } satisfies Attachment);
        yield* send(server, copying ? { type: "hello", root, copying } : { type: "hello", root });
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

        // The draft Annotations, an empty list too, so a client that reconnects drops the drafts deleted meanwhile.
        yield* send(server, annotationsMessage(yield* annotations.list));

        // The Viewed boxes, an empty list too, for the same reason.
        yield* send(server, viewedMessage(yield* viewed.list));

        return client;
      });

      // Sockets that outlived the last instance keep their watches, each from a fresh snapshot.
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

      return { connect, receive, drop, greetAgain } satisfies SessionSocketsService;
    }),
  );
