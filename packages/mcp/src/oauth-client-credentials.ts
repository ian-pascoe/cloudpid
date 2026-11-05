/**
 * The OAuth Client Credentials grant, and `private_key_jwt`: cloudpid's own additions to pi-mcp's `oauth`
 * (`docs/architecture/mcp-sign-in.md` → Client Credentials; The MCP core #394 D6, Signing in #390 D8). Re-exported by
 * `./oauth`, so the Registry reaches it without the SDK.
 *
 * - **Client authentication.** With a secret: `client_secret_post` if the authorization server lists it, else
 *   `client_secret_basic` if listed or if the list is absent, else a problem. With a key (RFC 7523 §2.2): the request
 *   carries `client_assertion_type`, `client_assertion`, `resource` and `scope` and no `client_id`; the assertion is signed
 *   RS256 (RSA, at least 2048 bits) or ES256 (P-256), whichever the key is and the server lists. Its claims are `iss` =
 *   `sub` = the client id, `aud` = the token endpoint of the metadata, `iat`, `exp` = `iat` + 60 s and a 128-bit `jti`,
 *   with the header's `kid` the entry's `keyId`. Every request is sent a fresh assertion.
 * - **Never a secret out.** Nothing here returns, logs or throws the client secret, the private key or an assertion: a
 *   problem says what is wrong with the setup, an outcome names the OAuth error code and the status, and the one
 *   message an authorization server wrote is cut and scrubbed of the values this request sent.
 */
// @effect-diagnostics missingPipeableSignature:off asyncFunction:off preferEffectArray:off globalJsonInEffect:off
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { AuthorizationServerMetadata } from "@earendil-works/pi-mcp/oauth";
import {
  CLIENT_ASSERTION_TYPE,
  isKeyProblem,
  importSigningKey,
  randomJti,
  signClientAssertion,
} from "./client-assertion.ts";
import {
  basicAuthorization,
  boundedText,
  MAX_SIGN_IN_ERROR_LENGTH,
  type OAuthFetch,
  scrubbed,
} from "./oauth-http.ts";

/** What a token response is held to (→ Bounds). */
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;

/** How the client proves itself at the token endpoint. */
export type ClientCredentialsAuth =
  | { readonly kind: "secret"; readonly clientId: string; readonly clientSecret: string }
  | {
      readonly kind: "key";
      readonly clientId: string;
      /** The PKCS#8 PEM. */
      readonly privateKey: string;
      readonly keyId?: string | undefined;
    };

/** The metadata fields client authentication reads, which the metadata's open record leaves unchecked. */
const AuthMetadata = Schema.Struct({
  token_endpoint_auth_methods_supported: Schema.optionalKey(Schema.String.pipe(Schema.Array)),
  token_endpoint_auth_signing_alg_values_supported: Schema.optionalKey(
    Schema.String.pipe(Schema.Array),
  ),
});

const readAuthMetadata = Schema.decodeUnknownOption(AuthMetadata);

/** How a secret is sent, given what the server lists: `client_secret_post`, else `client_secret_basic`, else neither. */
export const secretAuthMethod = (
  metadata: AuthorizationServerMetadata,
): "client_secret_post" | "client_secret_basic" | undefined => {
  const listed = Option.getOrUndefined(
    readAuthMetadata(metadata),
  )?.token_endpoint_auth_methods_supported;

  if (listed?.includes("client_secret_post") === true) return "client_secret_post";

  if (listed === undefined || listed.includes("client_secret_basic")) return "client_secret_basic";

  return undefined;
};

/** Why a request was not sent, a request was refused, or it came to nothing. */
export type ClientCredentialsOutcome =
  /** The setup cannot work, found before any request: what to fix. */
  | { readonly kind: "problem"; readonly message: string }
  | {
      readonly kind: "issued";
      /** `Bearer`, checked. */
      readonly accessToken: string;
      /** Seconds, as the server gave them. */
      readonly expiresIn: number | undefined;
      readonly scope: string | undefined;
      readonly status: number;
    }
  | {
      readonly kind: "refused";
      /** The OAuth error code, a plain token of at most 64 characters (`error` when the server gave none that is). */
      readonly code: string;
      /** The server's description, cut to 300 characters and scrubbed of the values this request sent. */
      readonly message: string;
      readonly status: number;
    }
  | {
      readonly kind: "failed";
      /** What went wrong, with no value the request sent. */
      readonly message: string;
      readonly status: number | undefined;
    };

const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  token_type: Schema.String,
  expires_in: Schema.optionalKey(Schema.Finite),
  scope: Schema.optionalKey(Schema.String),
});

const ErrorResponse = Schema.Struct({
  error: Schema.String,
  error_description: Schema.optionalKey(Schema.String),
});

const decodeToken = Schema.decodeUnknownOption(Schema.fromJsonString(TokenResponse));

const decodeError = Schema.decodeUnknownOption(Schema.fromJsonString(ErrorResponse));

/** A code as a page or span may show it: a plain token of at most 64 characters. */
const plainCode = (text: string): string => (/^[\w.:-]{1,64}$/.test(text) ? text : "error");

/**
 * One `client_credentials` request to `metadata`'s token endpoint through `fetch` (the guarded one: 15 s, bounded). Never
 * rejects: the outcome says what happened. `scope` and `resource` are sent when given; `now` is the epoch milliseconds
 * the assertion's `iat` is made from.
 */
export const requestClientCredentials = async (input: {
  readonly metadata: AuthorizationServerMetadata;
  readonly auth: ClientCredentialsAuth;
  readonly scope?: string | undefined;
  readonly resource?: string | undefined;
  readonly fetch: OAuthFetch;
  readonly now: number;
  /** Defaults to a random 128-bit value; a test fixes it. */
  readonly jti?: string | undefined;
}): Promise<ClientCredentialsOutcome> => {
  const { metadata, auth } = input;
  const endpoint = metadata.token_endpoint;

  const body = new URLSearchParams({ grant_type: "client_credentials" });

  const headers = new Headers({
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  });

  if (input.scope !== undefined) body.set("scope", input.scope);

  if (input.resource !== undefined) body.set("resource", input.resource);

  /** Everything this request carries that must not come back out of an error. */
  const sent: Array<string> = [];

  if (auth.kind === "secret") {
    const method = secretAuthMethod(metadata);

    if (method === undefined) {
      return {
        kind: "problem",
        message:
          "The authorization server lists neither client_secret_post nor client_secret_basic, the two ways to send a client secret",
      };
    }

    sent.push(auth.clientSecret);

    if (method === "client_secret_post") {
      // A server that echoes the form it was sent repeats the secret as it was encoded.
      sent.push(
        new URLSearchParams({ client_secret: auth.clientSecret })
          .toString()
          .slice("client_secret=".length),
      );
      body.set("client_id", auth.clientId);
      body.set("client_secret", auth.clientSecret);
    } else {
      const basic = basicAuthorization(auth.clientId, auth.clientSecret);

      sent.push(basic.slice("Basic ".length));
      headers.set("authorization", basic);
    }
  } else {
    const known = Option.getOrUndefined(readAuthMetadata(metadata));

    if (
      known?.token_endpoint_auth_methods_supported !== undefined &&
      !known.token_endpoint_auth_methods_supported.includes("private_key_jwt")
    ) {
      return {
        kind: "problem",
        message:
          "The authorization server does not list private_key_jwt as a client authentication",
      };
    }

    const signing = await importSigningKey(auth.privateKey);

    if (isKeyProblem(signing)) return { kind: "problem", message: signing.problem };

    const algorithms = known?.token_endpoint_auth_signing_alg_values_supported;

    if (algorithms !== undefined && !algorithms.includes(signing.algorithm)) {
      return {
        kind: "problem",
        message: `The key signs ${signing.algorithm}, which the authorization server does not list for assertions`,
      };
    }

    const assertion = await signClientAssertion({
      signing,
      clientId: auth.clientId,
      audience: endpoint,
      keyId: auth.keyId,
      now: input.now,
      jti: input.jti ?? randomJti(),
    });

    sent.push(assertion);
    body.set("client_assertion_type", CLIENT_ASSERTION_TYPE);
    body.set("client_assertion", assertion);
  }

  try {
    const response = await input.fetch(endpoint, { method: "POST", headers, body });
    const text = await boundedText(response, MAX_TOKEN_RESPONSE_BYTES);

    if (text === undefined) {
      return {
        kind: "failed",
        message: "The token response is longer than 64 KiB",
        status: response.status,
      };
    }

    if (response.ok) {
      const issued = decodeToken(text);

      if (Option.isNone(issued)) {
        return {
          kind: "failed",
          message: "The token response is not a token",
          status: response.status,
        };
      }

      if (issued.value.token_type.toLowerCase() !== "bearer") {
        return {
          kind: "failed",
          message: `The server issued a ${scrubbed(issued.value.token_type, sent, 32)} token, not a Bearer one`,
          status: response.status,
        };
      }

      return {
        kind: "issued",
        accessToken: issued.value.access_token,
        expiresIn: issued.value.expires_in,
        scope: issued.value.scope,
        status: response.status,
      };
    }

    const error = decodeError(text);

    if (Option.isNone(error)) {
      return {
        kind: "refused",
        code: response.status >= 500 ? "server_error" : "error",
        message: `HTTP ${response.status}`,
        status: response.status,
      };
    }

    const code = plainCode(error.value.error);
    const description = error.value.error_description;

    return {
      kind: "refused",
      code,
      message:
        description === undefined || description === ""
          ? code
          : scrubbed(description, sent, MAX_SIGN_IN_ERROR_LENGTH),
      status: response.status,
    };
  } catch (failure) {
    // The message of a fetch failure is the guarded fetch's own, with no body or header in it; it is scrubbed anyway.
    return {
      kind: "failed",
      message: scrubbed(
        failure instanceof Error ? failure.message : "The authorization server did not answer",
        sent,
        MAX_SIGN_IN_ERROR_LENGTH,
      ),
      status: undefined,
    };
  }
};
