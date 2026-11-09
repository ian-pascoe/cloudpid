// What a start puts in an authorization request (`docs/architecture/mcp-sign-in.md` → Client registration, Starting and
// completing a sign-in).
// @effect-diagnostics preferEffectArray:off
import type { AuthorizationServerMetadata } from "@cloudpid/mcp/oauth";
import * as Result from "effect/Result";
import { describe, expect, it } from "vitest";
import {
  authorizationUrl,
  clientDocument,
  pkceChallenge,
  randomToken,
  safeReturnPath,
  WELL_FORMED_STATE,
} from "./sign-in-client.ts";
import { dcrRedirectUri } from "./sign-in-origin.ts";

const ORIGIN = "https://cloudpid-server-pr-450.ian-g-pascoe.workers.dev";

describe("the client document", () => {
  it("names itself as the client id and the callback as its one redirect URI", () => {
    expect(clientDocument({ origin: ORIGIN, clientName: "cloudpid (pr-450)" })).toEqual({
      client_id: `${ORIGIN}/oauth/mcp/client.json`,
      client_name: "cloudpid (pr-450)",
      redirect_uris: [`${ORIGIN}/oauth/mcp/callback`],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "web",
    });
  });
});

describe("the DCR redirect URI", () => {
  it("is the callback when the server advertises iss", () => {
    expect(
      dcrRedirectUri({ origin: ORIGIN, issuer: "https://as.example", advertisesIss: true }),
    ).toBe(`${ORIGIN}/oauth/mcp/callback`);
  });

  it("carries the issuer's 12-character hash when it does not", () => {
    const uri = dcrRedirectUri({
      origin: ORIGIN,
      issuer: "https://as.example",
      advertisesIss: false,
    });

    const other = dcrRedirectUri({
      origin: ORIGIN,
      issuer: "https://other.example",
      advertisesIss: false,
    });

    expect(uri).toMatch(new RegExp(`^${ORIGIN}/oauth/mcp/callback/[0-9a-f]{12}$`));
    expect(other).not.toBe(uri);
  });
});

describe("PKCE", () => {
  it("makes the S256 challenge of RFC 7636 appendix B", () => {
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });
});

describe("random tokens", () => {
  it("are 43 URL-safe characters, and differ", () => {
    const tokens = Array.from({ length: 50 }, () => randomToken());

    expect(tokens.every((token) => WELL_FORMED_STATE.test(token))).toBe(true);
    expect(new Set(tokens).size).toBe(50);
  });

  it.each(["short", "a".repeat(44), `${"a".repeat(42)}\n`])(
    "are not what a state %j looks like",
    (state) => {
      expect(WELL_FORMED_STATE.test(state)).toBe(false);
    },
  );
});

const metadata = (
  over: Partial<AuthorizationServerMetadata> = {},
): AuthorizationServerMetadata => ({
  issuer: "https://as.example",
  authorization_endpoint: "https://as.example/authorize",
  token_endpoint: "https://as.example/token",
  response_types_supported: ["code"],
  code_challenge_methods_supported: ["S256"],
  ...over,
});

const withoutMethods = ({
  code_challenge_methods_supported: _methods,
  ...rest
}: AuthorizationServerMetadata): AuthorizationServerMetadata => rest;

const request = (over: Partial<Parameters<typeof authorizationUrl>[0]> = {}) => ({
  metadata: metadata(),
  clientId: `${ORIGIN}/oauth/mcp/client.json`,
  redirectUri: `${ORIGIN}/oauth/mcp/callback`,
  scope: undefined,
  state: "s".repeat(43),
  codeChallenge: "c".repeat(43),
  resource: undefined,
  ...over,
});

const urlOf = (result: Result.Result<URL, string>): URL => {
  if (Result.isFailure(result)) throw new Error(result.failure);

  return result.success;
};

describe("the authorization URL", () => {
  it("carries the code flow, the client, the redirect, the state and the S256 challenge", () => {
    const url = urlOf(authorizationUrl(request()));
    const query = url.searchParams;

    expect(`${url.origin}${url.pathname}`).toBe("https://as.example/authorize");
    expect(query.get("response_type")).toBe("code");
    expect(query.get("client_id")).toBe(`${ORIGIN}/oauth/mcp/client.json`);
    expect(query.get("redirect_uri")).toBe(`${ORIGIN}/oauth/mcp/callback`);
    expect(query.get("state")).toBe("s".repeat(43));
    expect(query.get("code_challenge")).toBe("c".repeat(43));
    expect(query.get("code_challenge_method")).toBe("S256");
    expect(query.has("scope")).toBe(false);
    expect(query.has("resource")).toBe(false);
    expect(query.has("prompt")).toBe(false);
  });

  it("adds the scope and the resource, and never forces the consent screen", () => {
    const query = urlOf(
      authorizationUrl(
        request({ scope: "read offline_access", resource: "https://mcp.example/mcp" }),
      ),
    ).searchParams;

    expect(query.get("scope")).toBe("read offline_access");
    expect(query.get("resource")).toBe("https://mcp.example/mcp");
    expect(query.has("prompt")).toBe(false);
  });

  it("keeps the query an endpoint already has", () => {
    const url = urlOf(
      authorizationUrl(
        request({
          metadata: metadata({ authorization_endpoint: "https://as.example/a?tenant=t1" }),
        }),
      ),
    );

    expect(url.searchParams.get("tenant")).toBe("t1");
    expect(url.searchParams.get("response_type")).toBe("code");
  });

  it.each([
    ["no code response type", { response_types_supported: ["token"] }],
    ["no S256", { code_challenge_methods_supported: ["plain"] }],
    ["a non-https endpoint", { authorization_endpoint: "http://as.example/authorize" }],
    ["an endpoint that is no URL", { authorization_endpoint: "not a url" }],
  ])("is refused for %s", (_name, over) => {
    expect(Result.isFailure(authorizationUrl(request({ metadata: metadata(over) })))).toBe(true);
  });

  it("takes a server that lists no PKCE methods", () => {
    expect(
      Result.isSuccess(authorizationUrl(request({ metadata: withoutMethods(metadata()) }))),
    ).toBe(true);
  });
});

describe("the return path", () => {
  it.each(["/", "/settings?tab=mcp#a"])("keeps %s", (path) => {
    expect(safeReturnPath(path)).toBe(path);
  });

  it.each(["//evil.example", "/\\evil.example", "https://evil.example"])("drops %j", (path) => {
    expect(safeReturnPath(path)).toBe(undefined);
  });
});
