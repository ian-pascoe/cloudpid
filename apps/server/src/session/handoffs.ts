// The Session's Browser Handoffs (`docs/spec.md` → Browser): the requests for the owner to take over the browser, kept in
// this object's storage and sent to every client over the Session socket, with the Live View link each carries.
import {
  type BrowserHostService,
  type BrowserSession,
  type BrowserHandoffStorage,
  browserHandoffsLayer,
  type BrowserHandoffs,
} from "@cloudpid/extensions/browser";
import type { OwnerNotifications } from "@cloudpid/extensions/notify";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import { browserHandoffRequests, send, type SocketState } from "./sockets.ts";

export type SessionBrowserHandoffsOptions = {
  /** The Session's browser host, which holds the handoff itself. */
  readonly host: BrowserHostService;
  /** The object's synchronous key-value storage. */
  readonly storage: BrowserHandoffStorage;
  /** The object's sockets, which every change to the waiting requests is sent to. */
  readonly sockets: Pick<SocketState, "getWebSockets">;
  /** How long a handoff waits for the owner, and how long one round of waiting lasts; for tests. */
  readonly timeoutMs?: number;
  readonly pollMs?: number;
  /** How long past its deadline a call may still hear a handoff end. */
  readonly graceMs?: number;
};

/**
 * The Session's `BrowserHandoffs`; needs its `BrowserSession` (kept in use while the owner works) and `OwnerNotifications` (the
 * push that carries the link).
 */
export const sessionBrowserHandoffsLayer = ({
  sockets,
  ...options
}: SessionBrowserHandoffsOptions): Layer.Layer<
  BrowserHandoffs,
  never,
  BrowserSession | OwnerNotifications
> =>
  browserHandoffsLayer({
    ...options,
    announce: (requests) =>
      Effect.forEach(sockets.getWebSockets(), (socket) =>
        send(socket, browserHandoffRequests(requests)),
      ).pipe(Effect.asVoid),
  });
