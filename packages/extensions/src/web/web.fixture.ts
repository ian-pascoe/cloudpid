// @effect-diagnostics missingPipeableSignature:off
// Test doubles for the web tools' network: a scripted transport that records what was sent, and a resolver with a
// table of hostnames. Nothing here touches the network.
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { DnsResolver } from "./dns.ts";
import { WebToolError } from "./errors.ts";
import { type WebRequest, WebTransport } from "./transport.ts";

/** How a fake answers one request: a response, or a failure. */
export type Answer = Response | WebToolError;

/** A fake transport answering each request with `answer(request)`, and the requests it saw, in order. */
export const fakeTransport = (answer: (request: WebRequest) => Answer) => {
  const requests: WebRequest[] = [];

  const layer = Layer.succeed(WebTransport, {
    fetch: (request) => {
      requests.push(request);
      const result = answer(request);

      return result instanceof Response ? Effect.succeed(result) : Effect.fail(result);
    },
  });

  return { layer, requests };
};

/** A fake resolver: a hostname not in `table` does not resolve, and `lookups` records what was asked. */
export const fakeResolver = (table: Readonly<Record<string, readonly string[]>>) => {
  const lookups: string[] = [];

  const layer = Layer.succeed(DnsResolver, {
    resolve: (hostname) => {
      lookups.push(hostname);
      const addresses = table[hostname];

      return addresses === undefined
        ? Effect.fail(WebToolError.make({ message: "host not found" }))
        : Effect.succeed(addresses);
    },
  });

  return { layer, lookups };
};

/** A redirect response. */
export const redirect = (location: string, status = 302): Response =>
  new Response(null, { status, headers: { location } });

/** A 200 response with a content type. */
export const ok = (body: string, contentType = "text/plain"): Response =>
  new Response(body, { status: 200, headers: { "content-type": contentType } });
