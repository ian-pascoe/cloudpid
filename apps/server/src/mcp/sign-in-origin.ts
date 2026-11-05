// The origin a MCP sign-in starts on, and the client document, callback and DCR redirect URLs under it
// (`docs/architecture/mcp-sign-in.md` → Client registration, The client document and the callback outside Access;
// ADR-0035). Pure, so it is tested without a Worker, and light, so the main Worker's props import it (`mcp-access.ts`
// lists the Self-use redirect URI; `docs/development/workers.md` → Startup).
//
// A live stage has one origin, a deploy-time var (`APP_ORIGIN_VAR`), and a request's `Host` is never read there. `alchemy dev`
// has two, `http://localhost:1337` (workerd) and `http://localhost:5173` (Vite), and the redirect URI follows the one the
// sign-in started on. Whether Vite rewrites `Host` was checked: its string form of a proxy target sets `changeOrigin` and
// does, to the Worker's own; the `/oauth/mcp/` proxy of `apps/web/vite.config.ts` sets `changeOrigin: false`, which keeps the
// browser's `Host`, so the Worker reads `Host` and no forwarded header (a client could set one).
// @effect-diagnostics missingPipeableSignature:off -- plain functions over values.
import { sha256Hex } from "@cloudpid/config/sha256";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";

/**
 * The client document's path: public on every deployed stage (`sign-in-routes.ts` routes it; the origin goes before). Here,
 * not in `sign-in-routes.ts`, so that the Worker's props (`bypass-access.ts`) import none of the routes.
 */
export const CLIENT_DOCUMENT_PATH = "/oauth/mcp/client.json";

/** The OAuth callback's path: public on every deployed stage, with an optional 12-character issuer hash below it. */
export const CALLBACK_PATH = "/oauth/mcp/callback";

/** The two origins of `alchemy dev` (the stage's `Host`es there): workerd's own, and Vite's, which proxies the sign-in paths. */
const LOCAL_ORIGINS: ReadonlyArray<string> = ["http://localhost:1337", "http://localhost:5173"];

/** The client document's URL, which is the client id at an authorization server that supports it. */
export const clientDocumentUrl = (origin: string): string => `${origin}${CLIENT_DOCUMENT_PATH}`;

/** The redirect URI of a sign-in that does not use an issuer hash: the callback itself. */
export const callbackUrl = (origin: string): string => `${origin}${CALLBACK_PATH}`;

/** The 12 characters of an issuer's hash in the redirect URI of an authorization server that does not advertise `iss`. */
const issuerHash = (issuer: string): string => sha256Hex(issuer).slice(0, 12);

/**
 * The redirect URI a DCR client registers: the callback, and below it the issuer's hash when the authorization server
 * does not advertise `authorization_response_iss_parameter_supported`, so the callback knows which server answered.
 */
export const dcrRedirectUri = (input: {
  readonly origin: string;
  readonly issuer: string;
  readonly advertisesIss: boolean;
}): string =>
  input.advertisesIss
    ? callbackUrl(input.origin)
    : `${callbackUrl(input.origin)}/${issuerHash(input.issuer)}`;

/** What reads the origin from: the Worker's vars and the request's `Host`. */
export type OriginSources = {
  /** `APP_ORIGIN_VAR`: set on live stages only. */
  readonly deployedOrigin: string | undefined;
  /** The Worker was built by `alchemy dev`. */
  readonly localMode: boolean;
  /** The request's `Host` header. */
  readonly host: string | undefined;
};

/**
 * The origin a sign-in starts on, or undefined when there is none to trust. A live stage's is its var, whatever `Host`
 * says; under `alchemy dev` it is the one of {@link LOCAL_ORIGINS} that `Host` names, and a Worker with neither answers
 * nothing (a deployed Worker that was not given its origin refuses starts).
 */
export const signInOrigin = (sources: OriginSources): string | undefined => {
  if (sources.localMode) {
    return Option.getOrUndefined(
      Arr.findFirst(
        LOCAL_ORIGINS,
        (origin) => origin === `http://${sources.host?.toLowerCase() ?? ""}`,
      ),
    );
  }

  const origin = sources.deployedOrigin;

  return origin === undefined || origin === "" ? undefined : origin;
};
