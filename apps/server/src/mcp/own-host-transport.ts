// The network the Registry's MCP sign-in runs over (`docs/architecture/mcp-sign-in.md` → Tokens reach the host object
// (Code), A hop to one of cloudpid's own hosts; `docs/architecture/mcp-endpoint.md` → Self-use): the Worker's own, but a
// hop to one of cloudpid's own hosts is read from `McpWorker` (`McpEngine.fetchPublic`), whose
// `global_fetch_strictly_public` sends it through Cloudflare's front door, since this Worker's `fetch` to its own host
// never reaches Access. `guardedFetch` still checks every hop here first, and follows redirects from here; an engine
// from before the method is read past: the hop is sent from here, as before.
// @effect-diagnostics missingPipeableSignature:off -- plain functions of a request and a binding.
import {
  BODYLESS_STATUSES,
  isMissingMethod,
  type McpEngineMethods,
  McpPublicFetched,
  type McpPublicFetchResult,
  McpPublicRefused,
  publicFetchHeaders,
} from "@cloudpid/mcp/types";
import {
  DohResolverLive,
  type WebRequest,
  type WebNetworkLive,
  WebToolError,
  WebTransport,
  WebTransportLive,
  type WebTransportService,
} from "@cloudpid/extensions/web";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import { isOwnHost } from "./own-hosts.ts";

/** What reads a URL from `McpWorker`: the `MCP_ENGINE` binding's `fetchPublic`, or a fake. */
export type PublicReader = Pick<McpEngineMethods, "fetchPublic">;

/**
 * Whether a hop is read from `McpWorker`: an https GET with no body to a host `isOwnHost` names (the production domain,
 * a stage's app host on `workers.dev`, and the App sandbox's zone, which a sign-in never reads but which is no less
 * cloudpid's).
 */
export const readsFromMcpWorker = (request: WebRequest): boolean => {
  if ((request.method ?? "GET") !== "GET" || request.body !== undefined) return false;

  if (!URL.canParse(request.url)) return false;

  const url = new URL(request.url);

  return url.protocol === "https:" && isOwnHost(url.hostname.toLowerCase());
};

/**
 * The response headers not copied onto the rebuilt `Response`: its body is the decoded text, so the upstream's length
 * and encodings no longer describe it, and hop-by-hop headers belong to the upstream's connection.
 */
const DROPPED_HEADERS: ReadonlyArray<string> = [
  "content-length",
  "content-encoding",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "upgrade",
];

const isFetched = Schema.is(McpPublicFetched);

const isRefused = Schema.is(McpPublicRefused);

/**
 * `McpWorker`'s answer as the `Response` the guard reads, or why it is not one: a refusal fails with its reason, and an
 * answer of a shape this Worker does not know (the fallback member, or none) fails the hop.
 */
const responseOf = (
  answer: typeof McpPublicFetchResult.Encoded,
): Effect.Effect<Response, WebToolError> => {
  if (isRefused(answer)) return Effect.fail(WebToolError.make({ message: answer.message }));

  if (!isFetched(answer)) {
    return Effect.fail(
      WebToolError.make({ message: "McpWorker answered in a form this Worker does not read" }),
    );
  }

  const { code, body } = answer;

  const headers = Record.filter(
    answer.headers,
    (_, name) => !DROPPED_HEADERS.includes(name.toLowerCase()),
  );

  return Effect.try({
    try: () =>
      new Response(BODYLESS_STATUSES.includes(code) ? null : body, { status: code, headers }),
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
): WebTransportService => ({
  fetch: (request) => {
    const read = reader?.fetchPublic;

    if (read === undefined || !readsFromMcpWorker(request)) return direct.fetch(request);

    return Effect.tryPromise({
      try: () => read({ url: request.url, headers: publicFetchHeaders(request.headers) }),
      catch: (error): "missing" | "failed" =>
        error instanceof Error && isMissingMethod(error.message) ? "missing" : "failed",
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

/** {@link ownHostTransport} over `reader`, in front of the `WebTransport` it is given. */
export const ownHostRouted = (reader: PublicReader | undefined) =>
  Layer.effect(
    WebTransport,
    Effect.gen(function* () {
      return ownHostTransport(reader, yield* WebTransport);
    }),
  );

/**
 * The Registry's sign-in network: the Worker's (`WebNetworkLive`'s DNS-over-HTTPS and `fetch`), with
 * {@link ownHostTransport} over `reader` (the `MCP_ENGINE` binding; undefined where the Worker has none) in front of its
 * `fetch`.
 */
export const signInNetwork = (reader: PublicReader | undefined): typeof WebNetworkLive =>
  DohResolverLive.pipe(
    Layer.provideMerge(ownHostRouted(reader).pipe(Layer.provide(WebTransportLive))),
  );
