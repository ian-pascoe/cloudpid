// The additions `./oauth` makes to pi-mcp's `oauth` (`docs/architecture/mcp-sign-in.md` → Tokens reach the host object (Code),
// Client registration, Sign-out): RFC 7009 revocation, `client_secret_expires_at`, the issuer pin and the size bounds.
// The fakes answer `fetch(url, init)` only.
// @effect-diagnostics asyncFunction:off globalFetch:off preferEffectArray:off
import { describe, expect, it } from "vitest";
import {
  boundedText,
  clientSecretExpiresAt,
  expiresWithin,
  isPinned,
  issuerPinProblem,
  normalizeIssuer,
  type AuthorizationServerMetadata,
  type OAuthFetch,
  REGISTRATION_RENEW_MARGIN_MS,
  revocationEndpoint,
  revokeTokens,
  sameIssuer,
} from "./oauth.ts";

const REFRESH = "refresh-token-9f2c";
const ACCESS = "access-token-77ab";

type MetadataExtras = Partial<
  Record<
    | "revocation_endpoint"
    | "revocation_endpoint_auth_methods_supported"
    | "token_endpoint_auth_methods_supported",
    string | ReadonlyArray<string> | undefined
  >
>;

/** Metadata with `extra` over it; a key given as undefined is absent. */
const metadata = (extra: MetadataExtras = {}): AuthorizationServerMetadata => {
  const merged = {
    issuer: "https://auth.example.com",
    authorization_endpoint: "https://auth.example.com/authorize",
    token_endpoint: "https://auth.example.com/token",
    response_types_supported: ["code"],
    revocation_endpoint: "https://auth.example.com/revoke",
    ...extra,
  };

  // SAFETY: the base holds the required fields, and `extra` only sets the optional ones the revocation code reads.
  return JSON.parse(JSON.stringify(merged)) as AuthorizationServerMetadata;
};

/** What a fake revocation endpoint was asked, in order. */
type Asked = { readonly url: string; readonly headers: Headers; readonly body: URLSearchParams };

const fakeEndpoint = (answer: (asked: Asked) => Response | Promise<Response>) => {
  const asked: Array<Asked> = [];

  const fetch: OAuthFetch = async (input, init) => {
    const request: Asked = {
      url: String(input),
      headers: new Headers(init?.headers),
      body: init?.body instanceof URLSearchParams ? init.body : new URLSearchParams(),
    };

    asked.push(request);

    return answer(request);
  };

  return { fetch, asked };
};

describe("revokeTokens", () => {
  it("revokes the refresh token, then the access token, naming a public client by its id", async () => {
    const { fetch, asked } = fakeEndpoint(() => new Response(null, { status: 200 }));

    const results = await revokeTokens({
      metadata: metadata(),
      client: { client_id: "https://pi.example/oauth/mcp/client.json" },
      refreshToken: REFRESH,
      accessToken: ACCESS,
      fetch,
    });

    expect(results).toEqual([
      { token: "refresh_token", status: "revoked" },
      { token: "access_token", status: "revoked" },
    ]);
    expect(asked.map((each) => each.body.get("token"))).toEqual([REFRESH, ACCESS]);
    expect(asked.map((each) => each.body.get("token_type_hint"))).toEqual([
      "refresh_token",
      "access_token",
    ]);
    expect(asked[0]?.url).toBe("https://auth.example.com/revoke");
    expect(asked[0]?.body.get("client_id")).toBe("https://pi.example/oauth/mcp/client.json");
    expect(asked[0]?.headers.get("authorization")).toBeNull();
  });

  it("does nothing, and says so, when the server advertises no revocation endpoint", async () => {
    const { fetch, asked } = fakeEndpoint(() => new Response(null, { status: 200 }));

    const results = await revokeTokens({
      metadata: metadata({ revocation_endpoint: undefined }),
      client: { client_id: "c" },
      refreshToken: REFRESH,
      fetch,
    });

    expect(results).toBeUndefined();
    expect(asked).toEqual([]);
  });

  it("never sends to an endpoint that is not https", () => {
    expect(
      revocationEndpoint(metadata({ revocation_endpoint: "http://auth.example.com/revoke" })),
    ).toBe(undefined);
    expect(revocationEndpoint(metadata({ revocation_endpoint: "not a url" }))).toBe(undefined);
    expect(revocationEndpoint(metadata())?.href).toBe("https://auth.example.com/revoke");
  });

  it("authenticates a client with a secret by client_secret_post when listed, else client_secret_basic", async () => {
    const post = fakeEndpoint(() => new Response(null, { status: 200 }));
    const basic = fakeEndpoint(() => new Response(null, { status: 200 }));
    const absent = fakeEndpoint(() => new Response(null, { status: 200 }));
    const client = { client_id: "an id", client_secret: "se:cret" };

    await revokeTokens({
      metadata: metadata({
        revocation_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
      }),
      client,
      refreshToken: REFRESH,
      fetch: post.fetch,
    });
    await revokeTokens({
      metadata: metadata({ token_endpoint_auth_methods_supported: ["client_secret_basic"] }),
      client,
      refreshToken: REFRESH,
      fetch: basic.fetch,
    });
    await revokeTokens({
      metadata: metadata(),
      client,
      refreshToken: REFRESH,
      fetch: absent.fetch,
    });

    expect(post.asked[0]?.body.get("client_secret")).toBe("se:cret");
    expect(post.asked[0]?.headers.get("authorization")).toBeNull();

    // RFC 6749 §2.3.1: form-encoded, then Base64: `an+id:se%3Acret`.
    expect(basic.asked[0]?.headers.get("authorization")).toBe(`Basic ${btoa("an+id:se%3Acret")}`);
    expect(basic.asked[0]?.body.get("client_secret")).toBeNull();
    expect(basic.asked[0]?.body.get("client_id")).toBeNull();
    expect(absent.asked[0]?.headers.get("authorization")).toBe(`Basic ${btoa("an+id:se%3Acret")}`);
  });

  it("reports a client authentication the server does not list instead of sending the secret", async () => {
    const { fetch, asked } = fakeEndpoint(() => new Response(null, { status: 200 }));

    const results = await revokeTokens({
      metadata: metadata({ revocation_endpoint_auth_methods_supported: ["private_key_jwt"] }),
      client: { client_id: "c", client_secret: "shh" },
      refreshToken: REFRESH,
      fetch,
    });

    expect(results).toEqual([
      {
        token: "refresh_token",
        status: "failed",
        reason: "no client authentication the server accepts",
      },
    ]);
    expect(asked).toEqual([]);
  });

  it("reports each failure by status, OAuth error code, timeout or network, and goes on to the next token", async () => {
    let calls = 0;

    const { fetch } = fakeEndpoint(() => {
      calls += 1;

      return calls === 1
        ? new Response(`{"error":"unsupported_token_type","error_description":"${REFRESH}"}`, {
            status: 400,
          })
        : new Response("<html>down</html>", { status: 503 });
    });

    const results = await revokeTokens({
      metadata: metadata(),
      client: { client_id: "c" },
      refreshToken: REFRESH,
      accessToken: ACCESS,
      fetch,
    });

    expect(results).toEqual([
      { token: "refresh_token", status: "failed", reason: "unsupported_token_type" },
      { token: "access_token", status: "failed", reason: "HTTP 503" },
    ]);

    const network = await revokeTokens({
      metadata: metadata(),
      client: { client_id: "c" },
      refreshToken: REFRESH,
      fetch: () => Promise.reject(new TypeError(`connect failed for ${REFRESH}`)),
    });

    expect(network).toEqual([
      { token: "refresh_token", status: "failed", reason: "network error" },
    ]);

    const timedOut = await revokeTokens({
      metadata: metadata(),
      client: { client_id: "c" },
      refreshToken: REFRESH,
      fetch: () => Promise.reject(new DOMException("timed out", "TimeoutError")),
    });

    expect(timedOut).toEqual([{ token: "refresh_token", status: "failed", reason: "timed out" }]);
  });

  it("never lets a token reach a result, whatever the server says", async () => {
    const { fetch } = fakeEndpoint(
      () => new Response(`{"error":"${ACCESS} ${REFRESH}"}`, { status: 400 }),
    );

    const results = await revokeTokens({
      metadata: metadata(),
      client: { client_id: "c" },
      refreshToken: REFRESH,
      accessToken: ACCESS,
      fetch,
    });

    expect(JSON.stringify(results)).not.toContain(REFRESH);
    expect(JSON.stringify(results)).not.toContain(ACCESS);
  });
});

describe("the issuer pin", () => {
  it("compares issuers after trimming one trailing slash", () => {
    expect(normalizeIssuer("https://a.example/")).toBe("https://a.example");
    expect(normalizeIssuer("https://a.example//")).toBe("https://a.example/");
    expect(sameIssuer("https://a.example/", "https://a.example")).toBe(true);
    expect(sameIssuer("https://a.example/x", "https://a.example")).toBe(false);
    expect(sameIssuer("https://A.example", "https://a.example")).toBe(false);
  });

  it("refuses an issuer other than the pinned one, and passes the same one or none pinned", () => {
    expect(issuerPinProblem({ issuer: "https://a.example/" }, "https://a.example")).toBeUndefined();
    expect(
      issuerPinProblem({ metadataIssuer: "https://a.example" }, "https://a.example/"),
    ).toBeUndefined();
    expect(issuerPinProblem({}, "https://anything.example")).toBeUndefined();
    expect(issuerPinProblem({ issuer: "https://a.example" }, "https://b.example")).toContain(
      "https://b.example",
    );
  });

  it("needs both pins to agree", () => {
    expect(
      issuerPinProblem(
        { issuer: "https://a.example", metadataIssuer: "https://b.example" },
        "https://a.example",
      ),
    ).toContain("disagree");
    expect(
      issuerPinProblem(
        { issuer: "https://a.example", metadataIssuer: "https://a.example/" },
        "https://a.example",
      ),
    ).toBeUndefined();
    expect(isPinned({})).toBe(false);
    expect(isPinned({ issuer: "https://a.example" })).toBe(true);
    expect(isPinned({ metadataIssuer: "https://a.example" })).toBe(true);
  });
});

describe("client_secret_expires_at", () => {
  it("reads epoch seconds as milliseconds, and 0 or absent as never", () => {
    expect(clientSecretExpiresAt({ client_secret_expires_at: 1_700_000_000 })).toBe(
      1_700_000_000_000,
    );
    expect(clientSecretExpiresAt({ client_secret_expires_at: 0 })).toBeUndefined();
    expect(clientSecretExpiresAt({})).toBeUndefined();
    expect(clientSecretExpiresAt({ client_secret_expires_at: Number.NaN })).toBeUndefined();
  });

  it("counts a secret within 5 min of its expiry as expiring", () => {
    const at = 1_000_000;

    expect(expiresWithin(at, at - REGISTRATION_RENEW_MARGIN_MS - 1)).toBe(false);
    expect(expiresWithin(at, at - REGISTRATION_RENEW_MARGIN_MS)).toBe(true);
    expect(expiresWithin(at, at + 1)).toBe(true);
    expect(expiresWithin(undefined, at)).toBe(false);
  });
});

describe("boundedText", () => {
  it("reads a body within the bound", async () => {
    expect(await boundedText(new Response("hello"), 5)).toBe("hello");
    expect(await boundedText(new Response(null), 5)).toBe("");
  });

  it("gives up on a longer body, declared or streamed", async () => {
    expect(await boundedText(new Response("hello!"), 5)).toBeUndefined();

    const declared = new Response("hi", { headers: { "content-length": "99" } });

    expect(await boundedText(declared, 5)).toBeUndefined();
  });
});
