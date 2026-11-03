// A server that signs in on its own (`docs/architecture/mcp-sign-in.md` → Client Credentials, Settings): an HTTP entry
// whose `oauth.grantType` is `client_credentials`. The Registry gets its token with no owner step, so it has no Sign in,
// no Sign out and no Sign-in request, and its row says so. Pure over an entry, for the Registry, the host and Settings.
// @effect-diagnostics missingPipeableSignature:off -- plain predicates over values, not combinators.
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import type { McpOauth } from "./mcp-servers.ts";

/** What a row says of a server that signs in on its own. */
export const MCP_CLIENT_GRANT_CHIP = "Signs in on its own";

/**
 * Whether `server`, an entry as written or as the host stores it, signs in on its own: not a stdio server, and
 * `oauth.grantType` is `client_credentials`. An entry with an `Authorization` header is refused with `oauth` at all, so
 * it never gets here.
 */
export const signsInOnItsOwn = (server: {
  readonly type?: unknown;
  readonly oauth?: unknown;
}): boolean =>
  server.type !== "stdio" &&
  Predicate.hasProperty(server.oauth, "grantType") &&
  server.oauth.grantType === "client_credentials";

/** The authorization server's host, from the pin the entry must have (`oauth.issuer`, else `oauth.authServerMetadataUrl`). */
const pinnedHost = (oauth: McpOauth): string | undefined => {
  const pin = oauth.issuer ?? oauth.authServerMetadataUrl;

  return pin === undefined
    ? undefined
    : Option.getOrUndefined(Option.liftThrowable((href: string) => new URL(href).host)(pin));
};

/** The row of a server that signs in on its own: no actions, and the issuer host when the entry's pin names one. */
export type McpClientGrantRow = {
  readonly chip: typeof MCP_CLIENT_GRANT_CHIP;
  readonly issuerHost: string | undefined;
  /** "Signs in on its own · <issuer host>", or just the chip when the pin has no host. */
  readonly text: string;
  /** There is nothing to press: no Sign in, no Sign in again and no Sign out. */
  readonly actions: readonly [];
};

/** The row for `oauth`, an entry that signs in on its own. */
export const mcpClientGrantRow = (oauth: McpOauth): McpClientGrantRow => {
  const issuerHost = pinnedHost(oauth);

  return {
    chip: MCP_CLIENT_GRANT_CHIP,
    issuerHost,
    text:
      issuerHost === undefined ? MCP_CLIENT_GRANT_CHIP : `${MCP_CLIENT_GRANT_CHIP} · ${issuerHost}`,
    actions: [],
  };
};
