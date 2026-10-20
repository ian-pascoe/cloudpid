// The SSRF guard. `web_fetch` reaches the network only through `guardedFetch`: it checks the URL, resolves its host, and
// follows redirects itself, so every hop (not just the URL the model gave) passes the same checks before a request is
// sent. See `ssrf.ts` for the rules and `dns.ts` for the residual DNS-rebinding risk.
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { DnsResolver } from "./dns.ts";
import { WebToolError } from "./errors.ts";
import { discardBody } from "./response.ts";
import { blockedAddressReason, blockedHostReason } from "./ssrf.ts";
import { type WebRequest, WebTransport } from "./transport.ts";

/** Most redirects one fetch follows. */
export const MAX_REDIRECTS = 10;

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

const blocked = (reason: string, hop: number): WebToolError =>
  WebToolError.make({
    message: hop === 0 ? `blocked: ${reason}` : `redirect blocked: ${reason}`,
  });

/** An IPv4 literal or a bracketed IPv6 literal needs no lookup: the host rules already judged the address. */
const isLiteralAddress = (hostname: string): boolean =>
  hostname.startsWith("[") || /^[0-9.]+$/.test(hostname) || /^0x/i.test(hostname);

/**
 * Check that `url` may be fetched: an HTTP(S) URL without credentials, whose host is neither a private name nor
 * address nor resolves to one. `hop` is 0 for the URL the model gave and above for a redirect's target.
 */
const checkUrl = Effect.fn("guardedFetch.checkUrl")(function* (url: URL, hop: number) {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return yield* WebToolError.make({
      message: `unsupported URL scheme ${url.protocol} (Web Fetch requires an HTTP or HTTPS URL)`,
    });
  }

  if (url.username !== "" || url.password !== "") {
    return yield* WebToolError.make({ message: "URLs with credentials are not supported" });
  }

  const reason = blockedHostReason(url.hostname);

  if (reason !== undefined) return yield* blocked(reason, hop);

  if (isLiteralAddress(url.hostname)) return;

  const resolver = yield* DnsResolver;
  const addresses = yield* resolver.resolve(url.hostname.replace(/\.$/, ""));

  const unsafe = Arr.findFirst(addresses, (address) => blockedAddressReason(address) !== undefined);

  if (Option.isSome(unsafe)) {
    return yield* blocked(
      `host resolves to a ${blockedAddressReason(unsafe.value) ?? "non-public address"}`,
      hop,
    );
  }
});

/**
 * Send `request`, following redirects by hand (up to `MAX_REDIRECTS`) and checking the URL and every redirect target
 * first. Returns the first response that is not a redirect, with the URL it came from. A refused target fails with
 * `blocked: …` and nothing is sent to it.
 */
export const guardedFetch = Effect.fn("guardedFetch")(function* (request: WebRequest) {
  const transport = yield* WebTransport;

  let current = yield* Effect.try({
    try: () => new URL(request.url),
    catch: () =>
      WebToolError.make({ message: "invalid URL (expected an absolute HTTP or HTTPS URL)" }),
  });

  for (let hop = 0; ; hop++) {
    yield* checkUrl(current, hop);

    const response = yield* transport.fetch({ ...request, url: current.toString() });
    const location = response.headers.get("location");

    if (!REDIRECT_STATUSES.has(response.status) || location === null) {
      return { response, url: current };
    }

    // The redirect's body is never read.
    yield* discardBody(response);

    if (hop >= MAX_REDIRECTS) {
      return yield* WebToolError.make({
        message: `too many redirects (more than ${MAX_REDIRECTS})`,
      });
    }

    current = yield* Effect.try({
      try: () => new URL(location, current),
      catch: () => WebToolError.make({ message: "redirected to an invalid URL" }),
    });
  }
});
