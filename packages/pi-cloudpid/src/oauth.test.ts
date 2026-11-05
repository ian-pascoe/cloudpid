// @effect-diagnostics preferEffectArray:off asyncFunction:off nodeBuiltinImport:off globalConsole:off -- native array methods over plain values (the bundle carries no Effect runtime); plain Promises, as `fetch` gives them; runs on node, on the owner's machine; replaces `console.warn` to check what the SDK writes there.
/**
 * `/cloudpid`'s OAuth client against a stub authorization server and protected resource (docs/architecture/mcp-endpoint.md
 * → Access and identity; The `/cloudpid` command → The connection): a 401 refreshes and retries, a rotated refresh token
 * is stored before the new access token is used, a refresh that fails asks for a sign-in, and a redirect on a bearer
 * request is read as an expired token, never followed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthEntry, AuthStore } from "./auth-store.ts";
import { type Config, endpointKey } from "./config.ts";
import { connectEndpoint } from "./endpoint.ts";
import { NOT_SIGNED_IN, SIGN_IN_REJECTED, SignInRequired } from "./errors.ts";
import { CloudpidOAuthProvider } from "./oauth.ts";
import { LOGIN_URL, oauthServer, type OAuthStub } from "./oauth.fixture.ts";
import { ENDPOINT_URL, stubEndpoint, tempAuthStore } from "./stub.fixture.ts";

const config: Config = { url: new URL(ENDPOINT_URL) };

const KEY = endpointKey(config);

let auth: ReturnType<typeof tempAuthStore>;
let oauth: OAuthStub;

/** What happened, in order: the store's writes and the requests that carried a bearer token. */
let log: Array<string>;

beforeEach(() => {
  auth = tempAuthStore();
  oauth = oauthServer();
  log = [];
});

afterEach(() => {
  auth.cleanup();
});

/** The store, noting each write of tokens in `log`. */
const loggingStore = (): AuthStore => ({
  read: (endpoint) => auth.store.read(endpoint),
  write: (endpoint, entry) => {
    log.push(
      `stored ${entry.tokens?.access_token ?? "none"} ${entry.tokens?.refresh_token ?? "none"}`,
    );

    return auth.store.write(endpoint, entry);
  },
  remove: (endpoint) => auth.store.remove(endpoint),
});

/** Connects to the stub endpoint, signed in as `login` leaves it, and calls `environments_list` through `call`. */
const connect = async (
  options: {
    readonly signedIn?: boolean;
    /** The test stored its own entry. */ readonly seeded?: boolean;
    readonly onWarning?: (message: string) => void;
  } = {},
) => {
  const stub = stubEndpoint({ oauth });
  const seen: Array<string> = [];

  if (options.signedIn !== false && options.seeded !== true) {
    await auth.store.write(KEY, oauth.signedIn());
  }

  log.length = 0;

  const endpoint = await connectEndpoint(config, {
    store: loggingStore(),
    now: oauth.now,
    sleep: () => Promise.resolve(),
    onWarning: options.onWarning,
    fetch: (url, init) => {
      const bearer = new Headers(init?.headers).get("authorization");
      const host = new URL(String(url)).host;

      seen.push(`${host} ${String(init?.redirect ?? "")}`);

      if (bearer !== null && host === "cloudpid.test")
        log.push(`request ${bearer.slice("Bearer ".length)}`);

      return stub.fetch(url, init);
    },
  });

  return { endpoint, seen, stub };
};

const attempt = async <A>(work: () => Promise<A>): Promise<Error | undefined> => {
  try {
    await work();
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }

  return undefined;
};

describe("a connection with a stored sign-in", () => {
  it("sends the stored access token as a bearer, and nothing else of Access", async () => {
    const { endpoint, stub } = await connect();

    await endpoint.environments();

    expect(new Set(oauth.bearers)).toEqual(new Set(["Bearer access-1"]));
    expect(oauth.tokenRequests).toEqual([]);

    for (const headers of stub.headers) {
      expect(headers.get("cf-access-client-id")).toBeNull();
      expect(headers.get("x-cloudpid-client")).toMatch(/^pi-cloudpid\//);
    }

    await endpoint.close();
  });

  it("on a 401, refreshes, stores the rotated refresh token before using the new access token, and retries", async () => {
    const { endpoint } = await connect();

    oauth.expireAccessTokens();

    const environments = await endpoint.environments();

    expect(environments).toHaveLength(1);
    expect(oauth.tokenRequests.map((request) => request.grantType)).toEqual(["refresh_token"]);
    expect(oauth.tokenRequests[0]?.refreshToken).toBe("refresh-1");
    expect(oauth.tokenRequests[0]?.clientId).toBe("client-seeded");

    // Stored first, used after.
    expect(log.indexOf("stored access-2 refresh-2")).toBeGreaterThanOrEqual(0);
    expect(log.indexOf("stored access-2 refresh-2")).toBeLessThan(log.indexOf("request access-2"));

    const stored = await auth.store.read(KEY);

    expect(stored?.tokens?.refresh_token).toBe("refresh-2");
    expect(stored?.client?.client_id).toBe("client-seeded");
    expect(stored?.obtainedAt).toBe(oauth.now());

    await endpoint.close();
  });

  it("refreshes before the access token expires, so no request is refused, and keeps going across expiries", async () => {
    const { endpoint } = await connect();

    await endpoint.environments();

    // Four minutes and a bit of a five-minute token: inside the margin.
    oauth.advance(241_000);

    await endpoint.environments();

    expect(oauth.tokenRequests.map((request) => request.refreshToken)).toEqual(["refresh-1"]);

    oauth.advance(241_000);

    await endpoint.environments();

    expect(oauth.tokenRequests.map((request) => request.refreshToken)).toEqual([
      "refresh-1",
      "refresh-2",
    ]);
    // No request ever carried a token the endpoint refused: the bearers are the token in use, each time.
    expect(oauth.bearers.every((bearer) => bearer !== null)).toBe(true);
    expect(new Set(oauth.bearers)).toEqual(
      new Set(["Bearer access-1", "Bearer access-2", "Bearer access-3"]),
    );
    expect((await auth.store.read(KEY))?.tokens?.refresh_token).toBe("refresh-3");

    await endpoint.close();
  });

  it("asks for a sign-in when the refresh fails, naming `/cloudpid login`", async () => {
    const { endpoint } = await connect();

    await endpoint.environments();

    oauth.advance(6 * 60_000);
    oauth.refreshFails = true;

    const failure = await attempt(() => endpoint.environments());

    expect(failure).toBeInstanceOf(SignInRequired);
    expect(failure).toHaveProperty("message", SIGN_IN_REJECTED);
    expect(SIGN_IN_REJECTED).toContain("/cloudpid login");
    // The grant is dead: its tokens are not kept, the client registration is.
    const stored = await auth.store.read(KEY);

    expect(stored?.tokens).toBeUndefined();
    expect(stored?.client?.client_id).toBe("client-seeded");

    await endpoint.close();
  });

  it("asks for a sign-in on connect when the grant has ended", async () => {
    await auth.store.write(KEY, oauth.signedIn());
    oauth.advance(6 * 60_000);
    oauth.refreshFails = true;

    const failure = await attempt(() => connect({ seeded: true }));

    expect(failure).toBeInstanceOf(SignInRequired);
    expect(failure).toHaveProperty("message", SIGN_IN_REJECTED);
  });
});

describe("Access answering an expired token with a redirect", () => {
  beforeEach(() => {
    oauth.expiredAnswer = 302;
  });

  it("reads it as an expired token: refreshes and retries, and follows the redirect nowhere", async () => {
    const { endpoint, seen } = await connect();

    oauth.expireAccessTokens();

    await endpoint.environments();

    expect(oauth.tokenRequests.map((request) => request.grantType)).toEqual(["refresh_token"]);
    // The login page was never asked for, and every request kept `redirect: "manual"`.
    expect(seen.some((line) => line.startsWith(new URL(LOGIN_URL).host))).toBe(false);
    expect(seen.every((line) => line.endsWith("manual"))).toBe(true);
    expect(oauth.bearers.at(-1)).toBe("Bearer access-2");

    await endpoint.close();
  });

  it("asks for a sign-in, once, when the refresh cannot help", async () => {
    const { endpoint } = await connect();

    oauth.expireAccessTokens();
    oauth.refreshFails = true;

    const failure = await attempt(() => endpoint.environments());

    expect(failure).toBeInstanceOf(SignInRequired);
    expect(oauth.tokenRequests).toHaveLength(1);

    await endpoint.close();
  });
});

describe("a connection with no stored sign-in", () => {
  it("asks for a sign-in without registering a client, when the endpoint wants one", async () => {
    const failure = await attempt(() => connect({ signedIn: false }));

    expect(failure).toBeInstanceOf(SignInRequired);
    expect(failure).toHaveProperty("message", NOT_SIGNED_IN);
    expect(oauth.registrations).toEqual([]);
    expect(oauth.authorizations).toEqual([]);
    expect(await auth.store.read(KEY)).toBeUndefined();
  });

  it("connects with no token when the endpoint wants none (alchemy dev)", async () => {
    const stub = stubEndpoint();
    const endpoint = await stub.endpoint(config);

    expect(await endpoint.environments()).toHaveLength(1);
    expect(stub.headers.every((headers) => headers.get("authorization") === null)).toBe(true);

    await endpoint.close();
  });
});

describe("the provider", () => {
  const options = (fresh: boolean) => ({
    store: auth.store,
    endpoint: KEY,
    redirectUrl: "http://127.0.0.1:1/callback",
    onRedirect: () => undefined,
    fresh,
    now: oauth.now,
  });

  const held: AuthEntry = {
    client: { client_id: "c", redirect_uris: ["http://127.0.0.1:1/callback"] },
    tokens: { access_token: "old", token_type: "Bearer", expires_in: 300, refresh_token: "keep" },
    obtainedAt: 1,
  };

  it("keeps the refresh token it holds when a refresh does not rotate it", async () => {
    await auth.store.write(KEY, held);

    const provider = new CloudpidOAuthProvider(options(false));

    await provider.load();
    await provider.saveTokens({ access_token: "new", token_type: "Bearer", expires_in: 300 });

    expect((await auth.store.read(KEY))?.tokens).toMatchObject({
      access_token: "new",
      refresh_token: "keep",
    });
  });

  it("forgets what the SDK invalidates, in the store too", async () => {
    await auth.store.write(KEY, {
      ...held,
      discovery: { authorizationServerUrl: "https://a.example.test" },
    });

    const provider = new CloudpidOAuthProvider(options(false));

    await provider.load();
    await provider.invalidateCredentials("tokens");

    expect(await auth.store.read(KEY)).toEqual({
      client: held.client,
      discovery: { authorizationServerUrl: "https://a.example.test" },
    });

    await provider.invalidateCredentials("all");

    expect(await auth.store.read(KEY)).toBeUndefined();
  });

  it("leaves the stored sign-in alone until a fresh sign-in has its tokens", async () => {
    await auth.store.write(KEY, held);

    const provider = new CloudpidOAuthProvider(options(true));

    await provider.load();

    expect(provider.signedIn).toBe(false);

    provider.saveClientInformation({ client_id: "new", redirect_uris: [] });
    await provider.invalidateCredentials("all");
    expect(await auth.store.read(KEY)).toEqual(held);

    await provider.saveTokens({ access_token: "fresh", token_type: "Bearer" });
    expect((await auth.store.read(KEY))?.tokens?.access_token).toBe("fresh");
  });

  it("knows when its access token is about to expire", async () => {
    await auth.store.write(KEY, { ...held, obtainedAt: 1_000_000 });

    const provider = new CloudpidOAuthProvider(options(false));

    await provider.load();

    expect(provider.expiresWithin(60_000, 1_000_000 + 239_000)).toBe(false);
    expect(provider.expiresWithin(60_000, 1_000_000 + 240_000)).toBe(true);
  });
});

describe("a sign-in the endpoint's authorization server no longer knows", () => {
  it.each(["invalid_client", "invalid_grant"] as const)(
    "asks for a sign-in on %s, and registers no client before the owner agrees",
    async (error) => {
      await auth.store.write(KEY, oauth.signedIn());
      oauth.expireAccessTokens();
      oauth.refreshFails = true;
      oauth.refreshError = error;

      const before = await auth.store.read(KEY);
      const failure = await attempt(() => connect({ seeded: true }));

      expect(failure).toBeInstanceOf(SignInRequired);
      expect(oauth.registrations).toEqual([]);
      expect(oauth.authorizations).toEqual([]);

      // What discovery found, and the client, stay (a new sign-in is the owner's to start); only dead tokens go.
      const stored = await auth.store.read(KEY);

      expect(stored?.discovery).toMatchObject(before?.discovery ?? {});
      expect(stored?.client).toEqual(before?.client);

      if (error === "invalid_client") expect(stored?.tokens).toEqual(before?.tokens);
      else expect(stored?.tokens).toBeUndefined();
    },
  );
});

describe("tokens held without a client this authorization server knows", () => {
  it.each([
    ["no client at all", (entry: AuthEntry): AuthEntry => ({ ...entry, client: undefined })],
    [
      "a client of another authorization server",
      (entry: AuthEntry): AuthEntry =>
        entry.client === undefined
          ? entry
          : { ...entry, client: { ...entry.client, issuer: "https://other-auth.example.test" } },
    ],
  ])("asks for a sign-in, and registers nothing, for %s", async (_name, change) => {
    const seeded = change(oauth.signedIn());

    await auth.store.write(KEY, seeded);
    oauth.expireAccessTokens();

    const failure = await attempt(() => connect({ seeded: true }));

    expect(failure).toBeInstanceOf(SignInRequired);
    expect(oauth.registrations).toEqual([]);
    expect(oauth.authorizations).toEqual([]);
    expect(oauth.tokenRequests).toEqual([]);
    // Nothing was dropped or replaced on the way (discovery may be refreshed).
    const stored = await auth.store.read(KEY);

    expect(stored?.tokens).toEqual(seeded.tokens);
    expect(stored?.client).toEqual(seeded.client);
  });
});

describe("the SDK's console warnings", () => {
  it("are kept off the console while connected, handed to the caller, and the console is restored", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const messages: Array<string> = [];

    try {
      await auth.store.write(KEY, oauth.signedIn());
      oauth.expireAccessTokens();
      oauth.refreshFails = true;

      const failure = await attempt(() =>
        connect({ seeded: true, onWarning: (message) => messages.push(message) }),
      );

      expect(failure).toBeInstanceOf(SignInRequired);
      expect(messages.some((message) => message.includes("invalid_grant"))).toBe(true);
      // The SDK says it is invalidating credentials; this provider does not (the owner decides), so that is not passed on.
      expect(messages.some((message) => message.includes("invalidating"))).toBe(false);
      expect(warn.mock.calls.filter(([text]) => String(text).includes("[mcp-sdk]"))).toEqual([]);
      expect(console.warn).toBe(warn);

      // Not the SDK's: it still reaches the console.
      console.warn("something else");

      expect(warn).toHaveBeenCalledWith("something else");
    } finally {
      warn.mockRestore();
    }
  });
});
