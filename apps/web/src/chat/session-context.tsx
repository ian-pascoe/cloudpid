// The Session, for the components that show a subagent: a card inside the transcript, the task panel, the composers
// and the usage badge reach it here instead of through the props of every message above them.
//
// A STOPGAP THAT STEP 6 REMOVES (`docs/plans/effect-atom-web-app.md`): `useConnection()` returns an adapter with the
// method names and signatures of the deleted `SessionConnection` class, implemented over `SessionClient`
// (`session/client.ts`), and `useSession(select)` reads the Session's state atom (`session/atoms.ts`), so those
// components keep working unchanged until step 6 moves each of them to the atoms and deletes this file.

import type { Catalog, CommandOutcome, FileMatches, WhenBusy } from "@cloudpid/protocol";
import { useAtomValue } from "@effect/atom-react";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { createContext, useContext } from "react";
import { messageOf } from "../registry.ts";
import { sessionStateAtom } from "../session/atoms.ts";
import type { SessionClient } from "../session/client.ts";
import type {
  AbortTarget,
  ConfigureChange,
  OutgoingMessage,
  SessionState,
} from "../session/state.ts";

/** What the chat components ask of the Session's socket: the old connection's methods, over `SessionClient`. */
export interface Connection {
  /**
   * Submit `message` to the root conversation, or to subagent conversation `conversationId`. `onOutcome` hears null
   * once the Session took it, or why it refused it, which it then shows itself; without it, a refusal shows as the
   * state's `failure`.
   */
  submit(
    message: string | OutgoingMessage,
    whenBusy: WhenBusy,
    conversationId?: number,
    onOutcome?: (failure: string | null) => void,
  ): void;
  /** Watch subagent conversation `conversationId` until the returned function is called. */
  watchThread(conversationId: number): () => void;
  watchTaskGraph(): void;
  watchUsage(): void;
  configure(change: ConfigureChange): void;
  answerSecrets(request: string, values: Readonly<Record<string, string>> | null): void;
  abort(target?: AbortTarget): void;
  /** Rejects with an `Error` whose message says why, as every request here does. */
  catalog(conversationId?: number): Promise<Catalog>;
  files(query: string, conversationId?: number): Promise<FileMatches>;
  command(name: string, args: string, conversationId?: number): Promise<CommandOutcome>;
}

const run = (effect: Effect.Effect<void>): void => {
  Effect.runFork(effect);
};

/** `effect`'s value, or a rejection with an `Error` that carries its failure's message. */
const promise = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromiseExit(effect).then((exit) =>
    Exit.isSuccess(exit) ? exit.value : Promise.reject(new Error(messageOf(exit.cause))),
  );

/** The `Connection` over `client`. */
export const connectionOf = (client: SessionClient): Connection => ({
  submit: (message, whenBusy, conversationId, onOutcome) => {
    if (onOutcome === undefined) {
      run(client.submit(message, whenBusy, conversationId));

      return;
    }

    run(
      client.submitAndAwait(message, whenBusy, conversationId).pipe(
        Effect.match({ onFailure: (error) => error.message, onSuccess: () => null }),
        Effect.flatMap((failure) =>
          Effect.sync(() => {
            onOutcome(failure);
          }),
        ),
      ),
    );
  },
  watchThread: (conversationId) => {
    const scope = Scope.makeUnsafe();

    run(client.watchThread(conversationId).pipe(Scope.provide(scope)));

    // Closing a scope twice closes it once, so a second release does nothing.
    return () => {
      run(Scope.close(scope, Exit.void));
    };
  },
  watchTaskGraph: () => {
    run(client.watchTaskGraph);
  },
  watchUsage: () => {
    run(client.watchUsage);
  },
  configure: (change) => {
    run(client.configure(change));
  },
  answerSecrets: (request, values) => {
    run(client.answerSecrets(request, values));
  },
  abort: (target) => {
    run(client.abort(target));
  },
  catalog: (conversationId) => promise(client.catalog(conversationId)),
  files: (query, conversationId) => promise(client.files(query, conversationId)),
  command: (name, args, conversationId) => promise(client.command(name, args, conversationId)),
});

const SessionContext = createContext<Connection | null>(null);

export const SessionProvider = SessionContext.Provider;

const SessionIdContext = createContext<string | null>(null);

/** The Session's ID, which the composers upload Attachments to, and whose state `useSession` reads. */
export const SessionIdProvider = SessionIdContext.Provider;

/** The ID of the Session shown, or null where there is none to upload Attachments to. */
export const useSessionId = (): string | null => useContext(SessionIdContext);

/** The Session's connection. */
export const useConnection = (): Connection => {
  const connection = useContext(SessionContext);

  if (connection === null) throw new Error("No Session connection is provided");

  return connection;
};

/**
 * What `select` picks from the Session's state, re-rendering only when the pick changes: a card must not render for
 * every token the root streams. `select` returns what the state already holds, not a copy.
 */
export const useSession = <T,>(select: (state: SessionState) => T): T => {
  const sessionId = useSessionId();

  if (sessionId === null) throw new Error("No Session is provided");

  return useAtomValue(sessionStateAtom(sessionId), select);
};
