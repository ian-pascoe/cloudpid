import type * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { REGISTRY_NAME, type Registry } from "./registry/Registry.ts";
import type { Session } from "./session/Session.ts";

/**
 * Open a client's socket to Session `sessionId` (`docs/spec.md` → Client and protocol): forward the upgrade to its
 * Session DO, which accepts it. A Session the Registry does not know answers 404, so a stale or mistyped ID fails
 * visibly instead of starting a Session nobody lists.
 */
export const connectSession = Effect.fn("connectSession")(function* (
  sessions: Cloudflare.DurableObject<Session>,
  registries: Cloudflare.DurableObject<Registry>,
  sessionId: string,
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const session = yield* registries.getByName(REGISTRY_NAME).getSession({ id: sessionId });

  if (session === null) {
    return HttpServerResponse.text(`No Session ${sessionId}`, { status: 404 });
  }

  return yield* sessions.getByName(sessionId).fetch(request);
});
