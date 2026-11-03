// How the Registry's OAuth requests reach the network (`docs/architecture/mcp-sign-in.md` → Tokens reach the host object
// (Code), Bounds): every one goes through `guardedFetch` (the SSRF guard of `web_fetch`: the URL and every redirect hop are
// checked before anything is sent) with a 15 s timeout, and no response is read past 64 KiB. `OAuthFetch` is the shape
// pi-mcp's discovery, registration and token functions take, so they run over this unchanged.
// @effect-diagnostics missingPipeableSignature:off asyncFunction:off globalFetch:off strictEffectProvide:off
import {
  boundedText,
  MAX_METADATA_BYTES,
  OAUTH_FETCH_TIMEOUT_MS,
  type OAuthFetch,
} from "@cloudpid/mcp/oauth";
import {
  guardedFetch,
  type WebRequest,
  WebNetworkLive,
  type WebToolError,
} from "@cloudpid/extensions/web";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Types from "effect/Types";

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

/**
 * An `OAuthFetch` over `guardedFetch` and the Worker's network (`fetch` and DNS-over-HTTPS), timed out after
 * {@link OAUTH_FETCH_TIMEOUT_MS} and bounded to {@link MAX_METADATA_BYTES}. Over the `network` it is given, so a test
 * answers requests without one.
 */
export const guardedOAuthFetch =
  (network: typeof WebNetworkLive = WebNetworkLive): OAuthFetch =>
  async (input, init) => {
    const timeout = AbortSignal.timeout(OAUTH_FETCH_TIMEOUT_MS);
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

      return await bounded(sent.response, MAX_METADATA_BYTES);
    } catch (error) {
      throw timeout.aborted ? new Error("The request timed out") : error;
    }
  };
