// docs/architecture/mcp-apps.md → The App sandbox (Origins, CSP). Where the page frames an App View: the sandbox origin the
// Session named for the View, and the proxy's URL on it, which carries the View's declared CSP as `?csp=` (the Worker sends
// it as a header). The origin comes from the Session, but is checked here as well before a frame is pointed at it: a page
// that framed whatever origin it was handed would run an App View, with the owner's page as its parent, wherever it said.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- plain functions over small values.
import type { McpUiResourceCsp } from "@modelcontextprotocol/ext-apps";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

/** The registrable domain the App sandbox serves on (`apps/server/src/view-host.ts`, `APP_DOMAIN`); a View's origin is under it. */
export const APP_DOMAIN = "ianpascoe.app";

/**
 * The one origin every View has under `alchemy dev` (`LOCAL_SANDBOX_ORIGIN` of the same file): the loopback address, so it is
 * cross-site to the app at `localhost` and shares no cookies with it. A drift guard in `frame-url.test.ts` holds the copies equal.
 */
export const LOCAL_SANDBOX_ORIGIN = "http://127.0.0.1:1338";

/** `https://<26 base32 characters>[--<label>].ianpascoe.app`, exactly: no path, port, credentials or other host. */
const VIEW_ORIGIN = new RegExp(
  `^https://[a-z2-7]{26}(--[a-z0-9]([a-z0-9-]{0,33}[a-z0-9])?)?\\.${APP_DOMAIN.replaceAll(".", "\\.")}$`,
);

/**
 * The app origins under `alchemy dev` (`LOCAL_APP_ORIGINS` of the server's `view-host.ts`; the drift guard in `frame-url.test.ts`
 * holds the copies equal): the main Worker's, which serves a build of this page, and Vite's. A page served from anywhere else
 * is not a local one.
 */
export const LOCAL_APP_ORIGINS: ReadonlyArray<string> = [
  "http://localhost:1337",
  "http://localhost:5173",
];

/**
 * Whether `origin` is one the page may frame an App View at: a View's host on the sandbox's domain, or the local sandbox,
 * and that only for a page that is itself at a local app origin (`pageOrigin`, the page's own `location.origin`): a deployed
 * page is never at one, so it never frames a loopback address, whatever it is told. The decision is the page's origin, not
 * the build's: under `alchemy dev` the Worker serves a production build at `localhost:1337`.
 */
export const isSandboxOrigin = (origin: string, pageOrigin: string): boolean =>
  VIEW_ORIGIN.test(origin) ||
  (origin === LOCAL_SANDBOX_ORIGIN && LOCAL_APP_ORIGINS.includes(pageOrigin));

/** Whether `origin` is the local sandbox, which has no hostname to tell it the app origin, so the page says it. */
const isLocalSandbox = (origin: string): boolean => origin === LOCAL_SANDBOX_ORIGIN;

/** The longest `?csp=` the Worker reads; a longer one it reads as absent, so it is not sent. */
const MAX_CSP_PARAM_LENGTH = 8192;

const Domains = Schema.String.pipe(Schema.Array, Schema.mutable, Schema.optionalKey);

const CspDeclaration = Schema.Struct({
  connectDomains: Domains,
  resourceDomains: Domains,
  frameDomains: Domains,
  baseUriDomains: Domains,
});

const decodeCsp = Schema.decodeUnknownOption(CspDeclaration);

/**
 * The View's declared CSP (`_meta.ui.csp`) as the spec's `McpUiResourceCsp`: only its four lists of strings; anything else
 * in it, and the whole declaration when it is not an object of them, is dropped. Undefined for none.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- this is the parse: a View's `_meta.ui.csp` as the host kept it, narrowed to the four lists
export const declaredCsp = (csp: unknown): McpUiResourceCsp | undefined => {
  if (!Predicate.isObject(csp)) return undefined;

  const decoded = decodeCsp(csp);

  if (Option.isNone(decoded)) return undefined;

  const { connectDomains, resourceDomains, frameDomains, baseUriDomains } = decoded.value;
  const kept: McpUiResourceCsp = {};

  if (connectDomains !== undefined && connectDomains.length > 0)
    kept.connectDomains = connectDomains;

  if (resourceDomains !== undefined && resourceDomains.length > 0)
    kept.resourceDomains = resourceDomains;

  if (frameDomains !== undefined && frameDomains.length > 0) kept.frameDomains = frameDomains;

  if (baseUriDomains !== undefined && baseUriDomains.length > 0)
    kept.baseUriDomains = baseUriDomains;

  const any =
    kept.connectDomains !== undefined ||
    kept.resourceDomains !== undefined ||
    kept.frameDomains !== undefined ||
    kept.baseUriDomains !== undefined;

  return any ? kept : undefined;
};

/**
 * The proxy page's URL at `origin`: its `?csp=` is the declared policy as JSON (left out when there is none or it is over
 * 8 KiB, which the Worker reads as none, so as strict as can be), and, at the local sandbox only, `?host=` names this page's
 * own origin, which the local Worker checks against its two (`localAppOriginOf`). Throws for an origin that is not a
 * sandbox's.
 */
export const frameUrl = (
  origin: string,
  csp: McpUiResourceCsp | undefined,
  pageOrigin: string,
): string => {
  if (!isSandboxOrigin(origin, pageOrigin))
    throw new Error(`${origin} is not an App sandbox origin`);

  const query: string[] = [];
  const declared = csp === undefined ? undefined : JSON.stringify(csp);

  if (declared !== undefined && declared.length <= MAX_CSP_PARAM_LENGTH) {
    query.push(`csp=${encodeURIComponent(declared)}`);
  }

  if (isLocalSandbox(origin)) query.push(`host=${encodeURIComponent(pageOrigin)}`);

  return `${origin}/${query.length === 0 ? "" : `?${query.join("&")}`}`;
};
