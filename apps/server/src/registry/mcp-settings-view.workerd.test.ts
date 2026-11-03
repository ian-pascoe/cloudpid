// What the Registry tells a Session for `settings_mcp_list`, `settings_mcp_get` and `settings_mcp_reload`, over its real
// storage and a fake GitHub (`docs/architecture/mcp-configuration.md` → The agent's changes → Lists, Results; A Repo's
// `.pi/mcp.json`): the set as each Scope resolves it, each `${NAME}` an entry reads as a Secret, a Variable or missing (the
// names alone: no vault is opened and no value read), where each key is written, the sign-in without a token, and what an
// agent's reload found, a Repo that cannot be read keeping its last good copy. No Secret's sealed value, no Variable's
// value, no hash and no file text is in any of it.
// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off newPromise:off globalDate:off preferEffectRecord:off
import { runInDurableObject } from "cloudflare:test";
import {
  DEFAULT_ENVIRONMENT,
  type SettingsMcpReload,
  type SettingsMcpView,
} from "@cloudpid/protocol";
import { env } from "cloudflare:workers";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { GithubReadError } from "../github/skill-fetch.ts";
import { fakeGithub } from "../github/skill-repo.fixture.ts";
import { GLOBAL_DOCUMENT } from "./global.ts";
import { MCP_REPO_THROTTLE_MS } from "./mcp-repo-files.ts";
import { openMcpRepoLooks } from "./mcp-repo-look.ts";
import {
  mcpReloadReport,
  mcpReloadSnapshot,
  mcpSettingsView,
  type McpSettingsSignIns,
} from "./mcp-settings-view.ts";
import type { McpSignInRow } from "./mcp-sign-ins.ts";
import { updateSettingsOverrides, writeSettings } from "./settings.ts";
import type { TestRegistry } from "./store.fixture.ts";
import { openRegistryStore } from "./store.ts";

const STAGING = "5a5a5a5a";
const APP = { name: "app", url: "https://github.com/acme/app" };
const FILE = ".pi/mcp.json";

/** What a Secret's sealed value is, as the store keeps it: a stand-in that must never be in a result. */
const SEALED = {
  version: 1 as const,
  iv: "SEALED-IV-MARKER",
  ciphertext: "SEALED-CIPHERTEXT-MARKER",
};

/** What a Variable's value is: not a Secret, but a value, so not in a result either. */
const REGION_VALUE = "eu-west-1-variable-value";

const file = (servers: Schema.JsonObject) => JSON.stringify({ mcpServers: servers });

const DOCS = {
  url: "https://docs.example/mcp",
  headers: { "X-Key": "${GH_TOKEN}", "X-Region": "${REGION}" },
};

const LOCAL = { command: "node", args: ["server.js"] };

const NO_SIGN_INS: McpSettingsSignIns = { get: () => null };

const NOW = 1_000_000;

/** Run `body` over a fresh Registry's store: Default (with the Repo `app`) and Staging, with Secrets, Variables and servers set. */
const inRegistry = <A>(
  body: (registry: {
    readonly store: ReturnType<typeof openRegistryStore>;
    readonly github: ReturnType<typeof fakeGithub>;
    readonly looks: ReturnType<typeof openMcpRepoLooks>;
    readonly setGlobal: (overrides: Schema.Json) => void;
    readonly setOverrides: (environment: string, overrides: Schema.Json) => void;
  }) => Promise<A>,
) =>
  runInDurableObject(
    env.REGISTRIES.get(env.REGISTRIES.newUniqueId()),
    async (_: TestRegistry, state) => {
      const store = openRegistryStore(state.storage);
      const github = fakeGithub();

      store.createEnvironment(STAGING, "Staging", 10);
      store.addRepo(DEFAULT_ENVIRONMENT, APP);

      return body({
        store,
        github,
        looks: openMcpRepoLooks(store, github.reader),
        setGlobal: (overrides) => {
          const written = writeSettings(store, overrides, 5);

          if (Result.isFailure(written))
            throw new Error(`bad Global: ${JSON.stringify(written.failure)}`);
        },
        setOverrides: (environment, overrides) => {
          const saved = updateSettingsOverrides(state.storage, store, environment, {
            set: overrides,
          });

          if (saved === null || Result.isFailure(saved)) throw new Error("bad Overrides");
        },
      });
    },
  );

/** Everything a view says, as text. */
const shown = (view: SettingsMcpReload | SettingsMcpView | null): string => JSON.stringify(view);

const expectNoValues = (view: SettingsMcpReload | SettingsMcpView | null) => {
  const text = shown(view);

  expect(text).not.toContain("SEALED");
  expect(text).not.toContain(REGION_VALUE);
  // The Repo file's text is a copy the page never shows here.
  expect(text).not.toContain("mcpServers");
  expect(text).not.toMatch(/"text"/);
  expect(text).not.toMatch(/hash|toolsHash|conn/i);
};

/** An Environment set up as the tests below read it. */
const configured = (registry: Parameters<Parameters<typeof inRegistry>[0]>[0]) => {
  const { store, setGlobal, setOverrides } = registry;

  store.putEnvironmentSecret({ environment: null, name: "GLOBAL_TOKEN", sealed: SEALED }, 1);
  store.putEnvironmentSecret(
    { environment: DEFAULT_ENVIRONMENT, name: "GH_TOKEN", sealed: SEALED },
    1,
  );
  store.putEnvironmentSecret(
    { environment: DEFAULT_ENVIRONMENT, name: "DEFAULT_ONLY", sealed: SEALED },
    1,
  );

  // Variables are Container settings, kept in their own document at Global.
  store.putDocument(GLOBAL_DOCUMENT, JSON.stringify({ variables: { REGION: REGION_VALUE } }), 1);

  setGlobal({
    mcp: {
      servers: {
        shared: {
          url: "https://shared.example/mcp",
          headers: { Authorization: "Bearer ${GLOBAL_TOKEN}", "X-Only": "${DEFAULT_ONLY}" },
        },
        plain: { url: "https://plain.example/mcp" },
      },
    },
  });

  // Default: its own stdio server reading a Secret, and an adjustment of Global's `shared`.
  setOverrides(DEFAULT_ENVIRONMENT, {
    mcp: {
      servers: {
        local: { ...LOCAL, env: { TOKEN: "${GH_TOKEN}", REGION: "${REGION}", GONE: "${NOPE}" } },
        shared: { enabled: false, exposure: "direct" },
      },
    },
  });

  // Staging: its own full entry of `plain`, which replaces Global's.
  setOverrides(STAGING, {
    mcp: { servers: { plain: { url: "https://staging-plain.example/mcp" } } },
  });
};

describe("mcpSettingsView at an Environment", () => {
  it("marks each ${NAME} an entry reads as a Secret, a Variable or missing, by names alone", () =>
    inRegistry(async (registry) => {
      const { store, github, looks } = registry;

      configured(registry);
      github.push("acme/app", { [FILE]: file({ docs: DOCS }) });
      await looks.look({ environment: DEFAULT_ENVIRONMENT, reason: "moved", now: NOW });

      const view = mcpSettingsView(store, NO_SIGN_INS, { environment: DEFAULT_ENVIRONMENT }, NOW);

      expect(view).not.toBeNull();
      expect(view?.scope).toBe(DEFAULT_ENVIRONMENT);

      const byName = Object.fromEntries(
        (view?.servers ?? []).map((each) => [each.server.name, each]),
      );

      expect(Object.keys(byName).sort()).toEqual(["docs", "local", "plain", "shared"]);
      expect(byName["local"]?.reads).toEqual([
        { name: "GH_TOKEN", kind: "secret", where: ["env.TOKEN"] },
        { name: "NOPE", kind: "missing", where: ["env.GONE"] },
        { name: "REGION", kind: "variable", where: ["env.REGION"] },
      ]);
      // A Global entry reads Global's Secret, and the Environment's own.
      expect(byName["shared"]?.reads).toEqual([
        { name: "DEFAULT_ONLY", kind: "secret", where: ["headers.X-Only"] },
        { name: "GLOBAL_TOKEN", kind: "secret", where: ["headers.Authorization"] },
      ]);
      // A Repo's entry reads Variables only: a name that is a Secret is missing for it.
      expect(byName["docs"]?.reads).toEqual([
        { name: "GH_TOKEN", kind: "missing", where: ["headers.X-Key"] },
        { name: "REGION", kind: "variable", where: ["headers.X-Region"] },
      ]);
      expect(byName["docs"]?.server.source).toMatchObject({ kind: "repo", directory: "app" });
      expectNoValues(view);
    }));

  it("says where each key's value in force is written, and the fields settings_reset takes", () =>
    inRegistry(async (registry) => {
      configured(registry);

      const view = mcpSettingsView(
        registry.store,
        NO_SIGN_INS,
        { environment: DEFAULT_ENVIRONMENT },
        NOW,
      );

      const shared = view?.servers.find((each) => each.server.name === "shared");
      const local = view?.servers.find((each) => each.server.name === "local");

      expect(shared?.origins).toEqual({
        enabled: "environment_adjustment",
        exposure: "environment_adjustment",
        toolExposure: "default",
      });
      expect(shared?.resetFields).toEqual([
        "mcp.servers.shared.enabled",
        "mcp.servers.shared.exposure",
      ]);
      expect(local?.origins).toEqual({
        enabled: "default",
        exposure: "default",
        toolExposure: "default",
      });
      expect(local?.resetFields).toEqual([]);
    }));

  it("gives one server with its layers as written, the Repo entries it shadows among them", () =>
    inRegistry(async (registry) => {
      const { store, github, looks } = registry;

      configured(registry);
      github.push("acme/app", { [FILE]: file({ shared: DOCS, docs: DOCS }) });
      await looks.look({ environment: DEFAULT_ENVIRONMENT, reason: "moved", now: NOW });

      const view = mcpSettingsView(
        store,
        NO_SIGN_INS,
        { environment: DEFAULT_ENVIRONMENT, name: "shared" },
        NOW,
      );

      expect(view?.servers.map((each) => each.server.name)).toEqual(["shared"]);
      expect([...(view?.names ?? [])].sort()).toEqual(["docs", "local", "plain", "shared"]);
      expect(view?.layers?.global).toMatchObject({ kind: "entry" });
      expect(view?.layers?.environment).toMatchObject({
        kind: "adjustment",
        value: { enabled: false, exposure: "direct" },
      });
      expect(view?.layers?.repos).toEqual([
        expect.objectContaining({
          name: "shared",
          shadowed: true,
          kind: "entry",
          source: expect.objectContaining({ directory: "app", slug: "acme/app" }),
        }),
      ]);

      // A name that is no server's has no layers, and the names of the set to say what there is.
      const none = mcpSettingsView(
        store,
        NO_SIGN_INS,
        { environment: DEFAULT_ENVIRONMENT, name: "nope" },
        NOW,
      );

      expect(none?.servers).toEqual([]);
      expect(none?.layers).toBeNull();
      expect(none?.names.length).toBeGreaterThan(0);
    }));

  it("lists each Repo's file as last looked at, without its text, and never a hash", () =>
    inRegistry(async (registry) => {
      const { store, github, looks } = registry;

      configured(registry);
      github.push("acme/app", { [FILE]: file({ docs: DOCS }) });
      await looks.look({ environment: DEFAULT_ENVIRONMENT, reason: "moved", now: NOW });

      const view = mcpSettingsView(
        store,
        NO_SIGN_INS,
        { environment: DEFAULT_ENVIRONMENT },
        NOW + 5,
      );

      expect(view?.repos).toEqual([
        {
          repo: "app",
          slug: "acme/app",
          path: FILE,
          state: "read",
          blob: expect.any(String),
          readAt: NOW,
          lookedAt: NOW,
        },
      ]);
      expectNoValues(view);
    }));

  it("gives the MCP sign-in as a status, the issuer's host, its scopes and the client's kind, never a token or a URL", () =>
    inRegistry(async (registry) => {
      const { store } = registry;

      registry.setGlobal({ mcp: { servers: { oauthy: { url: "https://oauthy.example/mcp" } } } });

      const row: McpSignInRow = {
        key: {
          hash: "0".repeat(64),
          source: "owner",
          name: "oauthy",
          url: "https://oauthy.example/mcp",
        },
        grantId: "g1",
        status: "step_up",
        issuer: "https://auth.example.com/tenant-7?secret=1",
        resource: null,
        client: { id: "c1", kind: "registered", secretRef: null, registration: "reg" },
        scope: "read write",
        expiresAt: null,
        wantedScope: null,
        stepUpCount: 0,
        challenge: null,
        lastError: null,
        lastErrorAt: null,
        createdAt: 1,
        refreshedAt: null,
        usedAt: 1,
        hasTokens: true,
        metadata: "{}",
        discovery: "{}",
        sealed: SEALED,
      };

      const signIns: McpSettingsSignIns = { get: () => row };

      const view = mcpSettingsView(store, signIns, { environment: DEFAULT_ENVIRONMENT }, NOW);

      expect(view?.servers.find((each) => each.server.name === "oauthy")?.signIn).toEqual({
        status: "step_up",
        issuerHost: "auth.example.com",
        scopes: "read write",
        clientKind: "registered",
      });
      expect(shown(view)).not.toContain("tenant-7");
      expect(shown(view)).not.toContain("SEALED");
    }));

  it("is null for an Environment no one has", () =>
    inRegistry(async ({ store }) => {
      expect(mcpSettingsView(store, NO_SIGN_INS, { environment: "00000000" }, NOW)).toBeNull();
    }));
});

describe("mcpSettingsView at Global", () => {
  it("lists Global's own entries, which Environments replace or adjust them, and where a name is missing", () =>
    inRegistry(async (registry) => {
      const { store, github, looks } = registry;

      configured(registry);
      github.push("acme/app", { [FILE]: file({ docs: DOCS }) });
      await looks.look({ environment: DEFAULT_ENVIRONMENT, reason: "moved", now: NOW });

      const view = mcpSettingsView(store, NO_SIGN_INS, { environment: undefined }, NOW);

      const byName = Object.fromEntries(
        (view?.servers ?? []).map((each) => [each.server.name, each]),
      );

      expect(view).toMatchObject({ scope: "*", name: "Global", repos: [] });
      // Its own entries only: no Repo's server and no Environment's.
      expect(Object.keys(byName).sort()).toEqual(["plain", "shared"]);
      expect(byName["plain"]?.overriddenIn).toEqual([{ id: STAGING, name: "Staging" }]);
      expect(byName["shared"]?.adjustedIn).toEqual([
        { id: DEFAULT_ENVIRONMENT, name: expect.any(String) },
      ]);
      // `DEFAULT_ONLY` is a Secret of Default only: Staging lacks it, and Default does not.
      expect(byName["shared"]?.reads).toEqual([
        {
          name: "DEFAULT_ONLY",
          kind: "missing",
          where: ["headers.X-Only"],
          missingIn: expect.arrayContaining([{ id: STAGING, name: "Staging" }]),
        },
        { name: "GLOBAL_TOKEN", kind: "secret", where: ["headers.Authorization"], missingIn: [] },
      ]);
      expect(byName["shared"]?.resetFields).toEqual([]);
      expectNoValues(view);
    }));
});

describe("an agent's reload (the `agent` look)", () => {
  const reload = async (registry: Parameters<Parameters<typeof inRegistry>[0]>[0], now: number) => {
    const before = mcpReloadSnapshot(registry.store, DEFAULT_ENVIRONMENT, now);

    if (before === null) throw new Error("no Environment");

    await registry.looks.look({ environment: DEFAULT_ENVIRONMENT, reason: "agent", now });

    const after = mcpReloadSnapshot(registry.store, DEFAULT_ENVIRONMENT, now);

    if (after === null) throw new Error("no Environment");

    return mcpReloadReport(DEFAULT_ENVIRONMENT, before, after);
  };

  it("reads a Repo's file, says what changed in the set, and is held to the 30 s throttle", () =>
    inRegistry(async (registry) => {
      const { github } = registry;

      configured(registry);
      github.push("acme/app", { [FILE]: file({ docs: DOCS }) });

      const first = await reload(registry, NOW);

      expect(first.repos).toEqual([
        expect.objectContaining({
          directory: "app",
          slug: "acme/app",
          outcome: "changed",
          readAt: NOW,
          keptCopy: false,
        }),
      ]);
      expect(first.set.added).toEqual(["docs"]);

      // At once again: the Repo was looked at less than 30 s ago, so it is not read.
      github.reset();

      const recent = await reload(registry, NOW + 1_000);

      expect(recent.repos[0]?.outcome).toBe("recent");
      expect(recent.set).toMatchObject({ added: [], removed: [], changed: [] });
      expect(github.requests).toEqual([]);

      // The same file, later: looked at, not read again.
      const unchanged = await reload(registry, NOW + MCP_REPO_THROTTLE_MS);

      expect(unchanged.repos[0]?.outcome).toBe("unchanged");

      // The file changes: the server it adds shows, and the one it changes.
      github.push("acme/app", {
        [FILE]: file({ docs: { ...DOCS, url: "https://docs2.example/mcp" }, other: LOCAL }),
      });

      const changed = await reload(registry, NOW + 2 * MCP_REPO_THROTTLE_MS);

      expect(changed.repos[0]?.outcome).toBe("changed");
      expect(changed.set).toMatchObject({ added: ["other"], removed: [], changed: ["docs"] });
      expectNoValues(changed);
    }));

  it("keeps the last good copy of a Repo GitHub does not answer for: its servers stand, and the outcome says so", () =>
    inRegistry(async (registry) => {
      const { github, store } = registry;

      configured(registry);
      github.push("acme/app", { [FILE]: file({ docs: DOCS }) });
      await reload(registry, NOW);

      github.fail("acme/app", GithubReadError.of("failed", "GitHub answered 502"));

      const failed = await reload(registry, NOW + MCP_REPO_THROTTLE_MS);

      expect(failed.repos[0]).toMatchObject({
        outcome: "unreadable",
        error: "GitHub answered 502",
        errorSince: NOW + MCP_REPO_THROTTLE_MS,
        keptCopy: true,
        readAt: NOW,
      });
      // The copy stands: no server is removed, and no problem is made of it.
      expect(failed.set).toMatchObject({ removed: [], problemsAdded: [] });
      expect(
        mcpSettingsView(store, NO_SIGN_INS, { environment: DEFAULT_ENVIRONMENT }, NOW)?.servers.map(
          (each) => each.server.name,
        ),
      ).toContain("docs");

      // Only the owner's Reload drops the copy.
      await registry.looks.look({
        environment: DEFAULT_ENVIRONMENT,
        reason: "reload",
        now: NOW + 3 * MCP_REPO_THROTTLE_MS,
      });

      expect(
        mcpSettingsView(store, NO_SIGN_INS, { environment: DEFAULT_ENVIRONMENT }, NOW)?.servers.map(
          (each) => each.server.name,
        ),
      ).not.toContain("docs");
    }));

  it("says a file that is gone is absent, and its servers are removed", () =>
    inRegistry(async (registry) => {
      const { github } = registry;

      configured(registry);
      github.push("acme/app", { [FILE]: file({ docs: DOCS }) });
      await reload(registry, NOW);

      github.push("acme/app", { "README.md": "nothing" });

      const gone = await reload(registry, NOW + MCP_REPO_THROTTLE_MS);

      expect(gone.repos[0]?.outcome).toBe("absent");
      expect(gone.set.removed).toEqual(["docs"]);
    }));

  it("says a file that is not valid JSON is invalid, with the problem it makes", () =>
    inRegistry(async (registry) => {
      const { github } = registry;

      configured(registry);
      github.push("acme/app", { [FILE]: "{ not json" });

      const invalid = await reload(registry, NOW);

      expect(invalid.repos[0]?.outcome).toBe("invalid");
      expect(invalid.set.problemsAdded.length).toBeGreaterThan(0);
    }));

  it("is null for an Environment no one has", () =>
    inRegistry(async ({ store }) => {
      expect(mcpReloadSnapshot(store, "00000000", NOW)).toBeNull();
    }));
});
