import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import type * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  canonicalMcpConnection,
  canonicalMcpIdentity,
  mcpConnectionKey,
  mcpServerIdentity,
  mcpSignInKey,
  sha256Hex,
} from "./mcp-connection.ts";
import { type McpRepoLayer, resolveMcpServerSet } from "./mcp-server-set.ts";

const hex = (digest: ArrayBuffer): string =>
  Arr.join(
    Arr.map(Array.from(new Uint8Array(digest)), (byte) => byte.toString(16).padStart(2, "0")),
    "",
  );

describe("sha256Hex", () => {
  it("matches the published digests", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
  });

  // @effect-diagnostics-next-line asyncFunction:off -- the platform digest is a promise; the test awaits it.
  it("matches the platform's, across block boundaries and for text that is not ASCII", async () => {
    const encoder = new TextEncoder();

    for (const length of [1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000]) {
      const text = "x".repeat(length);

      expect(sha256Hex(text)).toBe(
        hex(await crypto.subtle.digest("SHA-256", encoder.encode(text))),
      );
    }

    const unicode = "héllo ✓ 日本語 🚀 ${NAME}";

    expect(sha256Hex(unicode)).toBe(
      hex(await crypto.subtle.digest("SHA-256", encoder.encode(unicode))),
    );
  });
});

const LINEAR = {
  url: "https://mcp.linear.app/mcp",
  headers: { Authorization: "Bearer ${LINEAR_TOKEN}", "X-Team": "eng" },
};

const LOCAL = {
  command: "npx",
  args: ["-y", "linear-mcp"],
  env: { KEY: "${LINEAR_KEY}" },
  cwd: "/workspace/api",
};

/** The pinned `conn` of `LINEAR` and `LOCAL` as Global's `linear` and `local`: SHA-256 of the canonical text, by hand. */
const GOLDEN_LINEAR = "790648b0a63c2ac43c20e6b1cf099d36ddf6f4b29f25899438dc3219e2a73ca7";
const GOLDEN_LOCAL = "9412b0d696d8f3550385af63ea823a8b6408d91976106d66446dc273ad5db170";

const owner = (servers: Schema.Json): Schema.Json => ({ mcp: { servers } });

const repo = (directory: string, servers: Schema.Json): McpRepoLayer => ({
  directory,
  slug: `acme/${directory}`,
  path: ".pi/mcp.json",
  text: JSON.stringify({ mcpServers: servers }),
});

/** The server `name` of the set Global's `servers` give, with the Environment's `environment` Overrides. */
const keyed = (
  name: string,
  servers: Schema.Json,
  environment: Schema.Json = {},
  ...repos: Array<McpRepoLayer>
) => {
  const found = Arr.findFirst(
    resolveMcpServerSet(owner(servers), environment, repos).servers,
    (held) => held.name === name,
  );

  if (Option.isNone(found)) throw new Error(`No server ${name}`);

  return found.value;
};

const conn = (name: string, entry: Schema.Json, environment: Schema.Json = {}) =>
  mcpConnectionKey(keyed(name, { [name]: entry }, environment));

describe("the connection key `conn`", () => {
  it("is SHA-256 of the canonical source, name, type, url, headers, oauth, command, args, env and cwd", () => {
    expect(canonicalMcpConnection(keyed("Linear-App", { "Linear-App": LINEAR }))).toBe(
      '{"source":"owner","name":"linear_app","type":"http","url":"https://mcp.linear.app/mcp",' +
        '"headers":{"Authorization":"Bearer ${LINEAR_TOKEN}","X-Team":"eng"},"oauth":null,' +
        '"command":null,"args":[],"env":{},"cwd":null}',
    );
    expect(canonicalMcpConnection(keyed("local", { local: LOCAL }))).toBe(
      '{"source":"owner","name":"local","type":"stdio","url":null,"headers":{},"oauth":null,' +
        '"command":"npx","args":["-y","linear-mcp"],"env":{"KEY":"${LINEAR_KEY}"},"cwd":"/workspace/api"}',
    );
  });

  it("has these golden values, so a change to the canonical form is seen", () => {
    expect(conn("linear", LINEAR)).toBe(GOLDEN_LINEAR);
    expect(conn("local", LOCAL)).toBe(GOLDEN_LOCAL);
    expect(
      conn("signed", {
        url: "https://mcp.example.com/mcp",
        oauth: { clientId: "abc", clientSecret: "${CLIENT_SECRET}", scope: "read" },
      }),
    ).toBe("179ae157d396ef35fa2c97018ee9395781af777dbf273a5da85c15f8afdeb5e4");
  });

  it("is keyed by the Repo's slug for a Repo's server", () => {
    expect(mcpConnectionKey(keyed("linear", {}, {}, repo("web", { linear: LINEAR })))).toBe(
      "903065960eaf32f2ca7cb78f9a5d9ef9d9e9dc20c0157ee15739cd7cf2aa8752",
    );
  });

  it("is hashed from the unresolved text, so no Secret enters it", () => {
    const text = canonicalMcpConnection(keyed("linear", { linear: LINEAR }));

    expect(text).toContain("${LINEAR_TOKEN}");
  });

  describe("is left alone by editing a key outside it: the golden values stay", () => {
    for (const [label, edit] of [
      ["description", { description: "another" }],
      ["timeout", { timeout: 600 }],
      ["enabled", { enabled: false }],
      ["exposure", { exposure: "direct" }],
      ["toolExposure", { toolExposure: { "delete_*": "hidden" } }],
      ["sampling", { sampling: "allow" }],
    ] as const) {
      it(label, () => {
        expect(conn("linear", { ...LINEAR, ...edit })).toBe(GOLDEN_LINEAR);
        expect(conn("local", { ...LOCAL, ...edit })).toBe(GOLDEN_LOCAL);
      });
    }

    it("all of them at once", () => {
      expect(
        conn("linear", {
          ...LINEAR,
          description: "d",
          timeout: 30,
          enabled: false,
          exposure: "hidden",
          toolExposure: { a: "hidden" },
          sampling: "off",
        }),
      ).toBe(GOLDEN_LINEAR);
    });

    it("an Environment's adjustment, which holds nothing else", () => {
      expect(
        mcpConnectionKey(
          keyed(
            "linear",
            { linear: LINEAR },
            owner({
              linear: { enabled: false, exposure: "hidden", toolExposure: { a: "hidden" } },
            }),
          ),
        ),
      ).toBe(GOLDEN_LINEAR);
    });
  });

  describe("changes with a key inside it", () => {
    const changes: ReadonlyArray<readonly [string, Schema.Json]> = [
      ["url", { ...LINEAR, url: "https://mcp.linear.app/other" }],
      ["a header's value", { ...LINEAR, headers: { ...LINEAR.headers, "X-Team": "ops" } }],
      ["a header", { ...LINEAR, headers: { "X-Team": "eng" } }],
    ];

    for (const [label, edit] of changes) {
      it(label, () => {
        expect(conn("linear", edit)).not.toBe(conn("linear", LINEAR));
      });
    }

    for (const [label, edit] of [
      ["command", { command: "bunx" }],
      ["args", { args: ["-y", "other"] }],
      ["env", { env: { KEY: "${OTHER_KEY}" } }],
      ["cwd", { cwd: "/workspace/web" }],
    ] as const) {
      it(`a stdio server's ${label}`, () => {
        expect(conn("local", { ...LOCAL, ...edit })).not.toBe(conn("local", LOCAL));
      });
    }

    it("the name, other than in case or in `-`/`_`", () => {
      expect(mcpConnectionKey({ ...keyed("a", { a: LINEAR }), name: "b" })).not.toBe(
        conn("a", LINEAR),
      );
    });

    it("oauth, given or changed", () => {
      const url = "https://x.test";
      const oauth = { clientId: "abc" };

      expect(conn("s", { url, oauth })).not.toBe(conn("s", { url }));
      expect(conn("s", { url, oauth: { ...oauth, scope: "read" } })).not.toBe(
        conn("s", { url, oauth }),
      );
    });
  });

  describe("is the same for what the entry says in other words", () => {
    it("the name's case and `-`/`_`", () => {
      expect(
        mcpConnectionKey({ ...keyed("my-linear", { "my-linear": LINEAR }), name: "My_Linear" }),
      ).toBe(conn("my-linear", LINEAR));
    });

    it("the order of the keys of `env`, `headers` and `oauth`", () => {
      expect(
        conn("a", {
          url: "https://x.test",
          headers: { B: "2", A: "1" },
          oauth: { scope: "s", clientId: "c" },
        }),
      ).toBe(
        conn("a", {
          url: "https://x.test",
          headers: { A: "1", B: "2" },
          oauth: { clientId: "c", scope: "s" },
        }),
      );
      expect(conn("a", { command: "x", env: { B: "2", A: "1" } })).toBe(
        conn("a", { command: "x", env: { A: "1", B: "2" } }),
      );
    });

    it("`http` and `streamable-http`, an explicit type and an inferred one", () => {
      const key = conn("a", { url: "https://x.test" });

      expect(conn("a", { url: "https://x.test", type: "streamable-http" })).toBe(key);
      expect(conn("a", { url: "https://x.test", type: "http" })).toBe(key);
      expect(conn("a", { command: "x", type: "stdio" })).toBe(conn("a", { command: "x" }));
    });

    it("an empty `args`, `env` and `headers`, and none", () => {
      expect(conn("a", { command: "x", args: [], env: {} })).toBe(conn("a", { command: "x" }));
      expect(conn("a", { url: "https://x.test", headers: {} })).toBe(
        conn("a", { url: "https://x.test" }),
      );
    });

    it("the `oauth` defaults, and the ignored `callbackPort` and `callbackUrl`", () => {
      const url = "https://x.test";

      expect(
        conn("a", {
          url,
          oauth: {
            clientId: "c",
            clientRegistration: "auto",
            grantType: "authorization_code",
            callbackPort: 8080,
            callbackUrl: "http://localhost:8080/cb",
          },
        }),
      ).toBe(conn("a", { url, oauth: { clientId: "c" } }));
    });

    it("the url's fragment and spelling: `new URL(url).href` without its fragment", () => {
      expect(conn("a", { url: "https://X.test:443/mcp#frag" })).toBe(
        conn("a", { url: "https://x.test/mcp" }),
      );
    });

    it("an owner's server at Global and in the Environment, in any Repo order", () => {
      const global = mcpConnectionKey(keyed("linear", { linear: LINEAR }));
      const environment = mcpConnectionKey(keyed("linear", {}, owner({ linear: LINEAR })));

      expect(environment).toBe(global);
    });
  });

  describe("is the source's", () => {
    it("a Repo's server and the owner's of one definition have each their own", () => {
      const owned = mcpConnectionKey(keyed("linear", { linear: LINEAR }));
      const repoWeb = mcpConnectionKey(keyed("linear", {}, {}, repo("web", { linear: LINEAR })));
      const repoApi = mcpConnectionKey(keyed("linear", {}, {}, repo("api", { linear: LINEAR })));

      expect(new Set([owned, repoWeb, repoApi]).size).toBe(3);
    });

    it("every Environment holding one Repo shares it, whichever the directory", () => {
      const first = mcpConnectionKey(
        keyed("a", {}, {}, { ...repo("web", { a: LINEAR }), slug: "acme/web" }),
      );

      const second = mcpConnectionKey(
        keyed("a", {}, {}, { ...repo("site", { a: LINEAR }), slug: "acme/web" }),
      );

      expect(second).toBe(first);
    });
  });
});

describe("the server identity", () => {
  const identity = (name: string, entry: Schema.Json) =>
    mcpServerIdentity(keyed(name, { [name]: entry }));

  it("is SHA-256 of the canonical source, normalized name, type and url", () => {
    expect(canonicalMcpIdentity(keyed("Linear-App", { "Linear-App": LINEAR }))).toBe(
      '{"source":"owner","name":"linear_app","type":"http","url":"https://mcp.linear.app/mcp"}',
    );
    expect(identity("linear", LINEAR)).toBe(
      sha256Hex(canonicalMcpIdentity(keyed("linear", { linear: LINEAR }))),
    );
  });

  it("has a golden value", () => {
    expect(identity("linear", LINEAR)).toBe(
      "9ef03fe78a5e811eece3d73a506221e7c44edeb56d69ded9415a40b1e11d9d09",
    );
  });

  it("holds when the headers, the `oauth` and the keys outside `conn` change: a re-pin is the same server", () => {
    expect(
      identity("linear", { ...LINEAR, headers: {}, oauth: { clientId: "a" }, timeout: 5 }),
    ).toBe(identity("linear", LINEAR));
  });

  it("changes with the url, the name, the type and the source", () => {
    const base = identity("linear", LINEAR);

    expect(identity("linear", { url: "https://mcp.linear.app/v2" })).not.toBe(base);
    expect(identity("other", LINEAR)).not.toBe(base);
    expect(identity("linear", LOCAL)).not.toBe(base);
    expect(mcpServerIdentity(keyed("linear", {}, {}, repo("web", { linear: LINEAR })))).not.toBe(
      base,
    );
  });
});

describe("the MCP sign-in key", () => {
  const signIn = (name: string, entry: Schema.Json) => mcpSignInKey(keyed(name, { [name]: entry }));

  it("is the source, the normalized name and the url without its fragment, hashed", () => {
    const key = signIn("Linear-App", { url: "https://mcp.linear.app/mcp#frag" });

    expect(key).toEqual({
      source: "owner",
      name: "linear_app",
      url: "https://mcp.linear.app/mcp",
      hash: sha256Hex('{"source":"owner","name":"linear_app","url":"https://mcp.linear.app/mcp"}'),
    });
  });

  it("is the href of the url: a host's case and a default port fold, a path's case and a query stay", () => {
    expect(signIn("a", { url: "https://MCP.Linear.app:443/Mcp?x=1" })?.url).toBe(
      "https://mcp.linear.app/Mcp?x=1",
    );
    expect(signIn("a", { url: "https://mcp.linear.app/mcp" })?.hash).not.toBe(
      signIn("a", { url: "https://mcp.linear.app/mcp/" })?.hash,
    );
  });

  it("keeps the sign-in through edits to the headers and `oauth`, which `conn` does not", () => {
    expect(
      signIn("linear", { ...LINEAR, headers: { "X-A": "b" }, oauth: { clientId: "a" } })?.hash,
    ).toBe(signIn("linear", LINEAR)?.hash);
  });

  it("is a new sign-in for a new name, url or source: a Repo's never reuses the owner's", () => {
    const base = signIn("linear", LINEAR)?.hash;

    expect(signIn("other", LINEAR)?.hash).not.toBe(base);
    expect(signIn("linear", { url: "https://mcp.linear.app/v2" })?.hash).not.toBe(base);
    expect(mcpSignInKey(keyed("linear", {}, {}, repo("web", { linear: LINEAR })))?.hash).not.toBe(
      base,
    );
    expect(mcpSignInKey(keyed("linear", {}, {}, repo("web", { linear: LINEAR })))?.source).toBe(
      "repo:acme/web",
    );
  });

  it("is shared by every Environment holding one Repo, whichever the directory", () => {
    const first = mcpSignInKey(
      keyed("a", {}, {}, { ...repo("web", { a: LINEAR }), slug: "acme/web" }),
    );

    const second = mcpSignInKey(
      keyed("a", {}, {}, { ...repo("site", { a: LINEAR }), slug: "acme/web" }),
    );

    expect(second).toEqual(first);
  });

  it("is none for a stdio server", () => {
    expect(signIn("local", LOCAL)).toBeUndefined();
  });
});
