/**
 * `@cloudpid/mcp/oauth`: pi-mcp's `oauth` functions and cloudpid's local additions, for the sign-in code in the
 * Registry and the main Worker. It never imports the SDK; its test (`sdk-isolation.test.ts`) fails if it comes to.
 *
 * `docs/architecture/mcp-sign-in.md` → Tokens reach the host object (Code), Client registration, Sign-out;
 * `docs/architecture/mcp.md` → Packages and objects.
 *
 * What comes from pi-mcp is named one by one: its `oauth` entry also holds `McpOAuthProvider`, `OAuthCallbackServer`
 * (`node:http`) and `authorizeMcp`, which cloudpid never uses (`authorizeMcp` drops the client and the tokens on
 * `invalid_client`). The additions pi-mcp lacks live here, and go to pi as an issue first (The MCP core #394 D6): RFC 7009
 * revocation, `client_secret_expires_at` and the issuer pin, and the size bounds the Registry holds sign-ins to.
 * The `client_credentials` grant is in `./oauth-client-credentials.ts` and the `private_key_jwt` assertion in `./client-assertion.ts`, re-exported here.
 */
// @effect-diagnostics missingPipeableSignature:off asyncFunction:off preferEffectArray:off -- plain functions over values and Promises, as `fetch` is.
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { AuthorizationServerMetadata } from "@earendil-works/pi-mcp/oauth";
import { basicAuthorization, boundedText, type OAuthFetch } from "./oauth-http.ts";

export {
  boundedText,
  MAX_METADATA_BYTES,
  MAX_SIGN_IN_ERROR_LENGTH,
  OAUTH_FETCH_TIMEOUT_MS,
  type OAuthFetch,
  scrubbed,
} from "./oauth-http.ts";

export * from "./client-assertion.ts";

export * from "./oauth-client-credentials.ts";

export {
  buildAuthorizationServerDiscoveryUrls,
  discoverAuthorizationServerMetadata,
  discoverOAuthServerInfo,
  discoverProtectedResourceMetadata,
  exchangeAuthorizationCode,
  McpOAuthAuthorizationRequiredError,
  OAuthError,
  OAuthInsecureEndpointError,
  OAuthIssuerMismatchError,
  OAuthRegistrationError,
  parseWwwAuthenticate,
  refreshAuthorization,
  registerClient,
  resourceUrlFromServerUrl,
  selectResource,
  startAuthorization,
  stepUpScope,
} from "@earendil-works/pi-mcp/oauth";

export type {
  AddClientAuthentication,
  AuthorizationServerMetadata,
  OAuthChallenge,
  OAuthClientInformation,
  OAuthClientInformationFull,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthClientMetadataDocument,
  OAuthClientProvider,
  OAuthDiscoveryState,
  OAuthFlowOptions,
  OAuthFlowResult,
  OAuthProtectedResourceMetadata,
  OAuthServerInfo,
  OAuthTokens,
  TokenRequestOptions,
} from "@earendil-works/pi-mcp/oauth";

/** An access or refresh token is held to this many bytes (→ Bounds). */
export const MAX_TOKEN_BYTES = 16 * 1024;

const encoder = new TextEncoder();

/** The size of `text` as UTF-8, in bytes. */
export const byteLength = (text: string): number => encoder.encode(text).byteLength;

// The issuer pin ------------------------------------------------------------------------------------------------------

/** An issuer as it is compared: one trailing `/` trimmed (`oauth.issuer`, → The `oauth` fields). */
export const normalizeIssuer = (issuer: string): string =>
  issuer.endsWith("/") ? issuer.slice(0, -1) : issuer;

/** Whether two issuers are the same one, after trimming one trailing `/` from each. */
export const sameIssuer = (left: string, right: string): boolean =>
  normalizeIssuer(left) === normalizeIssuer(right);

/** What pins an entry's authorization server: `oauth.issuer`, and/or the `issuer` of the document at `authServerMetadataUrl`. */
export type IssuerPin = {
  readonly issuer?: string | undefined;
  readonly metadataIssuer?: string | undefined;
};

/** Whether the entry pins its authorization server at all. */
export const isPinned = (pin: IssuerPin): boolean =>
  pin.issuer !== undefined || pin.metadataIssuer !== undefined;

/**
 * Why `actual`, the issuer an authorization server answered with, is not the one `pin` names; undefined when it is, or
 * when there is no pin. With both pins they must agree (`oauth.issuer` and `authServerMetadataUrl`), whatever `actual` is.
 * The messages name issuers, which are public, and never a client secret.
 */
export const issuerPinProblem = (pin: IssuerPin, actual: string): string | undefined => {
  const { issuer, metadataIssuer } = pin;

  if (issuer !== undefined && metadataIssuer !== undefined && !sameIssuer(issuer, metadataIssuer)) {
    return `oauth.issuer (${issuer}) and the issuer of authServerMetadataUrl (${metadataIssuer}) disagree`;
  }

  const pinned = issuer ?? metadataIssuer;

  if (pinned === undefined || sameIssuer(pinned, actual)) return undefined;

  return `the server's authorization server is ${actual}, but the entry pins ${pinned}`;
};

// The client secret's expiry ------------------------------------------------------------------------------------------

/** A registration within this long of its `client_secret_expires_at` is replaced at the next start. */
export const REGISTRATION_RENEW_MARGIN_MS = 5 * 60_000;

/**
 * When the client secret of a registration expires, in epoch milliseconds, from RFC 7591's `client_secret_expires_at`
 * (epoch seconds); undefined when it never does (`0`, or absent).
 */
export const clientSecretExpiresAt = (information: {
  readonly client_secret_expires_at?: number | undefined;
}): number | undefined => {
  const seconds = information.client_secret_expires_at;

  return seconds === undefined || !Number.isFinite(seconds) || seconds <= 0
    ? undefined
    : seconds * 1000;
};

/** Whether `expiresAt` (epoch milliseconds; undefined: never) is within `margin` of `now`, or past. */
export const expiresWithin = (
  expiresAt: number | undefined,
  now: number,
  margin: number = REGISTRATION_RENEW_MARGIN_MS,
): boolean => expiresAt !== undefined && expiresAt - margin <= now;

// RFC 7009 revocation -------------------------------------------------------------------------------------------------

/** Each revocation request gets this long. */
export const REVOCATION_TIMEOUT_MS = 5_000;

/** The client that revokes: a public one (`client_id` only) or one with a secret. */
export type RevocationClient = {
  readonly client_id: string;
  readonly client_secret?: string | undefined;
};

/** The token kinds RFC 7009 names. */
export type RevocableToken = "refresh_token" | "access_token";

/** One token's revocation: sent and accepted, or why not. `reason` holds a status, an OAuth error code or a kind of failure, never a token. */
export type Revocation =
  | { readonly token: RevocableToken; readonly status: "revoked" }
  | { readonly token: RevocableToken; readonly status: "failed"; readonly reason: string };

/** The metadata fields revocation reads, which the metadata's open record leaves unchecked. */
const RevocationMetadata = Schema.Struct({
  revocation_endpoint: Schema.optionalKey(Schema.String),
  revocation_endpoint_auth_methods_supported: Schema.optionalKey(Schema.String.pipe(Schema.Array)),
  token_endpoint_auth_methods_supported: Schema.optionalKey(Schema.String.pipe(Schema.Array)),
});

const readRevocationMetadata = Schema.decodeUnknownOption(RevocationMetadata);

/** The server's `revocation_endpoint` (RFC 8414 §2), when it advertises one over https. */
export const revocationEndpoint = (
  metadata: AuthorizationServerMetadata | undefined,
): URL | undefined =>
  Option.getOrUndefined(
    Option.flatMap(Option.fromNullishOr(metadata), (known) =>
      Option.flatMap(readRevocationMetadata(known), ({ revocation_endpoint: advertised }) =>
        advertised !== undefined &&
        URL.canParse(advertised) &&
        new URL(advertised).protocol === "https:"
          ? Option.some(new URL(advertised))
          : Option.none(),
      ),
    ),
  );

type Authentication = "none" | "post" | "basic";

/**
 * How `client` authenticates at the revocation endpoint: the methods that endpoint lists, else the token endpoint's.
 * A public client sends its id. With a secret: `client_secret_post` if listed, else `client_secret_basic` if listed or
 * if no list is given, else none (the sign-out reports it).
 */
const revocationAuth = (
  metadata: AuthorizationServerMetadata,
  client: RevocationClient,
): Authentication | undefined => {
  if (client.client_secret === undefined) return "none";

  const known = Option.getOrUndefined(readRevocationMetadata(metadata));

  const listed =
    known?.revocation_endpoint_auth_methods_supported ??
    known?.token_endpoint_auth_methods_supported;

  if (listed?.includes("client_secret_post") === true) return "post";

  if (listed === undefined || listed.includes("client_secret_basic")) return "basic";

  return undefined;
};

const ErrorBody = Schema.fromJsonString(Schema.Struct({ error: Schema.String }));

const readErrorBody = Schema.decodeUnknownOption(ErrorBody);

/** The OAuth error code of a refusal's body, or the status when there is none, or it is not a plain code. */
const refusalReason = async (response: Response): Promise<string> => {
  const body = await boundedText(response, 4096).catch(() => undefined);
  const code = Option.map(Option.fromNullishOr(body), (text) => readErrorBody(text));
  const error = Option.flatten(code).pipe(Option.map(({ error: found }) => found));

  return Option.match(error, {
    onNone: () => `HTTP ${response.status}`,
    onSome: (found) => (/^[\w.-]{1,64}$/.test(found) ? found : `HTTP ${response.status}`),
  });
};

const revoke = async (
  endpoint: URL,
  metadata: AuthorizationServerMetadata,
  client: RevocationClient,
  kind: RevocableToken,
  token: string,
  fetch: OAuthFetch,
): Promise<Revocation> => {
  const auth = revocationAuth(metadata, client);

  if (auth === undefined) {
    return { token: kind, status: "failed", reason: "no client authentication the server accepts" };
  }

  const body = new URLSearchParams({ token, token_type_hint: kind });
  const headers = new Headers({ "content-type": "application/x-www-form-urlencoded" });
  const secret = client.client_secret;

  if (auth === "basic" && secret !== undefined) {
    headers.set("authorization", basicAuthorization(client.client_id, secret));
  } else {
    body.set("client_id", client.client_id);

    if (auth === "post" && secret !== undefined) body.set("client_secret", secret);
  }

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(REVOCATION_TIMEOUT_MS),
    });

    if (response.ok) {
      await response.body?.cancel();

      return { token: kind, status: "revoked" };
    }

    return { token: kind, status: "failed", reason: await refusalReason(response) };
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";

    return { token: kind, status: "failed", reason: timedOut ? "timed out" : "network error" };
  }
};

/**
 * Sign-out's RFC 7009 revocation (→ Sign-out): the refresh token, then the access token, `REVOCATION_TIMEOUT_MS` each,
 * through `fetch`. Best effort: each result says whether it went through, and none is thrown. `undefined` when the
 * server advertises no revocation endpoint. No token reaches a result or an error.
 */
export const revokeTokens = async (input: {
  readonly metadata: AuthorizationServerMetadata | undefined;
  readonly client: RevocationClient;
  readonly refreshToken?: string | undefined;
  readonly accessToken?: string | undefined;
  readonly fetch: OAuthFetch;
}): Promise<ReadonlyArray<Revocation> | undefined> => {
  const endpoint = revocationEndpoint(input.metadata);

  if (endpoint === undefined || input.metadata === undefined) return undefined;

  const results: Array<Revocation> = [];

  if (input.refreshToken !== undefined) {
    results.push(
      await revoke(
        endpoint,
        input.metadata,
        input.client,
        "refresh_token",
        input.refreshToken,
        input.fetch,
      ),
    );
  }

  if (input.accessToken !== undefined) {
    results.push(
      await revoke(
        endpoint,
        input.metadata,
        input.client,
        "access_token",
        input.accessToken,
        input.fetch,
      ),
    );
  }

  return results;
};
