// The Session's Browser Handoffs (`docs/spec.md` → Browser): the requests for the owner to take over the browser, kept in
// this object's storage and sent to every client over the Session socket, with the Live View link each carries.
import {
  type BrowserHostService,
  type BrowserSession,
  type HandoffStorage,
  handoffsLayer,
  type Handoffs,
} from "@cloudpid/extensions/browser";
import type { OwnerNotifications } from "@cloudpid/extensions/notify";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import { handoffRequests, send, type SocketState } from "./sockets.ts";

export type SessionHandoffsOptions = {
  /** The Session's browser host, which holds the handoff itself. */
  readonly host: BrowserHostService;
  /** The object's synchronous key-value storage. */
  readonly storage: HandoffStorage;
  /** The object's sockets, which every change to the waiting requests is sent to. */
  readonly sockets: Pick<SocketState, "getWebSockets">;
  /** How long a handoff waits for the owner, and how long one round of waiting lasts; for tests. */
  readonly timeoutMs?: number;
  readonly pollMs?: number;
  /** How long past its deadline a call may still hear a handoff end. */
  readonly graceMs?: number;
};

/**
 * The Session's `Handoffs`; needs its `BrowserSession` (kept in use while the owner works) and `OwnerNotifications` (the
 * push that carries the link).
 */
export const sessionHandoffsLayer = ({
  sockets,
  ...options
}: SessionHandoffsOptions): Layer.Layer<Handoffs, never, BrowserSession | OwnerNotifications> =>
  handoffsLayer({
    ...options,
    announce: (requests) =>
      Effect.forEach(sockets.getWebSockets(), (socket) =>
        send(socket, handoffRequests(requests)),
      ).pipe(Effect.asVoid),
  });
