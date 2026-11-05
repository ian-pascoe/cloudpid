// @effect-diagnostics preferEffectArray:off asyncFunction:off nodeBuiltinImport:off globalFetch:off newPromise:off globalTimers:off -- native array methods over plain values (the bundle carries no Effect runtime); plain Promises, as `fetch` gives them; runs on node, on the owner's machine; the loopback request a browser would make; a browser that opens late.
/**
 * Signing in against a stub authorization server (docs/architecture/mcp-endpoint.md → The `/cloudpid` command → The
 * connection): discovery from the 401's `resource_metadata`, Dynamic Client Registration with a loopback redirect, PKCE
 * `S256` (the stub's token endpoint verifies the verifier), the code arriving at the loopback server (exactly one request
 * with the matching `state`) or pasted, and the entry stored. A fake browser stands where `open` stands in production.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Config, endpointKey } from "./config.ts";
import { Refusal } from "./errors.ts";
import {
  AUTH_ORIGIN,
  oauthServer,
  type OAuthStub,
  RESOURCE_METADATA_URL,
} from "./oauth.fixture.ts";
import { parseRedirect, signIn, type SignInDeps, type SignInUi } from "./signin.ts";
import {
  ENDPOINT_URL,
  scriptedUi,
  stubEndpoint,
  type Stub,
  tempAuthStore,
} from "./stub.fixture.ts";

const config: Config = { url: new URL(ENDPOINT_URL) };

const KEY = endpointKey(config);

let auth: ReturnType<typeof tempAuthStore>;
let oauth: OAuthStub;
let stub: Stub;

beforeEach(() => {
  auth = tempAuthStore();
  oauth = oauthServer();
  stub = stubEndpoint({ oauth, store: auth.store });
});

afterEach(() => {
  auth.cleanup();
});

const deps = (extra: Partial<SignInDeps> = {}): SignInDeps => ({
  store: auth.store,
  fetch: stub.fetch,
  openBrowser: oauth.browse,
  client: "pi-cloudpid/test",
  now: oauth.now,
  ...extra,
});

/** The authorization URL's parameters, which the stub's authorization endpoint reads. */
const paramsOf = (url: string) => new URL(url).searchParams;

describe("parseRedirect", () => {
  it("reads the code from a whole URL, or from its query alone", () => {
    expect(parseRedirect("http://127.0.0.1:5000/callback?code=abc&state=s1", "s1")).toEqual({
      code: "abc",
      iss: undefined,
    });
    expect(
      parseRedirect("  ?code=abc&state=s1&iss=https%3A%2F%2Fauth.example.test ", "s1"),
    ).toEqual({
      code: "abc",
      iss: "https://auth.example.test",
    });
    expect(parseRedirect("code=abc&state=s1", "s1").code).toBe("abc");
  });

  it("refuses a redirect for another state, one with no code, and one the server reported an error on", () => {
    expect(() => parseRedirect("http://127.0.0.1/callback?code=abc&state=other", "s1")).toThrow(
      /state does not match/,
    );
    expect(() => parseRedirect("http://127.0.0.1/callback?code=abc", "s1")).toThrow(
      /state does not match/,
    );
    expect(() => parseRedirect("http://127.0.0.1/callback?state=s1", "s1")).toThrow(
      /no authorization code/,
    );
    expect(() =>
      parseRedirect(
        "http://127.0.0.1/callback?error=access_denied&error_description=No&state=s1",
        "s1",
      ),
    ).toThrow(/access_denied \(No\)/);
    expect(() =>
      parseRedirect("http://127.0.0.1/callback?error=access_denied&state=other", "s1"),
    ).toThrow(/state does not match/);
  });
});

describe("signing in", () => {
  it("registers a client with a loopback redirect, sends PKCE, exchanges the code, and stores the sign-in", async () => {
    const opened: Array<string> = [];
    const ui = scriptedUi({});

    const signedIn = await signIn(
      config,
      ui,
      deps({
        openBrowser: (url) => {
          opened.push(url);

          return oauth.browse(url);
        },
      }),
    );

    expect(signedIn).toBe("signed-in");

    // Dynamic Client Registration: a public client, redirecting to an ephemeral loopback port.
    const [registration] = oauth.registrations;

    expect(oauth.registrations).toHaveLength(1);
    expect(registration).toMatchObject({
      client_name: "pi-cloudpid",
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: "none",
    });
    expect(String(registration?.["redirect_uris"])).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/callback$/,
    );

    // The browser was sent to the authorization endpoint with PKCE S256 and a state.
    const [url] = opened;
    const query = paramsOf(url ?? "http://none");

    expect(opened).toHaveLength(1);
    expect(url).toContain(`${AUTH_ORIGIN}/authorize`);
    expect(query.get("code_challenge_method")).toBe("S256");
    expect(query.get("code_challenge")).toMatch(/^[\w-]{43}$/);
    expect(query.get("state")).toMatch(/^[\w-]{20,}$/);
    expect(query.get("redirect_uri")).toBe(String(registration?.["redirect_uris"]));
    expect(ui.notices[0]?.message).toContain(url);

    // The code exchange: the stub checked the verifier against the S256 challenge, and the redirect URI.
    expect(oauth.tokenRequests).toEqual([
      {
        grantType: "authorization_code",
        clientId: "client-1",
        refreshToken: undefined,
        redirectUri: query.get("redirect_uri"),
      },
    ]);

    // What is stored: the client, the tokens, when they were obtained, and where discovery found the server.
    const stored = await auth.store.read(KEY);

    expect(stored?.client?.client_id).toBe("client-1");
    expect(stored?.tokens?.access_token).toBe("access-1");
    expect(stored?.tokens?.refresh_token).toBe("refresh-1");
    expect(stored?.obtainedAt).toBe(oauth.now());
    expect(stored?.discovery?.resourceMetadataUrl).toBe(RESOURCE_METADATA_URL);
    expect(stored?.discovery?.authorizationServerUrl).toBe(AUTH_ORIGIN);
  });

  it("is refused by the token endpoint when the PKCE verifier is not the challenge's", async () => {
    // The stub is as strict as Access: this is what makes the exchange above a check of PKCE.
    let code = "";

    await signIn(
      config,
      scriptedUi({}),
      deps({
        openBrowser: async (url) => {
          const response = await stub.fetch(url, { redirect: "manual" });

          code =
            new URL(response.headers.get("location") ?? "http://none").searchParams.get("code") ??
            "";

          await fetch(response.headers.get("location") ?? "");
        },
      }),
    );

    const redirect = oauth.registrations[0]?.["redirect_uris"];

    const response = await stub.fetch("https://auth.cloudpid.test/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: "not-the-verifier",
        client_id: "client-1",
        redirect_uri: String(redirect),
      }),
    });

    expect(response.status).toBe(400);
  });

  it("replaces a stored sign-in only once the new one has its tokens", async () => {
    await auth.store.write(KEY, oauth.signedIn());

    const before = await auth.store.read(KEY);

    // Abandoned: no browser, nothing pasted, a short wait.
    await expect(
      signIn(config, scriptedUi({}), deps({ openBrowser: () => Promise.resolve(), timeoutMs: 40 })),
    ).rejects.toThrow(/no sign-in arrived/);
    expect(await auth.store.read(KEY)).toEqual(before);

    await signIn(config, scriptedUi({}), deps());

    const after = await auth.store.read(KEY);

    expect(after?.client?.client_id).not.toBe(before?.client?.client_id);
    expect(after?.tokens?.access_token).not.toBe(before?.tokens?.access_token);
  });

  it("accepts a pasted redirect URL when the browser cannot reach this machine", async () => {
    let located: (url: string) => void = () => undefined;

    const location = new Promise<string>((resolve) => {
      located = resolve;
    });

    const asked: Array<string> = [];

    const ui: SignInUi = {
      notify: () => undefined,
      input: async (title) => {
        asked.push(title);

        return await location;
      },
    };

    // SSH: the browser runs elsewhere, so what the owner pastes is the URL it ended up at.
    const signedIn = await signIn(
      config,
      ui,
      deps({
        openBrowser: async (url) => {
          const response = await stub.fetch(url, { redirect: "manual" });

          located(response.headers.get("location") ?? "");
        },
      }),
    );

    expect(signedIn).toBe("signed-in");
    expect(asked).toEqual(["Sign in to cloudpid"]);
    expect((await auth.store.read(KEY))?.tokens?.access_token).toBe("access-1");
  });

  it("asks again after a paste that is not for this sign-in", async () => {
    let located: (url: string) => void = () => undefined;

    const location = new Promise<string>((resolve) => {
      located = resolve;
    });

    // Two bad pastes, then the right one.
    const pastes = ["not a redirect", "http://127.0.0.1:1/callback?code=x&state=wrong"];
    const warnings: Array<string> = [];

    const ui: SignInUi = {
      notify: (message, type) => {
        if (type === "warning") warnings.push(message);
      },
      input: async () => pastes.shift() ?? (await location),
    };

    await signIn(
      config,
      ui,
      deps({
        openBrowser: async (url) => {
          const response = await stub.fetch(url, { redirect: "manual" });

          located(response.headers.get("location") ?? "");
        },
      }),
    );

    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/state does not match/);
    expect((await auth.store.read(KEY))?.tokens).toBeDefined();
  });

  it("takes exactly one request with the matching state, and refuses one with another", async () => {
    let redirectUri = "";
    let wrongState = 0;

    await signIn(
      config,
      scriptedUi({}),
      deps({
        openBrowser: async (url) => {
          redirectUri = paramsOf(url).get("redirect_uri") ?? "";

          // Another state (a stale tab, someone else on the machine): refused, and the wait goes on.
          wrongState = (await fetch(`${redirectUri}?code=stolen&state=not-the-state`)).status;

          await oauth.browse(url);
        },
      }),
    );

    expect(wrongState).toBe(400);
    expect(oauth.tokenRequests.map((request) => request.grantType)).toEqual(["authorization_code"]);

    // The server is gone once the sign-in is done.
    await expect(fetch(`${redirectUri}?code=again&state=anything`)).rejects.toThrow();
  });

  it("fails when the authorization server reports an error to the redirect", async () => {
    await expect(
      signIn(
        config,
        scriptedUi({}),
        deps({
          openBrowser: async (url) => {
            const redirect = paramsOf(url).get("redirect_uri") ?? "";
            const state = paramsOf(url).get("state") ?? "";

            await fetch(`${redirect}?error=access_denied&state=${state}`);
          },
        }),
      ),
    ).rejects.toThrow(/access_denied/);
    expect(await auth.store.read(KEY)).toBeUndefined();
  });

  it("shows what the authorization server reported as text, never as markup", async () => {
    let page: Promise<string> = Promise.resolve("");

    await expect(
      signIn(
        config,
        scriptedUi({}),
        deps({
          openBrowser: (url) => {
            const redirect = paramsOf(url).get("redirect_uri") ?? "";
            const state = paramsOf(url).get("state") ?? "";

            const description = encodeURIComponent("<script>alert(1)</script>");

            page = fetch(
              `${redirect}?error=access_denied&error_description=${description}&state=${state}`,
            ).then((response) => response.text());

            return Promise.resolve();
          },
        }),
      ),
    ).rejects.toThrow(/access_denied/);

    const body = await page;

    expect(body).not.toContain("<script>");
    expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("lets go of the SDK's warnings when it is done, whether it signed in or not", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await signIn(config, scriptedUi({}), deps());
      expect(console.warn).toBe(warn);

      await expect(
        signIn(
          config,
          scriptedUi({}),
          deps({ openBrowser: () => Promise.resolve(), timeoutMs: 40 }),
        ),
      ).rejects.toThrow(/no sign-in arrived/);
      expect(console.warn).toBe(warn);
    } finally {
      warn.mockRestore();
    }
  });

  it("is cancelled by dismissing the paste prompt", async () => {
    const ui = scriptedUi({ input: [undefined] });

    await expect(
      signIn(config, ui, deps({ openBrowser: () => Promise.resolve() })),
    ).rejects.toThrow(/sign-in cancelled/);
    expect(await auth.store.read(KEY)).toBeUndefined();
  });

  it("says so when the browser cannot be opened, and goes on waiting", async () => {
    const ui = scriptedUi({});

    await signIn(
      config,
      ui,
      deps({
        // The owner opens the URL themselves, a moment later.
        openBrowser: (url) => {
          setTimeout(() => void oauth.browse(url), 20);

          return Promise.reject(new Error("no xdg-open"));
        },
      }),
    );

    expect(
      ui.notices.some(
        (notice) => notice.type === "warning" && notice.message.includes("no xdg-open"),
      ),
    ).toBe(true);
    expect((await auth.store.read(KEY))?.tokens).toBeDefined();
  });

  it("does nothing when the endpoint wants no sign-in", async () => {
    const open = stubEndpoint();

    const signedIn = await signIn(config, scriptedUi({}), deps({ fetch: open.fetch }));

    expect(signedIn).toBe("not-required");
    expect(oauth.registrations).toEqual([]);
    expect(await auth.store.read(KEY)).toBeUndefined();
  });

  it("is a Refusal when the server is not one it can sign in to", async () => {
    // The protected resource's metadata names no authorization server this stub serves.
    const failing = (url: string | URL, init?: RequestInit) =>
      Promise.resolve(
        new URL(String(url)).pathname.includes("authorization-server")
          ? new Response("nope", { status: 500 })
          : undefined,
      ).then((response) => response ?? stub.fetch(url, init));

    const failure = await signIn(config, scriptedUi({}), deps({ fetch: failing })).catch(
      (error: Error) => error,
    );

    expect(failure).toBeInstanceOf(Refusal);
    expect(failure).toHaveProperty("message", expect.stringMatching(/^sign-in failed/));
  });
});
