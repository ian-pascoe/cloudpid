// The Session's Approval requests (`docs/spec.md` → Approval): kept in this object's storage, sent to every client over
// the Session socket whenever they change, and pushed to the owner, who may not have the page open, as each is made.
import {
  type ApprovalStorage,
  type Approvals,
  approvalsLayer,
} from "@cloudpid/extensions/approvals";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import type { PushEvent } from "../push/notification.ts";
import { approvalRequests, send, type SocketState } from "./sockets.ts";

export type SessionApprovalsOptions = {
  /** The object's synchronous key-value storage. */
  readonly storage: ApprovalStorage;
  /** The object's sockets, which every change to the waiting requests is sent to. */
  readonly sockets: Pick<SocketState, "getWebSockets">;
  /** Tell the owner, by Web Push, that a request is waiting for them. Leave it out to tell nobody. */
  readonly notify?: (event: PushEvent) => Effect.Effect<void>;
};

/** The Session's `Approvals`; build it once per instance. */
export const sessionApprovalsLayer = (options: SessionApprovalsOptions): Layer.Layer<Approvals> =>
  approvalsLayer({
    storage: options.storage,
    announce: (requests) =>
      Effect.forEach(options.sockets.getWebSockets(), (socket) =>
        send(socket, approvalRequests(requests)),
      ).pipe(Effect.asVoid),
    asked: (request) =>
      options.notify === undefined
        ? Effect.void
        : options.notify({
            kind: "input",
            names: [],
            // "Size limit, Environment "Default"": the push says what changes where; the card says the rest.
            approval: `${request.change}, ${request.target}`,
            reason: request.reason,
          }),
  });
