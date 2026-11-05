// @effect-diagnostics preferEffectArray:off preferEffectRecord:off asyncFunction:off nodeBuiltinImport:off globalDate:off globalFetch:off -- native array methods over plain values (the bundle carries no Effect runtime); native object methods over plain values; plain Promises, as `fetch` gives them; runs on node, on the owner's machine.
/**
 * A stub of what Access is to `/mcp` (docs/architecture/mcp-endpoint.md → Access and identity): an authorization server
 * (RFC 8414 metadata, Dynamic Client Registration, an authorization endpoint with PKCE `S256`, a token endpoint with
 * rotating refresh tokens; the old refresh token stays usable) and the protected resource in front of the endpoint (a 401
 * with `resource_metadata` for a caller with no bearer, and for one whose token expired either a 401 or a 302 to the login
 * page, as `expiredAnswer` says). The clock is the test's, so an access token expires when a test says.
 */
import { createHash, randomBytes } from "node:crypto";
import type { FetchLike } from "@modelcontextprotocol/client";
import type { AuthEntry } from "./auth-store.ts";
import type { JsonObject } from "./json.ts";

export const AUTH_ORIGIN = "https://auth.cloudpid.test";

export const RESOURCE_METADATA_URL =
  "https://cloudpid.test/.well-known/cloudflare-access-protected-resource/mcp";

export const LOGIN_URL = "https://team.cloudflareaccess.test/login";

const json = (
  status: number,
  body: JsonObject,
  headers: { readonly [name: string]: string } = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const challengeOf = (verifier: string): string =>
  createHash("sha256").update(verifier).digest("base64url");

/** One request the authorization server saw at its token endpoint. */
export interface TokenRequest {
  readonly grantType: string;
  readonly clientId: string;
  readonly refreshToken: string | undefined;
  readonly redirectUri: string | undefined;
}

export interface OAuthOptions {
  /** `expires_in` of the access tokens; Access's is 300. */
  readonly accessTokenSeconds?: number;
}

export interface OAuthStub {
  /** The test's clock, in ms. */
  now: () => number;
  advance: (ms: number) => void;
  /** What the endpoint answers a bearer token it no longer accepts: a 401 (refreshable) or a 302 to its login page. */
  expiredAnswer: 401 | 302;
  /** The token endpoint answers `invalid_grant` to a refresh: the grant has ended. */
  refreshFails: boolean;
  /** The OAuth error a failing refresh answers with: `invalid_grant` (the grant ended) or `invalid_client` (the client is gone). */
  refreshError: "invalid_grant" | "invalid_client";
  /** Called with the body of each request that reaches `/mcp`'s gate, before the gate looks at the token. */
  onMcpRequest: ((body: string) => void) | undefined;
  /** Every URL the gate was asked for, in order. */
  readonly requests: Array<string>;
  /** Dynamic Client Registrations, as received. */
  readonly registrations: Array<{ readonly [field: string]: string | ReadonlyArray<string> }>;
  /** Authorization requests the "browser" made. */
  readonly authorizations: Array<{ readonly clientId: string; readonly state: string }>;
  readonly tokenRequests: Array<TokenRequest>;
  /** The `Authorization` header of every request that reached `/mcp`'s gate. */
  readonly bearers: Array<string | null>;
  /** Wraps the endpoint's fetch with the gate, and answers the authorization server's own URLs. */
  readonly gate: (inner: FetchLike) => FetchLike;
  /** What a browser does with an authorization URL: asks the authorization endpoint, then goes where it redirects. */
  readonly browse: (url: string) => Promise<void>;
  /** A sign-in as `/cloudpid login` leaves it: a registered client and a live token pair, as the store holds them. */
  readonly signedIn: () => AuthEntry;
  /** Revokes the access token (it expires now) without touching its refresh token. */
  readonly expireAccessTokens: () => void;
}

export const oauthServer = (options: OAuthOptions = {}): OAuthStub => {
  let clock = 1_700_000_000_000;
  const ttl = options.accessTokenSeconds ?? 300;
  const clients = new Map<string, ReadonlyArray<string>>();
  const codes = new Map<string, { clientId: string; challenge: string; redirect: string }>();
  const accessTokens = new Map<string, number>();
  const refreshTokens = new Map<string, string>();
  let issued = 0;

  const registrations: OAuthStub["registrations"] = [];
  const authorizations: OAuthStub["authorizations"] = [];
  const tokenRequests: Array<TokenRequest> = [];
  const bearers: Array<string | null> = [];
  const requests: Array<string> = [];

  const stub: OAuthStub = {
    now: () => clock,
    advance: (ms) => {
      clock += ms;
    },
    expiredAnswer: 401,
    refreshFails: false,
    refreshError: "invalid_grant",
    onMcpRequest: undefined,
    requests,
    registrations,
    authorizations,
    tokenRequests,
    bearers,
    gate: (inner) => async (url, init) => {
      const request = new Request(url, init);
      const { host, pathname } = new URL(request.url);

      requests.push(request.url);

      if (
        host === "cloudpid.test" &&
        pathname === "/.well-known/cloudflare-access-protected-resource/mcp"
      ) {
        return json(200, {
          resource: "https://cloudpid.test/mcp",
          authorization_servers: [AUTH_ORIGIN],
          bearer_methods_supported: ["header"],
        });
      }

      if (host === "auth.cloudpid.test") return authorizationServer(request);

      if (host !== "cloudpid.test") return inner(url, init);

      if (stub.onMcpRequest !== undefined) stub.onMcpRequest(await request.clone().text());

      const header = request.headers.get("authorization");

      bearers.push(header);

      const token =
        header?.startsWith("Bearer ") === true ? header.slice("Bearer ".length) : undefined;

      const expires = token === undefined ? undefined : accessTokens.get(token);

      if (expires !== undefined && expires > clock) return inner(url, init);

      if (token !== undefined && stub.expiredAnswer === 302) {
        return new Response(null, { status: 302, headers: { location: LOGIN_URL } });
      }

      return new Response("Unauthorized", {
        status: 401,
        headers: { "www-authenticate": `Bearer resource_metadata="${RESOURCE_METADATA_URL}"` },
      });
    },
    browse: async (url) => {
      const response = await authorizationServer(new Request(url, { redirect: "manual" }));
      const location = response.headers.get("location");

      if (location === null)
        throw new Error(`authorization endpoint answered ${String(response.status)}`);

      // The redirect goes to the loopback server of the sign-in, for real.
      await fetch(location);
    },
    signedIn: () => {
      clients.set("client-seeded", ["http://127.0.0.1/callback"]);

      return {
        client: {
          client_id: "client-seeded",
          redirect_uris: ["http://127.0.0.1/callback"],
          token_endpoint_auth_method: "none",
          issuer: AUTH_ORIGIN,
        },
        tokens: { ...issue(), issuer: AUTH_ORIGIN },
        obtainedAt: clock,
        // What discovery found when the owner signed in: a refresh needs none (Access serves it away from the host's root).
        discovery: {
          authorizationServerUrl: AUTH_ORIGIN,
          resourceMetadataUrl: RESOURCE_METADATA_URL,
        },
      };
    },
    expireAccessTokens: () => {
      for (const token of accessTokens.keys()) accessTokens.set(token, clock);
    },
  };

  const issue = () => {
    issued += 1;

    const access = `access-${String(issued)}`;
    const refresh = `refresh-${String(issued)}`;

    accessTokens.set(access, clock + ttl * 1000);
    refreshTokens.set(refresh, "client");

    return {
      access_token: access,
      token_type: "Bearer" as const,
      expires_in: ttl,
      refresh_token: refresh,
    };
  };

  const authorizationServer = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return json(200, {
        issuer: AUTH_ORIGIN,
        authorization_endpoint: `${AUTH_ORIGIN}/authorize`,
        token_endpoint: `${AUTH_ORIGIN}/token`,
        registration_endpoint: `${AUTH_ORIGIN}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    }

    if (url.pathname === "/register" && request.method === "POST") {
      const body: { client_name: string; redirect_uris: Array<string> } = JSON.parse(
        await request.text(),
      );

      const clientId = `client-${String(clients.size + 1)}`;

      registrations.push(body);
      clients.set(clientId, body.redirect_uris);

      return json(201, { ...body, client_id: clientId });
    }

    if (url.pathname === "/authorize") {
      const clientId = url.searchParams.get("client_id") ?? "";
      const redirect = url.searchParams.get("redirect_uri") ?? "";
      const challenge = url.searchParams.get("code_challenge") ?? "";
      const state = url.searchParams.get("state") ?? "";

      if (clients.get(clientId)?.includes(redirect) !== true)
        return json(400, { error: "invalid_redirect_uri" });

      if (
        url.searchParams.get("response_type") !== "code" ||
        url.searchParams.get("code_challenge_method") !== "S256" ||
        challenge === ""
      ) {
        return json(400, { error: "invalid_request" });
      }

      const code = randomBytes(16).toString("hex");

      codes.set(code, { clientId, challenge, redirect });
      authorizations.push({ clientId, state });

      return new Response(null, {
        status: 302,
        headers: { location: `${redirect}?code=${code}&state=${encodeURIComponent(state)}` },
      });
    }

    if (url.pathname === "/token" && request.method === "POST") {
      const form = new URLSearchParams(await request.text());
      const grantType = form.get("grant_type") ?? "";
      const clientId = form.get("client_id") ?? "";

      tokenRequests.push({
        grantType,
        clientId,
        refreshToken: form.get("refresh_token") ?? undefined,
        redirectUri: form.get("redirect_uri") ?? undefined,
      });

      if (grantType === "authorization_code") {
        const held = codes.get(form.get("code") ?? "");

        codes.delete(form.get("code") ?? "");

        if (
          held === undefined ||
          held.clientId !== clientId ||
          held.redirect !== form.get("redirect_uri") ||
          challengeOf(form.get("code_verifier") ?? "") !== held.challenge
        ) {
          return json(400, { error: "invalid_grant" });
        }

        return json(200, issue());
      }

      if (grantType === "refresh_token") {
        if (stub.refreshFails) return json(400, { error: stub.refreshError });

        if (!refreshTokens.has(form.get("refresh_token") ?? "")) {
          return json(400, { error: "invalid_grant" });
        }

        // Rotates: a new refresh token with the new access token; the old one stays usable.
        return json(200, issue());
      }
    }

    return json(404, { error: "not_found" });
  };

  return stub;
};
