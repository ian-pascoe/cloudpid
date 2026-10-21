// The end of a Session's life (`docs/spec.md` → Client and protocol → Registry): archiving stops everything it runs,
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
  /** Reset the object (`ctx.abort`), so the next event (if any) finds no instance over the wiped storage. */
  readonly reset: (reason: string) => void;
};

/** Stop everything the Session runs: its root conversation and every subagent below it, background work included. */
export const stopSession = Effect.flatMap(SessionHost, (host) => host.abort({ subagents: true }));

/**
 * Delete the Session's own state: stop everything it runs, close its browser and its clients' sockets (with
 * `SESSION_DELETED_CLOSE_CODE`, so they do not reconnect), close the Harness so nothing writes after, and wipe the
 * storage and alarm. What could not be stopped or closed does not hold the wipe back. The object resets once the call
 * has answered.
 */
export const destroySession = Effect.fn("destroySession")(function* ({
  state,
  closeBrowser,
  reset,
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
    yield* Effect.try(() => socket.close(SESSION_DELETED_CLOSE_CODE, "Session deleted")).pipe(
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

  // After the reply: an abort now would fail the call that asked for the deletion. A plain timer, as the reset must
  // outlive this call and its fiber.
  yield* Effect.sync(() => {
    // @effect-diagnostics-next-line globalTimersInEffect:off
    setTimeout(() => {
      reset("Session deleted");
    }, 0);
  });
});
