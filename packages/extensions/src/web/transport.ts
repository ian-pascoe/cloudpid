// What the web tools reach the network through. A Service, so tests answer requests without one, and so the SSRF
// guard (`guarded-fetch.ts`) is the only code that decides which URLs are fetched.
// The one place the web tools call the global `fetch`: `HttpClient` offers no way to leave a redirect unfollowed and a
// body unread, which the SSRF guard needs.
// @effect-diagnostics globalFetch:off globalFetchInEffect:off
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { WebToolError } from "./errors.ts";

/** One HTTP request. Redirects are never followed by the transport: the caller sees the 3xx and decides. */
export type WebRequest = {
  readonly url: string;
  readonly method?: "GET" | "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
};

export type WebTransportService = {
  /** Send `request`. The response is returned for any status, with its body unread. */
  readonly fetch: (request: WebRequest) => Effect.Effect<Response, WebToolError>;
};

/** The network, as the web tools see it. */
export class WebTransport extends Context.Service<WebTransport, WebTransportService>()(
  "@cloudpid/extensions/web/transport/WebTransport",
) {}

/** Workers' `fetch`, with redirects left to the caller. Interrupting the Effect aborts the request. */
export const WebTransportLive = Layer.succeed(WebTransport, {
  fetch: (request) =>
    Effect.tryPromise({
      try: (signal) =>
        fetch(request.url, {
          method: request.method ?? "GET",
          headers: request.headers,
          body: request.body ?? null,
          redirect: "manual",
          signal,
        }),
      catch: () => WebToolError.make({ message: "network error" }),
    }),
});
