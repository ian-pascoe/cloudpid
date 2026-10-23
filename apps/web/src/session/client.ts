// The browser's end of a Session socket (`docs/spec.md` → Client and protocol, ADR-0009), as an Effect program: it
// connects, watches the root conversation the Session names in `hello`, folds the events into a `SessionView` kept in a
// `SubscriptionRef`, sends the owner's commands, and keeps the connection alive: a heartbeat, and a reconnect with a
// fresh watch after any close. It lives in a scope: closing it closes the socket and stops its fibers.
//
// What a socket's messages change is decided in synchronous steps over the bookkeeping below, each published to the
// state when it ends, so a step never sees another half done. Commands go straight to the open connection's WebSocket
// rather than through `Socket.writer`, whose writes made while disconnected wait for the next connection: a command
// belongs to the socket it was sent on, and the next one gets what is still due (held submits, watches) after `hello`.

// @effect-diagnostics preferEffectArray:off -- the bookkeeping of one socket: native arrays and maps mutated in place, one synchronous step at a time.

import {
  Catalog,
  CommandOutcome,
  EMPTY_VIEW,
  FileMatches,
  HEARTBEAT,
  HistoryPage,
  reduceEvents,
  withEarlier,
  SESSION_DELETED_CLOSE_CODE,
  ServerMessageJson,
  type ClientMessage,
  type ConversationId,
  type ServerMessage,
  type SessionView,
  type TodoTask,
  type UserInput,
  type WhenBusy,
} from "@cloudpid/protocol";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as RcMap from "effect/RcMap";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Socket from "effect/socket/Socket";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type * as Types from "effect/Types";
import {
  INITIAL_SESSION_STATE,
  type AbortTarget,
  type ConfigureChange,
  type OutgoingMessage,
  type QueuedEntry,
  type QueueLanes,
  type Reachability,
  type SendingEntry,
  type SessionState,
  type ThreadState,
} from "./state.ts";

/** How often the client pings an open socket. */
export const HEARTBEAT_INTERVAL_MS = 25_000;

/** How long after a ping the socket may stay silent before it counts as dead and is replaced. */
export const PONG_TIMEOUT_MS = 10_000;

/** The first reconnect waits this long, and each failed attempt after it twice as long as the one before… */
const RECONNECT_BASE_MS = 500;

/** …up to this; no jitter, as one browser tab is the only client of its socket. */
const RECONNECT_MAX_MS = 10_000;

/** After this many failed attempts without a snapshot, the client asks over HTTP whether trying again can work. */
const PROBE_AFTER_ATTEMPTS = 2;

/** Why a request cannot be answered while the socket is down. */
const NOT_CONNECTED = "The session is not connected; try again once it is.";

/**
 * Why a command to the Session did not get the answer it waited for: the Session refused it (its message), its answer
 * could not be read, or the socket closed first.
 */
export class SessionCommandError extends Schema.TaggedError<
  SessionCommandError,
  { readonly brand: unique symbol }
>()("SessionCommandError", { message: Schema.String }) {}

/**
 * Asks over HTTP why a Session's socket does not open: a WebSocket cannot see why it failed. A service, so a test can
 * answer for the network.
 */
export class SessionProbe extends Context.Service<
  SessionProbe,
  (socketUrl: string) => Effect.Effect<Reachability>
>()("@cloudpid/web/session/client/SessionProbe") {}

/**
 * A plain GET of the socket's path, redirects not followed: Access answers a lapsed sign-in with a redirect to its
 * login (or a 401), the Worker answers a Session the Registry does not know with 404, and anything else (the Session
 * itself wants an upgrade) means the socket is worth another try. `fetch` itself, as Effect's `HttpClientResponse`
 * does not say whether a response is an opaque redirect.
 */
export const probeSession = (socketUrl: string): Effect.Effect<Reachability> =>
  Effect.tryPromise(() => {
    const url = new URL(socketUrl);

    url.protocol = url.protocol === "wss:" ? "https:" : "http:";

    // @effect-diagnostics-next-line globalFetchInEffect:off
    return fetch(url, { redirect: "manual" });
  }).pipe(
    Effect.map((response): Reachability => {
      if (
        response.type === "opaqueredirect" ||
        response.status === 401 ||
        response.status === 403
      ) {
        return "signed-out";
      }

      return response.status === 404 ? "missing" : "reachable";
    }),
    Effect.orElseSucceed((): Reachability => "reachable"),
  );

/** The live probe, over the browser's `fetch`. */
export const layerSessionProbe: Layer.Layer<SessionProbe> =
  Layer.succeed(SessionProbe)(probeSession);

/** One Session's socket, as long as its scope is open. */
export interface SessionClient {
  /** What the Session's socket has said, folded: the same object until something changes. */
  readonly state: SubscriptionRef.SubscriptionRef<SessionState>;
  /**
   * Submit `message`: text, or an input with images and what its lane shows. Idle, it starts a Run; busy, `steer`
   * joins the running Run at its next boundary and `followUp` waits for the next Run. Held until the watch of its
   * conversation (the root's, or subagent conversation `conversationId`'s) is answered, as a submit sent before it can
   * land before the snapshot, and sent again under the same `requestId` after a reconnect if no answer came. Done
   * once it is queued; the Session's refusal shows as the state's `failure`, or its thread's.
   */
  readonly submit: (
    message: string | OutgoingMessage,
    whenBusy: WhenBusy,
    conversationId?: number,
  ) => Effect.Effect<void>;
  /**
   * `submit`, waiting for how it ended: done once the Session took it, failing with why the Session refused it (or why
   * it was dropped), which the caller then shows itself: the refusal is not the state's `failure`. It settles once,
   * even when it was sent again after a reconnect. A caller that may submit the same message again on another client
   * gives its own `requestId`, so the Session takes it once.
   */
  readonly submitAndAwait: (
    message: string | OutgoingMessage,
    whenBusy: WhenBusy,
    conversationId?: number,
    requestId?: string,
  ) => Effect.Effect<void, SessionCommandError>;
  /**
   * Watch subagent conversation `conversationId` on this socket, from a snapshot, and keep `threads[conversationId]`
   * current until the scope closes. However many ask for the same conversation, it is watched once, and unwatched when
   * the last scope closes. Each new socket watches it again.
   */
  readonly watchThread: (conversationId: number) => Effect.Effect<void, never, Scope.Scope>;
  /** Stream the Session's task graph into `taskGraph`: once is enough, and a new socket asks again. */
  readonly watchTaskGraph: Effect.Effect<void>;
  /** Stream what the Session has spent into `usage`: once is enough, and a new socket asks again. */
  readonly watchUsage: Effect.Effect<void>;
  /**
   * Pick the model and thinking level of the root conversation's next request. A field left out stays as it is, and
   * `null` makes the Session follow the default in the settings again. The Session's `agent_changed` event brings
   * the new pick into the view; a refusal shows as `failure`. Nothing is sent while the socket is down.
   */
  readonly configure: (change: ConfigureChange) => Effect.Effect<void>;
  /**
   * Answer Secret request `request` with the values the owner typed (a name left out is skipped), or `null` when the
   * owner cancelled. The values go to the Session once and are not kept here; the Session's next `secret_requests`
   * closes the form, and a refusal shows as `failure`.
   */
  readonly answerSecrets: (
    request: string,
    values: Readonly<Record<string, string>> | null,
  ) => Effect.Effect<void>;
  /**
   * Abort the root conversation's work and withdraw its queued input, or a subagent's when `conversationId` names
   * it. With `subagents`, the agents below it stop too; otherwise they keep working.
   */
  readonly abort: (target?: AbortTarget) => Effect.Effect<void>;
  /**
   * What the composer of the root conversation, or of subagent conversation `conversationId`, completes: the Session's
   * Slash commands, and the Prompt templates and Skills of the conversation's directory. Fails when the socket is not
   * open, when the Session refuses, and when the socket closes before it answers.
   */
  readonly catalog: (conversationId?: number) => Effect.Effect<Catalog, SessionCommandError>;
  /**
   * The files and folders of the root conversation's directory, or of subagent conversation `conversationId`'s, that
   * best match `query`, for the composer's `@` menu. Fails as `catalog` does.
   */
  readonly files: (
    query: string,
    conversationId?: number,
  ) => Effect.Effect<FileMatches, SessionCommandError>;
  /**
   * Run the Session's Slash command `name` with `args` on the root conversation, or on subagent conversation
   * `conversationId`: what it did, or a failure saying why it could not, or that it may have run when the socket closed
   * before its answer.
   */
  readonly command: (
    name: string,
    args: string,
    conversationId?: number,
  ) => Effect.Effect<CommandOutcome, SessionCommandError>;
  /**
   * Load the page of History before entry `before` of the root conversation, or of watched subagent conversation
   * `conversationId`, into its view's `earlier` messages: done once it is there, or once a snapshot made it moot. Fails
   * as `catalog` does.
   */
  readonly loadEarlier: (
    before: number,
    conversationId?: number,
  ) => Effect.Effect<void, SessionCommandError>;
}

/** A conversation ID as the protocol brands it. */
const conversation = (id: number): ConversationId =>
  // SAFETY: a number the Session named: in a task graph summary or a tool result's `conversation_id`.
  id as ConversationId;

/** A watch of a subagent's conversation, shared by everything that shows it. */
interface ThreadWatch {
  /** The `watch` command being answered, or null when none is out. */
  commandId: string | null;
  /** Whether the Session answered the watch, so a submit to it cannot land before its snapshot. */
  watched: boolean;
  status: ThreadState["status"];
  view: SessionView;
  failure: string | null;
  todos: readonly TodoTask[];
}

/** A submit not yet answered. Its `requestId` makes sending it again safe. */
interface PendingSubmit {
  readonly commandId: string;
  readonly requestId: string;
  readonly input: UserInput;
  /** What its lane shows: the typed text, with any Attachment's name. */
  readonly text: string;
  readonly whenBusy: WhenBusy;
  /** The subagent's conversation it is for; the root's when absent. */
  readonly conversationId: number | undefined;
  /** Whether it went out on the current socket. */
  sent: boolean;
  /** Where whoever submitted it hears how it ended; they show a refusal themselves. */
  readonly outcome: Deferred.Deferred<void, SessionCommandError> | undefined;
}

/** What a `result` carries. */
type ResultValue = Extract<ServerMessage, { type: "result" }>["result"];

/** A request whose answer an Effect waits for: `catalog`, `files` and `command`. */
interface PendingRequest {
  readonly answer: Deferred.Deferred<ResultValue, SessionCommandError>;
  /** Whether it changes the Session, so one whose answer was lost may have run all the same. */
  readonly acts: boolean;
}

/** One attempt at a socket. */
interface Connection {
  /** Its WebSocket, once dialled. */
  ws: Socket.WebSocketLike | null;
  /** Completed when the client gives up on it (a refused watch, a missed pong): `lost` has run. */
  readonly end: Deferred.Deferred<void>;
  /** Whether its end has been dealt with. */
  over: boolean;
  /** Whether a ping is out that nothing heard since has answered. */
  silent: boolean;
}

const decodeServerMessage = Schema.decodeOption(ServerMessageJson);

const decodeCatalog = Schema.decodeUnknownOption(Catalog);

const decodeFileMatches = Schema.decodeUnknownOption(FileMatches);

const decodeOutcome = Schema.decodeUnknownOption(CommandOutcome);

const decodeHistoryPage = Schema.decodeUnknownOption(HistoryPage);

const SubmitResult = Schema.Struct({ submissionId: Schema.Union([Schema.String, Schema.Finite]) });

const decodeSubmitResult = Schema.decodeUnknownOption(SubmitResult);

const submissionIdOf = (result: ServerMessage & { type: "result" }): string | undefined =>
  Option.match(decodeSubmitResult(result.result), {
    onNone: () => undefined,
    onSome: ({ submissionId }) => String(submissionId),
  });

const NO_SENDING: readonly SendingEntry[] = [];

const NO_TODOS: readonly TodoTask[] = [];

/** The close code a socket's end carries, when it was a close. */
const closeCodeOf = (error: Socket.SocketError): number | undefined =>
  Schema.is(Socket.SocketCloseError)(error.reason) ? error.reason.code : undefined;

/**
 * The client of the Session whose socket is at `socketUrl`, for as long as the scope is open: it dials at once, and
 * keeps a socket open until the scope closes, the Session is deleted, or the probe shows that trying again cannot work.
 */
export const make = Effect.fnUntraced(function* (socketUrl: string) {
  const probe = yield* SessionProbe;
  const makeWebSocket = yield* Socket.WebSocketConstructor;
  const state = yield* SubscriptionRef.make(INITIAL_SESSION_STATE);

  const texts = new Map<string, string>();
  const pending: PendingSubmit[] = [];
  const requests = new Map<string, PendingRequest>();
  const threadWatches = new Map<number, ThreadWatch>();

  const threadLanes = new Map<
    number,
    { readonly inbox: SessionView["inbox"]; readonly version: number; readonly queue: QueueLanes }
  >();

  let current: SessionState = INITIAL_SESSION_STATE;
  let connection: Connection | null = null;
  let graphWanted = false;
  let usageWanted = false;
  let root: ConversationId | null = null;
  let watchId: string | null = null;
  let watched = false;
  let stopped = false;
  let attempts = 0;
  let nextDelay = RECONNECT_BASE_MS;
  let commands = 0;
  let textsVersion = 0;
  let lanesFor: { readonly inbox: SessionView["inbox"]; readonly version: number } | undefined;

  /** Tell the state's subscribers what the last step changed. */
  const publish = Effect.suspend(() =>
    SubscriptionRef.getUnsafe(state) === current
      ? Effect.void
      : SubscriptionRef.set(state, current),
  );

  /**
   * Run `change` on the bookkeeping, then publish what it changed: both, as a step that ends a connection (completing
   * its `end`) interrupts the fiber it runs on.
   */
  const step = <A>(change: () => A): Effect.Effect<A> =>
    Effect.sync(change).pipe(
      Effect.tap(() => publish),
      Effect.uninterruptible,
    );

  const nextCommandId = (): string => {
    commands += 1;

    return `c${commands}`;
  };

  const isRoot = (conversationId: number | undefined): boolean =>
    conversationId === undefined || conversationId === root;

  const send = (message: ClientMessage): void => {
    connection?.ws?.send(JSON.stringify(message));
  };

  const lanes = (view: SessionView): QueueLanes => {
    const entry = (id: string): QueuedEntry => ({ id, text: texts.get(id) ?? null });
    const steer: QueuedEntry[] = [];
    const followUp: QueuedEntry[] = [];

    for (const item of view.inbox) {
      if (item.mode === "steer") steer.push(entry(String(item.id)));
      else if (item.mode === "followUp") followUp.push(entry(String(item.id)));
    }

    return { steer, followUp };
  };

  /** The submits to subagent conversation `conversationId` the Session has not answered. */
  const sendingTo = (
    conversationId: number,
    previous: readonly SendingEntry[] | undefined,
  ): readonly SendingEntry[] => {
    const next = pending.flatMap((submit) =>
      submit.conversationId === conversationId ? [{ id: submit.commandId, text: submit.text }] : [],
    );

    if (previous === undefined) return next.length === 0 ? NO_SENDING : next;

    if (
      previous.length === next.length &&
      previous.every((entry, index) => entry.id === next[index]?.id)
    ) {
      return previous;
    }

    return next.length === 0 ? NO_SENDING : next;
  };

  /** The submits to the root the Session has not answered, in the order they were made. */
  const sending = (): readonly SendingEntry[] => {
    const previous = current.sending;

    const next = pending.flatMap((submit) =>
      submit.conversationId === undefined ? [{ id: submit.commandId, text: submit.text }] : [],
    );

    // Keep the same array while nothing changed, so a view of it need not re-render.
    return previous.length === next.length &&
      previous.every((entry, index) => entry.id === next[index]?.id)
      ? previous
      : next;
  };

  /** Each watched subagent thread's state, the same object as before where nothing about it changed. */
  const threads = (): Readonly<Record<string, ThreadState>> => {
    const before = current.threads;
    const next: Record<string, ThreadState> = {};
    let same = Record.size(before) === threadWatches.size;

    for (const [conversationId, watch] of threadWatches) {
      const key = String(conversationId);
      const previous = before[key];
      const held = threadLanes.get(conversationId);

      const queue =
        held?.inbox === watch.view.inbox && held.version === textsVersion
          ? held.queue
          : lanes(watch.view);

      threadLanes.set(conversationId, { inbox: watch.view.inbox, version: textsVersion, queue });

      const sendingNow = sendingTo(conversationId, previous?.sending);

      const unchanged =
        previous !== undefined &&
        previous.status === watch.status &&
        previous.view === watch.view &&
        previous.queue === queue &&
        previous.sending === sendingNow &&
        previous.failure === watch.failure &&
        previous.todos === watch.todos;

      next[key] = unchanged
        ? previous
        : {
            status: watch.status,
            view: watch.view,
            queue,
            sending: sendingNow,
            failure: watch.failure,
            todos: watch.todos,
          };
      same = same && unchanged;
    }

    return same ? before : next;
  };

  /**
   * Apply `change`. `patch` sets the failure shown on thread `thread`; every thread's state is rebuilt from its watch,
   * reusing what did not change.
   */
  const update = (
    change: Partial<
      Pick<
        SessionState,
        | "status"
        | "view"
        | "failure"
        | "picked"
        | "secretRequests"
        | "secretLifetimeMinutes"
        | "browserHandoffRequests"
        | "taskGraph"
        | "usage"
        | "todos"
      >
    >,
    thread?: number,
    patch?: { readonly failure: string | null },
  ): void => {
    if (thread !== undefined && patch !== undefined) {
      const watch = threadWatches.get(thread);

      if (watch !== undefined) watch.failure = patch.failure;
    }

    const next = { ...current, ...change };
    const reuse = lanesFor?.inbox === next.view.inbox && lanesFor.version === textsVersion;
    const queue = reuse ? current.queue : lanes(next.view);

    lanesFor = { inbox: next.view.inbox, version: textsVersion };
    current = { ...next, queue, sending: sending(), threads: threads() };
  };

  const startThreadWatch = (conversationId: number): void => {
    const watch = threadWatches.get(conversationId);

    if (watch === undefined || connection === null) return;

    watch.watched = false;
    watch.commandId = nextCommandId();
    send({ type: "watch", id: watch.commandId, conversationId: conversation(conversationId) });
  };

  const threadWatchOf = (
    commandId: string,
  ): { readonly conversationId: number; readonly watch: ThreadWatch } | undefined => {
    for (const [conversationId, watch] of threadWatches) {
      if (watch.commandId === commandId) return { conversationId, watch };
    }

    return undefined;
  };

  /** The Session refused or ended the watch of a subagent's conversation: the thread says why, and is not retried. */
  const threadFailed = (conversationId: number, failure: string): void => {
    const watch = threadWatches.get(conversationId);

    if (watch === undefined) return;

    watch.status = "failed";
    watch.watched = false;
    watch.commandId = null;
    watch.failure = failure;
    update({}, conversationId);
  };

  const settle = (submit: PendingSubmit, failure: string | null): void => {
    if (submit.outcome === undefined) return;

    Deferred.doneUnsafe(
      submit.outcome,
      failure === null ? Effect.void : Effect.fail(SessionCommandError.make({ message: failure })),
    );
  };

  /**
   * A command's answer: a submit that has one is done, and a successful one has a submission ID to remember; `failure`
   * is why the Session refused it.
   */
  const answered = (
    commandId: string,
    submissionId: string | undefined,
    failure: string | null = null,
  ): void => {
    const index = pending.findIndex((submit) => submit.commandId === commandId);
    const submit = pending[index];

    if (submit === undefined) return;

    pending.splice(index, 1);
    settle(submit, failure);

    if (submissionId !== undefined) {
      texts.set(submissionId, submit.text);
      textsVersion += 1;
    }

    update({});
  };

  const watch = (): void => {
    if (root === null) return;

    watched = false;
    watchId = nextCommandId();
    send({ type: "watch", id: watchId, conversationId: root });
  };

  const flush = (): void => {
    for (const submit of pending) {
      if (submit.sent) continue;

      // A submit waits for the watch of the conversation it is for: it could land before the snapshot otherwise.
      const ready =
        submit.conversationId === undefined
          ? watched
          : threadWatches.get(submit.conversationId)?.watched === true;

      if (!ready) continue;

      const message: Types.Mutable<Extract<ClientMessage, { type: "submit" }>> = {
        type: "submit",
        id: submit.commandId,
        input: submit.input,
        whenBusy: submit.whenBusy,
        requestId: submit.requestId,
      };

      if (submit.conversationId !== undefined) {
        message.conversationId = conversation(submit.conversationId);
      }

      submit.sent = true;
      send(message);
    }
  };

  /**
   * Fail every request still waiting for an answer: the socket that carried them is gone. One that changes the Session
   * fails with `acted` when given: it may have reached the Session, and run, before the socket went.
   */
  const failRequests = (failure: string, acted = failure): void => {
    const waiting = [...requests.values()];

    requests.clear();

    for (const request of waiting) {
      Deferred.doneUnsafe(
        request.answer,
        Effect.fail(SessionCommandError.make({ message: request.acts ? acted : failure })),
      );
    }
  };

  /** The Session was deleted: stop for good, and say so. */
  const deleted = (ended: Connection): void => {
    ended.over = true;
    connection = null;
    stopped = true;
    failRequests("The session was deleted.");
    update({ status: "deleted" });
  };

  /** Connection `ended` closed or went silent: start over on a new one after a pause. */
  const lost = (ended: Connection, failure?: string): void => {
    if (ended.over) return;

    ended.over = true;
    Deferred.doneUnsafe(ended.end, Effect.void);

    if (connection === ended) connection = null;

    watched = false;

    // What was sent went with the socket; the answers will not come.
    for (const submit of pending) submit.sent = false;

    failRequests(
      "The connection was lost; try again once it is back.",
      "The connection was lost before the Session answered; the command may have run, so check before running it again.",
    );

    for (const thread of threadWatches.values()) {
      thread.watched = false;
      thread.commandId = null;
    }

    // The next socket says again which Secret requests and Browser Handoffs wait.
    current = { ...current, secretRequests: [], browserHandoffRequests: [] };

    if (stopped) return;

    nextDelay = Math.min(RECONNECT_BASE_MS * 2 ** attempts, RECONNECT_MAX_MS);
    attempts += 1;
    update(
      failure === undefined ? { status: "reconnecting" } : { status: "reconnecting", failure },
    );
  };

  const handle = (from: Connection, message: ServerMessage): void => {
    switch (message.type) {
      case "hello":
        root = message.root;
        watch();

        for (const conversationId of threadWatches.keys()) startThreadWatch(conversationId);

        if (graphWanted) send({ type: "watch_task_graph", id: nextCommandId() });

        if (usageWanted) send({ type: "watch_usage", id: nextCommandId() });

        return;
      case "task_graph":
        update({ taskGraph: { agents: message.agents, background: message.background } });

        return;
      case "usage": {
        const { type: _type, ...usage } = message;

        update({ usage });

        return;
      }

      case "todos": {
        if (message.conversationId === root) {
          update({ todos: message.tasks });

          return;
        }

        const thread = threadWatches.get(message.conversationId);

        if (thread !== undefined) {
          thread.todos = message.tasks;
          update({}, message.conversationId);
        }

        return;
      }

      case "picked":
        update({ picked: { model: message.model, thinkingLevel: message.thinkingLevel } });

        return;
      case "secret_requests":
        update({
          secretRequests: message.requests,
          secretLifetimeMinutes: message.lifetimeMinutes,
        });

        return;
      case "browser_handoff_requests":
        update({ browserHandoffRequests: message.requests });

        return;
      case "events": {
        const thread = threadWatches.get(message.conversationId);

        if (message.conversationId !== root) {
          if (thread !== undefined) {
            thread.view = reduceEvents(thread.view, message.events);
            thread.status = "live";
            thread.failure = null;
            update({}, message.conversationId);
          }

          return;
        }

        const view = reduceEvents(current.view, message.events);

        if (message.events.some((event) => event.type === "snapshot")) {
          // What the snapshot's inbox no longer holds has been placed, or was withdrawn.
          const queued = new Set(view.inbox.map((item) => String(item.id)));

          for (const id of texts.keys()) {
            if (queued.has(id)) continue;

            texts.delete(id);
            textsVersion += 1;
          }
        }

        // A snapshot or event shows the watch works, so the next failure starts the backoff over.
        attempts = 0;
        update({ view, status: "live" });

        return;
      }

      case "result": {
        const request = requests.get(message.id);

        if (request !== undefined) {
          requests.delete(message.id);
          Deferred.doneUnsafe(request.answer, Effect.succeed(message.result));

          return;
        }

        if (message.id === watchId) {
          watched = true;
          flush();
          update({});

          return;
        }

        const watching = threadWatchOf(message.id);

        if (watching !== undefined) {
          watching.watch.watched = true;
          flush();
          update({});

          return;
        }

        answered(message.id, submissionIdOf(message));

        return;
      }

      case "error": {
        const request = message.id === undefined ? undefined : requests.get(message.id);

        if (message.id !== undefined && request !== undefined) {
          requests.delete(message.id);
          Deferred.doneUnsafe(
            request.answer,
            Effect.fail(SessionCommandError.make({ message: message.message })),
          );

          return;
        }

        const failed = message.id === undefined ? undefined : threadWatchOf(message.id);

        if (message.id === watchId) {
          // The watch was refused: start over on a new socket, after the backoff, rather than asking again at once.
          lost(from, message.message);
        } else if (failed !== undefined) {
          threadFailed(failed.conversationId, message.message);
        } else if (message.id !== undefined) {
          const submit = pending.find((held) => held.commandId === message.id);

          answered(message.id, undefined, message.message);

          // A submitter told how it ended shows the refusal itself.
          if (submit?.outcome !== undefined) return;

          if (submit?.conversationId === undefined) update({ failure: message.message });
          else update({}, submit.conversationId, { failure: message.message });
        } else if (message.conversationId !== undefined) {
          // The watch ended and is dropped: the root's starts over, after the backoff, to resume it.
          if (message.conversationId === root) lost(from, message.message);
          else threadFailed(message.conversationId, message.message);
        } else {
          update({ failure: message.message });
        }

        return;
      }
    }
  };

  /** What connection `from` said, unless it has been replaced since. */
  const hear = (from: Connection, frames: ReadonlyArray<string>): void => {
    for (const text of frames) {
      if (connection !== from) return;

      // Anything heard shows the socket is alive.
      from.silent = false;

      if (text === HEARTBEAT.response) continue;

      const message = Option.getOrUndefined(decodeServerMessage(text));

      if (message !== undefined) handle(from, message);
    }
  };

  const addThread = (conversationId: number): void => {
    threadWatches.set(conversationId, {
      commandId: null,
      watched: false,
      status: "loading",
      view: EMPTY_VIEW,
      failure: null,
      todos: NO_TODOS,
    });
    startThreadWatch(conversationId);
    update({});
  };

  const releaseThread = (conversationId: number): void => {
    if (!threadWatches.delete(conversationId)) return;

    threadLanes.delete(conversationId);

    // Submits not yet sent to a conversation nobody shows are dropped with it.
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const submit = pending[index];

      if (submit?.conversationId === conversationId && !submit.sent) {
        pending.splice(index, 1);
        settle(submit, "The conversation was closed before the message was sent.");
      }
    }

    send({ type: "unwatch", id: nextCommandId(), conversationId: conversation(conversationId) });
    update({});
  };

  /**
   * Send `message` (made with its command ID) and wait for its answer, read by `read`. `acts` says whether it changes
   * the Session, as a command does and a catalog request does not.
   */
  const request = <A>(
    message: (id: string) => ClientMessage,
    read: (result: ResultValue) => Option.Option<A>,
    acts = false,
  ): Effect.Effect<A, SessionCommandError> =>
    Effect.suspend(() => {
      const id = nextCommandId();

      if (connection === null)
        return Effect.fail(SessionCommandError.make({ message: NOT_CONNECTED }));

      const answer = Deferred.makeUnsafe<ResultValue, SessionCommandError>();

      requests.set(id, { answer, acts });
      send(message(id));

      return Deferred.await(answer).pipe(
        Effect.flatMap((result) =>
          Effect.fromOption(read(result)).pipe(
            Effect.mapError(() =>
              SessionCommandError.make({ message: "The session's answer could not be read." }),
            ),
          ),
        ),
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            requests.delete(id);
          }),
        ),
      );
    });

  /** Address a request's message to `conversationId` when it names a subagent's conversation. */
  const addressTo = (
    message: { conversationId?: ConversationId },
    conversationId: number | undefined,
  ): void => {
    if (!isRoot(conversationId) && conversationId !== undefined) {
      message.conversationId = conversation(conversationId);
    }
  };

  const enqueue = (
    message: string | OutgoingMessage,
    whenBusy: WhenBusy,
    conversationId: number | undefined,
    outcome: Deferred.Deferred<void, SessionCommandError> | undefined,
    // @effect-diagnostics-next-line cryptoRandomUUID:off
    requestId: string = crypto.randomUUID(),
  ): void => {
    const { input, display } = Predicate.isString(message)
      ? { input: message, display: message }
      : message;

    pending.push({
      commandId: nextCommandId(),
      requestId,
      input,
      text: display,
      whenBusy,
      conversationId: isRoot(conversationId) ? undefined : conversationId,
      sent: false,
      outcome,
    });
    flush();

    if (isRoot(conversationId)) update({ failure: null });
    else update({}, conversationId, { failure: null });
  };

  /** Keep `ended` alive: a ping every `HEARTBEAT_INTERVAL_MS`; ends once one goes unanswered for `PONG_TIMEOUT_MS`. */
  const heartbeat = (ended: Connection) =>
    Effect.gen(function* () {
      yield* Effect.sleep(Duration.millis(HEARTBEAT_INTERVAL_MS));

      // A ping every interval; the pong's deadline falls inside it, as the timeout is the shorter.
      while (!ended.over) {
        yield* step(() => {
          ended.ws?.send(HEARTBEAT.request);
          ended.silent = true;
        });
        yield* Effect.sleep(Duration.millis(PONG_TIMEOUT_MS));

        if (ended.silent) {
          yield* step(() => {
            lost(ended);
          });

          return;
        }

        yield* Effect.sleep(Duration.millis(HEARTBEAT_INTERVAL_MS - PONG_TIMEOUT_MS));
      }
    });

  /** Dial a socket and serve it until it closes or the client gives up on it; then its end has been dealt with. */
  const connectOnce = Effect.gen(function* () {
    const attempt: Connection = {
      ws: null,
      end: Deferred.makeUnsafe<void>(),
      over: false,
      silent: false,
    };

    const socket = yield* Socket.fromWebSocket(
      Effect.acquireRelease(
        Effect.sync(() => {
          const ws = makeWebSocket(socketUrl);

          attempt.ws = ws;

          return ws;
        }),
        (ws) =>
          Effect.sync(() => {
            ws.close();
          }),
      ),
      // As long as the browser takes: it closes a socket that cannot open.
      { openTimeout: Duration.infinity },
    );

    // The close code, when the socket closed with one; nothing when the client gave up on it (`lost` has run).
    const code = yield* Effect.gen(function* () {
      const pull = yield* Socket.readerString(socket);

      yield* step(() => {
        connection = attempt;
        watched = false;
        watchId = null;
      });

      const serve = Effect.forever(
        Effect.flatMap(pull, (frames) =>
          step(() => {
            hear(attempt, frames);
          }),
        ),
      );

      yield* Effect.raceAllFirst([serve, heartbeat(attempt), Deferred.await(attempt.end)]);

      return undefined;
    }).pipe(
      Effect.catch((error) => error.pipe(closeCodeOf, Effect.succeed)),
      Effect.scoped,
    );

    // A close the client did not ask for: the Session said why, or the network dropped it.
    yield* step(() => {
      if (attempt.over) return;

      if (code === SESSION_DELETED_CLOSE_CODE) deleted(attempt);
      else lost(attempt);
    });
  });

  /** Connect, and again after each close, until the client stops. */
  const supervise = Effect.gen(function* () {
    while (!stopped) {
      yield* connectOnce;

      if (stopped) return;

      if (attempts >= PROBE_AFTER_ATTEMPTS) {
        // Repeated failure: find out whether another attempt can work before making one.
        const reach = yield* probe(socketUrl);

        if (reach !== "reachable") {
          yield* step(() => {
            stopped = true;
            update({ status: reach });
          });

          return;
        }
      }

      yield* Effect.sleep(Duration.millis(nextDelay));
    }
  });

  const threadMap = yield* RcMap.make({
    lookup: (conversationId: number) =>
      Effect.acquireRelease(
        step(() => {
          addThread(conversationId);
        }),
        () =>
          step(() => {
            releaseThread(conversationId);
          }),
      ),
  });

  // Closing the scope: the supervisor stops first (its socket closes with it), then the client says it is closed.
  yield* Effect.addFinalizer(() =>
    step(() => {
      stopped = true;
      connection = null;
      failRequests("The session was closed.");
      update({ status: "closed" });
    }),
  );

  yield* Effect.forkScoped(supervise);

  const client: SessionClient = {
    state,
    submit: (message, whenBusy, conversationId) =>
      step(() => {
        enqueue(message, whenBusy, conversationId, undefined);
      }),
    submitAndAwait: (message, whenBusy, conversationId, requestId) =>
      Effect.suspend(() => {
        const outcome = Deferred.makeUnsafe<void, SessionCommandError>();

        return step(() => {
          enqueue(message, whenBusy, conversationId, outcome, requestId);
        }).pipe(Effect.andThen(Deferred.await(outcome)));
      }),
    watchThread: (conversationId) => RcMap.get(threadMap, conversationId),
    watchTaskGraph: step(() => {
      if (graphWanted) return;

      graphWanted = true;

      if (root !== null) send({ type: "watch_task_graph", id: nextCommandId() });
    }),
    watchUsage: step(() => {
      if (usageWanted) return;

      usageWanted = true;

      if (root !== null) send({ type: "watch_usage", id: nextCommandId() });
    }),
    configure: (change) =>
      step(() => {
        send({ type: "configure", id: nextCommandId(), ...change });
      }),
    answerSecrets: (request, values) =>
      step(() => {
        send({ type: "secret_answer", id: nextCommandId(), request, values });
      }),
    abort: (target = {}) =>
      step(() => {
        if (connection === null) return;

        const { conversationId, subagents } = target;

        const abort: Types.Mutable<Extract<ClientMessage, { type: "abort" }>> = {
          type: "abort",
          id: nextCommandId(),
        };

        if (conversationId !== undefined) abort.conversationId = conversation(conversationId);

        if (subagents !== undefined) abort.subagents = subagents;

        send(abort);
      }),
    catalog: (conversationId) =>
      request((id) => {
        const message: Types.Mutable<Extract<ClientMessage, { type: "catalog" }>> = {
          type: "catalog",
          id,
        };

        addressTo(message, conversationId);

        return message;
      }, decodeCatalog),
    files: (query, conversationId) =>
      request((id) => {
        const message: Types.Mutable<Extract<ClientMessage, { type: "files" }>> = {
          type: "files",
          id,
          query,
        };

        addressTo(message, conversationId);

        return message;
      }, decodeFileMatches),
    command: (name, args, conversationId) =>
      request(
        (id) => {
          const message: Types.Mutable<Extract<ClientMessage, { type: "command" }>> = {
            type: "command",
            id,
            name,
            args,
          };

          addressTo(message, conversationId);

          return message;
        },
        decodeOutcome,
        true,
      ),
    loadEarlier: (before, conversationId) =>
      request((id) => {
        const message: Types.Mutable<Extract<ClientMessage, { type: "history" }>> = {
          type: "history",
          id,
          before,
        };

        addressTo(message, conversationId);

        return message;
      }, decodeHistoryPage).pipe(
        Effect.map((page) => {
          // A view whose snapshot moved on since it asked keeps what it has: `withEarlier` checks `before`.
          if (isRoot(conversationId) || conversationId === undefined) {
            update({ view: withEarlier(current.view, before, page) });

            return;
          }

          const thread = threadWatches.get(conversationId);

          if (thread === undefined) return;

          thread.view = withEarlier(thread.view, before, page);
          update({}, conversationId);
        }),
      ),
  };

  return client;
});
