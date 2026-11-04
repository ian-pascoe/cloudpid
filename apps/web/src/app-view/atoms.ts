// @effect-diagnostics missingPipeableSignature:off -- a key built from two strings, not a combinator.
// docs/architecture/mcp-apps.md → App Views in the transcript. The atoms behind an App call's card: its View's data, loaded
// when the card mounts and kept with the card (`app-call.tsx`), and what the page knows of the call's server.
import { GLOBAL_SCOPE } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Atom from "effect/reactivity/Atom";
import { appRuntime } from "../runtime.ts";
import { sessionClientAtom } from "../session/atoms.ts";
import { mcpStatusesAtom } from "../settings/mcp-state.ts";
import { sessionListAtom } from "../sessions.ts";
import { type AppLoad, loadAppView } from "./load.ts";

/** The key of one call's View: the Session it ran in, and the call. */
export interface AppKey {
  readonly sessionId: string;
  readonly callId: string;
}

/** The key as a string, which an atom family compares by. */
export const appKey = (sessionId: string, callId: string): string => `${sessionId}\0${callId}`;

const unkey = (key: string): AppKey => {
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
      .pipe(Effect.flatMap((client): Effect.Effect<AppLoad> => loadAppView(client, callId)));
  }),
);

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
