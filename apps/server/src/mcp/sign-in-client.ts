// What a start puts in an authorization request, and what cloudpid calls itself there (`docs/architecture/mcp-sign-in.md` →
// Client registration, The client document and the callback outside Access, Starting and completing a sign-in; ADR-0035):
// the stage's client name, the client document, the DCR redirect URI, the 256-bit `state`, the PKCE pair and the
// authorization URL. Pure but for the random bytes, so it is tested without a Worker.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- plain functions over values.
import { sha256Hex } from "@cloudpid/config";
import type { AuthorizationServerMetadata } from "@cloudpid/mcp/oauth";
import * as Arr from "effect/Array";
import * as Result from "effect/Result";
import { callbackUrl, clientDocumentUrl } from "./sign-in-origin.ts";

/** The longest `client_name` (`oauth.clientName`: 1–100 characters). */
const MAX_CLIENT_NAME_LENGTH = 100;

/** The stage a client name is made for: its label (absent on `prod`) and whether it runs under `alchemy dev`. */
export type StageNaming = {
  readonly label?: string | undefined;
  readonly local: boolean;
};

/** The ` (<label>)` or ` (<label>, local)` a non-prod stage adds to a client name; empty on `prod`. */
const suffixOf = ({ label, local }: StageNaming): string =>
  label === undefined ? "" : ` (${label}${local ? ", local" : ""})`;

/**
 * The name cloudpid registers and shows as: `cloudpid` on prod, `cloudpid (<label>)` on other deployed stages and
 * `cloudpid (<label>, local)` under `alchemy dev`. A configured `oauth.clientName` gets the suffix off prod too. The
 * suffix is never cut: past 100 characters the configured part is shortened at a code-point boundary.
 */
export const clientNameFor = (stage: StageNaming, configured?: string): string => {
  const suffix = suffixOf(stage);
  const base = Array.from(configured ?? "cloudpid");
  const room = Math.max(0, MAX_CLIENT_NAME_LENGTH - Array.from(suffix).length);

  return `${base.slice(0, room).join("")}${suffix}`;
};

/** The client document (→ The document): the content an authorization server fetches at its first sign-in. */
export const clientDocument = (input: {
  readonly origin: string;
  readonly clientName: string;
}) => ({
  client_id: clientDocumentUrl(input.origin),
  client_name: input.clientName,
  redirect_uris: [callbackUrl(input.origin)],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
  application_type: "web",
});

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

const base64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

/** 256 random bits as 43 URL-safe characters: the `state`, and with the same size the PKCE verifier (RFC 7636 §4.1). */
export const randomToken = (): string => base64Url(crypto.getRandomValues(new Uint8Array(32)));

/** What a `state` looks like: what {@link randomToken} makes. The callback gives the Registry no other. */
export const WELL_FORMED_STATE = /^[A-Za-z0-9_-]{43}$/;

/** The 32 bytes of the SHA-256 of `text`. */
export const sha256Bytes = (text: string): Uint8Array => {
  const hex = sha256Hex(text);

  return Uint8Array.from(
    Arr.makeBy(32, (index) => Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)),
  );
};

/** The PKCE `S256` challenge of `verifier` (RFC 7636 §4.2): the SHA-256 of its ASCII bytes, Base64url-encoded. */
export const pkceChallenge = (verifier: string): string => base64Url(sha256Bytes(verifier));

/** What the authorization URL is built from. */
export type AuthorizationRequest = {
  readonly metadata: AuthorizationServerMetadata;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scope: string | undefined;
  readonly state: string;
  readonly codeChallenge: string;
  readonly resource: string | undefined;
};

/**
 * The authorization request's URL (RFC 6749 §4.1.1 with PKCE `S256`, and `resource` of RFC 8707), or why the server cannot
 * take it: it must offer the `code` response type and, if it lists methods, `S256`, and its endpoint must be https.
 */
export const authorizationUrl = (request: AuthorizationRequest): Result.Result<URL, string> => {
  const { metadata } = request;

  if (!Arr.contains(metadata.response_types_supported, "code")) {
    return Result.fail("The authorization server does not support authorization codes");
  }

  if (
    metadata.code_challenge_methods_supported !== undefined &&
    !Arr.contains(metadata.code_challenge_methods_supported, "S256")
  ) {
    return Result.fail("The authorization server does not support PKCE S256");
  }

  if (!URL.canParse(metadata.authorization_endpoint)) {
    return Result.fail("The authorization server's authorization endpoint is not a URL");
  }

  const url = new URL(metadata.authorization_endpoint);

  if (url.protocol !== "https:") {
    return Result.fail("The authorization server's authorization endpoint is not https");
  }

  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", request.clientId);
  url.searchParams.set("code_challenge", request.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("redirect_uri", request.redirectUri);
  url.searchParams.set("state", request.state);

  if (request.scope !== undefined && request.scope !== "") {
    url.searchParams.set("scope", request.scope);
  }

  if (request.resource !== undefined) url.searchParams.set("resource", request.resource);

  return Result.succeed(url);
};

/** The longest return path a start link carries. */
const MAX_RETURN_PATH_LENGTH = 512;

// A path of this app: one `/`, then no second `/` or `\` (a protocol-relative URL), and no control character.
// eslint-disable-next-line no-control-regex
const RETURN_PATH = /^\/(?![/\\])[^\\\u0000-\u001f\u007f]*$/;

/**
 * `path` when it is a path of this app that a Back link may go to; undefined otherwise, so a start link cannot send the
 * owner to another site.
 */
export const safeReturnPath = (path: string | null | undefined): string | undefined =>
  path === null || path === undefined || path.length > MAX_RETURN_PATH_LENGTH
    ? undefined
    : RETURN_PATH.test(path)
      ? path
      : undefined;
