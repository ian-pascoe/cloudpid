// @effect-diagnostics asyncFunction:off nodeBuiltinImport:off globalDate:off preferEffectArray:off preferEffectRecord:off -- WebCrypto and `fetch` are Promise APIs; node:crypto makes the test keys.
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GitHubApp, githubAppKeyProblem, type MintedToken } from "./app.ts";

const MINUTE = 60_000;

/** An RSA key pair as GitHub hands an app's out: the private key as PKCS#1 PEM. */
const appKeys = () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });

  return { privateKey, publicKey };
};

const KEYS = appKeys();

const fromBase64 = (text: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

const fromBase64Url = (text: string) => fromBase64(text.replaceAll("-", "+").replaceAll("_", "/"));

const pemBody = (pem: string) => fromBase64(pem.replaceAll(/-----[A-Z ]+-----|\s/g, ""));

/** The claims of `jwt`, once its RS256 signature checks out against the app's public key; throws otherwise. */
const verifiedClaims = async (
  jwt: string,
): Promise<{ readonly iss: string; readonly iat: number; readonly exp: number }> => {
  const [header = "", payload = "", signature = ""] = jwt.split(".");

  const key = await crypto.subtle.importKey(
    "spki",
    pemBody(KEYS.publicKey),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );

  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    fromBase64Url(signature),
    new TextEncoder().encode(`${header}.${payload}`),
  );

  if (!valid) throw new Error("the JWT's signature does not verify");

  expect(JSON.parse(new TextDecoder().decode(fromBase64Url(header)))).toEqual({
    alg: "RS256",
    typ: "JWT",
  });

  return JSON.parse(new TextDecoder().decode(fromBase64Url(payload)));
};

type Seen = {
  readonly method: string;
  readonly url: string;
  readonly auth: string;
  readonly body: string;
};

/**
 * GitHub's API for one app, owned by `ian-pascoe`: its installations, and a token per mint, each living an hour from
 * `now`.
 */
const fakeGitHub = (options: {
  readonly now: () => number;
  readonly installations?: ReadonlyArray<{ readonly id: number; readonly login: string }>;
}) => {
  const seen: Seen[] = [];
  let minted = 0;

  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const headers = new Headers(init.headers);
    const method = init.method ?? "GET";

    seen.push({
      method,
      url,
      auth: headers.get("authorization") ?? "",
      body: await new Response(init.body).text(),
    });

    if (method === "GET" && url === "https://api.github.com/app") {
      return Response.json({ owner: { login: "ian-pascoe" } });
    }

    if (method === "GET" && url === "https://api.github.com/app/installations?per_page=100") {
      const installations = options.installations ?? [{ id: 42, login: "ian-pascoe" }];

      return Response.json(installations.map(({ id, login }) => ({ id, account: { login } })));
    }

    const mint = /^https:\/\/api\.github\.com\/app\/installations\/(\d+)\/access_tokens$/.exec(url);

    if (method === "POST" && mint !== null) {
      minted += 1;

      return Response.json(
        {
          token: `ghs_token${minted}`,
          expires_at: new Date(options.now() + 60 * MINUTE).toISOString(),
        },
        { status: 201 },
      );
    }

    return Response.json({ message: "Not Found" }, { status: 404 });
  };

  return { fetch, seen };
};

describe("GitHubApp", () => {
  it("mints a token for the installation on its own account with a JWT its PKCS#1 key signs", async () => {
    const now = Date.UTC(2026, 0, 1, 12);
    const github = fakeGitHub({ now: () => now });

    const app = new GitHubApp({
      appId: "123456",
      privateKey: KEYS.privateKey,
      fetch: github.fetch,
      now: () => now,
    });

    expect(await app.token()).toBe("ghs_token1");

    expect(github.seen.map(({ method, url }) => `${method} ${url}`)).toEqual([
      "GET https://api.github.com/app",
      "GET https://api.github.com/app/installations?per_page=100",
      "POST https://api.github.com/app/installations/42/access_tokens",
    ]);

    for (const { auth } of github.seen) {
      const claims = await verifiedClaims(auth.replace(/^Bearer /, ""));

      // Backdated a minute for clock drift; GitHub refuses one that lives past ten minutes.
      expect(claims).toEqual({ iss: "123456", iat: now / 1000 - 60, exp: now / 1000 + 9 * 60 });
    }
  });

  it("keeps a token until less than 45 minutes are left, and lists the ones that have not expired", async () => {
    let now = Date.UTC(2026, 0, 1, 12);
    const github = fakeGitHub({ now: () => now });

    const app = new GitHubApp({
      appId: "1",
      privateKey: KEYS.privateKey,
      fetch: github.fetch,
      now: () => now,
    });

    expect(await app.token()).toBe("ghs_token1");

    now += 15 * MINUTE;
    expect(await app.token()).toBe("ghs_token1");

    now += 1;
    expect(await app.token()).toBe("ghs_token2");
    expect(app.live()).toEqual(["ghs_token1", "ghs_token2"]);

    // The installations are listed again once the list is five minutes old.
    expect(github.seen.filter(({ url }) => url.includes("/app/installations?"))).toHaveLength(2);

    now += 45 * MINUTE;
    expect(app.live()).toEqual(["ghs_token2"]);
  });

  it("mints a token for each account it is installed on, named in any case, and says which it is not installed on", async () => {
    let now = Date.UTC(2026, 0, 1, 12);

    const installations = [
      { id: 42, login: "ian-pascoe" },
      { id: 43, login: "SpiritLedSoftware" },
    ];

    const github = fakeGitHub({ now: () => now, installations });

    const app = new GitHubApp({
      appId: "1",
      privateKey: KEYS.privateKey,
      fetch: github.fetch,
      now: () => now,
    });

    const all = await app.tokens();

    expect(all.appAccount).toBe("ian-pascoe");
    expect(all.problems).toEqual([]);
    expect(Object.keys(all.byAccount).sort()).toEqual(["ian-pascoe", "spiritledsoftware"]);
    expect(await app.token("spiritLEDsoftware")).toBe(all.byAccount.spiritledsoftware);
    expect(await app.token()).toBe(all.byAccount["ian-pascoe"]);
    expect(new Set(app.live())).toEqual(new Set(Object.values(all.byAccount)));

    await expect(app.token("someone-else")).rejects.toThrow(
      "The GitHub App is not installed on someone-else: install it there, on all repositories",
    );

    // An account it is installed on later is found once the list is five minutes old.
    installations.push({ id: 44, login: "someone-else" });
    now += 5 * MINUTE;

    expect(Object.keys((await app.tokens()).byAccount).sort()).toEqual([
      "ian-pascoe",
      "someone-else",
      "spiritledsoftware",
    ]);
  });

  it("says how to install it when it is not installed on its own account", async () => {
    const now = Date.UTC(2026, 0, 1, 12);

    const app = new GitHubApp({
      appId: "1",
      privateKey: KEYS.privateKey,
      fetch: fakeGitHub({ now: () => now, installations: [] }).fetch,
      now: () => now,
    });

    await expect(app.token()).rejects.toThrow(
      "The GitHub App is not installed on ian-pascoe: install it there, on all repositories",
    );
    expect(await app.tokens()).toEqual({ byAccount: {}, appAccount: "ian-pascoe", problems: [] });
  });

  it("says why GitHub refused it, and asks again only after a wait that doubles with each failure", async () => {
    let now = Date.UTC(2026, 0, 1, 12);
    let refusing = true;
    const github = fakeGitHub({ now: () => now });
    const asked: string[] = [];

    const app = new GitHubApp({
      appId: "1",
      privateKey: KEYS.privateKey,
      fetch: (url, init) => {
        asked.push(url);

        return refusing
          ? Promise.resolve(
              Response.json({ message: "A JSON web token could not be decoded" }, { status: 401 }),
            )
          : github.fetch(url, init);
      },
      now: () => now,
    });

    const refusal =
      "GitHub refused the GitHub App (401: A JSON web token could not be decoded): check CLOUDPID_GITHUB_APP_ID and CLOUDPID_GITHUB_APP_PRIVATE_KEY";

    await expect(app.token()).rejects.toThrow(refusal);
    expect(asked).toHaveLength(1);

    // Within the minute, the failure is told again without asking.
    now += 59_000;
    await expect(app.token()).rejects.toThrow(refusal);
    expect(asked).toHaveLength(1);

    now += 1_000;
    await expect(app.token()).rejects.toThrow(refusal);
    expect(asked).toHaveLength(2);

    // Then two minutes.
    refusing = false;
    now += 119_000;
    await expect(app.token()).rejects.toThrow(refusal);

    now += 1_000;
    expect(await app.token()).toBe("ghs_token1");
  });

  it("hands out its last token while it has not expired when no new one can be minted", async () => {
    let now = Date.UTC(2026, 0, 1, 12);
    let down = false;
    const github = fakeGitHub({ now: () => now });

    const app = new GitHubApp({
      appId: "1",
      privateKey: KEYS.privateKey,
      fetch: (url, init) =>
        down ? Promise.reject(new Error("connection refused")) : github.fetch(url, init),
      now: () => now,
    });

    expect(await app.token()).toBe("ghs_token1");

    down = true;
    now += 30 * MINUTE;
    expect(await app.token()).toBe("ghs_token1");

    // Within the wait after that failure too.
    now += MINUTE / 2;
    expect(await app.token()).toBe("ghs_token1");

    now += 29.5 * MINUTE;
    await expect(app.token()).rejects.toThrow("GitHub could not be reached: connection refused");
  });

  it("remembers the tokens it minted where it keeps them, so one made again hands out and lists them", async () => {
    let now = Date.UTC(2026, 0, 1, 12);
    const github = fakeGitHub({ now: () => now });
    let stored: ReadonlyArray<MintedToken> | undefined;

    const kept = {
      load: () => stored,
      save: (minted: ReadonlyArray<MintedToken>) => (stored = minted),
    };

    const options = {
      appId: "1",
      privateKey: KEYS.privateKey,
      fetch: github.fetch,
      now: () => now,
      kept,
    };

    expect(await new GitHubApp(options).token()).toBe("ghs_token1");

    now += 20 * MINUTE;
    expect(await new GitHubApp(options).token()).toBe("ghs_token2");

    const again = new GitHubApp(options);

    expect(again.live()).toEqual(["ghs_token1", "ghs_token2"]);
    expect(await again.token()).toBe("ghs_token2");

    now += 45 * MINUTE;
    expect(again.live()).toEqual(["ghs_token2"]);
    expect(new GitHubApp(options).live()).toEqual(["ghs_token2"]);
  });

  it("mints again after a token GitHub refused is invalidated, still listing it until it expires", async () => {
    const now = Date.UTC(2026, 0, 1, 12);
    const github = fakeGitHub({ now: () => now });

    const app = new GitHubApp({
      appId: "1",
      privateKey: KEYS.privateKey,
      fetch: github.fetch,
      now: () => now,
    });

    const refused = await app.token();

    app.invalidate(refused);
    // A caller that saw the same refusal later does not throw the new token away.
    expect(await app.token()).toBe("ghs_token2");
    app.invalidate(refused);

    expect(await app.token()).toBe("ghs_token2");
    expect(app.live()).toEqual(["ghs_token1", "ghs_token2"]);
  });

  it("asks for only the permissions it was made with", async () => {
    const now = Date.UTC(2026, 0, 1, 12);
    const github = fakeGitHub({ now: () => now });

    const app = new GitHubApp({
      appId: "1",
      privateKey: KEYS.privateKey,
      fetch: github.fetch,
      now: () => now,
      permissions: { contents: "read", pull_requests: "read" },
    });

    await app.token();

    expect(JSON.parse(github.seen.at(-1)?.body ?? "")).toEqual({
      permissions: { contents: "read", pull_requests: "read" },
    });
  });

  it("finds the installation again when it is gone (installed again under another id)", async () => {
    let now = Date.UTC(2026, 0, 1, 12);
    let installation = 42;
    const github = fakeGitHub({ now: () => now });

    const app = new GitHubApp({
      appId: "1",
      privateKey: KEYS.privateKey,
      fetch: (url, init) => {
        if (url === "https://api.github.com/app/installations?per_page=100") {
          return Promise.resolve(
            Response.json([{ id: installation, account: { login: "ian-pascoe" } }]),
          );
        }

        return url === "https://api.github.com/app" ||
          url.endsWith(`/installations/${installation}/access_tokens`)
          ? github.fetch(url, init)
          : Promise.resolve(Response.json({ message: "Not Found" }, { status: 404 }));
      },
      now: () => now,
    });

    expect(await app.token()).toBe("ghs_token1");

    // Its token refused and the installation gone, the mint under the id it knows is refused too.
    installation = 43;
    now += 1 * MINUTE;
    app.invalidate("ghs_token1");
    await expect(app.token()).rejects.toThrow(
      "GitHub refused the GitHub App's request (404: Not Found)",
    );

    now += 1 * MINUTE;
    expect(await app.token()).toBe("ghs_token2");
  });

  it("takes the key as PKCS#8 too, and with its line breaks written as \\n", async () => {
    const now = Date.UTC(2026, 0, 1, 12);

    const pkcs8 = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    }).privateKey;

    for (const privateKey of [pkcs8, KEYS.privateKey.replaceAll("\n", "\\n")]) {
      const app = new GitHubApp({
        appId: "1",
        privateKey,
        fetch: fakeGitHub({ now: () => now }).fetch,
        now: () => now,
      });

      expect(await app.token()).toBe("ghs_token1");
      expect(await githubAppKeyProblem(privateKey)).toBeUndefined();
    }
  });

  it("finds the problem with a key that is not an RSA private key in PEM", async () => {
    const ec = generateKeyPairSync("ec", {
      namedCurve: "P-256",
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    }).privateKey;

    expect(await githubAppKeyProblem("")).toBe(
      "CLOUDPID_GITHUB_APP_PRIVATE_KEY is not a PEM private key (-----BEGIN RSA PRIVATE KEY-----)",
    );
    expect(await githubAppKeyProblem(KEYS.publicKey)).toBe(
      "CLOUDPID_GITHUB_APP_PRIVATE_KEY is not a PEM private key (-----BEGIN RSA PRIVATE KEY-----)",
    );
    expect(await githubAppKeyProblem(ec)).toMatch(
      /^CLOUDPID_GITHUB_APP_PRIVATE_KEY is not the GitHub App's RSA private key: /,
    );
  });

  it("mints once for callers that ask at the same time", async () => {
    const now = Date.UTC(2026, 0, 1, 12);
    const github = fakeGitHub({ now: () => now });

    const app = new GitHubApp({
      appId: "1",
      privateKey: KEYS.privateKey,
      fetch: github.fetch,
      now: () => now,
    });

    expect(await Promise.all([app.token(), app.token(), app.token()])).toEqual([
      "ghs_token1",
      "ghs_token1",
      "ghs_token1",
    ]);
    expect(github.seen.filter(({ method }) => method === "POST")).toHaveLength(1);
  });
});
