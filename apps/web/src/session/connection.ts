// The browser's end of a Session socket (`docs/spec.md` → Client and protocol, ADR-0009): it connects, watches the
// root conversation the Session names in `hello`, folds the events into a `SessionView`, sends the user's commands,
// and keeps the connection alive: a heartbeat, and a reconnect with a fresh watch after any close.

// @effect-diagnostics asyncFunction:off cryptoRandomUUID:off globalFetch:off globalTimers:off preferEffectArray:off -- browser code in a React app with no Effect runtime: native arrays, promises, timers, Date and fetch are the platform here.

import {
  EMPTY_VIEW,
  HEARTBEAT,
  reduceEvents,
  ServerMessageJson,
  type ClientMessage,
  type ConversationId,
  type BrowserHandoffRequest,
  type SecretRequest,
  type ServerMessage,
  type SessionView,
  type TaskGraphSummary,
  type WhenBusy,
} from "@cloudpid/protocol";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import type * as Types from "effect/Types";

/** How often the client pings an open socket. */
export const HEARTBEAT_INTERVAL_MS = 25_000;

/** How long after a ping the socket may stay silent before it counts as dead and is replaced. */
export const PONG_TIMEOUT_MS = 10_000;

const RECONNECT_BASE_MS = 500;

const RECONNECT_MAX_MS = 10_000;

/** The part of a `WebSocket` the connection uses, so a test can drive it by hand. */
export interface SessionSocket {
  send(data: string): void;
  close(): void;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<string>) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
}

export type SessionSocketFactory = (url: string) => SessionSocket;

/**
 * `connecting`: no snapshot yet. `live`: the view is current. `reconnecting`: the socket closed; the view is the
 * last one seen, until a fresh snapshot replaces it. `signed-out` and `missing`: reconnecting is pointless, because
 * Access no longer lets the page through, or the Session does not exist (found out by asking over HTTP after a few
 * failed attempts, as a WebSocket cannot see why it failed). `closed`: disposed.
 */
export type ConnectionStatus =
  | "connecting"
  | "live"
  | "reconnecting"
  | "signed-out"
  | "missing"
  | "closed";

/** What `configure` changes: the fields of the `configure` command, without its `type` and `id`. */
export type ConfigureChange = Omit<Extract<ClientMessage, { type: "configure" }>, "type" | "id">;

/** A queued input. `text` is null when this page did not send it (it was sent before a reload). */
export interface QueuedEntry {
  readonly id: string;
  readonly text: string | null;
}

/** The inbox by lane: steers join the running Run, follow-ups wait for the next one. */
export interface QueueLanes {
  readonly steer: readonly QueuedEntry[];
  readonly followUp: readonly QueuedEntry[];
}

/** A submit the Session has not answered yet, which shows as "sending" until it does. */
export interface SendingEntry {
  readonly id: string;
  readonly text: string;
}

/** Which of the model and thinking level the Session picked itself; the rest follows the default in the settings. */
export interface Picked {
  readonly model: boolean;
  readonly thinkingLevel: boolean;
}

/**
 * A subagent's conversation, watched on the same socket. `loading` until its snapshot lands; `failed` when the
 * Session refused or ended the watch (`failure` says why), which is not retried: the thread is opened again to retry.
 */
export interface ThreadState {
  readonly status: "loading" | "live" | "failed";
  readonly view: SessionView;
  readonly queue: QueueLanes;
  /** Submits to this conversation the Session has not answered. */
  readonly sending: readonly SendingEntry[];
  /** Why the watch failed, or the last submit to it did; until the next submit. */
  readonly failure: string | null;
}

/** What an abort reaches: the root by default; see the `abort` command. */
export interface AbortTarget {
  /** The subagent's conversation to abort. */
  readonly conversationId?: number;
  /** Also stop the subagents below it. */
  readonly subagents?: boolean;
}

/** A conversation ID as the protocol brands it. */
const conversation = (id: number): ConversationId =>
  // SAFETY: a number the Session named: in a task graph summary or a tool result's `conversation_id`.
  id as ConversationId;

export interface SessionState {
  readonly status: ConnectionStatus;
  readonly view: SessionView;
  readonly picked: Picked;
  readonly queue: QueueLanes;
  /** Submits held for want of a connection, or not yet answered. */
  readonly sending: readonly SendingEntry[];
  /** The message of the last command that failed, until the next submit. */
  readonly failure: string | null;
  /** Requests for Secrets waiting for the owner, to answer in a masked form; never shown in the chat. */
  readonly secretRequests: readonly SecretRequest[];
  /** How long an entered Secret is held, as the Session says. */
  readonly secretLifetimeMinutes: number;
  /** Browser Handoffs waiting for the owner, each with the Live View link to open; never shown in the chat. */
  readonly browserHandoffRequests: readonly BrowserHandoffRequest[];
  /** The subagent threads being watched, by conversation ID. */
  readonly threads: Readonly<Record<string, ThreadState>>;
  /** The Session's subagents and background work, as of the last summary; null until it sends one. */
  readonly taskGraph: TaskGraphSummary | null;
}

/** A watch of a subagent's conversation, shared by everything that shows it. */
interface ThreadWatch {
  refs: number;
  /** The `watch` command being answered, or null when none is out. */
  commandId: string | null;
  /** Whether the Session answered the watch, so a submit to it cannot land before its snapshot. */
  watched: boolean;
  status: ThreadState["status"];
  view: SessionView;
  failure: string | null;
}

/** A submit not yet answered. Its `requestId` makes sending it again safe. */
interface PendingSubmit {
  readonly commandId: string;
  readonly requestId: string;
  readonly text: string;
  readonly whenBusy: WhenBusy;
  /** The subagent's conversation it is for; the root's when absent. */
  readonly conversationId: number | undefined;
  /** Whether it went out on the current socket. */
  sent: boolean;
}

const decodeServerMessage = Schema.decodeOption(ServerMessageJson);

const SubmitResult = Schema.Struct({ submissionId: Schema.Union([Schema.String, Schema.Finite]) });

const decodeSubmitResult = Schema.decodeUnknownOption(SubmitResult);

const submissionIdOf = (result: ServerMessage & { type: "result" }): string | undefined =>
  Option.match(decodeSubmitResult(result.result), {
    onNone: () => undefined,
    onSome: ({ submissionId }) => String(submissionId),
  });

const EMPTY_QUEUE: QueueLanes = { steer: [], followUp: [] };

const NO_SENDING: readonly SendingEntry[] = [];

/** What asking the Session over HTTP shows about why its socket does not open. */
export type Reachability = "reachable" | "signed-out" | "missing";

export type SessionProbe = (socketUrl: string) => Promise<Reachability>;

/** After this many failed attempts without a snapshot, the client asks over HTTP whether trying again can work. */
const PROBE_AFTER_ATTEMPTS = 2;

/**
 * A plain GET of the socket's path, redirects not followed: Access answers a lapsed sign-in with a redirect to its
 * login (or a 401), the Worker answers a Session the Registry does not know with 404, and anything else (the Session
 * itself wants an upgrade) means the socket is worth another try.
 */
export const probeSession: SessionProbe = async (socketUrl) => {
  const url = new URL(socketUrl);

  url.protocol = url.protocol === "wss:" ? "https:" : "http:";

  try {
    const response = await fetch(url, { redirect: "manual" });

    if (response.type === "opaqueredirect" || response.status === 401 || response.status === 403) {
      return "signed-out";
    }

    return response.status === 404 ? "missing" : "reachable";
  } catch {
    return "reachable";
  }
};

export class SessionConnection {
  private readonly listeners = new Set<() => void>();
  private readonly texts = new Map<string, string>();
  private readonly pending: PendingSubmit[] = [];
  private socket: SessionSocket | null = null;
  private readonly threadWatches = new Map<number, ThreadWatch>();
  private readonly threadLanes = new Map<
    number,
    { readonly inbox: SessionView["inbox"]; readonly version: number; readonly queue: QueueLanes }
  >();
  private graphWanted = false;
  private root: ConversationId | null = null;
  private watchId: string | null = null;
  private watched = false;
  private opened = false;
  private disposed = false;
  private attempts = 0;
  private commands = 0;
  private textsVersion = 0;
  private lanesFor: { readonly inbox: SessionView["inbox"]; readonly version: number } | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private pongTimer: ReturnType<typeof setTimeout> | undefined;
  private state: SessionState = {
    status: "connecting",
    view: EMPTY_VIEW,
    picked: { model: false, thinkingLevel: false },
    queue: EMPTY_QUEUE,
    sending: [],
    failure: null,
    secretRequests: [],
    secretLifetimeMinutes: 15,
    browserHandoffRequests: [],
    threads: {},
    taskGraph: null,
  };

  constructor(
    private readonly url: string,
    private readonly createSocket: SessionSocketFactory = (target) => new WebSocket(target),
    private readonly probe: SessionProbe = probeSession,
  ) {
    this.connect();
  }

  /** For `useSyncExternalStore`: the same object until something changes. */
  readonly getState = (): SessionState => this.state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  };

  /**
   * Submit `text`. Idle, it starts a Run; busy, `steer` joins the running Run at its next boundary and `followUp`
   * waits for the next Run. Held until the watch is answered (a submit sent before it can land before the snapshot),
   * and sent again after a reconnect if no answer came.
   */
  submit(text: string, whenBusy: WhenBusy, conversationId?: number): void {
    this.pending.push({
      commandId: this.nextCommandId(),
      requestId: crypto.randomUUID(),
      text,
      whenBusy,
      conversationId: this.isRoot(conversationId) ? undefined : conversationId,
      sent: false,
    });
    this.flush();

    if (this.isRoot(conversationId)) this.update({ failure: null });
    else this.update({}, conversationId, { failure: null });
  }

  /**
   * Watch subagent conversation `conversationId` on this socket, from a snapshot, and keep `threads[conversationId]`
   * current until the returned function is called. However many ask for the same conversation, it is watched once, and
   * unwatched when the last lets go. Each new socket watches it again.
   */
  watchThread(conversationId: number): () => void {
    const known = this.threadWatches.get(conversationId);

    if (known !== undefined) known.refs += 1;
    else {
      this.threadWatches.set(conversationId, {
        refs: 1,
        commandId: null,
        watched: false,
        status: "loading",
        view: EMPTY_VIEW,
        failure: null,
      });
      this.startThreadWatch(conversationId);
      this.update({});
    }

    let released = false;

    return () => {
      if (released) return;

      released = true;
      this.releaseThread(conversationId);
    };
  }

  /** Stream the Session's task graph into `taskGraph`: once is enough, and a new socket asks again. */
  watchTaskGraph(): void {
    if (this.graphWanted) return;

    this.graphWanted = true;

    if (this.root !== null) this.send({ type: "watch_task_graph", id: this.nextCommandId() });
  }

  /**
   * Pick the model and thinking level of the root conversation's next request. A field left out stays as it is, and
   * `null` makes the Session follow the default in the settings again. The Session's `agent_changed` event brings
   * the new pick into the view; a refusal shows as `failure`.
   */
  configure(change: ConfigureChange): void {
    if (this.opened) this.send({ type: "configure", id: this.nextCommandId(), ...change });
  }

  /**
   * Answer Secret request `request` with the values the owner typed (a name left out is skipped), or `null` when the
   * owner cancelled. The values go to the Session once and are not kept here; the Session's next `secret_requests`
   * closes the form, and a refusal shows as `failure`.
   */
  answerSecrets(request: string, values: Readonly<Record<string, string>> | null): void {
    if (this.opened) {
      this.send({ type: "secret_answer", id: this.nextCommandId(), request, values });
    }
  }

  /**
   * Abort the root conversation's work and withdraw its queued input, or a subagent's when `conversationId` names
   * it. With `subagents`, the agents below it stop too; otherwise they keep working.
   */
  abort(target: AbortTarget = {}): void {
    if (!this.opened) return;

    const { conversationId, subagents } = target;

    const abort: Types.Mutable<Extract<ClientMessage, { type: "abort" }>> = {
      type: "abort",
      id: this.nextCommandId(),
    };

    if (conversationId !== undefined) abort.conversationId = conversation(conversationId);

    if (subagents !== undefined) abort.subagents = subagents;

    this.send(abort);
  }

  dispose(): void {
    this.disposed = true;
    this.stopTimers();

    const socket = this.socket;

    this.socket = null;
    socket?.close();
    this.update({ status: "closed" });
  }

  private connect(): void {
    const socket = this.createSocket(this.url);

    this.socket = socket;
    this.opened = false;
    this.watched = false;
    this.watchId = null;

    // A replaced socket may still say something; only the current one counts.
    socket.onopen = () => {
      if (this.socket !== socket) return;

      this.opened = true;
      this.startHeartbeat();
    };

    socket.onmessage = (message) => {
      if (this.socket !== socket) return;

      this.hear(message.data);
    };

    socket.onclose = () => {
      if (this.socket !== socket) return;

      this.lost();
    };
  }

  private hear(text: string): void {
    // Anything heard shows the socket is alive.
    clearTimeout(this.pongTimer);

    if (text === HEARTBEAT.response) return;

    const message = Option.getOrUndefined(decodeServerMessage(text));

    if (message !== undefined) this.handle(message);
  }

  private handle(message: ServerMessage): void {
    switch (message.type) {
      case "hello":
        this.root = message.root;
        this.watch();

        for (const conversationId of this.threadWatches.keys())
          this.startThreadWatch(conversationId);

        if (this.graphWanted) this.send({ type: "watch_task_graph", id: this.nextCommandId() });

        return;
      case "task_graph":
        this.update({ taskGraph: { agents: message.agents, background: message.background } });

        return;
      case "picked":
        this.update({ picked: { model: message.model, thinkingLevel: message.thinkingLevel } });

        return;
      case "secret_requests":
        this.update({
          secretRequests: message.requests,
          secretLifetimeMinutes: message.lifetimeMinutes,
        });

        return;
      case "browser_handoff_requests":
        this.update({ browserHandoffRequests: message.requests });

        return;
      case "events": {
        const thread = this.threadWatches.get(message.conversationId);

        if (message.conversationId !== this.root) {
          if (thread !== undefined) {
            thread.view = reduceEvents(thread.view, message.events);
            thread.status = "live";
            thread.failure = null;
            this.update({}, message.conversationId);
          }

          return;
        }

        const view = reduceEvents(this.state.view, message.events);

        if (message.events.some((event) => event.type === "snapshot")) {
          // What the snapshot's inbox no longer holds has been placed, or was withdrawn.
          const queued = new Set(view.inbox.map((item) => String(item.id)));

          for (const id of this.texts.keys()) {
            if (queued.has(id)) continue;

            this.texts.delete(id);
            this.textsVersion += 1;
          }
        }

        // A snapshot or event shows the watch works, so the next failure starts the backoff over.
        this.attempts = 0;
        this.update({ view, status: "live" });

        return;
      }

      case "result": {
        if (message.id === this.watchId) {
          this.watched = true;
          this.flush();
          this.update({});

          return;
        }

        const watching = this.threadWatchOf(message.id);

        if (watching !== undefined) {
          watching.watch.watched = true;
          this.flush();
          this.update({});

          return;
        }

        this.answered(message.id, submissionIdOf(message));

        return;
      }

      case "error": {
        const failed = message.id === undefined ? undefined : this.threadWatchOf(message.id);

        if (message.id === this.watchId) {
          // The watch was refused: start over on a new socket, after the backoff, rather than asking again at once.
          this.lost(message.message);
        } else if (failed !== undefined) {
          this.threadFailed(failed.conversationId, message.message);
        } else if (message.id !== undefined) {
          const conversationId = this.pending.find(
            (submit) => submit.commandId === message.id,
          )?.conversationId;

          this.answered(message.id, undefined);

          if (conversationId === undefined) this.update({ failure: message.message });
          else this.update({}, conversationId, { failure: message.message });
        } else if (message.conversationId !== undefined) {
          // The watch ended and is dropped: the root's starts over, after the backoff, to resume it.
          if (message.conversationId === this.root) this.lost(message.message);
          else this.threadFailed(message.conversationId, message.message);
        } else {
          this.update({ failure: message.message });
        }

        return;
      }
    }
  }

  private isRoot(conversationId: number | undefined): boolean {
    return conversationId === undefined || conversationId === this.root;
  }

  private threadWatchOf(
    commandId: string,
  ): { readonly conversationId: number; readonly watch: ThreadWatch } | undefined {
    for (const [conversationId, watch] of this.threadWatches) {
      if (watch.commandId === commandId) return { conversationId, watch };
    }

    return undefined;
  }

  private startThreadWatch(conversationId: number): void {
    const watch = this.threadWatches.get(conversationId);

    if (watch === undefined || !this.opened) return;

    watch.watched = false;
    watch.commandId = this.nextCommandId();
    this.send({ type: "watch", id: watch.commandId, conversationId: conversation(conversationId) });
  }

  private releaseThread(conversationId: number): void {
    const watch = this.threadWatches.get(conversationId);

    if (watch === undefined) return;

    watch.refs -= 1;

    if (watch.refs > 0) return;

    this.threadWatches.delete(conversationId);
    this.threadLanes.delete(conversationId);

    // Submits not yet sent to a conversation nobody shows are dropped with it.
    for (let index = this.pending.length - 1; index >= 0; index -= 1) {
      const submit = this.pending[index];

      if (submit?.conversationId === conversationId && !submit.sent) this.pending.splice(index, 1);
    }

    if (this.opened) {
      this.send({
        type: "unwatch",
        id: this.nextCommandId(),
        conversationId: conversation(conversationId),
      });
    }

    this.update({});
  }

  /** The Session refused or ended the watch of a subagent's conversation: the thread says why, and is not retried. */
  private threadFailed(conversationId: number, failure: string): void {
    const watch = this.threadWatches.get(conversationId);

    if (watch === undefined) return;

    watch.status = "failed";
    watch.watched = false;
    watch.commandId = null;
    watch.failure = failure;
    this.update({}, conversationId);
  }

  /** A command's answer: a submit that has one is done, and a successful one has a submission ID to remember. */
  private answered(commandId: string, submissionId: string | undefined): void {
    const index = this.pending.findIndex((submit) => submit.commandId === commandId);
    const submit = this.pending[index];

    if (submit === undefined) return;

    this.pending.splice(index, 1);

    if (submissionId !== undefined) {
      this.texts.set(submissionId, submit.text);
      this.textsVersion += 1;
    }

    this.update({});
  }

  private watch(): void {
    if (this.root === null) return;

    this.watched = false;
    this.watchId = this.nextCommandId();
    this.send({ type: "watch", id: this.watchId, conversationId: this.root });
  }

  private flush(): void {
    for (const submit of this.pending) {
      if (submit.sent) continue;

      // A submit waits for the watch of the conversation it is for: it could land before the snapshot otherwise.
      const ready =
        submit.conversationId === undefined
          ? this.watched
          : this.threadWatches.get(submit.conversationId)?.watched === true;

      if (!ready) continue;

      const message: Types.Mutable<Extract<ClientMessage, { type: "submit" }>> = {
        type: "submit",
        id: submit.commandId,
        input: submit.text,
        whenBusy: submit.whenBusy,
        requestId: submit.requestId,
      };

      if (submit.conversationId !== undefined) {
        message.conversationId = conversation(submit.conversationId);
      }

      submit.sent = true;
      this.send(message);
    }
  }

  private send(message: ClientMessage): void {
    this.socket?.send(JSON.stringify(message));
  }

  private nextCommandId(): string {
    this.commands += 1;

    return `c${this.commands}`;
  }

  /** The socket closed or went silent: start over on a new one after a pause. */
  private lost(failure?: string): void {
    const socket = this.socket;

    this.socket = null;
    this.opened = false;
    this.watched = false;
    this.stopTimers();

    // What was sent went with the socket; the answers will not come.
    for (const submit of this.pending) submit.sent = false;

    for (const watch of this.threadWatches.values()) {
      watch.watched = false;
      watch.commandId = null;
    }

    // The next socket says again which Secret requests and Browser Handoffs wait.
    this.state = { ...this.state, secretRequests: [], browserHandoffRequests: [] };

    // An unanswered close may leave the socket open at this end.
    socket?.close();

    if (this.disposed) return;

    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.attempts, RECONNECT_MAX_MS);

    this.attempts += 1;
    this.update(
      failure === undefined ? { status: "reconnecting" } : { status: "reconnecting", failure },
    );

    if (this.attempts < PROBE_AFTER_ATTEMPTS) {
      this.scheduleReconnect(delay);

      return;
    }

    // Repeated failure: find out whether another attempt can work before making one.
    void this.probe(this.url).then((reach) => {
      if (this.disposed || this.socket !== null) return;

      if (reach === "reachable") this.scheduleReconnect(delay);
      else this.update({ status: reach });
    });
  }

  private scheduleReconnect(delay: number): void {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      if (!this.disposed) this.connect();
    }, delay);
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      this.socket?.send(HEARTBEAT.request);
      clearTimeout(this.pongTimer);
      this.pongTimer = setTimeout(() => {
        this.lost();
      }, PONG_TIMEOUT_MS);
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopTimers(): void {
    clearTimeout(this.reconnectTimer);
    clearInterval(this.heartbeatTimer);
    clearTimeout(this.pongTimer);
  }

  /**
   * Apply `change` and tell the listeners. `patch` sets the failure shown on thread `thread`; every thread's state
   * is rebuilt from its watch, reusing what did not change.
   */
  private update(
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
      >
    >,
    thread?: number,
    patch?: { readonly failure: string | null },
  ): void {
    if (thread !== undefined && patch !== undefined) {
      const watch = this.threadWatches.get(thread);

      if (watch !== undefined) watch.failure = patch.failure;
    }

    const next = { ...this.state, ...change };

    const reuse =
      this.lanesFor?.inbox === next.view.inbox && this.lanesFor.version === this.textsVersion;

    const queue = reuse ? this.state.queue : this.lanes(next.view);

    this.lanesFor = { inbox: next.view.inbox, version: this.textsVersion };
    this.state = { ...next, queue, sending: this.sending(), threads: this.threads() };

    for (const listener of this.listeners) listener();
  }

  /** Each watched subagent thread's state, the same object as before where nothing about it changed. */
  private threads(): Readonly<Record<string, ThreadState>> {
    const before = this.state.threads;
    const threads: Record<string, ThreadState> = {};
    let same = Record.size(before) === this.threadWatches.size;

    for (const [conversationId, watch] of this.threadWatches) {
      const key = String(conversationId);
      const previous = before[key];
      const lanes = this.threadLanes.get(conversationId);

      const queue =
        lanes?.inbox === watch.view.inbox && lanes.version === this.textsVersion
          ? lanes.queue
          : this.lanes(watch.view);

      this.threadLanes.set(conversationId, {
        inbox: watch.view.inbox,
        version: this.textsVersion,
        queue,
      });

      const sending = this.sendingTo(conversationId, previous?.sending);

      const unchanged =
        previous !== undefined &&
        previous.status === watch.status &&
        previous.view === watch.view &&
        previous.queue === queue &&
        previous.sending === sending &&
        previous.failure === watch.failure;

      threads[key] = unchanged
        ? previous
        : { status: watch.status, view: watch.view, queue, sending, failure: watch.failure };
      same = same && unchanged;
    }

    return same ? before : threads;
  }

  /** The submits to subagent conversation `conversationId` the Session has not answered. */
  private sendingTo(
    conversationId: number,
    previous: readonly SendingEntry[] | undefined,
  ): readonly SendingEntry[] {
    const next = this.pending
      .filter((submit) => submit.conversationId === conversationId)
      .map((submit) => ({ id: submit.commandId, text: submit.text }));

    if (previous === undefined) return next.length === 0 ? NO_SENDING : next;

    return previous.length === next.length &&
      previous.every((entry, index) => entry.id === next[index]?.id)
      ? previous
      : next.length === 0
        ? NO_SENDING
        : next;
  }

  /** The submits the Session has not answered, in the order they were made. */
  private sending(): readonly SendingEntry[] {
    const previous = this.state.sending;

    const next = this.pending
      .filter((submit) => submit.conversationId === undefined)
      .map((submit) => ({ id: submit.commandId, text: submit.text }));

    // Keep the same array while nothing changed, so a view of it need not re-render.
    return previous.length === next.length &&
      previous.every((entry, index) => entry.id === next[index]?.id)
      ? previous
      : next;
  }

  private lanes(view: SessionView): QueueLanes {
    const entry = (id: string): QueuedEntry => ({ id, text: this.texts.get(id) ?? null });
    const steer: QueuedEntry[] = [];
    const followUp: QueuedEntry[] = [];

    for (const item of view.inbox) {
      if (item.mode === "steer") steer.push(entry(String(item.id)));
      else if (item.mode === "followUp") followUp.push(entry(String(item.id)));
    }

    return { steer, followUp };
  }
}
