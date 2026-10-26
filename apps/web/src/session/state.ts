// What the browser knows of a Session through its socket (`docs/spec.md` → Client and protocol): the shape
// `SessionClient` keeps in its `SubscriptionRef`, and the types of what its commands take.

import {
  EMPTY_VIEW,
  type ApprovalRequest,
  type BrowserHandoffRequest,
  type OwnerTabDriver,
  type OwnerTabListing,
  type ClientMessage,
  type SecretRequest,
  type SessionUsage,
  type SessionView,
  type TaskGraphSummary,
  type TodoTask,
  type UserInput,
} from "@cloudpid/protocol";

/**
 * `connecting`: no snapshot yet. `live`: the view is current. `reconnecting`: the socket closed; the view is the
 * last one seen, until a fresh snapshot replaces it. `signed-out` and `missing`: reconnecting is pointless, because
 * Access no longer lets the page through, or the Session does not exist (found out by asking over HTTP after a few
 * failed attempts, as a WebSocket cannot see why it failed). `deleted`: the owner deleted the Session, which closed
 * the socket saying so. `closed`: disposed.
 */
export type ConnectionStatus =
  | "connecting"
  | "live"
  | "reconnecting"
  | "signed-out"
  | "missing"
  | "deleted"
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
  /** Its Todo List, as of the last one the Session sent; empty until it sends one. */
  readonly todos: readonly TodoTask[];
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

/** A message with more than text (an Attachment's image): what is submitted, and what its lane shows. */
export interface OutgoingMessage {
  readonly input: UserInput;
  readonly display: string;
}

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
  /** Agent changes waiting for the owner's Approval, each shown as a card with Approve and Decline, oldest first. */
  readonly approvalRequests: readonly ApprovalRequest[];
  /**
   * Browser Handoffs waiting for the owner; a Live View Pane mints its own links for one (`liveView`). Null until this
   * socket has listed them: a Pane closes for a handoff missing from a list it was sent, not from one not sent yet.
   */
  readonly browserHandoffRequests: readonly BrowserHandoffRequest[] | null;
  /**
   * The Browser Pane's Owner tabs and the one shown, as of the last answer or message about them (the Session sends them
   * to every client when one changes them); null until the Pane has asked. They hold no Live View link.
   */
  readonly ownerTabs: OwnerTabListing | null;
  /** The `browser` calls driving the owner's Owner tabs now, for the Browser Pane to say so; none until the socket says. */
  readonly ownerTabDrivers: readonly OwnerTabDriver[];
  /** The subagent threads being watched, by conversation ID. */
  readonly threads: Readonly<Record<string, ThreadState>>;
  /** The Session's subagents and background work, as of the last summary; null until it sends one. */
  readonly taskGraph: TaskGraphSummary | null;
  /** What the Session has spent and its spend limit, as of the last message; null until it sends one. */
  readonly usage: SessionUsage | null;
  /** The active branch's Todo List, as of the last one the Session sent; empty until it sends one. */
  readonly todos: readonly TodoTask[];
  /**
   * The active Session branch's conversation (GLOSSARY.md → Session branch), the one the root view shows; null until the
   * Session says.
   */
  readonly activeBranch: number | null;
  /** How many times the active branch changed, or a branch was made, since the client started: a tree shown is stale. */
  readonly treeVersion: number;
  /** Whether the Session is still being filled from the one it is a Fork or Clone of: it takes no message until done. */
  readonly copying: boolean;
}

/** A Session's state before its socket has said anything. */
export const INITIAL_SESSION_STATE: SessionState = {
  status: "connecting",
  view: EMPTY_VIEW,
  picked: { model: false, thinkingLevel: false },
  queue: { steer: [], followUp: [] },
  sending: [],
  failure: null,
  secretRequests: [],
  secretLifetimeMinutes: 15,
  approvalRequests: [],
  browserHandoffRequests: null,
  ownerTabs: null,
  ownerTabDrivers: [],
  threads: {},
  taskGraph: null,
  usage: null,
  todos: [],
  activeBranch: null,
  treeVersion: 0,
  copying: false,
};

/** What asking the Session over HTTP shows about why its socket does not open. */
export type Reachability = "reachable" | "signed-out" | "missing";
