// docs/architecture/mcp-apps.md → The App sandbox (CSP); docs/architecture/visuals.md → The check. The Content-Security-Policy
// of a sandboxed page, built from the `_meta.ui.csp` a server declares (the proxy page puts it in its URL as `?csp=<JSON>`),
// as one pure function that two Workers share: the App sandbox's proxy, and the browser host, which gives a Visual the same
// header when it checks it. It lives here, not in `apps/app-sandbox`, because the browser host cannot depend on that package
// (it depends on the server, which depends on the browser host). What is cloudpid's own, and so never allowed, is the
// caller's to say (`OwnHosts`): the sandbox knows the stage's hosts; the check's list names none.
// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- plain functions over small native arrays.
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** What the caller knows of cloudpid's own hosts, which no list of a policy may name. */
export type OwnHosts = {
  /** Whether `host`, a plain host name, is one of cloudpid's own. */
  readonly isOwnHost: (host: string) => boolean;
  /** Whether the wildcard `*.<base>` could match a host of cloudpid's. A wildcard is refused whole; it is never narrowed. */
  readonly wildcardCoversOwnHost: (base: string) => boolean;
};

/** For a policy whose lists are known to name none of cloudpid's hosts. */
export const NO_OWN_HOSTS: OwnHosts = {
  isOwnHost: () => false,
  wildcardCoversOwnHost: () => false,
};

/**
 * The longest `?csp=` value read. A policy that is longer is read as absent, never cut, so it cannot be looser than the
 * server declared.
 */
const MAX_CSP_PARAM_LENGTH = 8192;

/** The part of the spec's `McpUiResourceCsp` that becomes a source list. Anything else in it is ignored. */
const UiCsp = Schema.Struct({
  connectDomains: Schema.String.pipe(Schema.Array, Schema.optional),
  resourceDomains: Schema.String.pipe(Schema.Array, Schema.optional),
  frameDomains: Schema.String.pipe(Schema.Array, Schema.optional),
  baseUriDomains: Schema.String.pipe(Schema.Array, Schema.optional),
});

const decodeUiCsp = Schema.decodeUnknownOption(Schema.fromJsonString(UiCsp));

/** A host name, or `*.` and one, in the lowercase form `URL` gives: labels of letters, digits and `-`, with no empty one. */
const HOST_NAME = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/** The scheme every list takes; `connectDomains` also takes `wss:`. */
const HTTPS_ONLY = ["https:"] as const;

/**
 * `entry` as the one CSP source it is, or `undefined` when it is dropped. An entry is an origin and nothing more: a
 * scheme in `schemes`, a host name (a leading `*.` allowed) and an optional port, with at most a trailing `/`. One that
 * holds a path, a query, a fragment or credentials is dropped whole, never cut to its origin: a CSP source with a path
 * would allow only that path, and its origin allows the whole host, which is looser than declared. Anything that
 * doesn't parse, or names one of cloudpid's own hosts, is dropped too.
 */
const toCspSource = (
  entry: string,
  schemes: readonly string[],
  own: OwnHosts,
): string | undefined => {
  const url = URL.canParse(entry) ? new URL(entry) : undefined;

  if (url === undefined || !schemes.includes(url.protocol)) return undefined;

  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return undefined;

  if (url.username !== "" || url.password !== "") return undefined;

  const host = url.hostname;

  if (!HOST_NAME.test(host)) return undefined;

  const refused = host.startsWith("*.")
    ? own.wildcardCoversOwnHost(host.slice(2))
    : own.isOwnHost(host);

  return refused ? undefined : `${url.protocol}//${url.host}`;
};

/** The sources of one declared list. Each is the list's own, never more: no scheme-only or `*` source appears. */
const sources = (
  list: readonly string[] | undefined,
  schemes: readonly string[],
  own: OwnHosts,
): readonly string[] => [
  ...new Set((list ?? []).flatMap((entry) => toCspSource(entry, schemes, own) ?? [])),
];

/** ` a b c` for the sources a directive adds after its own keywords, or nothing. */
const appendSources = (values: readonly string[]): string =>
  values.map((value) => ` ${value}`).join("");

/** A directive that is `'none'` without sources: with the policy's `default-src 'none'`, an omitted one is too. */
const listOrNone = (values: readonly string[]): string =>
  values.length === 0 ? "'none'" : values.join(" ");

/**
 * The CSP of a proxy page, never looser than what `csp` (the raw `?csp=` value, a JSON `_meta.ui.csp`) declares:
 *
 * - Without a usable declaration (absent, longer than 8 KiB, not JSON of the spec's shape): inline script and style,
 *   `data:` images, scripts from `'self'` (for `/proxy.js`), `connect-src 'none'`, and nothing else.
 * - `resourceDomains` add to scripts, styles, images, fonts and media; `connectDomains` are `connect-src`
 *   (`https:` and `wss:`), `frameDomains` `frame-src`, `baseUriDomains` `base-uri`. Every domain is an `https:` origin
 *   exactly as declared, with at most a trailing `/` (an entry with a path, query, fragment or credentials is dropped,
 *   not reduced), and a domain naming cloudpid's own hosts is dropped from every list.
 * - `object-src` and `form-action` are `'none'` and `frame-ancestors` is exactly `frameAncestor`, the stage's app origin.
 *
 * The inner View frame inherits it through `document.write`.
 */
export const buildCsp = (csp: string | null, frameAncestor: string, own: OwnHosts): string => {
  const declared =
    csp === null || csp.length > MAX_CSP_PARAM_LENGTH ? Option.none() : decodeUiCsp(csp);

  const { connectDomains, resourceDomains, frameDomains, baseUriDomains } = Option.getOrElse(
    declared,
    (): typeof UiCsp.Type => ({}),
  );

  const resources = sources(resourceDomains, HTTPS_ONLY, own);

  return [
    "default-src 'none'",
    `script-src 'self' 'unsafe-inline'${appendSources(resources)}`,
    `style-src 'unsafe-inline'${appendSources(resources)}`,
    `img-src data:${appendSources(resources)}`,
    ...(resources.length === 0
      ? []
      : [`font-src${appendSources(resources)}`, `media-src${appendSources(resources)}`]),
    `connect-src ${listOrNone(sources(connectDomains, [...HTTPS_ONLY, "wss:"], own))}`,
    `frame-src ${listOrNone(sources(frameDomains, HTTPS_ONLY, own))}`,
    `base-uri ${listOrNone(sources(baseUriDomains, HTTPS_ONLY, own))}`,
    "object-src 'none'",
    "form-action 'none'",
    `frame-ancestors ${frameAncestor}`,
  ].join("; ");
};
