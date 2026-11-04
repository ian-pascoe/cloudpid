import * as Arr from "effect/Array";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  declaresSampling,
  decodeMcpServerValue,
  MCP_OAUTH_KEYS,
  mcpEntryHints,
  mcpLayerProblems,
  mcpRepoCwd,
  normalizeMcpName,
  normalizeMcpServer,
  readMcpRepoFile,
  samplingOf,
  mcpKeyField,
  parseMcpField,
} from "./mcp-servers.ts";
import { resolveSettings } from "./settings.ts";

/** The problems of an entry the Settings refuse, one line each; fails the test when it decodes. */
const refused = (
  value: Schema.Json,
  where: "settings" | "repo" = "settings",
): ReadonlyArray<string> => {
  const result = decodeMcpServerValue(value, where);

  if (Result.isSuccess(result)) throw new Error("Expected the entry to be refused");

  return Arr.map(result.failure, ({ line }) => line);
};

const accepted = (value: Schema.Json, where: "settings" | "repo" = "settings") => {
  const result = decodeMcpServerValue(value, where);

  if (Result.isFailure(result))
    throw new Error(
      Arr.join(
        Arr.map(result.failure, (p) => p.line),
        "\n",
      ),
    );

  return result.success;
};

/** `count` keys that start with `prefix`, each holding `value`. */
const named = (count: number, prefix: string, value: Schema.Json): Schema.JsonObject =>
  Record.fromEntries(
    count === 0 ? [] : Arr.makeBy(count, (i): [string, Schema.Json] => [`${prefix}${i}`, value]),
  );

const STDIO = { command: "npx", args: ["-y", "linear-mcp"] };
const HTTP = { url: "https://mcp.linear.app/mcp" };

describe("an MCP server entry in the Settings", () => {
  it("is a stdio or an HTTP server, its type inferred from `command` or `url`", () => {
    expect(normalizeMcpServer(accepted(STDIO))).toMatchObject({ type: "stdio", command: "npx" });
    expect(normalizeMcpServer(accepted(HTTP))).toMatchObject({ type: "http", url: HTTP.url });
  });

  it("reads `streamable-http` as `http` and takes either spelling with its url", () => {
    expect(normalizeMcpServer(accepted({ ...HTTP, type: "streamable-http" }))?.type).toBe("http");
    expect(normalizeMcpServer(accepted({ ...HTTP, type: "http" }))?.type).toBe("http");
    expect(normalizeMcpServer(accepted({ ...STDIO, type: "stdio" }))?.type).toBe("stdio");
  });

  it("applies the defaults only when the entry is read in force", () => {
    expect(accepted(STDIO)).toEqual(STDIO);
    expect(normalizeMcpServer(accepted(STDIO))).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "linear-mcp"],
      env: {},
      enabled: true,
      exposure: "codemode",
      toolExposure: {},
      timeout: 60,
      sampling: "ask",
    });
  });

  it("reads pi's `codemode-deferred` as `codemode`, also in `toolExposure`", () => {
    const entry = normalizeMcpServer(
      accepted({
        ...STDIO,
        exposure: "codemode-deferred",
        toolExposure: { "a*": "codemode-deferred" },
      }),
    );

    expect(entry?.exposure).toBe("codemode");
    expect(entry?.toolExposure).toEqual({ "a*": "codemode" });
  });

  it("refuses `sse`, naming Streamable HTTP", () => {
    expect(refused({ ...HTTP, type: "sse" })).toEqual([expect.stringContaining("Streamable HTTP")]);
  });

  it("refuses a `type` that is not one", () => {
    expect(refused({ ...HTTP, type: "websocket" })).toHaveLength(1);
  });

  it("refuses a `type` that does not fit the command or url", () => {
    expect(refused({ ...HTTP, type: "stdio" })).toEqual([expect.stringContaining("type")]);
    expect(refused({ ...STDIO, type: "http" })).toEqual([expect.stringContaining("type")]);
  });

  it("refuses an entry with a `type` alone: it is a full entry, and defines no server", () => {
    expect(refused({ type: "http" })).toEqual([
      expect.stringContaining("does not define a server"),
    ]);
    expect(refused({ type: "stdio", enabled: false })).toEqual([
      expect.stringContaining("does not define a server"),
    ]);
  });

  it("refuses both a command and a url", () => {
    expect(refused({ ...STDIO, ...HTTP })).toEqual([expect.stringContaining("both")]);
  });

  it("refuses the keys of the other transport", () => {
    expect(refused({ ...STDIO, headers: { A: "b" } })).toEqual(["headers: is for an HTTP server"]);
    expect(refused({ ...HTTP, args: [], env: {}, cwd: "/workspace" })).toEqual([
      "args: is for a stdio server",
      "env: is for a stdio server",
      "cwd: is for a stdio server",
    ]);
  });

  it("refuses an unknown key", () => {
    expect(refused({ ...STDIO, idleTimeout: 5 })).toEqual([expect.stringContaining("idleTimeout")]);
  });

  it("refuses pi's `auth`", () => {
    expect(refused({ ...HTTP, auth: "bearer" })).toEqual([expect.stringMatching(/^auth: .*oauth/)]);
  });

  it("refuses `~` in the command, the arguments and the directory", () => {
    expect(refused({ command: "~/bin/mcp" })).toEqual([expect.stringMatching(/^command: .*~/)]);
    expect(refused({ command: "mcp", args: ["--a", "~/x"] })).toEqual([
      expect.stringMatching(/^args\.1: .*~/),
    ]);
    expect(refused({ command: "mcp", cwd: "~/x" })).toEqual([expect.stringMatching(/^cwd: .*~/)]);
  });

  it("takes a `~` that is not a home directory", () => {
    accepted({ command: "mcp", args: ["~backup", "a~b"] });
  });

  it("refuses a relative `cwd`", () => {
    expect(refused({ ...STDIO, cwd: "packages/x" })).toEqual([
      expect.stringMatching(/^cwd: .*absolute/),
    ]);
    accepted({ ...STDIO, cwd: "/workspace/api" });
  });

  it("refuses a url that is not http or https", () => {
    expect(refused({ url: "ftp://example.com" })).toEqual([expect.stringMatching(/^url: /)]);
    expect(refused({ url: "not a url" })).toEqual([expect.stringMatching(/^url: /)]);
  });

  it("refuses pi's `!command` values in `env` and `headers`", () => {
    expect(refused({ ...STDIO, env: { TOKEN: "!op read x" } })).toEqual([
      expect.stringMatching(/^env\.TOKEN: starts with !/),
    ]);
    expect(refused({ ...HTTP, headers: { Authorization: "!op read x" } })).toEqual([
      expect.stringMatching(/^headers\.Authorization: starts with !/),
    ]);
  });

  it("reads `${NAME}` in `env` and `headers` values, and nowhere else", () => {
    accepted({ ...STDIO, env: { KEY: "${LINEAR_KEY}", MIXED: "a-${B}-c", BARE: "$HOME" } });
    accepted({ ...HTTP, headers: { Authorization: "Bearer ${TOKEN}" } });

    expect(refused({ command: "run-${X}" })).toEqual([
      expect.stringMatching(/^command: .*\$\{NAME\}/),
    ]);
    expect(refused({ command: "run", args: ["--key=${KEY}"] })).toEqual([
      expect.stringMatching(/^args\.0: /),
    ]);
    expect(refused({ url: "https://${HOST}/mcp" })).toEqual([expect.stringMatching(/^url: /)]);
    expect(refused({ ...STDIO, cwd: "/w/${X}" })).toEqual([expect.stringMatching(/^cwd: /)]);
  });

  it("refuses a `${…}` that is not a `${NAME}`", () => {
    expect(refused({ ...STDIO, env: { A: "${not a name}" } })).toHaveLength(1);
    expect(refused({ ...STDIO, env: { A: "${OPEN" } })).toHaveLength(1);
  });

  it("holds `enabled`, `exposure`, `toolExposure`, `timeout`, `description` and `sampling`", () => {
    const entry = accepted({
      ...STDIO,
      enabled: false,
      exposure: "deferred",
      toolExposure: { "delete_*": "hidden", search: "direct" },
      timeout: 120,
      description: "Linear issues",
      sampling: "off",
    });

    expect(normalizeMcpServer(entry)).toMatchObject({
      enabled: false,
      exposure: "deferred",
      toolExposure: { "delete_*": "hidden", search: "direct" },
      timeout: 120,
      description: "Linear issues",
      sampling: "off",
    });
  });

  it("reads `sampling` the same for a stdio server and an HTTP one: `ask` by default, `allow`, or `off`", () => {
    for (const type of ["stdio", "http"]) {
      const base: Record<string, unknown> = { type };

      expect(samplingOf(base)).toBe("ask");
      expect(samplingOf({ ...base, sampling: "allow" })).toBe("allow");
      expect(samplingOf({ ...base, sampling: "off" })).toBe("off");
      expect(declaresSampling(base)).toBe(true);
      expect(declaresSampling({ ...base, sampling: "off" })).toBe(false);
    }
  });

  it("refuses an exposure, a sampling mode and a timeout that are not valid", () => {
    expect(refused({ ...STDIO, exposure: "visible" })).toHaveLength(1);
    expect(refused({ ...STDIO, toolExposure: { a: "visible" } })).toHaveLength(1);
    expect(refused({ ...STDIO, sampling: "sometimes" })).toHaveLength(1);
    expect(refused({ ...STDIO, timeout: 0 })).toHaveLength(1);
    expect(refused({ ...STDIO, timeout: "60" })).toHaveLength(1);
  });
});

describe("an MCP server adjustment", () => {
  it("holds `enabled`, `exposure` and `toolExposure`", () => {
    expect(accepted({ enabled: false, exposure: "hidden", toolExposure: { a: "hidden" } })).toEqual(
      { enabled: false, exposure: "hidden", toolExposure: { a: "hidden" } },
    );
    expect(normalizeMcpServer(accepted({ enabled: false }))).toBeUndefined();
  });

  it("can never carry a key of the definition", () => {
    expect(refused({ enabled: false, timeout: 5 })).toEqual([
      expect.stringMatching(/^timeout: .*adjustment/),
    ]);
    expect(refused({ sampling: "allow" })).toEqual([
      expect.stringMatching(/^sampling: .*adjustment/),
    ]);
    expect(refused({ description: "x", args: [] })).toHaveLength(2);
  });
});

describe("the `oauth` fields", () => {
  const oauth = (fields: Schema.Json): Schema.Json => ({ ...HTTP, oauth: fields });

  it("take every field, and ignore `callbackPort` and `callbackUrl`", () => {
    accepted(
      oauth({
        clientId: "abc",
        clientSecret: "${CLIENT_SECRET}",
        keyId: "k1",
        scope: "read write",
        clientName: "cloudpid",
        clientRegistration: "dcr",
        authServerMetadataUrl: "https://auth.example.com/.well-known/oauth-authorization-server",
        issuer: "https://auth.example.com",
        grantType: "authorization_code",
        callbackPort: 8080,
        callbackUrl: "http://localhost:8080/cb",
      }),
    );
  });

  it("are refused on a stdio entry, and beside an Authorization header", () => {
    expect(refused({ ...STDIO, oauth: {} })).toEqual([expect.stringMatching(/^oauth: .*HTTP/)]);
    expect(
      refused({ ...HTTP, headers: { authorization: "Bearer ${T}" }, oauth: { clientId: "a" } }),
    ).toEqual([expect.stringMatching(/^oauth: .*Authorization/)]);
  });

  it("refuse a client secret without a client id, and a literal one in the Settings", () => {
    expect(refused(oauth({ clientSecret: "${S}" }))).toEqual([
      "oauth.clientSecret: needs a clientId",
    ]);
    expect(refused(oauth({ clientId: "a", clientSecret: "hunter2" }))).toEqual([
      expect.stringMatching(/^oauth\.clientSecret: must be exactly one \$\{NAME\}/),
    ]);
    expect(refused(oauth({ clientId: "a", clientSecret: "x${S}" }))).toHaveLength(1);
  });

  const GRANT = {
    grantType: "client_credentials",
    clientId: "a",
    issuer: "https://auth.example.com",
  } as const;

  it("refuse a literal private key, and one outside `client_credentials` or beside a client secret", () => {
    expect(refused(oauth({ ...GRANT, privateKey: "-----BEGIN" }))).toEqual([
      expect.stringMatching(/^oauth\.privateKey: must be exactly one/),
    ]);
    expect(refused(oauth({ privateKey: "${KEY}" }))).toEqual([
      expect.stringMatching(/^oauth\.privateKey: is only for/),
    ]);
    expect(refused(oauth({ ...GRANT, clientSecret: "${S}", privateKey: "${KEY}" }))).toEqual([
      expect.stringMatching(/^oauth\.privateKey: is refused together/),
    ]);
    accepted(oauth({ ...GRANT, privateKey: "${KEY}" }));
  });

  it("need, for `client_credentials`, a client id, a pin and a secret or a key", () => {
    accepted(oauth({ ...GRANT, clientSecret: "${S}" }));
    accepted(oauth({ ...GRANT, privateKey: "${KEY}", keyId: "k1", scope: "read" }));
    accepted(
      oauth({
        grantType: "client_credentials",
        clientId: "a",
        authServerMetadataUrl: "https://auth.example.com/.well-known/oauth-authorization-server",
        clientSecret: "${S}",
      }),
    );
    expect(
      refused(
        oauth({ grantType: "client_credentials", issuer: GRANT.issuer, privateKey: "${KEY}" }),
      ),
    ).toEqual([expect.stringMatching(/^oauth\.clientId: is needed/)]);
    expect(
      refused(oauth({ grantType: "client_credentials", clientId: "a", clientSecret: "${S}" })),
    ).toEqual([expect.stringMatching(/^oauth\.issuer: or authServerMetadataUrl is needed/)]);
    expect(refused(oauth(GRANT))).toEqual([
      expect.stringMatching(/^oauth\.clientSecret: or privateKey is needed/),
    ]);
  });

  it("refuse a registration setting and a client name for `client_credentials`, and leave the code grant alone", () => {
    expect(refused(oauth({ ...GRANT, clientSecret: "${S}", clientRegistration: "dcr" }))).toEqual([
      expect.stringMatching(/^oauth\.clientRegistration: .*client_credentials/),
    ]);
    expect(refused(oauth({ ...GRANT, clientSecret: "${S}", clientName: "n" }))).toEqual([
      expect.stringMatching(/^oauth\.clientName: .*client_credentials/),
    ]);
    accepted(
      oauth({ grantType: "authorization_code", clientRegistration: "dcr", clientName: "n" }),
    );
  });

  it("refuse `cimd` beside a client id or a client name", () => {
    expect(refused(oauth({ clientRegistration: "cimd", clientId: "a" }))).toEqual([
      expect.stringMatching(/^oauth\.clientRegistration: .*cimd/),
    ]);
    expect(refused(oauth({ clientRegistration: "cimd", clientName: "a" }))).toHaveLength(1);
    accepted(oauth({ clientRegistration: "cimd" }));
  });

  it("bound the client id, key id, client name and scope", () => {
    expect(refused(oauth({ clientId: "has space" }))).toHaveLength(1);
    expect(refused(oauth({ clientId: "a".repeat(257) }))).toHaveLength(1);
    expect(refused(oauth({ keyId: "" }))).toHaveLength(1);
    expect(refused(oauth({ clientName: "n".repeat(101) }))).toHaveLength(1);
    expect(
      refused(
        oauth({
          scope: Arr.join(
            Arr.makeBy(65, (i) => `s${i}`),
            " ",
          ),
        }),
      ),
    ).toHaveLength(1);
    expect(refused(oauth({ scope: "s".repeat(1025) }))).toHaveLength(1);
    accepted(
      oauth({
        scope: Arr.join(
          Arr.makeBy(64, (i) => `s${i}`),
          " ",
        ),
      }),
    );
  });

  it("pin the authorization server by an https URL, the issuer without a query or fragment", () => {
    expect(refused(oauth({ issuer: "http://auth.example.com" }))).toHaveLength(1);
    expect(refused(oauth({ issuer: "https://auth.example.com/?a=1" }))).toHaveLength(1);
    expect(refused(oauth({ issuer: "https://auth.example.com/#x" }))).toHaveLength(1);
    expect(refused(oauth({ authServerMetadataUrl: "http://auth.example.com/m" }))).toHaveLength(1);
    expect(
      refused(oauth({ authServerMetadataUrl: `https://a.example/${"x".repeat(2048)}` })),
    ).toHaveLength(1);
    accepted(oauth({ issuer: "https://auth.example.com/" }));
  });

  it("refuse an unknown key and a registration or grant that is not one", () => {
    expect(refused(oauth({ audience: "x" }))).toHaveLength(1);
    expect(refused(oauth({ clientRegistration: "manual" }))).toHaveLength(1);
    expect(refused(oauth({ grantType: "password" }))).toHaveLength(1);
  });

  it("accept `callbackPort` and `callbackUrl` with a hint that says so", () => {
    const entry = accepted(oauth({ callbackPort: 8080, callbackUrl: "http://localhost:8080/cb" }));

    expect(mcpEntryHints(entry)).toEqual([
      {
        kind: "oauth-callback-ignored",
        keys: ["callbackPort", "callbackUrl"],
        message: expect.stringContaining("redirect URI"),
      },
    ]);
    expect(mcpEntryHints(accepted(oauth({ clientId: "a" })))).toEqual([]);
    expect(mcpEntryHints(accepted(STDIO))).toEqual([]);
  });

  it("hold every field but the ignored ones in `MCP_OAUTH_KEYS`", () => {
    expect(MCP_OAUTH_KEYS).toContain("issuer");
    expect(MCP_OAUTH_KEYS).toContain("clientSecret");
    expect(MCP_OAUTH_KEYS).not.toContain("callbackPort");
    expect(MCP_OAUTH_KEYS).not.toContain("callbackUrl");
  });

  it("read the registration and grant defaults in force", () => {
    expect(normalizeMcpServer(accepted(oauth({ clientId: "a" })))).toMatchObject({
      oauth: { clientId: "a", clientRegistration: "auto", grantType: "authorization_code" },
    });
  });
});

describe("the bounds of an entry", () => {
  it("allow 64 `env` keys, 64 `headers` keys and 200 `toolExposure` keys, and no more", () => {
    const keys = (count: number, value: string): Schema.Json => named(count, "K", value);

    accepted({ ...STDIO, env: keys(64, "v") });
    accepted({ ...HTTP, headers: keys(64, "v") });
    accepted({ ...STDIO, toolExposure: keys(200, "hidden") });
    expect(refused({ ...STDIO, env: keys(65, "v") })).toEqual(["env has more than 64 keys"]);
    expect(refused({ ...HTTP, headers: keys(65, "v") })).toEqual(["headers has more than 64 keys"]);
    expect(refused({ ...STDIO, toolExposure: keys(201, "hidden") })).toEqual([
      "toolExposure has more than 200 keys",
    ]);
  });

  it("allow a description of 1 KiB, in bytes of UTF-8, and no more", () => {
    accepted({ ...STDIO, description: "d".repeat(1024) });
    expect(refused({ ...STDIO, description: "d".repeat(1025) })).toEqual([
      "description is over 1 KiB",
    ]);
    expect(refused({ ...STDIO, description: "é".repeat(513) })).toEqual([
      "description is over 1 KiB",
    ]);
  });

  it("allow an entry of 16 KiB as written, and no more", () => {
    const args = Arr.makeBy(4, () => "a".repeat(4000));

    accepted({ command: "x", args });
    expect(refused({ command: "x", args: [...args, "a".repeat(400)] })).toContain("is over 16 KiB");
  });
});

describe("the names of the `mcp.servers`", () => {
  const settings = (servers: Schema.Json) => resolveSettings({ mcp: { servers } });

  const problems = (servers: Schema.Json): string => {
    const result = settings(servers);

    if (Result.isSuccess(result)) throw new Error("Expected the servers to be refused");

    return result.failure.message;
  };

  it("are letters, digits, `-` and `_`, at most 64 characters", () => {
    expect(Result.isSuccess(settings({ "my-server_2": STDIO, [`a`.repeat(64)]: STDIO }))).toBe(
      true,
    );
    expect(problems({ "my server": STDIO })).toContain("my server");
    expect(problems({ "a.b": STDIO })).toContain("a.b");
    expect(problems({ [`a`.repeat(65)]: STDIO })).toContain("at most 64 characters");
    expect(problems({ "": STDIO })).toContain("not a name");
  });

  it("clash when they differ only in case, or in `-` and `_`", () => {
    expect(normalizeMcpName("My-Server")).toBe("my_server");
    expect(problems({ linear: STDIO, Linear: STDIO })).toBe(
      'mcp.servers.Linear: clashes with "linear": names that differ only in case or in - and _ are one server',
    );
    expect(problems({ "my-server": STDIO, my_server: STDIO })).toContain(
      "mcp.servers.my_server: clashes",
    );
    expect(problems({ a: STDIO, B: STDIO, b: STDIO })).toContain("mcp.servers.b: clashes");
  });

  it("name the problem of an entry by its key", () => {
    expect(problems({ linear: { ...STDIO, auth: "oauth" } })).toMatch(
      /^mcp\.servers\.linear\.auth: /,
    );
  });

  it("take `mcp` without `servers`: it defaults to none", () => {
    const result = resolveSettings({ mcp: {} });

    expect(Result.isSuccess(result) && result.success.mcp).toEqual({ servers: {} });
  });

  it("hold nothing else under `mcp`", () => {
    const result = resolveSettings({ mcp: { servers: {}, autoEnableCodemode: true } });

    expect(Result.isFailure(result)).toBe(true);
  });
});

describe("the servers of a Scope", () => {
  const servers = (full: number, adjustments = 0): Schema.Json =>
    Record.union(
      named(full, "s", STDIO),
      named(adjustments, "a", { enabled: false }),
      (left) => left,
    );

  it("are at most 50, and an Environment's adjustments do not count", () => {
    expect(mcpLayerProblems(servers(50), "global")).toEqual([]);
    expect(mcpLayerProblems(servers(50, 10), "environment")).toEqual([]);
    expect(mcpLayerProblems(servers(51), "environment")).toEqual([
      {
        keys: ["mcp", "servers", "s50"],
        line: "mcp.servers.s50: is over the 50 MCP servers a Scope may have",
      },
    ]);
    expect(mcpLayerProblems(servers(52), "global")).toHaveLength(2);
  });

  it("hold no adjustment at Global", () => {
    expect(mcpLayerProblems(servers(1, 1), "global")).toEqual([
      {
        keys: ["mcp", "servers", "a0"],
        line: "mcp.servers.a0: Global holds no MCP server adjustment: it has no lower layer to adjust",
      },
    ]);
  });

  it("are refused at Global by the strict read of its document", () => {
    const refusedGlobal = resolveSettings({ mcp: { servers: servers(51) } });

    expect(Result.isFailure(refusedGlobal)).toBe(true);
    expect(Result.isFailure(resolveSettings({ mcp: { servers: servers(50) } }))).toBe(false);
    expect(Result.isFailure(resolveSettings({ mcp: { servers: { a: { enabled: false } } } }))).toBe(
      true,
    );
  });
});

describe("a Repo's `.pi/mcp.json`", () => {
  const file = (servers: Schema.Json): string => JSON.stringify({ mcpServers: servers });

  const read = (servers: Schema.Json) => readMcpRepoFile(file(servers), "api");

  it("gives its entries, with a stdio entry's directory made absolute", () => {
    const { entries, problems } = read({
      linear: HTTP,
      local: { command: "node", args: ["s.js"] },
      sub: { command: "node", cwd: "tools/./mcp/" },
    });

    expect(problems).toEqual([]);
    expect(entries).toEqual([
      { name: "linear", value: HTTP },
      { name: "local", value: { command: "node", args: ["s.js"], cwd: "/workspace/api" } },
      { name: "sub", value: { command: "node", cwd: "/workspace/api/tools/mcp" } },
    ]);
  });

  it("skips an entry whose `cwd` is absolute, or leaves the Repo", () => {
    for (const cwd of ["/etc", "../other", "a/../../b", "~/x"]) {
      const { entries, problems } = read({ x: { command: "n", cwd } });

      expect(entries).toEqual([]);
      expect(problems).toEqual([{ name: "x", message: expect.stringContaining("skipped") }]);
    }

    expect(mcpRepoCwd("api", "a/../b")).toBe("/workspace/api/b");
    expect(mcpRepoCwd("api", ".")).toBe("/workspace/api");
  });

  it("skips an entry that breaks a rule of the Settings, with its problem, and keeps the rest", () => {
    const { entries, problems } = read({
      ok: HTTP,
      sse: { url: "https://x.test", type: "sse" },
      auth: { url: "https://x.test", auth: "bearer" },
      tilde: { command: "~/bin/x" },
      bang: { command: "x", env: { A: "!cmd" } },
      unknown: { command: "x", mystery: 1 },
      noserver: { type: "http" },
      oauthStdio: { command: "x", oauth: { clientId: "a" } },
      timeoutAdjust: { timeout: 5 },
    });

    expect(Arr.map(entries, ({ name }) => name)).toEqual(["ok"]);
    expect(Arr.map(problems, ({ name }) => name)).toEqual([
      "sse",
      "auth",
      "tilde",
      "bang",
      "unknown",
      "noserver",
      "oauthStdio",
      "timeoutAdjust",
    ]);
    expect(problems[0]?.message).toContain("Streamable HTTP");
  });

  it("skips an entry whose name is not one, or clashes with an earlier one", () => {
    const { entries, problems } = read({ linear: HTTP, "bad name": HTTP, Linear: HTTP });

    expect(Arr.map(entries, ({ name }) => name)).toEqual(["linear"]);
    expect(Arr.map(problems, ({ name }) => name)).toEqual(["bad name", "Linear"]);
  });

  it("allows a literal `oauth` secret, since the file is public already", () => {
    const { entries, problems } = read({
      a: { ...HTTP, oauth: { clientId: "id", clientSecret: "literal" } },
    });

    expect(problems).toEqual([]);
    expect(entries).toHaveLength(1);
  });

  it("reads `sampling: allow` as `ask`, with the problem", () => {
    const { entries, problems } = read({
      a: { ...HTTP, sampling: "allow" },
      b: { ...HTTP, sampling: "off" },
    });

    expect(Arr.map(entries, ({ value }) => value.sampling)).toEqual(["ask", "off"]);
    expect(problems).toEqual([
      { name: "a", message: expect.stringContaining("copy it into the Settings to allow it") },
    ]);
  });

  it("holds adjustments that only switch off", () => {
    const { entries, problems } = read({
      off: { enabled: false },
      hide: { exposure: "hidden" },
      hideTools: { toolExposure: { "delete_*": "hidden" } },
      all: { enabled: false, exposure: "hidden", toolExposure: { a: "hidden", b: "hidden" } },
    });

    expect(problems).toEqual([]);
    expect(Arr.map(entries, ({ name }) => name)).toEqual(["off", "hide", "hideTools", "all"]);
  });

  it("skips an adjustment that does more than switch off, or nothing", () => {
    const { entries, problems } = read({
      on: { enabled: true },
      direct: { exposure: "direct" },
      loosen: { toolExposure: { a: "hidden", b: "direct" } },
      mixed: { enabled: false, exposure: "deferred" },
      nothing: {},
    });

    expect(entries).toEqual([]);
    expect(Arr.map(problems, ({ name }) => name)).toEqual([
      "on",
      "direct",
      "loosen",
      "mixed",
      "nothing",
    ]);
    expect(problems[0]?.message).toContain("only switch off");
  });

  it("is skipped whole, with a problem, when it is not JSON, has no `mcpServers` object, or is over 64 KiB", () => {
    for (const text of [
      "{",
      "[]",
      "{}",
      JSON.stringify({ mcpServers: [] }),
      JSON.stringify({ mcpServers: { a: { command: "x", description: "d".repeat(70_000) } } }),
    ]) {
      const { entries, problems } = readMcpRepoFile(text, "api");

      expect(entries).toEqual([]);
      expect(problems).toEqual([{ name: null, message: expect.any(String) }]);
    }
  });

  it("is skipped whole when it is over a bound: 51 servers, a long name, an entry over its bounds", () => {
    const over = (servers: Schema.Json) => read(servers);

    for (const servers of [
      named(51, "s", HTTP),
      { [`a`.repeat(65)]: HTTP, ok: HTTP },
      { ok: HTTP, big: { command: "x", description: "d".repeat(2000) } },
      {
        ok: HTTP,
        big: { command: "x", env: named(65, "K", "v") },
      },
    ]) {
      const { entries, problems } = over(servers);

      expect(entries).toEqual([]);
      expect(problems).toEqual([{ name: null, message: expect.any(String) }]);
    }

    expect(read(named(50, "s", HTTP)).entries).toHaveLength(50);
  });

  it("hints at an ignored `callbackPort` in an entry that stands", () => {
    const { entries, hints, problems } = read({
      a: { ...HTTP, oauth: { callbackPort: 8080 } },
      b: { ...HTTP, oauth: { callbackPort: 1 }, auth: "x" },
    });

    expect(problems).toHaveLength(1);
    expect(entries).toHaveLength(1);
    expect(hints).toEqual([
      {
        name: "a",
        kind: "oauth-callback-ignored",
        keys: ["callbackPort"],
        message: expect.stringContaining("redirect URI"),
      },
    ]);
  });

  it("ignores the keys of the file that are not `mcpServers`", () => {
    const { entries, problems } = readMcpRepoFile(
      JSON.stringify({ autoEnableCodemode: true, settings: {}, mcpServers: { a: HTTP } }),
      "api",
    );

    expect(problems).toEqual([]);
    expect(entries).toHaveLength(1);
  });
});

describe("parseMcpField", () => {
  it("names the server and, for a key, the key", () => {
    expect(parseMcpField("mcp.servers.linear")).toEqual({ name: "linear", key: null });
    expect(parseMcpField("mcp.servers.linear.enabled")).toEqual({ name: "linear", key: "enabled" });
    expect(parseMcpField("mcp.servers.linear.exposure")).toEqual({
      name: "linear",
      key: "exposure",
    });
    expect(parseMcpField("mcp.servers.linear.toolExposure")).toEqual({
      name: "linear",
      key: "toolExposure",
    });
  });

  it("is null for any other field", () => {
    expect(parseMcpField("roles.small")).toBeNull();
    expect(parseMcpField("mcp.servers")).toBeNull();
    expect(parseMcpField("mcp.servers.linear.url")).toBeNull();
    expect(parseMcpField("mcp.servers.linear.enabled.x")).toBeNull();
    expect(parseMcpField("mcp.other.linear.enabled")).toBeNull();
  });

  it("is the inverse of mcpKeyField", () => {
    expect(parseMcpField(mcpKeyField("docs", "toolExposure"))).toEqual({
      name: "docs",
      key: "toolExposure",
    });
  });
});
