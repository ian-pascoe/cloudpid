// docs/architecture/client-and-protocol.md → Same-origin check: `/rpc` and the Session socket answer only the web app's own
// page, so a site the owner visits cannot drive them with the owner's cookie (or, under `alchemy dev`, with nothing at all:
// the guard admits every loopback request there).
// @effect-diagnostics missingPipeableSignature:off -- `crossOriginReason` is called with its two arguments, not piped.

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { hostsOf } from "./access.ts";
import { isRegistryRpc, sessionSocketId } from "./routes.ts";

/** Why a request is refused, for the log. */
export type CrossOriginReason =
  /** `Sec-Fetch-Site` is present and is anything but `same-origin`. */
  | "fetch-site"
  /** There is no `Sec-Fetch-Site`, and `Origin` names a host the request does not. */
  | "origin";

/**
 * Why `headers` show a call from another origin than the page it names, or undefined when they do not. The browser's own
 * judgement decides when it gave one, since a dev proxy may change `Host` but not `Sec-Fetch-Site` (Vite proxies `/rpc` with `changeOrigin`, so
 * the Worker sees `Host: localhost:1337` under `Origin: http://localhost:5173`, a page's same-origin call):
 *
 * 1. `Sec-Fetch-Site` present: only `same-origin` is admitted; `same-site`, `cross-site`, `none` and any other value are not.
 * 2. Else `Origin` present: admitted only when its host is one of `hosts` (the request's `Host`, and its URL's own).
 * 3. Neither: admitted. That caller is no browser, and a forged cross-site request needs a browser's credentials.
 *
 * Pure: `headers` are the request's, keyed in lower case; `hosts` are what `hostsOf` (access.ts) reads.
 */
export const crossOriginReason = (
  headers: Readonly<Record<string, string | undefined>>,
  hosts: ReadonlyArray<string>,
): CrossOriginReason | undefined => {
  const site = headers["sec-fetch-site"];

  if (site !== undefined) return site === "same-origin" ? undefined : "fetch-site";

  const origin = headers["origin"];

  if (origin === undefined) return undefined;

  // `null` (a sandboxed or redirected page), a list, or anything that is no origin names no host.
  const host = URL.canParse(origin) ? new URL(origin).host : undefined;

  return host !== undefined && Arr.some(hosts, (named) => named.toLowerCase() === host)
    ? undefined
    : "origin";
};

const refusal = HttpServerResponse.text("cross_origin", {
  status: 403,
  headers: { "cache-control": "no-store" },
});

/**
 * The two routes that act for the owner with no preflight, held to {@link crossOriginReason}: the Session socket's upgrade
 * (`socket`, with the Session's ID) and `POST /rpc` (`rpc`; built only for an admitted call). A request for either that the rule refuses gets a 403
 * `cross_origin` (logged as the guard logs its refusals) and reaches neither branch; one it admits is answered by the
 * branch; any other request gets undefined. `worker-init.ts` runs it after the guard, ahead of its other routes.
 */
export const serveOwnerCalls = <E1, R1, E2, R2>(branches: {
  readonly socket: (
    sessionId: string,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, E1, R1>;
  readonly rpc: () => Effect.Effect<HttpServerResponse.HttpServerResponse, E2, R2>;
}) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const sessionId = sessionSocketId(request);

    if (sessionId === undefined && !isRegistryRpc(request)) return undefined;

    const reason = crossOriginReason(request.headers, hostsOf(request));

    if (reason !== undefined) {
      yield* Effect.logWarning("Refused a cross-origin request").pipe(
        Effect.annotateLogs({ reason }),
      );

      return refusal;
    }

    return sessionId === undefined ? yield* branches.rpc() : yield* branches.socket(sessionId);
  });
