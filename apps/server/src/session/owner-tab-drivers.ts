// Who drives the owner's Owner tabs (`docs/spec.md` → Browser → Browser Pane): the `browser` calls working in one, sent to
// every client over the Session socket whenever they change (and to each client on connect, `./sockets.ts`), for the
// Browser Pane to show that the agent is driving.
import { type OwnerTabDrivers, ownerTabDriversLayer } from "@cloudpid/extensions/browser";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import { ownerTabDriversMessage, send, type SocketState } from "./sockets.ts";

/** The Session's `OwnerTabDrivers`, told to every client on `sockets`. */
export const sessionOwnerTabDriversLayer = (
  sockets: Pick<SocketState, "getWebSockets">,
): Layer.Layer<OwnerTabDrivers> =>
  ownerTabDriversLayer({
    announce: (drivers) =>
      Effect.forEach(
        sockets.getWebSockets(),
        (socket) => send(socket, ownerTabDriversMessage(drivers)),
        {
          discard: true,
        },
      ),
  });
