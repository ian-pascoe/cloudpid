// The Client Credentials grant and `private_key_jwt` (`docs/architecture/mcp-sign-in.md` → Client Credentials): the
// assertion's claims and header, golden; the signature, checked against the public key; the key problems; how a secret or
// an assertion is sent; and that no secret, key or assertion comes back out of an outcome.
// @effect-diagnostics asyncFunction:off globalFetch:off preferEffectArray:off schemaSync:off
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  CLIENT_ASSERTION_TYPE,
  clientAssertionClaims,
  importSigningKey,
  isKeyProblem,
  pemSecrets,
  randomJti,
  requestClientCredentials,
  secretAuthMethod,
  signClientAssertion,
  type AuthorizationServerMetadata,
  type ClientCredentialsAuth,
  type OAuthFetch,
} from "./oauth.ts";

const CLIENT_ID = "cloudpid-prod";
const SECRET = "s3cr3t-value-3f9a";
const TOKEN_ENDPOINT = "https://auth.example.com/oauth2/token";
const NOW = 1_700_000_000_000;
const JTI = "00112233445566778899aabbccddeeff";

const metadata = (
  extra: Partial<Record<string, ReadonlyArray<string>>> = {},
): AuthorizationServerMetadata => ({
  issuer: "https://auth.example.com",
  authorization_endpoint: "https://auth.example.com/authorize",
  token_endpoint: TOKEN_ENDPOINT,
  response_types_supported: ["code"],
  ...extra,
});

const pemOf = (der: ArrayBuffer, label = "PRIVATE KEY"): string => {
  const text = btoa(String.fromCharCode(...new Uint8Array(der)));
  const lines = text.match(/.{1,64}/g) ?? [];

  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
};

/** A key pair; `generateKey` is typed as a key or a pair, and these parameters give a pair. */
const pairOf = async (
  algorithm: Parameters<typeof crypto.subtle.generateKey>[0],
): Promise<{ readonly pem: string; readonly publicKey: CryptoKey }> => {
  const generated = await crypto.subtle.generateKey(algorithm, true, ["sign", "verify"]);

  // SAFETY: an RSA or EC `generateKey` returns a key pair.
  const pair = generated as CryptoKeyPair;
  const der = await crypto.subtle.exportKey("pkcs8", pair.privateKey);

  if (!(der instanceof ArrayBuffer)) throw new Error("pkcs8 exports bytes");

  return { pem: pemOf(der), publicKey: pair.publicKey };
};

const rsaKey = (modulusLength = 2048) =>
  pairOf({
    name: "RSASSA-PKCS1-v1_5",
    modulusLength,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  });

const ecKey = (namedCurve = "P-256") => pairOf({ name: "ECDSA", namedCurve });

const decoder = new TextDecoder();

const fromBase64Url = (text: string): Uint8Array =>
  Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (character) =>
    character.charCodeAt(0),
  );

/** The three parts of a compact JWS: header and payload as written, and the signature's bytes. */
const partsOf = (jws: string) => {
  const [header = "", payload = "", signature = ""] = jws.split(".");

  return {
    header: decoder.decode(fromBase64Url(header)),
    payload: decoder.decode(fromBase64Url(payload)),
    signature: fromBase64Url(signature),
    signingInput: `${header}.${payload}`,
  };
};

const decodeClaims = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ jti: Schema.String })),
);

describe("the assertion's claims", () => {
  it("are iss = sub = the client id, aud = the token endpoint, iat, exp = iat + 60 and the jti (golden)", () => {
    expect(
      JSON.stringify(
        clientAssertionClaims({
          clientId: CLIENT_ID,
          audience: TOKEN_ENDPOINT,
          now: NOW,
          jti: JTI,
        }),
      ),
    ).toBe(
      `{"iss":"cloudpid-prod","sub":"cloudpid-prod","aud":"https://auth.example.com/oauth2/token","iat":1700000000,"exp":1700000060,"jti":"00112233445566778899aabbccddeeff"}`,
    );
  });

  it("take iat from whole seconds of the clock, never rounded up", () => {
    const claims = clientAssertionClaims({
      clientId: "a",
      audience: "b",
      now: 1_700_000_000_999,
      jti: JTI,
    });

    expect(claims.iat).toBe(1_700_000_000);
    expect(claims.exp - claims.iat).toBe(60);
  });

  it("give a 128-bit jti, new each time", () => {
    const first = randomJti();

    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(randomJti()).not.toBe(first);
  });
});

describe("a signed assertion", () => {
  it("is RS256 for an RSA key: the header carries kid, the claims are golden and the signature verifies", async () => {
    const { pem, publicKey } = await rsaKey();
    const signing = await importSigningKey(pem);

    if (isKeyProblem(signing)) throw new Error(signing.problem);

    const jws = await signClientAssertion({
      signing,
      clientId: CLIENT_ID,
      audience: TOKEN_ENDPOINT,
      keyId: "key-2026",
      now: NOW,
      jti: JTI,
    });

    const parts = partsOf(jws);

    expect(parts.header).toBe(`{"alg":"RS256","typ":"JWT","kid":"key-2026"}`);
    expect(parts.payload).toBe(
      `{"iss":"cloudpid-prod","sub":"cloudpid-prod","aud":"https://auth.example.com/oauth2/token","iat":1700000000,"exp":1700000060,"jti":"00112233445566778899aabbccddeeff"}`,
    );
    expect(
      await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        publicKey,
        parts.signature,
        new TextEncoder().encode(parts.signingInput),
      ),
    ).toBe(true);
  });

  it("is ES256 for a P-256 key, with no kid when there is no keyId, and a 64-byte r || s signature", async () => {
    const { pem, publicKey } = await ecKey();
    const signing = await importSigningKey(pem);

    if (isKeyProblem(signing)) throw new Error(signing.problem);

    const jws = await signClientAssertion({
      signing,
      clientId: CLIENT_ID,
      audience: TOKEN_ENDPOINT,
      now: NOW,
      jti: JTI,
    });

    const parts = partsOf(jws);

    expect(parts.header).toBe(`{"alg":"ES256","typ":"JWT"}`);
    expect(parts.signature.byteLength).toBe(64);
    expect(
      await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        publicKey,
        parts.signature,
        new TextEncoder().encode(parts.signingInput),
      ),
    ).toBe(true);
  });
});

describe("a private key", () => {
  const problemOf = async (pem: string) => {
    const found = await importSigningKey(pem);

    return isKeyProblem(found) ? found.problem : "usable";
  };

  it("is refused when it is not PKCS#8, naming the fix and never quoting the key", async () => {
    const { pem } = await rsaKey();
    const body = pem.split("\n").slice(1, -2).join("\n");

    const pkcs1 = `-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----`;
    const sec1 = `-----BEGIN EC PRIVATE KEY-----\n${body}\n-----END EC PRIVATE KEY-----`;
    const encrypted = `-----BEGIN ENCRYPTED PRIVATE KEY-----\n${body}\n-----END ENCRYPTED PRIVATE KEY-----`;

    const problems = [
      await problemOf(pkcs1),
      await problemOf(sec1),
      await problemOf(encrypted),
      await problemOf("not a key"),
    ];

    expect(problems[0]).toMatch(/PKCS#8.*openssl pkcs8 -topk8/);
    expect(problems[1]).toMatch(/EC PRIVATE KEY block/);
    expect(problems[2]).toMatch(/encrypted/);
    expect(problems[3]).toMatch(/not a PEM block/);

    for (const problem of problems) expect(problem).not.toContain(body.slice(0, 30));
  });

  it("is refused when it is RSA under 2048 bits, or a curve other than P-256, or garbage", async () => {
    expect(await problemOf((await rsaKey(1024)).pem)).toMatch(/1024 bits.*at least 2048/);
    expect(await problemOf((await ecKey("P-384")).pem)).toMatch(/neither an RSA key.*nor a P-256/);
    expect(await problemOf("-----BEGIN PRIVATE KEY-----\n@@@@\n-----END PRIVATE KEY-----")).toMatch(
      /Base64/,
    );
    expect(await problemOf("-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----")).toMatch(
      /neither an RSA key/,
    );
  });
});

describe("how a secret is sent", () => {
  it("is client_secret_post when listed, else client_secret_basic when listed or when no list is given, else neither", () => {
    expect(
      secretAuthMethod(
        metadata({
          token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
        }),
      ),
    ).toBe("client_secret_post");
    expect(
      secretAuthMethod(
        metadata({ token_endpoint_auth_methods_supported: ["client_secret_basic"] }),
      ),
    ).toBe("client_secret_basic");
    expect(secretAuthMethod(metadata())).toBe("client_secret_basic");
    expect(
      secretAuthMethod(metadata({ token_endpoint_auth_methods_supported: ["private_key_jwt"] })),
    ).toBeUndefined();
  });
});

type Seen = { url: string; headers: Headers; form: URLSearchParams };

/** A fetch that records what it was sent and answers `answer` (a function of the call's index). */
const recording = (answer: (seen: Seen, index: number) => Response | Error) => {
  const calls: Array<Seen> = [];

  const fetch: OAuthFetch = async (input, init) => {
    const seen: Seen = {
      url: String(input),
      headers: new Headers(init?.headers),
      form: init?.body instanceof URLSearchParams ? init.body : new URLSearchParams(),
    };

    calls.push(seen);

    const result = answer(seen, calls.length - 1);

    if (result instanceof Error) throw result;

    return result;
  };

  return { fetch, calls };
};

const issued = (extra: { scope?: string; token_type?: string } = {}) =>
  new Response(
    JSON.stringify({ access_token: "at-1", token_type: "Bearer", expires_in: 3600, ...extra }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const SECRET_AUTH: ClientCredentialsAuth = {
  kind: "secret",
  clientId: CLIENT_ID,
  clientSecret: SECRET,
};

const send = (
  fetch: OAuthFetch,
  auth: ClientCredentialsAuth,
  meta: AuthorizationServerMetadata = metadata(),
  extra: { scope?: string; resource?: string } = {},
) =>
  requestClientCredentials({
    metadata: meta,
    auth,
    fetch,
    now: NOW,
    jti: JTI,
    ...extra,
  });

describe("the token request with a secret", () => {
  it("posts client_id and client_secret in the body when the server lists client_secret_post", async () => {
    const { fetch, calls } = recording(() => issued({ scope: "read" }));

    const outcome = await send(
      fetch,
      SECRET_AUTH,
      metadata({ token_endpoint_auth_methods_supported: ["client_secret_post"] }),
      { scope: "read write", resource: "https://mcp.example.com/mcp" },
    );

    expect(outcome).toEqual({
      kind: "issued",
      accessToken: "at-1",
      expiresIn: 3600,
      scope: "read",
      status: 200,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(TOKEN_ENDPOINT);
    expect(Record.fromEntries(calls[0]?.form ?? [])).toEqual({
      grant_type: "client_credentials",
      client_id: CLIENT_ID,
      client_secret: SECRET,
      scope: "read write",
      resource: "https://mcp.example.com/mcp",
    });
    expect(calls[0]?.headers.has("authorization")).toBe(false);
  });

  it("sends HTTP Basic, form-encoded, and no client_id in the body, when only basic is listed or no list is given", async () => {
    const { fetch, calls } = recording(() => issued());

    await send(fetch, { kind: "secret", clientId: "a b", clientSecret: "p@ss:w/rd" });

    expect(calls[0]?.headers.get("authorization")).toBe(`Basic ${btoa("a+b:p%40ss%3Aw%2Frd")}`);
    expect(Record.fromEntries(calls[0]?.form ?? [])).toEqual({ grant_type: "client_credentials" });
  });

  it("is a problem, with nothing sent, when the server lists neither way to send a secret", async () => {
    const { fetch, calls } = recording(() => issued());

    const outcome = await send(
      fetch,
      SECRET_AUTH,
      metadata({ token_endpoint_auth_methods_supported: ["private_key_jwt"] }),
    );

    expect(outcome).toMatchObject({ kind: "problem", message: expect.stringContaining("neither") });
    expect(calls).toHaveLength(0);
  });
});

describe("the token request with a key", () => {
  it("carries the assertion, its type, grant_type, resource and scope, and no client_id", async () => {
    const { pem } = await rsaKey();
    const { fetch, calls } = recording(() => issued());

    const outcome = await send(
      fetch,
      { kind: "key", clientId: CLIENT_ID, privateKey: pem, keyId: "k1" },
      metadata({ token_endpoint_auth_methods_supported: ["private_key_jwt"] }),
      { scope: "read", resource: "https://mcp.example.com/mcp" },
    );

    expect(outcome.kind).toBe("issued");

    const form = calls[0]?.form ?? new URLSearchParams();

    expect([...form.keys()].sort()).toEqual([
      "client_assertion",
      "client_assertion_type",
      "grant_type",
      "resource",
      "scope",
    ]);
    expect(form.get("client_assertion_type")).toBe(CLIENT_ASSERTION_TYPE);
    expect(form.get("grant_type")).toBe("client_credentials");
    expect(calls[0]?.headers.has("authorization")).toBe(false);

    const parts = partsOf(form.get("client_assertion") ?? "");

    expect(parts.header).toBe(`{"alg":"RS256","typ":"JWT","kid":"k1"}`);
    expect(parts.payload).toBe(
      `{"iss":"cloudpid-prod","sub":"cloudpid-prod","aud":"${TOKEN_ENDPOINT}","iat":1700000000,"exp":1700000060,"jti":"${JTI}"}`,
    );
  });

  it("makes a fresh assertion for every request", async () => {
    const { pem } = await ecKey();
    const { fetch, calls } = recording(() => issued());

    const input = {
      metadata: metadata(),
      auth: { kind: "key", clientId: CLIENT_ID, privateKey: pem },
    } as const;

    await requestClientCredentials({ ...input, fetch, now: NOW });
    await requestClientCredentials({ ...input, fetch, now: NOW });

    const jtis = calls.map(
      ({ form }) => decodeClaims(partsOf(form.get("client_assertion") ?? "").payload).jti,
    );

    expect(new Set(jtis).size).toBe(2);
    expect(jtis.every((jti) => /^[0-9a-f]{32}$/.test(jti))).toBe(true);
  });

  it("is a problem, with nothing sent, when private_key_jwt is not listed or the key's algorithm is not", async () => {
    const { pem } = await ecKey();
    const { fetch, calls } = recording(() => issued());
    const auth = { kind: "key", clientId: CLIENT_ID, privateKey: pem } as const;

    expect(
      await send(
        fetch,
        auth,
        metadata({ token_endpoint_auth_methods_supported: ["client_secret_basic"] }),
      ),
    ).toMatchObject({ kind: "problem", message: expect.stringContaining("private_key_jwt") });
    expect(
      await send(
        fetch,
        auth,
        metadata({
          token_endpoint_auth_methods_supported: ["private_key_jwt"],
          token_endpoint_auth_signing_alg_values_supported: ["RS256"],
        }),
      ),
    ).toMatchObject({ kind: "problem", message: expect.stringContaining("ES256") });
    expect(calls).toHaveLength(0);
  });

  it("is a problem for a key that cannot sign, and says nothing of the key", async () => {
    const { fetch, calls } = recording(() => issued());

    const outcome = await send(fetch, {
      kind: "key",
      clientId: CLIENT_ID,
      privateKey:
        "-----BEGIN RSA PRIVATE KEY-----\nTOPSECRETKEYBODY\n-----END RSA PRIVATE KEY-----",
    });

    expect(outcome.kind).toBe("problem");
    expect(JSON.stringify(outcome)).not.toContain("TOPSECRETKEYBODY");
    expect(calls).toHaveLength(0);
  });
});

describe("pemSecrets", () => {
  it("is the block as written and its body without armor or whitespace", () => {
    expect(
      pemSecrets("-----BEGIN PRIVATE KEY-----\nAAAA\nBBBB\n-----END PRIVATE KEY-----"),
    ).toEqual(["-----BEGIN PRIVATE KEY-----\nAAAA\nBBBB\n-----END PRIVATE KEY-----", "AAAABBBB"]);
  });
});

describe("what a request comes to", () => {
  it("is refused with the OAuth code, the status and a description scrubbed of the secret", async () => {
    const { fetch } = recording(
      () =>
        new Response(
          JSON.stringify({
            error: "invalid_client",
            error_description: `bad secret ${SECRET} for ${CLIENT_ID}`,
          }),
          { status: 401 },
        ),
    );

    const outcome = await send(fetch, SECRET_AUTH);

    expect(outcome).toEqual({
      kind: "refused",
      code: "invalid_client",
      message: `bad secret [REDACTED] for ${CLIENT_ID}`,
      status: 401,
    });
  });

  it("scrubs the Basic credentials and the assertion the server echoes, and cuts the description at 300", async () => {
    const { pem } = await ecKey();
    let echoed = "";

    const { fetch } = recording((seen) => {
      echoed = seen.form.get("client_assertion") ?? "";

      return new Response(
        JSON.stringify({
          error: "invalid_client",
          error_description: `got ${echoed} ${"x".repeat(400)}`,
        }),
        { status: 400 },
      );
    });

    const outcome = await send(fetch, { kind: "key", clientId: CLIENT_ID, privateKey: pem });

    expect(outcome.kind).toBe("refused");
    expect(JSON.stringify(outcome)).not.toContain(echoed);
    expect(outcome.kind === "refused" && Array.from(outcome.message).length).toBe(300);

    const basic = recording(
      (seen) =>
        new Response(
          JSON.stringify({
            error: "invalid_request",
            error_description: `header ${seen.headers.get("authorization")?.slice(6)}`,
          }),
          { status: 400 },
        ),
    );

    const viaBasic = await send(basic.fetch, SECRET_AUTH);

    expect(JSON.stringify(viaBasic)).not.toContain(btoa(`${CLIENT_ID}:${SECRET}`));
    expect(viaBasic).toMatchObject({ message: "header [REDACTED]" });
  });

  it("scrubs the form-encoded secret client_secret_post sent, as the server may echo the form", async () => {
    const odd = "p@ss word/+=&é";
    const encoded = new URLSearchParams({ x: odd }).toString().slice(2);

    expect(encoded).not.toBe(odd);

    const { fetch } = recording(
      () =>
        new Response(
          JSON.stringify({
            error: "invalid_request",
            error_description: `form client_secret=${encoded} and ${odd}`,
          }),
          { status: 400 },
        ),
    );

    const outcome = await requestClientCredentials({
      metadata: metadata({ token_endpoint_auth_methods_supported: ["client_secret_post"] }),
      auth: { kind: "secret", clientId: CLIENT_ID, clientSecret: odd },
      fetch,
      now: NOW,
    });

    expect(outcome).toMatchObject({ message: "form client_secret=[REDACTED] and [REDACTED]" });
  });

  it("is refused by status when the body is not an OAuth error, a 5xx as server_error", async () => {
    expect(
      await send(
        recording(() => new Response("<html>nope</html>", { status: 502 })).fetch,
        SECRET_AUTH,
      ),
    ).toEqual({ kind: "refused", code: "server_error", message: "HTTP 502", status: 502 });
    expect(
      await send(recording(() => new Response("nope", { status: 403 })).fetch, SECRET_AUTH),
    ).toEqual({ kind: "refused", code: "error", message: "HTTP 403", status: 403 });
  });

  it("takes an error code that is not a plain token as `error`", async () => {
    const outcome = await send(
      recording(
        () => new Response(JSON.stringify({ error: "<script>alert(1)</script>" }), { status: 400 }),
      ).fetch,
      SECRET_AUTH,
    );

    expect(outcome).toMatchObject({ kind: "refused", code: "error" });
  });

  it("fails on a network error, a malformed token response and a token that is not a Bearer one", async () => {
    expect(
      await send(recording(() => new Error(`connect failed with ${SECRET}`)).fetch, SECRET_AUTH),
    ).toEqual({ kind: "failed", message: "connect failed with [REDACTED]", status: undefined });
    expect(
      await send(recording(() => new Response("{}", { status: 200 })).fetch, SECRET_AUTH),
    ).toMatchObject({ kind: "failed", message: "The token response is not a token" });
    expect(
      await send(recording(() => issued({ token_type: "DPoP" })).fetch, SECRET_AUTH),
    ).toMatchObject({ kind: "failed", message: expect.stringContaining("not a Bearer one") });
    expect(
      await send(
        recording(() => new Response("x".repeat(70_000), { status: 200 })).fetch,
        SECRET_AUTH,
      ),
    ).toMatchObject({ kind: "failed", message: "The token response is longer than 64 KiB" });
  });

  it("takes a token with no lifetime as one with none", async () => {
    const outcome = await send(
      recording(() => new Response(JSON.stringify({ access_token: "at-2", token_type: "bearer" })))
        .fetch,
      SECRET_AUTH,
    );

    expect(outcome).toMatchObject({ kind: "issued", accessToken: "at-2", expiresIn: undefined });
  });
});
