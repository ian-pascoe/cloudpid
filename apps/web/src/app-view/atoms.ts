// @effect-diagnostics missingPipeableSignature:off -- a key built from two strings, not a combinator.
// docs/architecture/mcp-apps.md → App Views in the transcript. The atoms behind an App call's card: its View's data, loaded
// when the card mounts and kept with the card (`app-call.tsx`), and what the page knows of the call's server.
import { GLOBAL_SCOPE } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Atom from "effect/reactivity/Atom";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { appRuntime } from "../runtime.ts";
import type { ConversationKey } from "../chat/conversation.ts";
import { appEntries } from "../session/apps.ts";
import {
  mcpAppsAtom,
  mcpAppToolsAtom,
  sessionClientAtom,
  sessionViewAtom,
  threadAtom,
} from "../session/atoms.ts";
import { mcpStatusesAtom } from "../settings/mcp-state.ts";
import { sessionListAtom } from "../sessions.ts";
import { liveGeneration, NO_LIVE_CALLS, runningAppCalls } from "./generation.ts";
import { type AppLoad, loadAppView, loadRunningView } from "./load.ts";

/** The key of one call's View: the Session it ran in, and the call. */
export interface AppKey {
  readonly sessionId: string;
  readonly callId: string;
}

/** The key as a string, which an atom family compares by. */
export const appKey = (sessionId: string, callId: string): string => `${sessionId}\0${callId}`;

export const unkey = (key: string): AppKey => {
  const [sessionId = "", callId = ""] = key.split("\0");

  return { sessionId, callId };
};

/**
 * Call `callId`'s View of Session `sessionId`, loaded: its record, then its page. It loads when something reads it and
 * reloads when read again after nothing did, which is how Retry works (a refresh of the atom).
 */
export const appLoadAtom = Atom.family((key: string) =>
  appRuntime.atom((get) => {
    const { sessionId, callId } = unkey(key);

    return get
      .result(sessionClientAtom(sessionId))
      .pipe(
        Effect.flatMap((client): Effect.Effect<AppLoad> =>
          loadAppView(client, callId, window.location.origin),
        ),
      );
  }),
);

/** The key of a running call's View: its Session, the call and the model-facing name of its App tool. */
export const runningKey = (sessionId: string, callId: string, toolName: string): string =>
  `${sessionId}\0${callId}\0${toolName}`;

/**
 * The page of the View of a call that is still running (`loadRunningView`): it has no record, so the page is its tool's. It
 * loads when the card of a running call reads it, and again on Retry; the call's record, once there is one, is
 * `appLoadAtom`'s.
 */
export const appRunningAtom = Atom.family((key: string) =>
  appRuntime.atom((get) => {
    const [sessionId = "", callId = "", toolName = ""] = key.split("\0");

    return get
      .result(sessionClientAtom(sessionId))
      .pipe(
        Effect.flatMap((client): Effect.Effect<AppLoad> =>
          loadRunningView(client, toolName, callId, window.location.origin),
        ),
      );
  }),
);

/** What a card reads while it wants no running call's page: nothing is loaded. */
export const NO_RUNNING_PAGE = Atom.make(AsyncResult.initial<AppLoad>());

/** The Environment Session `sessionId` runs in, whose servers its Apps' are: undefined until the list names it. */
export const sessionEnvironmentAtom = Atom.family((sessionId: string) =>
  Atom.readable((get) =>
    Arr.findFirst(get(sessionListAtom) ?? [], (session) => session.id === sessionId).pipe(
      Option.flatMap((session) => Option.fromNullishOr(session.environment)),
      Option.getOrUndefined,
    ),
  ),
);

/** The status chips of the servers of Session `sessionId`'s Environment. */
export const sessionMcpStatusesAtom = Atom.family((sessionId: string) =>
  Atom.readable((get) =>
    get(mcpStatusesAtom(get(sessionEnvironmentAtom(sessionId)) ?? GLOBAL_SCOPE)),
  ),
);

/**
 * The calls of the thread `key` whose App Views are in the newest generation of their server's (`liveGeneration`): the root
 * thread's, or a subagent's, from its transcript and the Session's App calls. A thread with no App call is the same empty
 * set each time, so a transcript's every token costs its cards nothing.
 */
export const appGenerationAtom = Atom.family((key: ConversationKey) =>
  Atom.make((get): ReadonlySet<string> => {
    const apps = appEntries(get(mcpAppsAtom(key.sessionId)));
    const tools = get(mcpAppToolsAtom(key.sessionId)) ?? [];

    // Nothing to place, and nothing that could be: a transcript's every token costs such a conversation nothing.
    if (apps.length === 0 && tools.length === 0) return NO_LIVE_CALLS;

    const view =
      key.conversationId === undefined
        ? get(sessionViewAtom(key.sessionId))
        : get(threadAtom({ sessionId: key.sessionId, conversationId: key.conversationId }))?.view;

    if (view === undefined) return NO_LIVE_CALLS;

    const messages = [...view.messages, ...(view.live !== null ? [view.live] : [])];

    // The calls still streaming or running have no entry yet, and are the newest generation all the same.
    const running = runningAppCalls(messages, tools, apps, view.running);

    return apps.length + running.length === 0
      ? NO_LIVE_CALLS
      : liveGeneration(messages, [...apps, ...running]);
  }),
);

/** Whether Session `sessionId` is archived, as the list last had it: its App Views are collapsed, and reopen read-only. */
export const sessionArchivedAtom = Atom.family((sessionId: string) =>
  Atom.readable((get) =>
    Arr.findFirst(get(sessionListAtom) ?? [], (session) => session.id === sessionId).pipe(
      Option.exists((session) => session.archivedAt !== null),
    ),
  ),
);
