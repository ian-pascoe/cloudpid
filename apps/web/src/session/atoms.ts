// A Session's socket as atoms (ADR-0011): one `SessionClient` per Session, its state, narrow slices of that state (a
// card that reads the task graph does not render for every token the root streams), and the commands.

import {
  sessionSocketPath,
  type BrowserHandoffRequest,
  type SecretKeep,
  type TodoTask,
  type WhenBusy,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { appRuntime } from "../runtime.ts";
import type { ConversationKey } from "./conversation-key.ts";
import { make } from "./client.ts";
import {
  INITIAL_SESSION_STATE,
  type AbortTarget,
  type ConfigureChange,
  type OutgoingMessage,
  type SessionState,
} from "./state.ts";

/** The socket URL of Session `sessionId`, on the page's origin. */
const socketUrl = (sessionId: string): string => {
  const url = new URL(sessionSocketPath(sessionId), window.location.href);

  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

  return url.href;
};

/** Session `sessionId`'s client: its socket is open while something reads this, and closes when nothing does. */
export const sessionClientAtom = Atom.family((sessionId: string) =>
  appRuntime.atom(Effect.sync(() => socketUrl(sessionId)).pipe(Effect.flatMap((url) => make(url)))),
);

/** The client's state as it changes, once the client is built. */
const stateRefAtom = Atom.family((sessionId: string) =>
  appRuntime.subscriptionRef((get) =>
    get.result(sessionClientAtom(sessionId)).pipe(Effect.map((client) => client.state)),
  ),
);

/** Session `sessionId`'s state: what its socket said, folded; `connecting` until its client is built. */
export const sessionStateAtom = Atom.family((sessionId: string) =>
  Atom.map(stateRefAtom(sessionId), (result) =>
    AsyncResult.getOrElse(result, () => INITIAL_SESSION_STATE),
  ),
);

/** A family of atoms that each hold one field of a Session's state, and change only when it does. */
const slice = <A>(pick: (state: SessionState) => A) =>
  Atom.family((sessionId: string) => Atom.map(sessionStateAtom(sessionId), pick));

/** Whether the Session's socket is live, and why not. */
export const sessionStatusAtom = slice((state) => state.status);

/** The root conversation's view. */
export const sessionViewAtom = slice((state) => state.view);

/** The root conversation's queued input, by lane. */
export const sessionQueueAtom = slice((state) => state.queue);

/** The submits to the root the Session has not answered. */
export const sessionSendingAtom = slice((state) => state.sending);

/** Why the last command failed, until the next submit. */
export const sessionFailureAtom = slice((state) => state.failure);

/** Which of the model and thinking level the Session picked itself. */
export const sessionPickedAtom = slice((state) => state.picked);

/** The Secret requests waiting for the owner. */
export const secretRequestsAtom = slice((state) => state.secretRequests);

/** How long an entered Secret is held, as the Session says. */
export const secretLifetimeMinutesAtom = slice((state) => state.secretLifetimeMinutes);

/** The Agent changes waiting for the owner's Approval. */
export const approvalRequestsAtom = slice((state) => state.approvalRequests);

const NO_HANDOFFS: readonly BrowserHandoffRequest[] = [];

/** The Browser Handoffs waiting for the owner: none until the socket lists them. */
export const browserHandoffRequestsAtom = slice(
  (state) => state.browserHandoffRequests ?? NO_HANDOFFS,
);

/** The Browser Handoffs waiting, or null until this socket has listed them (a Live View closes only on a list). */
export const listedBrowserHandoffRequestsAtom = slice((state) => state.browserHandoffRequests);

/** The Browser Pane's Owner tabs and the one shown, as this client last heard them; null until it has. */
export const ownerTabsAtom = slice((state) => state.ownerTabs);

/** The `browser` calls driving the owner's Owner tabs now. */
export const ownerTabDriversAtom = slice((state) => state.ownerTabDrivers);

/** The root conversation's Todo List. */
export const todosAtom = slice((state) => state.todos);

/** Watches the Session's task graph while mounted (a new socket asks again). */
const watchingTaskGraphAtom = Atom.family((sessionId: string) =>
  appRuntime.atom((get) =>
    get
      .result(sessionClientAtom(sessionId))
      .pipe(Effect.flatMap((client) => client.watchTaskGraph)),
  ),
);

const taskGraphFieldAtom = slice((state) => state.taskGraph);

/** The Session's subagents and background work, null until it says; asks the Session to send them while read. */
export const taskGraphAtom = Atom.family((sessionId: string) =>
  Atom.make((get) => {
    get.mount(watchingTaskGraphAtom(sessionId));

    return get(taskGraphFieldAtom(sessionId));
  }),
);

/** Watches what the Session has spent while mounted (a new socket asks again). */
const watchingUsageAtom = Atom.family((sessionId: string) =>
  appRuntime.atom((get) =>
    get.result(sessionClientAtom(sessionId)).pipe(Effect.flatMap((client) => client.watchUsage)),
  ),
);

const usageFieldAtom = slice((state) => state.usage);

/** What the Session has spent and its spend limit, null until it says; asks the Session to send them while read. */
export const usageAtom = Atom.family((sessionId: string) =>
  Atom.make((get) => {
    get.mount(watchingUsageAtom(sessionId));

    return get(usageFieldAtom(sessionId));
  }),
);

/**
 * Watches the Changes `key` names while mounted: the Session's for as long as its client lives (a new socket asks
 * again), a subagent conversation's until nothing mounts this any more.
 */
const watchingChangesAtom = Atom.family(({ sessionId, conversationId }: ConversationKey) =>
  appRuntime.atom((get) =>
    get
      .result(sessionClientAtom(sessionId))
      .pipe(
        Effect.flatMap((client) =>
          conversationId === undefined
            ? client.watchChanges
            : client.watchConversationChanges(conversationId),
        ),
      ),
  ),
);

const changesFieldAtom = Atom.family(({ sessionId, conversationId }: ConversationKey) =>
  Atom.map(sessionStateAtom(sessionId), (state) =>
    conversationId === undefined
      ? state.changes
      : (state.conversationChanges[String(conversationId)] ?? null),
  ),
);

/**
 * The Changes of the conversation `key` names (`conversation-key.ts`): the Session's Workspace's for the root's, or a
 * subagent conversation's Workspace's; null until the Session lists them. Asks the Session to send them while read. The Session's page reads its own for as long
 * as it is open, for the Session details, and a Subagent page the subagent's.
 */
export const changesAtom = Atom.family((key: ConversationKey) =>
  Atom.make((get) => {
    get.mount(watchingChangesAtom(key));

    return get(changesFieldAtom(key));
  }),
);

/** What `change_file` asks for: a file of a repo, and a rename's old path. */
export interface ChangeFileQuery {
  readonly repo: string;
  readonly path: string;
  readonly oldPath?: string;
}

/** A subagent's conversation in a Session. */
export interface ThreadKey {
  readonly sessionId: string;
  readonly conversationId: number;
}

/** Watches a subagent's conversation while mounted; however many mount it, the client watches it once. */
const watchingThreadAtom = Atom.family(({ sessionId, conversationId }: ThreadKey) =>
  appRuntime.atom((get) =>
    get
      .result(sessionClientAtom(sessionId))
      .pipe(Effect.flatMap((client) => client.watchThread(conversationId))),
  ),
);

const threadFieldAtom = Atom.family(({ sessionId, conversationId }: ThreadKey) =>
  Atom.map(sessionStateAtom(sessionId), (state) => state.threads[String(conversationId)] ?? null),
);

/**
 * A subagent's thread: its conversation's view, queue and Todo List, watched on the Session's socket while this is
 * read; null until the watch starts.
 */
export const threadAtom = Atom.family((key: ThreadKey) =>
  Atom.make((get) => {
    get.mount(watchingThreadAtom(key));

    return get(threadFieldAtom(key));
  }),
);

/**
 * Whether a conversation of a Session is running: the root's (`conversationId` undefined) as the Session's view says,
 * a subagent's as its thread does, which this watches while read.
 */
export const conversationRunningAtom = Atom.family(({ sessionId, conversationId }: ConversationKey) =>
  Atom.make((get): boolean =>
    conversationId === undefined
      ? get(sessionViewAtom(sessionId)).running
      : get(threadAtom({ sessionId, conversationId }))?.view.running === true,
  ),
);

const NO_TODOS: readonly TodoTask[] = [];

/**
 * The Todo List of a conversation of a Session: the root's (`conversationId` undefined), or a subagent's from its
 * thread, which this watches while read.
 */
export const conversationTodosAtom = Atom.family(({ sessionId, conversationId }: ConversationKey) =>
  Atom.make((get): readonly TodoTask[] =>
    conversationId === undefined
      ? get(todosAtom(sessionId))
      : (get(threadAtom({ sessionId, conversationId }))?.todos ?? NO_TODOS),
  ),
);

/** What to submit, and to which conversation: the root's when `conversationId` is absent. */
export interface Submission {
  readonly message: string | OutgoingMessage;
  readonly whenBusy: WhenBusy;
  readonly conversationId?: number;
}

/** Submit to Session `sessionId`; a refusal shows as its `failure` (or its thread's). */
export const submitAtom = Atom.family((sessionId: string) =>
  appRuntime.fn(
    ({ message, whenBusy, conversationId }: Submission, get) =>
      get
        .result(sessionClientAtom(sessionId))
        .pipe(Effect.flatMap((client) => client.submit(message, whenBusy, conversationId))),
    { concurrent: true },
  ),
);

/** Pick Session `sessionId`'s model and thinking level. */
export const configureAtom = Atom.family((sessionId: string) =>
  appRuntime.fn(
    (change: ConfigureChange, get) =>
      get
        .result(sessionClientAtom(sessionId))
        .pipe(Effect.flatMap((client) => client.configure(change))),
    { concurrent: true },
  ),
);

/** Abort Session `sessionId`'s root, or a subagent, with or without the agents below it. */
export const abortAtom = Atom.family((sessionId: string) =>
  appRuntime.fn(
    (target: AbortTarget, get) =>
      get
        .result(sessionClientAtom(sessionId))
        .pipe(Effect.flatMap((client) => client.abort(target))),
    { concurrent: true },
  ),
);

/** How long a Stop from the Session list waits for the Session's socket and task graph before it gives up. */
const STOP_WAIT = Duration.seconds(15);

/**
 * Stop subagent `agentId` of Session `sessionId` (its canonical ID, as the Session list knows it from the Registry), its
 * conversation only: the agents below it keep working. The list has no conversation ID, so this reads the Session's
 * client, which opens its socket if no page has it open, watches the task graph until it lists the agent, and aborts
 * its conversation if it is still working. The socket stays open for as long as this atom is mounted (the list's Stop
 * button, shown only while the agent works), then closes when nothing else reads it.
 */
export const stopAgentAtom = Atom.family((sessionId: string) =>
  appRuntime.fn(
    (agentId: string, get) =>
      Effect.gen(function* () {
        // Held, not only read: the socket must outlive the wait for the task graph.
        get.mount(sessionClientAtom(sessionId));

        const client = yield* get.result(sessionClientAtom(sessionId));

        yield* client.watchTaskGraph;

        const listed = yield* SubscriptionRef.changes(client.state).pipe(
          Stream.filter((state) => state.status === "live" && state.taskGraph !== null),
          Stream.map((state) =>
            Option.getOrUndefined(
              Arr.findFirst(state.taskGraph?.agents ?? [], (agent) => agent.id === agentId),
            ),
          ),
          Stream.runHead,
          Effect.timeoutOption(STOP_WAIT),
          Effect.map(Option.flatten),
        );

        const agent = Option.getOrUndefined(listed);

        if (agent?.status === "working") {
          yield* client.abort({ conversationId: agent.conversationId });
        }
      }),
    { concurrent: true },
  ),
);

/** The owner's answer to a Secret request: the values typed, or null when cancelled, and what to do with them. */
export interface SecretAnswer {
  readonly request: string;
  readonly values: Readonly<Record<string, string>> | null;
  readonly keep?: SecretKeep;
}

/** The owner's answer to an Approval request: Approve, or Decline with an optional reason for the agent. */
export interface ApprovalAnswerInput {
  readonly request: string;
  readonly approve: boolean;
  readonly reason?: string;
}

/** Answer one of Session `sessionId`'s Approval requests. */
export const answerApprovalAtom = Atom.family((sessionId: string) =>
  appRuntime.fn(
    ({ request, approve, reason }: ApprovalAnswerInput, get) =>
      get
        .result(sessionClientAtom(sessionId))
        .pipe(Effect.flatMap((client) => client.answerApproval(request, approve, reason))),
    { concurrent: true },
  ),
);

/** Answer one of Session `sessionId`'s Secret requests. */
export const answerSecretsAtom = Atom.family((sessionId: string) =>
  appRuntime.fn(
    ({ request, values, keep }: SecretAnswer, get) =>
      get
        .result(sessionClientAtom(sessionId))
        .pipe(Effect.flatMap((client) => client.answerSecrets(request, values, keep))),
    { concurrent: true },
  ),
);
