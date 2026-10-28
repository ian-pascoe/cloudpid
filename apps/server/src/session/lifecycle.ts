// The end of a Session's life (`docs/architecture/client-and-protocol.md` → Registry): archiving stops everything it runs,
// and deleting also closes its browser and its clients' sockets and wipes its storage. The main Worker asks, then
// updates the Registry.
import type { BrowserError } from "@cloudpid/extensions/browser";
import { SESSION_DELETED_CLOSE_CODE } from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import { SessionHost } from "./host.ts";

/** How long a deletion waits for the browser host to close the Session's browser. */
const BROWSER_CLOSE_TIMEOUT = "5 seconds";

/** The parts of a Session DO's `ctx` a deletion uses. */
export type DestroyableState = {
  getWebSockets(): WebSocket[];
  readonly storage: {
    deleteAlarm(): Promise<void>;
    deleteAll(): Promise<void>;
  };
};

export type DestroySessionOptions = {
  readonly state: DestroyableState;
  /** Close the Session's browser; the Browser Run session it holds would otherwise run until its keep-alive ends. */
  readonly closeBrowser: Effect.Effect<boolean, BrowserError>;
};

/** Why a deleted Session's object resets (`ctx.abort`); the call that asks for the reset fails with it. */
export const SESSION_DELETED_REASON = "Session deleted";

/** Stop everything the Session runs: its root conversation and every subagent below it, background work included. */
export const stopSession = Effect.flatMap(SessionHost, (host) => host.stopEverything);

/**
 * Delete the Session's own state: stop everything it runs, close its browser and its clients' sockets (with
 * `SESSION_DELETED_CLOSE_CODE`, so they do not reconnect), close the Harness so nothing writes after, and wipe the
 * storage and alarm. What could not be stopped or closed does not hold the wipe back.
 *
 * The instance is not reset here: the caller resets it with a call of its own once this one has answered (the Session
 * DO's `reset`). A reset from a timer set here raced the reply: the Effect runtime resolves the call through timers of
 * its own, so the abort could land first and fail the deletion with "Session deleted".
 */
export const destroySession = Effect.fn("destroySession")(function* ({
  state,
  closeBrowser,
}: DestroySessionOptions) {
  const host = yield* SessionHost;

  yield* stopSession.pipe(
    Effect.catchCause((cause) => Effect.logWarning("Deleting a Session: stop failed", cause)),
  );
  yield* closeBrowser.pipe(
    Effect.timeout(BROWSER_CLOSE_TIMEOUT),
    Effect.catchCause((cause) =>
      Effect.logWarning("Deleting a Session: closing its browser failed", cause),
    ),
  );

  for (const socket of state.getWebSockets()) {
    yield* Effect.try(() => socket.close(SESSION_DELETED_CLOSE_CODE, SESSION_DELETED_REASON)).pipe(
      Effect.ignore,
    );
  }

  yield* host.close.pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Deleting a Session: closing the Harness failed", cause),
    ),
  );
  yield* Effect.promise(() => state.storage.deleteAlarm());
  yield* Effect.promise(() => state.storage.deleteAll());
});
