import type * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Schema from "effect/Schema";
import type { Session } from "./session/Session.ts";

const PROMPT_PATH = /^\/sessions\/([^/]+)\/prompt$/;

const PromptBody = Schema.Struct({ requestId: Schema.NonEmptyString, text: Schema.NonEmptyString });

/** The Session a `POST /sessions/:sessionId/prompt` request addresses, if it is one. */
export const promptSessionId = (
  request: HttpServerRequest.HttpServerRequest,
): string | undefined =>
  request.method === "POST"
    ? PROMPT_PATH.exec(new URL(request.url, "http://localhost").pathname)?.[1]
    : undefined;

/**
 * Temporary endpoint until the RPC protocol lands: submit `{ requestId, text }` to Session `sessionId` and answer with
 * its reply as JSON. The same `requestId` finds the first submission instead of submitting again. It is reachable only
 * through the Access gate in front of the Worker.
 */
export const promptSession = Effect.fn("promptSession")(
  function* (sessions: Cloudflare.DurableObject<Session>, sessionId: string) {
    const prompt = yield* HttpServerRequest.schemaBodyJson(PromptBody);
    const answer = yield* sessions.getByName(sessionId).prompt(prompt);

    return yield* HttpServerResponse.json(answer);
  },
  Effect.catchTags({
    SchemaError: (error) => HttpServerResponse.json({ error: error.message }, { status: 400 }),
    SessionError: (error) => HttpServerResponse.json({ error: error.message }, { status: 502 }),
  }),
  Effect.catchCause((cause) =>
    Effect.logError("Prompt failed", cause).pipe(
      Effect.andThen(HttpServerResponse.json({ error: "Internal error" }, { status: 500 })),
    ),
  ),
);
