// The main Worker's Attachments route (`attachments.ts`) for a Session the Registry knows, in the Workspace it is bound to.
import type * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { answerAttachment, type AttachmentFiles } from "./attachments.ts";
import { REGISTRY_NAME, type Registry } from "./registry/Registry.ts";
import type { AttachmentRoute } from "./routes.ts";

/**
 * Serve `route` for a Session the Registry knows, in the Workspace it is bound to (`filesFor(slug)`); one it does not
 * know answers 404, so an upload never lands for a Session nobody lists.
 */
export const serveAttachment = Effect.fn("serveAttachment")(function* (
  registries: Cloudflare.DurableObject<Registry>,
  filesFor: (slug: string) => AttachmentFiles,
  route: AttachmentRoute,
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const session = yield* registries.getByName(REGISTRY_NAME).getSession({ id: route.sessionId });

  if (session === null) {
    return HttpServerResponse.text(`No Session ${route.sessionId}`, { status: 404 });
  }

  // A request the Worker received is a Web request already: converting it cannot fail.
  const web = yield* Effect.orDie(HttpServerRequest.toWeb(request));

  const response = yield* Effect.promise(() =>
    answerAttachment(web, route, filesFor(session.machine)),
  );

  return HttpServerResponse.fromWeb(response);
});
