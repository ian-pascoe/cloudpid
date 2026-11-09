// docs/architecture/mcp-endpoint.md → The handler, Access and identity: what `/mcp` hands `McpServer`.
// @effect-diagnostics asyncFunction:off preferEffectArray:off missedPipeableOpportunity:off globalDate:off
import {
  DEFAULT_ENVIRONMENT,
  type EnvironmentRecord,
  type SessionRecord,
  type SubmitRequest,
} from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import { describe, expect, it } from "vitest";
import { AccessCaller, type Caller } from "../access.ts";
import {
  type HostCalls,
  harnessHosts,
  harnessRegistry,
  type RegistryCalls,
} from "../harness/registry.fixture.ts";
import { serveMcpRoute, type McpEndpoint } from "./endpoint.ts";

type Serve = McpEndpoint["server"]["serve"];

type Target = Parameters<Serve>[1];

type Served = { request: Request; target: Target };

/** What the test reads of the target the route builds. */
type ReadTarget = { readonly auth: string; readonly describe: () => object };

// SAFETY: the route's target is its own class, whose members are the ones `ReadTarget` names.
const readTarget = (target: Target | undefined) => target as ReadTarget | undefined;

const endpointOf = (serve: Serve, calls?: McpEndpoint["calls"]) =>
  // SAFETY: serving the route reads `server` and `calls` only; no case here makes a call that reaches the Registry or a Session.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- see above.
  ({
    registries: { getByName: () => ({}) },
    sessions: { getByName: () => ({}) },
    server: { serve },
    calls,
    // `cloudflare:workers` is not loadable under Node: a plain class stands in for its `RpcTarget`.
    loadRpcTarget: () => Promise.resolve({ RpcTarget: class {} }),
  }) as unknown as McpEndpoint;

const call = (endpoint: McpEndpoint, request: Request, caller: Caller = { kind: "owner" }) =>
  Effect.runPromise(
    serveMcpRoute(endpoint).pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(request),
      ),
      Effect.provideService(AccessCaller, caller),
    ),
  );

const mcpRequest = () =>
  new Request("https://cloudpid.test/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-access-jwt-assertion": "jwt",
      "cf-access-client-id": "id",
      "cf-access-client-secret": "secret",
      "cf-access-authenticated-user-email": "me@example.com",
      "Cf-Access-Foo": "added-by-access-later",
      cookie: "CF_Authorization=x",
      authorization: "Bearer y",
      "mcp-protocol-version": "2025-11-25",
    },
    body: "{}",
  });

describe("the request McpServer gets", () => {
  it("is the caller's own with every identity header, cookie and Authorization removed", async () => {
    const served: Array<Served> = [];

    const response = await call(
      endpointOf((request, target) => {
        served.push({ request, target });

        return Promise.resolve(new Response("ok", { status: 202 }));
      }),
      mcpRequest(),
    );

    expect(response.status).toBe(202);

    const forwarded = served[0]?.request;

    expect(forwarded?.url).toBe("https://cloudpid.test/mcp");
    expect(forwarded?.method).toBe("POST");
    expect(forwarded?.headers.get("mcp-protocol-version")).toBe("2025-11-25");
    expect(forwarded?.headers.get("content-type")).toBe("application/json");

    for (const name of [
      "cf-access-jwt-assertion",
      "cf-access-client-id",
      "cf-access-client-secret",
      "cf-access-authenticated-user-email",
      "cf-access-foo",
      "cookie",
      "authorization",
    ]) {
      expect(forwarded?.headers.has(name)).toBe(false);
    }

    expect(await forwarded?.text()).toBe("{}");
  });

  it("is told who the caller is through the api target only", async () => {
    const targets: Array<Served["target"]> = [];

    await call(
      endpointOf((_request, target) => {
        targets.push(target);

        return Promise.resolve(new Response(null, { status: 202 }));
      }),
      mcpRequest(),
      { kind: "local" },
    );

    expect(readTarget(targets[0])?.auth).toBe("local");
    expect(readTarget(targets[0])?.describe()).toMatchObject({
      operations: [
        "environments",
        "sessions",
        "session",
        "transcript",
        "start",
        "send",
        "stop",
        "wait",
        "importBegin",
        "importAppend",
        "importFinish",
        "importCancel",
        "harness",
      ],
      harness: [
        "environment_list",
        "environment_get",
        "settings_get",
        "settings_mcp_list",
        "settings_mcp_get",
      ],
    });
  });
});

const SESSION = "0190f0a8-1b2c-7d3e-8f40-123456789abc";

/** What the fakes note of the calls the route makes for a start. */
interface Asked {
  readonly created: Array<CreateInput>;
  readonly submitted: Array<SubmitRequest>;
  readonly upkeep: Array<string>;
  readonly waited: Array<{ readonly after?: string; readonly deadline: number }>;
  readonly statuses: Array<{ readonly after?: string } | undefined>;
}

type CreateInput = Parameters<RegistryStub["createSession"]>[0];

type RegistryStub = {
  readonly listEnvironments: () => Effect.Effect<ReadonlyArray<EnvironmentRecord>>;
  readonly getSession: (input: { readonly id: string }) => Effect.Effect<SessionRecord | null>;
  readonly createSession: (input: {
    readonly workspace: object;
    readonly marks?: object;
    readonly maxRunning?: number | undefined;
    readonly requestId?: string | undefined;
  }) => Effect.Effect<
    SessionRecord | { readonly refused: "too-many-running"; readonly limit: number }
  >;
};

/** A Registry and a Session over fakes that note what they are asked; `refusal` is what `createSession` answers instead of a Session. */
const startEndpoint = (
  refusal?: {
    readonly refused: "too-many-running";
    readonly limit: number;
  },
  waiting: (request: {
    readonly after?: string;
    readonly deadline: number;
  }) => Effect.Effect<object> = () => Effect.succeed({ ok: true, value: {} }),
) => {
  const asked: Asked = { created: [], submitted: [], upkeep: [], waited: [], statuses: [] };

  const record: SessionRecord = {
    id: SESSION,
    title: null,
    titleSource: null,
    environment: DEFAULT_ENVIRONMENT,
    workspace: "abcd1234",
    status: "idle",
    createdAt: 1,
    updatedAt: 1,
    archivedAt: null,
  };

  const registry: RegistryStub = {
    listEnvironments: () =>
      Effect.succeed([{ id: DEFAULT_ENVIRONMENT, name: "Default", repos: [], createdAt: 1 }]),
    getSession: () => Effect.succeed(record),
    createSession: (input) => {
      asked.created.push(input);

      return Effect.succeed(refusal ?? record);
    },
  };

  const session = {
    submit: (input: SubmitRequest) => {
      asked.submitted.push(input);

      return Effect.succeed({ ok: true, value: { delivery: "started", cursor: "c1" } });
    },
    status: (request?: { readonly after?: string }) => {
      asked.statuses.push(request);

      return Effect.succeed({ ok: true, value: { status: "running", waiting: [], cursor: "c2" } });
    },
    waitForChange: (request: { readonly after?: string; readonly deadline: number }) => {
      asked.waited.push(request);

      return waiting(request);
    },
  };

  const upkeep = (kind: string) => (environment: string) =>
    Effect.sync(() => {
      asked.upkeep.push(`${kind} ${environment}`);
    });

  const base = endpointOf(() => Promise.resolve(new Response(null, { status: 202 })));

  // SAFETY: the route reads these stubs through the methods above only, as the other cases here read theirs.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- see above.
  const endpoint = {
    ...base,
    registries: { getByName: () => registry },
    sessions: { getByName: () => session },
    spares: { of: upkeep("spare") },
    builds: { of: upkeep("build") },
    background: (effect: Effect.Effect<void>) => effect,
  } as unknown as McpEndpoint;

  return { endpoint, asked };
};

/** The target's `start`, which the test calls as `McpServer` would over RPC. */
type Start = {
  readonly start: (request: {
    readonly text: string;
    readonly request_id: string;
    readonly via: { readonly client: { readonly name: string }; readonly era: "legacy" };
  }) => Promise<object>;
};

const startThrough = async (endpoint: McpEndpoint, caller: Caller) => {
  const targets: Array<Served["target"]> = [];

  // The route hands the target to `serve`; the test takes it from there.
  const serving: McpEndpoint = {
    ...endpoint,
    server: {
      serve: (_request, target) => {
        targets.push(target);

        return Promise.resolve(new Response(null, { status: 202 }));
      },
    },
  };

  await call(serving, mcpRequest(), caller);

  // SAFETY: the route's target is its own class, whose `start` is the one `Start` names.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- see above.
  const target = targets[0] as unknown as Start;

  return target.start({
    text: "Fix it",
    request_id: "req-1",
    via: { client: { name: "pi" }, era: "legacy" },
  });
};

describe("starting a Session through the target", () => {
  it("creates it marked and capped, tells the Session who sent the first message, and keeps the spare and Build coming", async () => {
    const { endpoint, asked } = startEndpoint();

    const result = await startThrough(endpoint, { kind: "owner", clientId: "dcr-1" });

    expect(asked.created).toEqual([
      {
        workspace: { kind: "new", environment: DEFAULT_ENVIRONMENT },
        marks: { kind: "mcp", auth: "oauth", client: { name: "pi" } },
        maxRunning: 10,
        requestId: "req-1",
      },
    ]);
    expect(asked.submitted).toEqual([
      {
        input: "Fix it",
        requestId: "req-1",
        via: { client: { name: "pi" }, auth: "oauth", era: "legacy", clientId: "dcr-1" },
      },
    ]);
    expect(asked.upkeep).toEqual(["spare default", "build default"]);
    expect(result).toMatchObject({ ok: true, value: { session_id: SESSION, cursor: "c1" } });
  });

  it("answers the running cap as too_many_running, and sends and prepares nothing", async () => {
    const { endpoint, asked } = startEndpoint({ refused: "too-many-running", limit: 10 });

    const result = await startThrough(endpoint, { kind: "local" });

    expect(result).toMatchObject({ ok: false, error: { code: "too_many_running" } });
    expect(asked.submitted).toEqual([]);
    expect(asked.upkeep).toEqual([]);
  });
});

/** The target's `wait`, which the test calls as `McpServer` would over RPC. */
type Wait = {
  readonly wait: (request: {
    readonly session_id: string;
    readonly after?: string;
    readonly timeout_s?: number;
  }) => Promise<object>;
};

const waitThrough = async (endpoint: McpEndpoint, after: string | undefined) => {
  const targets: Array<Served["target"]> = [];

  const serving: McpEndpoint = {
    ...endpoint,
    server: {
      serve: (_request, target) => {
        targets.push(target);

        return Promise.resolve(new Response(null, { status: 202 }));
      },
    },
  };

  await call(serving, mcpRequest(), { kind: "owner" });

  // SAFETY: the route's target is its own class, whose `wait` is the one `Wait` names.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- see above.
  const target = targets[0] as unknown as Wait;

  return target.wait(
    after === undefined
      ? { session_id: SESSION, timeout_s: 30 }
      : { session_id: SESSION, after, timeout_s: 30 },
  );
};

describe("waiting on a Session through the target", () => {
  it("hands the Session the cursor held and a deadline, and answers what it ended with", async () => {
    const ended = {
      status: "idle",
      ended_by: "run_ended",
      waiting: [],
      activity: { entries: 1, tool_calls: 0, latest: [] },
      cursor: "c-end",
    };

    const { endpoint, asked } = startEndpoint(undefined, () =>
      Effect.succeed({ ok: true, value: ended }),
    );

    const result = await waitThrough(endpoint, "c-held");

    expect(asked.waited).toHaveLength(1);
    expect(asked.waited[0]?.after).toBe("c-held");
    expect(asked.waited[0]?.deadline).toBeGreaterThan(Date.now());
    expect(result).toEqual({ ok: true, value: { session_id: SESSION, ...ended } });
    expect(asked.statuses).toEqual([]);
  });
});

/** The arguments of a management tool, as the cases here send them. */
type HarnessInput = Readonly<Record<string, string | number>>;

/** The target's `harness`, which the test calls as `McpServer` would over RPC. */
type Harness = {
  readonly harness: (request: {
    readonly tool: string;
    readonly input: HarnessInput;
    readonly via: { readonly client: { readonly name: string }; readonly era: "modern" };
  }) => Promise<{
    readonly ok: boolean;
    readonly value?: { readonly text: string; readonly structured: object };
    readonly error?: { readonly code: string };
  }>;
};

/** The route over a stand-in Registry and McpHost namespace, and its target's `harness`. */
const harnessThrough = async () => {
  const registryCalls: RegistryCalls = [];
  const hostCalls: HostCalls = [];
  const targets: Array<Served["target"]> = [];

  const base = endpointOf((_request, target) => {
    targets.push(target);

    return Promise.resolve(new Response(null, { status: 202 }));
  });

  const registry = harnessRegistry(registryCalls);

  // SAFETY: serving the route and calling `harness` read the Registry and the hosts through the stand-ins' methods only.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- see above.
  const endpoint = {
    ...base,
    registries: { getByName: () => registry },
    mcpHosts: harnessHosts(hostCalls),
    appOrigin: "https://cloudpid.test",
  } as unknown as McpEndpoint;

  await call(endpoint, mcpRequest(), { kind: "owner", clientId: "dcr-1" });

  // SAFETY: the route's target is its own class, whose `harness` is the one `Harness` names.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- see above.
  const target = targets[0] as unknown as Harness;

  return {
    registryCalls,
    hostCalls,
    ask: (tool: string, input: HarnessInput) =>
      target.harness({ tool, input, via: { client: { name: "pi" }, era: "modern" } }),
  };
};

describe("the management tools through the target", () => {
  it("answers all five reads from the Registry and the hosts alone, with nothing marked a Session's own", async () => {
    const { ask, registryCalls, hostCalls } = await harnessThrough();

    const asked: ReadonlyArray<readonly [string, HarnessInput]> = [
      ["environment_list", {}],
      ["environment_get", { id: "default" }],
      ["settings_get", { scope: "default" }],
      ["settings_mcp_list", { scope: "default" }],
      ["settings_mcp_get", { scope: "default", name: "docs" }],
    ];

    for (const [tool, input] of asked) {
      const answer = await ask(tool, input);

      expect(answer.ok, tool).toBe(true);
      expect(answer.value?.text.length, tool).toBeGreaterThan(0);
      expect(answer.value?.text, tool).not.toContain("this Session's");

      const structured = JSON.stringify(answer.value?.structured);

      for (const mark of ["is_own", "own_environment", '"current"']) {
        expect(structured, `${tool} ${mark}`).not.toContain(mark);
      }
    }

    // Only reads reached the Registry, and only the Environment's own host was asked.
    expect(registryCalls.length).toBeGreaterThan(0);
    expect(registryCalls.every((method) => /^(list|get|mcp)/.test(method))).toBe(true);
    expect(new Set(hostCalls.map(({ host }) => host))).toEqual(new Set(["mcp:default"]));
  });

  it("answers an id that names nothing as not_found, and a tool it does not serve as unsupported", async () => {
    const { ask } = await harnessThrough();

    expect(await ask("environment_get", { id: "ghost" })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    expect(await ask("settings_get", { scope: "ghost" })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    expect(await ask("environment_variable_set", { id: "default" })).toMatchObject({
      ok: false,
      error: { code: "unsupported" },
    });
  });

  it("reads a page of a field, whole, with where the next begins", async () => {
    const { ask } = await harnessThrough();

    const answer = await ask("environment_get", { id: "default", field: "setupScript" });

    expect(answer.value?.structured).toMatchObject({
      id: "default",
      field: "setupScript",
      offset: 0,
      next_offset: 40_000,
    });
    expect(answer.value?.text).toContain("pass offset 40000 for the next page");
  });
});

describe("when McpServer cannot answer", () => {
  it("is a 503 with a JSON-RPC error and a Retry-After", async () => {
    const response = await call(
      endpointOf(() => Promise.reject(new Error("not deployed"))),
      mcpRequest(),
    );

    expect(response.status).toBe(503);
    expect(response.headers["retry-after"]).toBeDefined();
  });
});
