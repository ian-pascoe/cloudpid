// How the Registry's OAuth requests reach the network (`docs/architecture/mcp-sign-in.md` → Tokens reach the host object
// (Code), Bounds): every one goes through `guardedFetch` (the SSRF guard of `web_fetch`: the URL and every redirect hop are
// checked before anything is sent) with a 15 s timeout, and no response is read past 64 KiB. `OAuthFetch` is the shape
// pi-mcp's discovery, registration and token functions take, so they run over this unchanged.
//
// One hop is sent from elsewhere: an https GET to one of cloudpid's own hosts (the resource metadata Access serves on the
// MCP endpoint's host, at a Self-use sign-in) goes through `McpWorker` (`McpEngine.fetchPublic`), whose
// `global_fetch_strictly_public` sends it through Cloudflare's front door, since this Worker's own `fetch` to its own
// host never reaches Access (`docs/architecture/mcp-endpoint.md` → Self-use). The guard still checks every hop here
// first, and an engine from before the method is read past: the hop is sent from here, as before.
// @effect-diagnostics missingPipeableSignature:off asyncFunction:off globalFetch:off strictEffectProvide:off
import {
  boundedText,
  MAX_METADATA_BYTES,
  OAUTH_FETCH_TIMEOUT_MS,
  type OAuthFetch,
} from "@cloudpid/mcp/oauth";
import {
  McpPublicFetchResult,
  PUBLIC_FETCH_HEADERS,
  type McpEngineMethods,
} from "@cloudpid/mcp/types";
import {
  DohResolverLive,
  guardedFetch,
  type WebRequest,
  WebNetworkLive,
  WebToolError,
  WebTransport,
  WebTransportLive,
  type WebTransportService,
} from "@cloudpid/extensions/web";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import type * as Types from "effect/Types";
import { isOwnHost } from "./own-hosts.ts";

const isText = Schema.is(Schema.String);

/** What a `fetch` of the OAuth functions carries that the guard can send: a method, headers and a text body. */
const requestOf = (input: string | URL, init: RequestInit | undefined): WebRequest => {
  const method = init?.method ?? "GET";

  if (method !== "GET" && method !== "POST") {
    throw new Error(`An OAuth request is never a ${method}`);
  }

  const headers: Record<string, string> = {};

  new Headers(init?.headers).forEach((value, name) => {
    headers[name] = value;
  });

  const request: Types.Mutable<WebRequest> = { url: String(input), method, headers };
  const body = init?.body;

  if (body instanceof URLSearchParams || isText(body)) {
    request.body = body.toString();
  } else if (body !== undefined && body !== null) {
    throw new Error("An OAuth request's body is text or a form");
  }

  return request;
};

/**
 * `response` with its body ended by `signal`: a server that drips its body is cut off with the request's timeout, not
 * waited for. The body is read through a stream that errors, and cancels its source, when the signal aborts.
 */
const endedBy = (response: Response, signal: AbortSignal): Response => {
  const source = response.body;

  if (source === null) return response;

  const reader = source.getReader();

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      signal.addEventListener(
        "abort",
        () => {
          controller.error(signal.reason);
          reader.cancel(signal.reason).catch(() => undefined);
        },
        { once: true },
      );
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();

        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        // The source failed (or the signal errored the stream already, which this leaves as it is): the reader sees why.
        controller.error(error);
      }
    },
    cancel: (reason) => reader.cancel(reason),
  });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};

/** `response` with its body read to the bound, as the whole text; fails when it is longer. */
const bounded = async (response: Response, limit: number): Promise<Response> => {
  const text = await boundedText(response, limit);

  if (text === undefined) {
    throw new Error(`The authorization server's response is longer than ${limit / 1024} KiB`);
  }

  // A body is not allowed on these.
  const bodyless = [101, 204, 205, 304].includes(response.status);

  return new Response(bodyless ? null : text, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};

/** The failure of a guarded request, as a plain `Error` whose message is the guard's own. */
const failure = (error: WebToolError): Error => new Error(error.message);

/** What reads a URL from `McpWorker`: the `MCP_ENGINE` binding's `fetchPublic`, or a fake. */
export type PublicReader = Pick<McpEngineMethods, "fetchPublic">;

/** Whether a hop is read from `McpWorker`: an https GET with no body to one of cloudpid's own hosts. */
export const readsFromMcpWorker = (
  request: WebRequest,
  isOwn: (host: string) => boolean = isOwnHost,
): boolean => {
  if ((request.method ?? "GET") !== "GET" || request.body !== undefined) return false;

  if (!URL.canParse(request.url)) return false;

  const url = new URL(request.url);

  return url.protocol === "https:" && isOwn(url.hostname.toLowerCase());
};

/**
 * The text of an RPC failure whose callee has no such method (an `McpWorker` behind): workerd says so only in the text of
 * a plain `TypeError` (`The RPC receiver does not implement the method "x"`), as `@cloudpid/mcp/server`'s handler reads it
 * too.
 */
const MISSING_METHOD = /does not implement|is not a function/i;

const isPublicFetchResult = Schema.is(McpPublicFetchResult);

/** A status a `Response` may carry no body with. */
const BODYLESS: ReadonlyArray<number> = [101, 204, 205, 304];

/** `McpWorker`'s answer as the `Response` the guard reads, or why it is not one. */
const responseOf = (answer: McpPublicFetchResult): Effect.Effect<Response, WebToolError> => {
  if (!isPublicFetchResult(answer)) {
    return Effect.fail(
      WebToolError.make({ message: "McpWorker answered in a form this Worker does not read" }),
    );
  }

  if (answer.status === "refused") {
    return Effect.fail(WebToolError.make({ message: answer.message }));
  }

  const { code, headers, body } = answer;

  return Effect.try({
    try: () => new Response(BODYLESS.includes(code) ? null : body, { status: code, headers }),
    catch: () => WebToolError.make({ message: `McpWorker answered a status ${code}` }),
  });
};

/**
 * The transport the sign-in's guard sends each hop through: `direct` (this Worker's `fetch`), but a hop that
 * {@link readsFromMcpWorker} goes to `reader`, with only the content-negotiation headers. With no `reader`, or one whose
 * `McpWorker` does not have the method yet, the hop is sent `direct`; any other failure of the call fails the hop.
 */
export const ownHostTransport = (
  reader: PublicReader | undefined,
  direct: WebTransportService,
  isOwn: (host: string) => boolean = isOwnHost,
): WebTransportService => ({
  fetch: (request) => {
    const read = reader?.fetchPublic;

    if (read === undefined || !readsFromMcpWorker(request, isOwn)) return direct.fetch(request);

    const headers = Record.filter(request.headers, (_, name) =>
      PUBLIC_FETCH_HEADERS.includes(name.toLowerCase()),
    );

    return Effect.tryPromise({
      try: () => read({ url: request.url, headers }),
      catch: (error): "missing" | "failed" =>
        error instanceof Error && MISSING_METHOD.test(error.message) ? "missing" : "failed",
    }).pipe(
      Effect.matchEffect({
        onFailure: (failed) =>
          failed === "missing"
            ? direct.fetch(request)
            : Effect.fail(WebToolError.make({ message: "McpWorker could not be reached" })),
        onSuccess: responseOf,
      }),
    );
  },
});

/**
 * The Registry's sign-in network: {@link WebNetworkLive}, with {@link ownHostTransport} over `reader` (the `MCP_ENGINE`
 * binding; undefined where the Worker has none) in front of its `fetch`.
 */
export const signInNetwork = (reader: PublicReader | undefined): typeof WebNetworkLive =>
  DohResolverLive.pipe(
    Layer.provideMerge(
      Layer.effect(
        WebTransport,
        Effect.gen(function* () {
          return ownHostTransport(reader, yield* WebTransport);
        }),
      ).pipe(Layer.provide(WebTransportLive)),
    ),
  );

/**
 * An `OAuthFetch` over `guardedFetch` and the Worker's network (`fetch` and DNS-over-HTTPS), timed out after
 * {@link OAUTH_FETCH_TIMEOUT_MS} (the whole exchange, the body's read included) and bounded to {@link MAX_METADATA_BYTES}.
 * Over the `network` it is given, so a test answers requests without one, and with the `timeoutMs` it is given.
 */
export const guardedOAuthFetch =
  (
    network: typeof WebNetworkLive = WebNetworkLive,
    timeoutMs: number = OAUTH_FETCH_TIMEOUT_MS,
  ): OAuthFetch =>
  async (input, init) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signals = [timeout];

    if (init?.signal !== undefined && init.signal !== null) signals.push(init.signal);

    try {
      const sent = await Effect.runPromise(
        guardedFetch(requestOf(input, init)).pipe(
          Effect.provide(network),
          Effect.mapError(failure),
        ),
        { signal: AbortSignal.any(signals) },
      );

      return await bounded(endedBy(sent.response, AbortSignal.any(signals)), MAX_METADATA_BYTES);
    } catch (error) {
      throw timeout.aborted ? new Error("The request timed out") : error;
    }
  };
