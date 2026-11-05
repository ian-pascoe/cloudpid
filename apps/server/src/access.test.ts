/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- claims and the guard are cut down to what a case sets. */
// @effect-diagnostics asyncFunction:off preferEffectArray:off missedPipeableOpportunity:off
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ACCESS_ASSERTION_HEADER,
  AccessCaller,
  admit,
  guardAccess,
  guardFromEnv,
  teamKeys,
  type AccessGuard,
} from "./access.ts";
import { ACCESS_TEAM_DOMAIN, OWNER_EMAIL } from "./deployment.ts";

const MAIN_AUDIENCE = "a".repeat(64);
const MCP_AUDIENCE = "b".repeat(64);
const ISSUER = `https://${ACCESS_TEAM_DOMAIN}`;
const NOW = 1_800_000_000;

const KEY_PARAMS = {
  name: "RSASSA-PKCS1-v1_5",
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: "SHA-256",
} as const;

const base64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

type Claims = {
  readonly iss?: string;
  readonly aud?: string | ReadonlyArray<string>;
  readonly email?: string;
  readonly sub?: string;
  readonly iat?: number;
  readonly nbf?: number;
  readonly exp?: number;
  readonly type?: string;
  readonly common_name?: string | number | null;
  readonly oauth?: { readonly client_id: string };
};

type Header = { readonly alg: string; readonly kid?: string; readonly typ?: string };

const encodeJson = (value: Claims | Header) =>
  base64Url(new TextEncoder().encode(JSON.stringify(value)));

type Pair = { readonly privateKey: CryptoKey; readonly jwks: string };

/** A test team key pair, and the key set the team would publish for it. */
const makeTeamKey = async (kid: string): Promise<Pair> => {
  // SAFETY: RSA parameters make a key pair, which the Workers types do not tell apart from a symmetric key.
  const pair = (await crypto.subtle.generateKey(KEY_PARAMS, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  // SAFETY: the "jwk" format exports a JSON Web Key.

  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;

  return {
    privateKey: pair.privateKey,
    jwks: JSON.stringify({
      keys: [{ kid, kty: "RSA", alg: "RS256", use: "sig", n: jwk.n, e: jwk.e }],
    }),
  };
};

const ownerClaims = () =>
  ({
    iss: ISSUER,
    aud: [MAIN_AUDIENCE],
    email: OWNER_EMAIL,
    sub: "0190f0a8-1b2c-7d3e-8f40-123456789abc",
    iat: NOW - 60,
    nbf: NOW - 60,
    exp: NOW + 3600,
    type: "app",
  }) satisfies Claims;

const sign = async (
  pair: Pair,
  claims: Claims,
  header: Header = { alg: "RS256", kid: "team-key", typ: "JWT" },
) => {
  const signed = `${encodeJson(header)}.${encodeJson(claims)}`;

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    pair.privateKey,
    new TextEncoder().encode(signed),
  );

  return `${signed}.${base64Url(new Uint8Array(signature))}`;
};

let team: Pair;
let stranger: Pair;

beforeAll(async () => {
  team = await makeTeamKey("team-key");
  stranger = await makeTeamKey("team-key");
});

const guard = (overrides: Partial<AccessGuard> = {}): AccessGuard => ({
  audience: MAIN_AUDIENCE,
  localMode: false,
  keys: teamKeys(
    () => Promise.resolve(team.jwks),
    () => NOW * 1000,
  ),
  ...overrides,
});

const HOST = "cloudpid-server-pr-1.ian-g-pascoe.workers.dev";
const TOKEN_CLIENT_ID = "0123456789abcdef.access";

const classify = (assertion: string | undefined) =>
  admit({ assertion, hosts: [HOST], now: NOW }, guard());

/** The same, for a request to `/mcp`: its own audience, and the Local agent's service token. */
const classifyMcp = (assertion: string | undefined, overrides: Partial<AccessGuard> = {}) =>
  admit(
    { assertion, hosts: [HOST], mcp: true, now: NOW },
    guard({ mcp: { audience: MCP_AUDIENCE, serviceToken: TOKEN_CLIENT_ID }, ...overrides }),
  );

const OWNER = { admitted: true, caller: { kind: "owner" } };

describe("the assertion's classification", () => {
  it("admits the owner", async () => {
    expect(await classify(await sign(team, ownerClaims()))).toEqual(OWNER);
  });

  it("admits the owner when the audience is a single string", async () => {
    expect(await classify(await sign(team, { ...ownerClaims(), aud: MAIN_AUDIENCE }))).toEqual(
      OWNER,
    );
  });

  it("refuses an assertion for another application's audience, the MCP endpoint's among them", async () => {
    expect(await classify(await sign(team, { ...ownerClaims(), aud: [MCP_AUDIENCE] }))).toEqual({
      admitted: false,
      reason: "wrong_audience",
    });
    expect(await classify(await sign(team, { ...ownerClaims(), aud: [] }))).toEqual({
      admitted: false,
      reason: "wrong_audience",
    });

    const { aud: _aud, ...withoutAudience } = ownerClaims();

    expect(await classify(await sign(team, withoutAudience))).toEqual({
      admitted: false,
      reason: "wrong_audience",
    });
  });

  it("refuses an expired assertion, and one that expires this second", async () => {
    expect(await classify(await sign(team, { ...ownerClaims(), exp: NOW - 1 }))).toEqual({
      admitted: false,
      reason: "expired",
    });
    expect(await classify(await sign(team, { ...ownerClaims(), exp: NOW }))).toEqual({
      admitted: false,
      reason: "expired",
    });

    const { exp: _exp, ...withoutExpiry } = ownerClaims();

    expect(await classify(await sign(team, withoutExpiry))).toEqual({
      admitted: false,
      reason: "expired",
    });
  });

  it("refuses an assertion that is not valid yet, past a small clock leeway", async () => {
    expect(await classify(await sign(team, { ...ownerClaims(), nbf: NOW + 10 }))).toEqual(OWNER);
    expect(await classify(await sign(team, { ...ownerClaims(), nbf: NOW + 600 }))).toEqual({
      admitted: false,
      reason: "not_yet_valid",
    });
  });

  it("refuses an assertion with a common_name, a service token's, even with the owner's email", async () => {
    const serviceToken = {
      iss: ISSUER,
      aud: [MAIN_AUDIENCE],
      common_name: "0123456789abcdef.access",
      sub: "",
      type: "app",
      iat: NOW - 60,
      exp: NOW + 3600,
    } satisfies Claims;

    expect(await classify(await sign(team, serviceToken))).toEqual({
      admitted: false,
      reason: "common_name",
    });
    expect(await classify(await sign(team, { ...serviceToken, email: OWNER_EMAIL }))).toEqual({
      admitted: false,
      reason: "common_name",
    });
    expect(await classify(await sign(team, { ...ownerClaims(), common_name: "" }))).toEqual({
      admitted: false,
      reason: "common_name",
    });
    expect(await classify(await sign(team, { ...ownerClaims(), common_name: null }))).toEqual({
      admitted: false,
      reason: "common_name",
    });
  });

  it("refuses a request without an assertion", async () => {
    expect(await classify(undefined)).toEqual({ admitted: false, reason: "missing" });
    expect(await classify("")).toEqual({ admitted: false, reason: "missing" });
  });

  it("refuses anyone but the owner", async () => {
    expect(
      await classify(await sign(team, { ...ownerClaims(), email: "someone@example.com" })),
    ).toEqual({
      admitted: false,
      reason: "not_owner",
    });
    expect(
      await classify(await sign(team, { ...ownerClaims(), email: OWNER_EMAIL.toUpperCase() })),
    ).toEqual({ admitted: false, reason: "not_owner" });

    const { email: _email, ...withoutEmail } = ownerClaims();

    expect(await classify(await sign(team, withoutEmail))).toEqual({
      admitted: false,
      reason: "not_owner",
    });
  });

  it("refuses another team's assertion", async () => {
    expect(
      await classify(
        await sign(team, { ...ownerClaims(), iss: "https://other.cloudflareaccess.com" }),
      ),
    ).toEqual({
      admitted: false,
      reason: "wrong_issuer",
    });
  });

  it("refuses a signature the team's key did not make, and a changed payload", async () => {
    expect(await classify(await sign(stranger, ownerClaims()))).toEqual({
      admitted: false,
      reason: "bad_signature",
    });

    const [header, , signature] = (await sign(team, ownerClaims())).split(".");
    const forged = `${header}.${encodeJson({ ...ownerClaims(), exp: NOW + 10 ** 9 })}.${signature}`;

    expect(await classify(forged)).toEqual({ admitted: false, reason: "bad_signature" });
  });

  it("refuses an algorithm Access does not sign with, and a key the team does not have", async () => {
    const unsigned = `${encodeJson({ alg: "none", kid: "team-key" })}.${encodeJson(ownerClaims())}.`;

    expect(await classify(unsigned)).toEqual({ admitted: false, reason: "unsupported_algorithm" });
    expect(
      await classify(await sign(team, ownerClaims(), { alg: "RS256", kid: "other-key" })),
    ).toEqual({ admitted: false, reason: "unknown_key" });
    expect(await classify(await sign(team, ownerClaims(), { alg: "RS256" }))).toEqual({
      admitted: false,
      reason: "unknown_key",
    });
  });

  it.each(["not-a-jwt", "a.b", "a.b.c.d", "!!!.!!!.!!!"])(
    "refuses %s as malformed",
    async (value) => {
      expect((await classify(value)).admitted).toBe(false);
    },
  );

  it("refuses everything when the Worker has no audience", async () => {
    const assertion = await sign(team, ownerClaims());

    expect(
      await admit(
        { assertion, hosts: ["cloudpid-server-pr-1.ian-g-pascoe.workers.dev"], now: NOW },
        guard({ audience: undefined }),
      ),
    ).toEqual({
      admitted: false,
      reason: "not_configured",
    });
    expect(
      await admit({ assertion, hosts: ["x.workers.dev"], now: NOW }, guard({ audience: "" })),
    ).toEqual({
      admitted: false,
      reason: "not_configured",
    });
  });

  it("refuses, rather than failing, when a lookup or a verification throws", async () => {
    const assertion = await sign(team, ownerClaims());
    const request = { assertion, hosts: ["x.workers.dev"], now: NOW };

    expect(await admit(request, guard({ keys: () => Promise.reject(new Error("boom")) }))).toEqual({
      admitted: false,
      reason: "error",
    });

    // A key that is not a verification key: `verify` throws.
    const signingOnly = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
    ]);

    expect(
      // SAFETY: an HMAC key, not a key pair.
      await admit(request, guard({ keys: () => Promise.resolve(signingOnly as CryptoKey) })),
    ).toEqual({ admitted: false, reason: "error" });
  });

  it("refuses when the team's keys cannot be read", async () => {
    const down = guard({
      keys: teamKeys(
        () => Promise.reject(new Error("offline")),
        () => NOW * 1000,
      ),
    });

    expect(
      await admit(
        { assertion: await sign(team, ownerClaims()), hosts: ["x.workers.dev"], now: NOW },
        down,
      ),
    ).toEqual({ admitted: false, reason: "unknown_key" });
  });
});

describe("the MCP endpoint's classification", () => {
  const mcpClaims = () => ({ ...ownerClaims(), aud: [MCP_AUDIENCE] });

  const tokenClaims = () =>
    ({
      iss: ISSUER,
      aud: [MCP_AUDIENCE],
      common_name: TOKEN_CLIENT_ID,
      sub: "",
      type: "app",
      iat: NOW - 60,
      exp: NOW + 3600,
    }) satisfies Claims;

  it("admits the owner on the MCP endpoint's audience, and carries the OAuth registration", async () => {
    expect(await classifyMcp(await sign(team, mcpClaims()))).toEqual(OWNER);
    expect(
      await classifyMcp(await sign(team, { ...mcpClaims(), oauth: { client_id: "dcr-1" } })),
    ).toEqual({ admitted: true, caller: { kind: "owner", clientId: "dcr-1" } });
  });

  it("admits the Local agent's service token, by its client id", async () => {
    expect(await classifyMcp(await sign(team, tokenClaims()))).toEqual({
      admitted: true,
      caller: { kind: "service_token", clientId: TOKEN_CLIENT_ID },
    });
    expect(
      await classifyMcp(
        await sign(team, {
          iss: ISSUER,
          aud: [MCP_AUDIENCE],
          common_name: TOKEN_CLIENT_ID,
          iat: NOW - 60,
          exp: NOW + 3600,
        }),
      ),
    ).toEqual({
      admitted: true,
      caller: { kind: "service_token", clientId: TOKEN_CLIENT_ID },
    });
  });

  it.each([
    ["another token's client id", { common_name: "other.access" }],
    ["an email", { email: OWNER_EMAIL }],
    ["a user's id", { sub: "0190f0a8-1b2c-7d3e-8f40-123456789abc" }],
    ["a non-string common_name", { common_name: 7 }],
  ])("refuses a service token's assertion with %s", async (_name, claims) => {
    expect(await classifyMcp(await sign(team, { ...tokenClaims(), ...claims }))).toEqual({
      admitted: false,
      reason: "not_service_token",
    });
  });

  it("refuses a token when the Worker was not given the token's client id", async () => {
    const mcp = { audience: MCP_AUDIENCE, serviceToken: undefined };

    expect(await classifyMcp(await sign(team, tokenClaims()), { mcp })).toEqual({
      admitted: false,
      reason: "common_name",
    });
    expect(
      await classifyMcp(await sign(team, tokenClaims()), { mcp: { ...mcp, serviceToken: "" } }),
    ).toEqual({ admitted: false, reason: "common_name" });
  });

  it("refuses an assertion for the main application's audience, both ways round", async () => {
    expect(await classifyMcp(await sign(team, ownerClaims()))).toEqual({
      admitted: false,
      reason: "wrong_audience",
    });
    expect(await classify(await sign(team, mcpClaims()))).toEqual({
      admitted: false,
      reason: "wrong_audience",
    });
  });

  // Seen on prod once the owner had signed in to the MCP endpoint's application (managed OAuth) as well as the main one:
  // the owner's assertions on both routes listed both audiences (#419 had seen one `aud` on `/mcp`).
  it("admits the owner's assertion that lists both audiences, on a main route and on /mcp alike", async () => {
    const both = { aud: [MAIN_AUDIENCE, MCP_AUDIENCE] };

    const main = await admit(
      { assertion: await sign(team, { ...ownerClaims(), ...both }), hosts: [HOST], now: NOW },
      guard({ mcp: { audience: MCP_AUDIENCE, serviceToken: TOKEN_CLIENT_ID } }),
    );

    expect(main).toEqual(OWNER);
    expect(await classifyMcp(await sign(team, { ...mcpClaims(), ...both }))).toEqual(OWNER);
    expect(
      await classifyMcp(
        await sign(team, { ...mcpClaims(), ...both, oauth: { client_id: "dcr-1" } }),
      ),
    ).toEqual({ admitted: true, caller: { kind: "owner", clientId: "dcr-1" } });
    expect(await classifyMcp(await sign(team, { ...tokenClaims(), ...both }))).toEqual({
      admitted: true,
      caller: { kind: "service_token", clientId: TOKEN_CLIENT_ID },
    });
  });

  it("still refuses a service token on a main route when its assertion lists both audiences", async () => {
    const both = { aud: [MAIN_AUDIENCE, MCP_AUDIENCE] };

    const main = await admit(
      { assertion: await sign(team, { ...tokenClaims(), ...both }), hosts: [HOST], now: NOW },
      guard({ mcp: { audience: MCP_AUDIENCE, serviceToken: TOKEN_CLIENT_ID } }),
    );

    expect(main).toEqual({ admitted: false, reason: "common_name" });
  });

  it("refuses a service token on any route but the MCP endpoint's", async () => {
    expect(await classify(await sign(team, { ...tokenClaims(), aud: [MAIN_AUDIENCE] }))).toEqual({
      admitted: false,
      reason: "common_name",
    });
  });

  it("refuses an unsigned or stranger's assertion, and a Worker without the MCP audience", async () => {
    expect(await classifyMcp(undefined)).toEqual({ admitted: false, reason: "missing" });
    expect(await classifyMcp(await sign(stranger, mcpClaims()))).toEqual({
      admitted: false,
      reason: "bad_signature",
    });
    expect(
      await classifyMcp(await sign(team, mcpClaims()), {
        mcp: { audience: undefined, serviceToken: TOKEN_CLIENT_ID },
      }),
    ).toEqual({ admitted: false, reason: "not_configured" });
    expect(
      await classifyMcp(await sign(team, mcpClaims()), {
        audience: MAIN_AUDIENCE,
        mcp: undefined,
      } as never),
    ).toEqual({
      admitted: false,
      reason: "not_configured",
    });
  });
});

describe("local mode (alchemy dev)", () => {
  const local = guard({ audience: undefined, localMode: true });

  it.each(["localhost:1337", "localhost:5173", "127.0.0.1:1337", "[::1]:1337", "LOCALHOST"])(
    "admits the owner on the loopback host %s, with no assertion",
    async (host) => {
      expect(await admit({ assertion: undefined, hosts: [host], now: NOW }, local)).toEqual({
        admitted: true,
        caller: { kind: "local" },
      });
    },
  );

  it.each([
    ["a LAN address", ["192.168.1.5:1337"]],
    ["a tunnel", ["abc.trycloudflare.com"]],
    ["a deployed host", ["cloudpid-server-pr-1.ian-g-pascoe.workers.dev"]],
    ["a look-alike", ["localhost.evil.test"]],
    ["a loopback Host over a foreign URL", ["localhost:1337", "evil.test"]],
    ["userinfo that reads as localhost", ["evil.test@localhost"]],
    ["userinfo before an evil host", ["localhost:1337@evil.test"]],
    ["a path", ["localhost/evil"]],
    ["a trailing dot", ["localhost."]],
    ["no host", []],
  ])("refuses %s even in local mode", async (_name, hosts) => {
    expect(await admit({ assertion: undefined, hosts, now: NOW }, local)).toEqual({
      admitted: false,
      reason: "not_local",
    });
  });

  it("does not treat a loopback host as the owner on a deployed Worker", async () => {
    expect(
      await admit({ assertion: undefined, hosts: ["localhost:1337"], now: NOW }, guard()),
    ).toEqual({
      admitted: false,
      reason: "missing",
    });
  });
});

describe("the guard's vars", () => {
  it("are read from the Worker's environment as strings", () => {
    expect(guardFromEnv({ CLOUDPID_ACCESS_AUD: "an-aud" })).toMatchObject({
      audience: "an-aud",
      localMode: false,
    });
    expect(guardFromEnv({ CLOUDPID_LOCAL_MODE: "true" })).toMatchObject({
      audience: undefined,
      localMode: true,
    });
    expect(
      guardFromEnv({
        CLOUDPID_MCP_ACCESS_AUD: "mcp-aud",
        MCP_SERVICE_TOKEN_CLIENT_ID: "id.access",
      }).mcp,
    ).toEqual({ audience: "mcp-aud", serviceToken: "id.access" });
  });

  it.each(["false", "1", "True", "", "yes"])(
    "do not put the Worker in local mode for %j",
    (value) => {
      expect(guardFromEnv({ CLOUDPID_LOCAL_MODE: value }).localMode).toBe(false);
    },
  );

  it("put nothing in local mode when the var is absent", () => {
    expect(guardFromEnv({})).toMatchObject({ audience: undefined, localMode: false });
  });
});

describe("the team's keys", () => {
  it("are read once, and kept", async () => {
    const load = vi.fn(() => Promise.resolve(team.jwks));
    const keys = teamKeys(load, () => NOW * 1000);

    expect(await keys("team-key")).toBeDefined();
    expect(await keys("team-key")).toBeDefined();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("are read again for an unknown key, but only once a minute", async () => {
    let clock = NOW * 1000;
    const load = vi.fn(() => Promise.resolve(team.jwks));
    const keys = teamKeys(load, () => clock);

    expect(await keys("team-key")).toBeDefined();
    expect(await keys("made-up")).toBeUndefined();
    expect(await keys("made-up")).toBeUndefined();
    expect(load).toHaveBeenCalledTimes(1);

    clock += 61_000;
    expect(await keys("made-up")).toBeUndefined();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("are not trusted past an hour once they cannot be read again", async () => {
    let clock = NOW * 1000;
    let up = true;

    const keys = teamKeys(
      () => (up ? Promise.resolve(team.jwks) : Promise.reject(new Error("offline"))),
      () => clock,
    );

    expect(await keys("team-key")).toBeDefined();

    up = false;
    clock += 30 * 60_000;
    expect(await keys("team-key")).toBeDefined();

    clock += 31 * 60_000;
    expect(await keys("team-key")).toBeUndefined();

    up = true;
    clock += 10_000;
    expect(await keys("team-key")).toBeDefined();
  });

  it("answer concurrent lookups of a cold start, each reading for itself: a read is not shared across requests", async () => {
    const load = vi.fn(() => Promise.resolve(team.jwks));
    const keys = teamKeys(load, () => NOW * 1000);
    const found = await Promise.all([keys("team-key"), keys("team-key"), keys("team-key")]);

    expect(found.every((key) => key !== undefined)).toBe(true);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("skip a key that is not RSA or is incomplete, and keep the others", async () => {
    const mixed = JSON.stringify({
      keys: [
        { kid: "ec", kty: "EC", crv: "P-256", x: "x", y: "y" },
        { kid: "broken", kty: "RSA" },
        "not a key",
        ...JSON.parse(team.jwks).keys,
      ],
    });

    const keys = teamKeys(
      () => Promise.resolve(mixed),
      () => NOW * 1000,
    );

    expect(await keys("team-key")).toBeDefined();
    expect(await keys("ec")).toBeUndefined();
    expect(await keys("broken")).toBeUndefined();
  });

  it("find nothing in a body that is not a key set", async () => {
    const keys = teamKeys(
      () => Promise.resolve("<html>"),
      () => NOW * 1000,
    );

    expect(await keys("team-key")).toBeUndefined();
  });
});

describe("the guard on a request", () => {
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  const inner = vi.fn(() => Effect.succeed(HttpServerResponse.text("inside")));

  const run = (request: Request, overrides: Partial<AccessGuard> = {}) =>
    Effect.runPromise(
      guardAccess(guard(overrides))(Effect.suspend(inner)).pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(request),
        ),
      ),
    );

  it("runs the route for the owner", async () => {
    inner.mockClear();

    const response = await run(
      new Request("https://cloudpid-server-pr-1.ian-g-pascoe.workers.dev/rpc", {
        method: "POST",
        headers: { [ACCESS_ASSERTION_HEADER]: await sign(team, ownerClaims()) },
      }),
    );

    expect(response.status).toBe(200);
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it("gives the route the caller on /mcp, with its audience", async () => {
    const seen = vi.fn();

    const response = await Effect.runPromise(
      guardAccess(guard({ mcp: { audience: MCP_AUDIENCE, serviceToken: TOKEN_CLIENT_ID } }))(
        Effect.gen(function* () {
          seen(yield* AccessCaller);

          return HttpServerResponse.text("inside");
        }),
      ).pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(
            new Request("https://x.workers.dev/mcp", {
              method: "POST",
              headers: {
                [ACCESS_ASSERTION_HEADER]: await sign(team, {
                  ...ownerClaims(),
                  aud: [MCP_AUDIENCE],
                }),
              },
            }),
          ),
        ),
      ),
    );

    expect(response.status).toBe(200);
    expect(seen).toHaveBeenCalledWith({ kind: "owner" });
  });

  it("refuses the main audience on /mcp, and the MCP audience elsewhere", async () => {
    inner.mockClear();

    const mcp = { audience: MCP_AUDIENCE, serviceToken: TOKEN_CLIENT_ID };
    const main = await sign(team, ownerClaims());
    const other = await sign(team, { ...ownerClaims(), aud: [MCP_AUDIENCE] });

    const onMcp = await run(
      new Request("https://x.workers.dev/mcp", { headers: { [ACCESS_ASSERTION_HEADER]: main } }),
      { mcp },
    );

    const onMain = await run(
      new Request("https://x.workers.dev/rpc", { headers: { [ACCESS_ASSERTION_HEADER]: other } }),
      { mcp },
    );

    expect([onMcp.status, onMain.status]).toEqual([403, 403]);
    expect(inner).not.toHaveBeenCalled();
  });

  it("refuses a fetch through a service binding, which carries no assertion, without running the route", async () => {
    inner.mockClear();

    for (const path of ["/", "/rpc", "/sessions/0190f0a8-1b2c-7d3e-8f40-123456789abc/socket"]) {
      const response = await run(
        new Request(`https://cloudpid-server-pr-1.ian-g-pascoe.workers.dev${path}`, {
          method: "POST",
        }),
      );

      expect(response.status).toBe(403);
    }

    expect(inner).not.toHaveBeenCalled();
  });

  it("answers 403, not a defect, when the check itself throws", async () => {
    inner.mockClear();

    const response = await run(
      new Request("https://x.workers.dev/", {
        headers: { [ACCESS_ASSERTION_HEADER]: await sign(team, ownerClaims()) },
      }),
      { keys: () => Promise.reject(new Error("boom")) },
    );

    expect(response.status).toBe(403);
    expect(inner).not.toHaveBeenCalled();
  });

  it("answers a refusal with a bare 403 that gives no reason", async () => {
    const response = await run(
      new Request("https://x.workers.dev/", {
        headers: {
          [ACCESS_ASSERTION_HEADER]: await sign(team, { ...ownerClaims(), aud: [MCP_AUDIENCE] }),
        },
      }),
    );

    expect(response.status).toBe(403);
    expect(response.headers["cache-control"]).toBe("no-store");
  });
});
