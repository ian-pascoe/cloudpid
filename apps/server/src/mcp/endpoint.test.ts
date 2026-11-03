// docs/architecture/mcp-endpoint.md → The handler, Access and identity: what `/mcp` hands `McpServer`.
// @effect-diagnostics asyncFunction:off preferEffectArray:off missedPipeableOpportunity:off
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
      { kind: "service_token", clientId: "id.access" },
    );

    expect(readTarget(targets[0])?.auth).toBe("service_token");
    expect(readTarget(targets[0])?.describe()).toMatchObject({
      operations: ["environments", "sessions", "session", "transcript", "start", "send", "stop"],
    });
  });
});

const SESSION = "0190f0a8-1b2c-7d3e-8f40-123456789abc";

/** What the fakes note of the calls the route makes for a start. */
interface Asked {
  readonly created: Array<CreateInput>;
  readonly submitted: Array<SubmitRequest>;
  readonly upkeep: Array<string>;
}

type CreateInput = Parameters<RegistryStub["createSession"]>[0];

type RegistryStub = {
  readonly listEnvironments: () => Effect.Effect<ReadonlyArray<EnvironmentRecord>>;
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
const startEndpoint = (refusal?: {
  readonly refused: "too-many-running";
  readonly limit: number;
}) => {
  const asked: Asked = { created: [], submitted: [], upkeep: [] };

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
    status: () =>
      Effect.succeed({ ok: true, value: { status: "running", waiting: [], cursor: "c2" } }),
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
