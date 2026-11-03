// docs/architecture/mcp-endpoint.md → The handler, Access and identity: what `/mcp` hands `McpServer`.
// @effect-diagnostics asyncFunction:off preferEffectArray:off missedPipeableOpportunity:off
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
      operations: ["environments", "sessions", "session", "transcript"],
    });
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
