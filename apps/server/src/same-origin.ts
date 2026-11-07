// docs/architecture/client-and-protocol.md → Same-origin check: `/rpc` and the Session socket answer only the web app's own
// page, so a site the owner visits cannot drive them with the owner's cookie (or, under `alchemy dev`, with nothing at all:
// the guard admits every loopback request there).
// @effect-diagnostics missingPipeableSignature:off -- `crossOriginProblem` is called with its two arguments, not piped.

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { hostsOf } from "./access.ts";

/** What a request must not be, as a reason for the log. */
export type CrossOriginProblem =
  /** `Sec-Fetch-Site` is present and is anything but `same-origin`. */
  | "fetch-site"
  /** There is no `Sec-Fetch-Site`, and `Origin` names a host the request does not. */
  | "origin";

/**
 * Whether a call that came from another origin than the page it names, and why. The browser's own judgement decides when
 * it gave one, since a dev proxy may change `Host` but not `Sec-Fetch-Site` (Vite proxies `/rpc` with `changeOrigin`, so
 * the Worker sees `Host: localhost:1337` under `Origin: http://localhost:5173`, a page's same-origin call):
 *
 * 1. `Sec-Fetch-Site` present: only `same-origin` is admitted; `same-site`, `cross-site`, `none` and any other value are not.
 * 2. Else `Origin` present: admitted only when its host is one of `hosts` (the request's `Host`, and its URL's own).
 * 3. Neither: admitted. That caller is no browser, and a forged cross-site request needs a browser's credentials.
 *
 * Pure: `headers` are the request's, keyed in lower case; `hosts` are what `hostsOf` (access.ts) reads.
 */
export const crossOriginProblem = (
  headers: Readonly<Record<string, string | undefined>>,
  hosts: ReadonlyArray<string>,
): CrossOriginProblem | undefined => {
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
 * The 403 `cross_origin` for `request` if {@link crossOriginProblem} refuses it (logged as the guard logs its refusals),
 * else undefined. Called after the guard, for `/rpc` and the Session socket (worker-init.ts).
 */
export const refuseCrossOrigin = (
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<HttpServerResponse.HttpServerResponse | undefined> =>
  Effect.gen(function* () {
    const problem = crossOriginProblem(request.headers, hostsOf(request));

    if (problem === undefined) return undefined;

    yield* Effect.logWarning("Refused a cross-origin request").pipe(
      Effect.annotateLogs({ reason: problem }),
    );

    return refusal;
  });
