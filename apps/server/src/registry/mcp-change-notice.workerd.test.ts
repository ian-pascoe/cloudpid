// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off globalDate:off preferEffectArray:off
// The Notification for the changes an agent made over the MCP endpoint (`docs/architecture/mcp-endpoint.md` → After a
// change, and Notifications), through the real Registry's `notifyMcpChanges` (`registry.fixture.ts` runs `registryMethods`
// as deployed): nothing when the caller recorded nothing in the last 10 minutes, else its title, its body by Scope name,
// its tag and its link to the newest change.
import {
  type AgentChangeVia,
  DEFAULT_ENVIRONMENT,
  SETTINGS_SCOPE,
  variableField,
} from "@cloudpid/protocol";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { type AgentChangeAuthor, openAgentChanges } from "./agent-changes.ts";
import { MCP_NOTICE_WINDOW_MS } from "./mcp-change-notice.ts";
import type { RegistryMethods } from "./Registry.ts";
import type { RealRegistry } from "./registry.fixture.ts";

declare global {
  namespace Cloudflare {
    /** The bindings `vitest.config.ts` gives the test Worker. */
    interface Env {
      readonly REAL_REGISTRIES: DurableObjectNamespace<RealRegistry>;
    }
  }
}

const PI: AgentChangeVia = { auth: "oauth", client: { name: "pi", version: "1.2" } };
const CLAUDE: AgentChangeVia = { auth: "oauth", client: { name: "claude-code" } };

const authored = (via: AgentChangeVia, tool = "environment_variable_set"): AgentChangeAuthor => ({
  via,
  tool,
  reason: "The tests need it",
});

/** A fresh real Registry; `call` runs its method, and `recordAt` records a change it made at `at`, as an older call would have. */
const started = async () => {
  const stub = env.REAL_REGISTRIES.get(env.REAL_REGISTRIES.newUniqueId());

  const call = async <K extends keyof RegistryMethods>(
    method: K,
    ...input: Parameters<RegistryMethods[K]>
  ) => runInDurableObject(stub, (registry: RealRegistry) => registry.call(method, ...input));

  // The Registry's own store is opened (and migrated) by its first call.
  await call("agentChangeFeatures");

  return {
    call,
    setVariable: async (via: AgentChangeVia, name: string, environment = DEFAULT_ENVIRONMENT) =>
      call("changeEnvironment", {
        environment,
        change: { field: variableField(name), value: "1" },
        author: authored(via),
      }),
    setGlobalVariable: async (via: AgentChangeVia, name: string) =>
      call("changeGlobal", {
        change: { field: variableField(name), value: "1" },
        author: authored(via),
      }),
    recordAt: async (via: AgentChangeVia, field: string, at: number, scope = DEFAULT_ENVIRONMENT) =>
      runInDurableObject(stub, (_: RealRegistry, state) =>
        openAgentChanges(state.storage).record({
          scope,
          at,
          actor: "agent",
          session: null,
          conversation: null,
          tool: "environment_variable_set",
          reason: "Earlier",
          field,
          before: null,
          after: "1",
          reverts: null,
          via,
        }),
      ),
  };
};

describe("notifyMcpChanges", () => {
  it("sends nothing when the caller recorded nothing", async () => {
    const { call } = await started();

    expect(await call("notifyMcpChanges", { via: PI })).toBeNull();
  });

  it("sends a call's change: titled by the client, in the Scope's name, tagged by the caller, linking to the change", async () => {
    const { call, setVariable } = await started();

    expect(await setVariable(PI, "API_URL")).toMatchObject({ status: "changed" });

    expect(await call("notifyMcpChanges", { via: PI })).toEqual({
      title: "Changed over MCP · pi",
      body: "Default: variables.API_URL",
      url: "/settings/default/agent-changes#agent-change-1",
      tag: "mcp-changes:pi",
    });
  });

  it("groups the fields by Scope name and links to the newest change, in its Scope", async () => {
    const { call, setVariable, setGlobalVariable } = await started();

    await setVariable(PI, "API_URL");
    await setGlobalVariable(PI, "REGION");
    await setVariable(PI, "LOG_LEVEL");
    await setGlobalVariable(PI, "TZ");

    expect(await call("notifyMcpChanges", { via: PI })).toEqual({
      title: "Changed over MCP · pi",
      body: "Global: variables.TZ, variables.REGION; Default: variables.LOG_LEVEL, variables.API_URL",
      url: "/settings/all/agent-changes#agent-change-4",
      tag: "mcp-changes:pi",
    });
  });

  it("names the Settings' changes as their own group, linking to Global's list", async () => {
    const { call, recordAt } = await started();

    await recordAt(PI, "roles.small", Date.now(), SETTINGS_SCOPE);

    expect(await call("notifyMcpChanges", { via: PI })).toMatchObject({
      body: "Settings: roles.small",
      url: "/settings/all/agent-changes#agent-change-1",
    });
  });

  it("lists only the caller's own changes", async () => {
    const { call, setVariable } = await started();

    await setVariable(PI, "FROM_PI");
    await setVariable(CLAUDE, "FROM_CLAUDE");
    // A Session's agent's change, and the owner's, are no endpoint caller's.
    await call("changeEnvironment", {
      environment: DEFAULT_ENVIRONMENT,
      change: { field: variableField("FROM_SESSION"), value: "1" },
      author: { session: "s-1", conversation: 1, tool: "environment_variable_set", reason: "r" },
    });

    expect(await call("notifyMcpChanges", { via: PI })).toMatchObject({
      body: "Default: variables.FROM_PI",
      url: "/settings/default/agent-changes#agent-change-1",
    });

    expect(await call("notifyMcpChanges", { via: CLAUDE })).toMatchObject({
      title: "Changed over MCP · claude-code",
      body: "Default: variables.FROM_CLAUDE",
      url: "/settings/default/agent-changes#agent-change-2",
      tag: "mcp-changes:claude-code",
    });
  });

  it("tells callers by the owner's OAuth registration when there is one, tagging by it", async () => {
    const { call, setVariable } = await started();
    const first = { ...PI, clientId: "grant-1" };
    const second = { ...PI, clientId: "grant-2" };

    await setVariable(first, "ONE");
    await setVariable(second, "TWO");

    expect(await call("notifyMcpChanges", { via: first })).toMatchObject({
      body: "Default: variables.ONE",
      tag: "mcp-changes:grant-1",
    });

    expect(await call("notifyMcpChanges", { via: second })).toMatchObject({
      body: "Default: variables.TWO",
      tag: "mcp-changes:grant-2",
    });
  });

  it("keeps a caller with only a name apart from a caller of that name with a registration", async () => {
    const { call, setVariable } = await started();
    const registered = { ...PI, clientId: "grant-1" };

    await setVariable(PI, "NAME_ONLY");
    await setVariable(registered, "REGISTERED");

    expect(await call("notifyMcpChanges", { via: PI })).toMatchObject({
      body: "Default: variables.NAME_ONLY",
    });

    // A registration is told apart whatever name it gave.
    expect(await call("notifyMcpChanges", { via: registered })).toMatchObject({
      body: "Default: variables.REGISTERED",
    });

    expect(
      await call("notifyMcpChanges", { via: { auth: "oauth", clientId: "grant-1" } }),
    ).toMatchObject({ body: "Default: variables.REGISTERED", tag: "mcp-changes:grant-1" });
  });

  it("leaves a caller with neither a name nor a registration out of the changes that have one", async () => {
    const { call, setVariable } = await started();
    const nameless: AgentChangeVia = { auth: "oauth" };

    await setVariable(PI, "NAMED");
    await setVariable({ ...PI, clientId: "grant-1" }, "REGISTERED");
    await setVariable(nameless, "NEITHER");

    expect(await call("notifyMcpChanges", { via: nameless })).toMatchObject({
      body: "Default: variables.NEITHER",
      tag: "mcp-changes:oauth",
    });
  });

  it("titles a caller that gave no name plainly, tagged by how it got in", async () => {
    const { call, setVariable } = await started();
    const nameless: AgentChangeVia = { auth: "local" };

    await setVariable(nameless, "API_URL");

    expect(await call("notifyMcpChanges", { via: nameless })).toMatchObject({
      title: "Changed over MCP",
      tag: "mcp-changes:local",
    });
  });

  it("looks back 10 minutes only", async () => {
    const { call, recordAt } = await started();
    const now = Date.now();

    await recordAt(PI, "variables.OLD", now - MCP_NOTICE_WINDOW_MS - 60_000);
    expect(await call("notifyMcpChanges", { via: PI })).toBeNull();

    await recordAt(PI, "variables.RECENT", now - MCP_NOTICE_WINDOW_MS + 60_000);

    expect(await call("notifyMcpChanges", { via: PI })).toMatchObject({
      body: "Default: variables.RECENT",
    });
  });

  it("keeps the body to 140 characters", async () => {
    const { call, setVariable } = await started();

    for (let index = 0; index < 12; index += 1) {
      await setVariable(PI, `A_VERY_LONG_VARIABLE_NAME_NUMBER_${index}`);
    }

    const sent = await call("notifyMcpChanges", { via: PI });

    expect(sent?.body).toHaveLength(140);
    expect(sent?.body.startsWith("Default: ")).toBe(true);
  });

  it("goes on when a browser is subscribed whose push service cannot be reached", async () => {
    const { call, setVariable } = await started();

    await call("subscribePush", {
      subscription: {
        endpoint: "https://push.example.invalid/1",
        keys: { p256dh: "not a key", auth: "x" },
      },
    });

    await setVariable(PI, "API_URL");

    expect(await call("notifyMcpChanges", { via: PI })).toMatchObject({ tag: "mcp-changes:pi" });
  });
});
