// The Session's connection, for the components that show a subagent: a card inside the transcript, and the task
// panel, reach it here instead of through the props of every message above them.

// @effect-diagnostics missingPipeableSignature:off -- browser code in a React app with no Effect runtime.

import { createContext, useContext, useSyncExternalStore } from "react";
import type { SessionConnection, SessionState } from "../session/connection.ts";

const SessionContext = createContext<SessionConnection | null>(null);

export const SessionProvider = SessionContext.Provider;

/** The Session's connection. */
export const useConnection = (): SessionConnection => {
  const connection = useContext(SessionContext);

  if (connection === null) throw new Error("No Session connection is provided");

  return connection;
};

/**
 * What `select` picks from the Session's state, re-rendering only when the pick changes: a card must not render for
 * every token the root streams. `select` returns what the state already holds, not a copy.
 */
export const useSession = <T,>(select: (state: SessionState) => T): T => {
  const connection = useConnection();

  return useSyncExternalStore(connection.subscribe, () => select(connection.getState()));
};
