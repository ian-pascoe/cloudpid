// docs/architecture/triggers.md → Webhooks → The Trigger URL, Checks and answers, Logs; ADR-0048: what the main Worker does
// with a request under `/hooks`, ahead of the Access guard as `serveSignInPaths` does for the sign-in paths. A POST to
// the exact shape `/hooks/<id>/<token>` is read (at most 25 MiB, never more than the cap in memory) and handed to its
// Trigger object, which checks it and answers; the Worker only turns the answer into a status. Every other form under
// `/hooks` is a 404 and the bare `/hooks` goes on to the guard (`hooksRoute`).
//
// The token is in the path, so neither this Worker's spans nor its logs may hold the path: the Worker's own server span
// (Effect's `HttpMiddleware.tracer`, which records `url.full` and `url.path`) is turned off for these requests
// (`hooksTracing`), and the one span made here records the route template, `/hooks/:id/:token`, and the status.
// @effect-diagnostics missingPipeableSignature:off asyncFunction:off -- `serveHooks` is called by `worker-init.ts` with its handler; a stream is read with Promises.
import { MAX_DELIVERY_BODY_BYTES } from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import * as HttpMiddleware from "effect/http/HttpMiddleware";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { HOOKS_ROUTE_TEMPLATE } from "./hooks-path.ts";
import { hooksRoute } from "./hooks-routes.ts";
import { rawPathOf } from "./sign-in-routes.ts";
import type { Delivery, DeliveryAnswer, TriggerUnreachable } from "./trigger/object.ts";

/** What a delivery is handed to: Trigger `id`'s object, which checks it and answers. */
export type HookDeliver = (
  id: string,
  delivery: Delivery,
) => Effect.Effect<DeliveryAnswer, TriggerUnreachable>;

const empty = (status: number, headers: Record<string, string> = {}) =>
  HttpServerResponse.empty({ status, headers: { "cache-control": "no-store", ...headers } });

/** What a path under `/hooks` is, for a request's URL as it was sent. */
const routeOf = (request: HttpServerRequest.HttpServerRequest) =>
  hooksRoute(rawPathOf(request.url));

/**
 * Turns off Effect's server span for a request under `/hooks` (the exact shape or not), since the span records the whole
 * path and the path holds the Trigger URL's token. The bare `/hooks` has no token and keeps its span.
 */
export const hooksTracing = Layer.succeed(HttpMiddleware.TracerDisabledWhen)(
  (request) => routeOf(request) !== undefined,
);

/**
 * The body of a request, read to the end or to `max` bytes: `size` is the bytes received, or `max + 1` when it went
 * over (the reading stops there, so a body that is larger is never held), and then `body` is empty.
 */
export const readBounded = async (
  stream: ReadableStream<Uint8Array> | null,
  max: number,
): Promise<{ readonly body: Uint8Array<ArrayBuffer>; readonly size: number }> => {
  if (stream === null) return { body: new Uint8Array(0), size: 0 };

  const reader = stream.getReader();
  const chunks: Array<Uint8Array> = [];
  let size = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) break;

    size += value.length;

    if (size > max) {
      await reader.cancel();

      return { body: new Uint8Array(0), size: max + 1 };
    }

    chunks.push(value);
  }

  const body = new Uint8Array(size);
  let at = 0;

  for (const chunk of chunks) {
    body.set(chunk, at);
    at += chunk.length;
  }

  return { body, size };
};

/** The length a request says its body has, when it says one that is a count. */
const declaredLength = (request: HttpServerRequest.HttpServerRequest): number | undefined => {
  const value = request.headers["content-length"];

  return value !== undefined && /^\d{1,15}$/u.test(value) ? Number(value) : undefined;
};

/** A POST to a Trigger URL: read, handed to its object, and answered as the object answers. */
// @effect-diagnostics-next-line effectFnOpportunity:off -- the span's attributes are fixed, and the function is called once per request.
const serveDelivery = (
  deliver: HookDeliver,
  route: { readonly id: string; readonly token: string },
  request: HttpServerRequest.HttpServerRequest,
) =>
  Effect.gen(function* () {
    // A request the Worker received is a Web request already: converting it cannot fail.
    const web = yield* Effect.orDie(HttpServerRequest.toWeb(request));
    const length = declaredLength(request);

    // A body declared over the cap is not read: the object answers it once the token is right.
    const received =
      length !== undefined && length > MAX_DELIVERY_BODY_BYTES
        ? { body: new Uint8Array(0), size: length }
        : yield* Effect.promise(() => readBounded(web.body, MAX_DELIVERY_BODY_BYTES));

    const headers = request.headers;

    const answered = yield* deliver(route.id, {
      token: route.token,
      headers: {
        contentType: headers["content-type"],
        signature: headers["x-hub-signature-256"],
        event: headers["x-github-event"],
        delivery: headers["x-github-delivery"],
        webhookId: headers["webhook-id"],
        webhookTimestamp: headers["webhook-timestamp"],
        webhookSignature: headers["webhook-signature"],
      },
      ...received,
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("A delivery could not reach its Trigger's object", error.message).pipe(
          Effect.as({ status: 503, outcome: "unavailable" } as const satisfies DeliveryAnswer),
        ),
      ),
    );

    yield* Effect.annotateCurrentSpan("http.response.status_code", answered.status);

    return empty(answered.status);
  }).pipe(
    Effect.withSpan("hooks.delivery", {
      attributes: { "http.request.method": "POST", "http.route": HOOKS_ROUTE_TEMPLATE },
    }),
  );

/**
 * Puts the Trigger URLs ahead of `guarded`, the Worker's guarded routes: a request for a path under `/hooks` never
 * reaches them, except the bare `/hooks`. A POST to a Trigger URL is `deliver`ed (its answer's status, no body, never
 * cached; 503 when the object does not answer), another method is a 405, and every other form is a 404.
 */
export const serveHooks =
  (deliver: HookDeliver) =>
  <E, R>(
    guarded: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  ): Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    E,
    R | HttpServerRequest.HttpServerRequest
  > =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const route = routeOf(request);

      if (route === undefined) return yield* guarded;

      if (route.kind === "refused") return empty(404);

      if (request.method !== "POST") return empty(405, { allow: "POST" });

      return yield* serveDelivery(deliver, route, request);
    });
