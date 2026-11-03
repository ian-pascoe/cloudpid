// docs/architecture/mcp-endpoint.md → The handler, Tools, Limits and errors, Telemetry and testing: `serveMcp` on a fake `api`.
/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-known-value-widening, anti-slop/no-conditional-empty-object-spread, anti-slop/no-runtime-typeof -- JSON-RPC messages are read as the client reads them, and the fake `api` is cut down to what a test exercises. */
// @effect-diagnostics asyncFunction:off preferEffectArray:off missedPipeableOpportunity:off globalDate:off preferEffectRecord:off
import { apiFailure, apiOk, MCP_API_LIMITS } from "@cloudpid/protocol/mcp-api";
import { describe, expect, it, vi } from "vitest";
import { clientOf } from "./caller.ts";
import {
  DESCRIBE_TTL_MS,
  instructionsFor,
  type McpObserver,
  type McpServerApi,
  serveMcp,
  toolGate,
} from "./handler.ts";
import { renderEnvironments, renderSessions, renderTranscript } from "./render.ts";
import { TOOLS } from "./tools.ts";

const ID = "0190f0a8-1b2c-7d3e-8f40-123456789abc";
const URL_ = "https://cloudpid.test/mcp";

const summary = {
  session_id: ID,
  title: "Fix the thing",
  environment: { id: "default", name: "Default" },
  status: "idle" as const,
  updated_at: "2026-01-01T00:00:00.000Z",
  archived: false,
  url: `https://cloudpid.test/sessions/${ID}`,
};

const OPERATIONS = ["environments", "sessions", "session", "transcript"];

const fakeApi = (overrides: Partial<McpServerApi> = {}): McpServerApi => ({
  describe: () => ({ operations: OPERATIONS, limits: MCP_API_LIMITS }) as never,
  environments: () =>
    Promise.resolve(
      apiOk({
        environments: [
          {
            id: "default",
            name: "Default",
            default: true,
            repos: [{ name: "app", url: "https://github.com/a/app" }],
            running_sessions: 1,
          },
        ],
        models: { available: ["m1"], default: "m1" },
      }),
    ),
  sessions: () => Promise.resolve(apiOk({ sessions: [summary], next_cursor: "cur" })),
  session: () => Promise.resolve(apiFailure("not_found", "No Session.")),
  transcript: (request) =>
    Promise.resolve(
      apiOk({
        session_id: request.session_id,
        entries: [{ entry_id: 1, role: "user" as const, at: "", text: "x".repeat(20_000) }],
        newer: "n1",
      }),
    ),
  auth: "service_token",
  ...overrides,
});

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(URL_, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-11-25",
      ...headers,
    },
    body: JSON.stringify(body),
  });

const rpc = (method: string, params: unknown = {}, id = 1) => ({
  jsonrpc: "2.0",
  id,
  method,
  params,
});

/** The one JSON-RPC message of a response, whether it came as JSON or as one SSE event. */
const messageOf = async (response: Response) => {
  const text = await response.text();

  const data = text.startsWith("{")
    ? text
    : (text
        .split("\n")
        .find((line) => line.startsWith("data:"))
        ?.slice(5) ?? "{}");

  return JSON.parse(data) as {
    result?: Record<string, any>;
    error?: { code: number; message: string };
  };
};

const gate = () => toolGate();

const serve = (request: Request, api = fakeApi(), observe?: McpObserver) =>
  serveMcp(request, {
    api,
    version: "v1",
    gate: gate(),
    ...(observe === undefined ? {} : { observe }),
  });

const call = async (name: string, args: unknown, api = fakeApi(), observe?: McpObserver) => {
  const response = await serve(post(rpc("tools/call", { name, arguments: args })), api, observe);

  return (await messageOf(response)).result as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
    structuredContent: Record<string, any>;
  };
};

describe("the HTTP surface", () => {
  it.each(["GET", "DELETE", "PUT"])("answers %s with 405 and an Allow header", async (method) => {
    const response = await serve(new Request(URL_, { method }));

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it("answers 400 for an Origin or Host that is not the endpoint's own", async () => {
    expect((await serve(post(rpc("ping"), { origin: "https://evil.test" }))).status).toBe(400);
    expect((await serve(post(rpc("ping"), { host: "evil.test" }))).status).toBe(400);
    expect((await serve(post(rpc("ping"), { origin: "https://cloudpid.test" }))).status).not.toBe(
      400,
    );
  });

  it("answers 413 for a body over the cap", async () => {
    const response = await serve(
      new Request(URL_, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "content-length": String(6 * 1024 * 1024),
        },
        body: "x".repeat(6 * 1024 * 1024),
      }),
    );

    expect(response.status).toBe(413);
  });
});

describe("tools/list", () => {
  it("lists the four read tools, read-only, with input and output schemas", async () => {
    const response = await serve(post(rpc("tools/list")));
    const { result } = await messageOf(response);
    const tools = result?.["tools"] as Array<Record<string, any>>;

    expect(tools.map((tool) => tool["name"])).toEqual([
      "environments_list",
      "sessions_list",
      "session_get",
      "session_transcript",
    ]);

    for (const tool of tools) {
      expect(tool["annotations"]).toMatchObject({ readOnlyHint: true, openWorldHint: false });
      expect(tool["inputSchema"]["type"]).toBe("object");
      expect(tool["outputSchema"]["type"]).toBe("object");
    }
  });

  it("leaves a tool out when the deployed Server does not list its operation", async () => {
    const api = fakeApi({
      describe: () =>
        ({ operations: ["environments", "sessions", "session"], limits: MCP_API_LIMITS }) as never,
    });

    const { result } = await messageOf(await serve(post(rpc("tools/list")), api));

    const names = (result?.["tools"] ?? []).map((tool: { name: string }) => tool.name);

    expect(names).not.toContain("session_transcript");
  });

  it("serves no tools when describe() fails", async () => {
    const api = fakeApi({ describe: () => Promise.reject(new Error("rpc down")) as never });
    const { result } = await messageOf(await serve(post(rpc("tools/list")), api));

    expect(result?.["tools"]).toEqual([]);
  });
});

describe("initialize", () => {
  it("answers with tools only, the server's info and instructions within 1,500 characters", async () => {
    const { result } = await messageOf(
      await serve(
        post(
          rpc("initialize", {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "test", version: "1" },
          }),
        ),
      ),
    );

    expect(result?.["serverInfo"]).toMatchObject({ name: "cloudpid", version: "v1" });
    expect(Object.keys(result?.["capabilities"])).toEqual(["tools"]);
    expect(result?.["capabilities"]["tools"]).toEqual({ listChanged: false });

    const instructions = result?.["instructions"] as string;

    expect(instructions.length).toBeLessThanOrEqual(1500);
    expect(instructions.split("\n")[0]).toMatch(/^cloudpid: /);
  });
});

describe("the instructions", () => {
  it("are one line when only environments_list is served, and name no tool that is not", () => {
    const text = instructionsFor(new Set(["environments_list"]));

    expect(text).not.toContain("session_start");
    expect(text).not.toContain("session_wait");
    expect(text).not.toContain("session_get");
  });

  it("stay within 1,500 characters with every tool served", () => {
    const all = new Set(TOOLS.map((tool) => tool.name));

    expect(instructionsFor(all).length).toBeLessThanOrEqual(1500);
    expect(instructionsFor(all).split("\n")[0]?.length).toBeLessThan(200);
  });
});

describe("the tool gate", () => {
  it("keeps describe() for its TTL, then asks again", async () => {
    let now = 0;
    const describe_ = vi.fn(() => ({ operations: OPERATIONS, limits: MCP_API_LIMITS }) as never);
    const api = fakeApi({ describe: describe_ });
    const keep = toolGate({ now: () => now });

    expect((await keep(api)).size).toBe(4);
    now += DESCRIBE_TTL_MS - 1;
    await keep(api);
    expect(describe_).toHaveBeenCalledTimes(1);
    now += 2;
    await keep(api);
    expect(describe_).toHaveBeenCalledTimes(2);
  });

  it("asks again at once after a failure", async () => {
    const describe_ = vi
      .fn()
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValue({ operations: OPERATIONS, limits: MCP_API_LIMITS });

    const keep = toolGate();

    expect((await keep(fakeApi({ describe: describe_ }))).size).toBe(0);
    expect((await keep(fakeApi({ describe: describe_ }))).size).toBe(4);
  });
});

describe("tools/call", () => {
  it("answers text and structuredContent that say the same, with the next sentence in both", async () => {
    const result = await call("sessions_list", {});

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("Fix the thing");
    expect(result.content[0]?.text).toContain(`Call sessions_list again with cursor "cur"`);
    expect(result.structuredContent["next"]).toContain(`cursor "cur"`);
    expect(result.content[0]?.text.endsWith(result.structuredContent["next"])).toBe(true);
    expect(result.structuredContent["sessions"][0]["session_id"]).toBe(ID);
  });

  it("names only the tools that are served in the next sentence", async () => {
    const api = fakeApi({
      describe: () =>
        ({ operations: ["environments", "sessions"], limits: MCP_API_LIMITS }) as never,
    });

    const result = await call("sessions_list", {}, api);

    expect(result.content[0]?.text).not.toContain("session_get");
    expect(result.content[0]?.text).not.toContain("session_transcript");
  });

  it("answers a domain failure as isError with its code, whose text is its sentence", async () => {
    const result = await call("session_get", { session_id: ID });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("No Session.");
    expect(result.structuredContent["error"]).toMatchObject({
      code: "not_found",
      retryable: false,
    });
  });

  it("cuts a long result's text in the middle, but never a transcript's", async () => {
    const envs = await call(
      "environments_list",
      {},
      fakeApi({
        environments: () =>
          Promise.resolve(
            apiOk({
              environments: [
                {
                  id: "default",
                  name: "D",
                  default: true,
                  repos: Array.from({ length: 400 }, (_, i) => ({
                    name: `repo-${i}`,
                    url: `https://github.com/a/repo-${i}-${"x".repeat(30)}`,
                  })),
                  running_sessions: 0,
                },
              ],
              models: { available: ["m1"] },
            }),
          ),
      }),
    );

    expect(envs.content[0]?.text.length).toBeLessThanOrEqual(12_000);
    expect(envs.content[0]?.text).toContain("[... cut ...]");

    const transcript = await call("session_transcript", { session_id: ID });

    expect(transcript.content[0]?.text.length).toBeGreaterThan(20_000);
    expect(transcript.content[0]?.text).not.toContain("[... cut ...]");
  });

  it("answers rate_limited with retry_after_s, without calling the operation", async () => {
    const environments = vi.fn();

    const result = await call(
      "environments_list",
      {},
      fakeApi({ environments, limited: { retryAfterS: 60 } }),
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent["error"]).toMatchObject({
      code: "rate_limited",
      retryable: true,
      details: { retry_after_s: 60 },
    });
    expect(environments).not.toHaveBeenCalled();
  });

  it("answers an `api` that fails over RPC as unavailable, or unsupported for a method it lacks", async () => {
    const down = await call(
      "sessions_list",
      {},
      fakeApi({ sessions: () => Promise.reject(new Error("socket closed")) }),
    );

    const old = await call(
      "sessions_list",
      {},
      fakeApi({
        sessions: () =>
          Promise.reject(new Error('The RPC receiver does not implement the method "sessions".')),
      }),
    );

    expect(down.structuredContent["error"]).toMatchObject({ code: "unavailable", retryable: true });
    expect(old.structuredContent["error"]).toMatchObject({ code: "unsupported" });
  });

  it("answers an operation's `unsupported` as a value", async () => {
    const result = await call(
      "sessions_list",
      {},
      fakeApi({ sessions: () => Promise.resolve(apiFailure("unsupported", "Not yet.")) }),
    );

    expect(result.structuredContent["error"]).toMatchObject({ code: "unsupported" });
  });

  it("answers an answer it cannot read as unavailable", async () => {
    const result = await call(
      "sessions_list",
      {},
      fakeApi({ sessions: () => Promise.resolve({ ok: true, value: 7 } as never) }),
    );

    expect(result.structuredContent["error"]).toMatchObject({ code: "unavailable" });
  });

  it("refuses arguments that do not match the schema", async () => {
    const response = await serve(post(rpc("tools/call", { name: "session_get", arguments: {} })));
    const message = await messageOf(response);

    expect(message.error !== undefined || message.result?.["isError"] === true).toBe(true);
  });
});

describe("the telemetry", () => {
  it("is a span per tools/call and a count for every other request, with no argument text", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const requests: Array<Record<string, unknown>> = [];

    const observe: McpObserver = {
      request: (attributes) => void requests.push(attributes),
      call: async (attributes, run) => {
        const record: Record<string, unknown> = { ...attributes };

        calls.push(record);

        return run((more) => void Object.assign(record, more));
      },
    };

    await call("session_get", { session_id: ID }, fakeApi(), observe);
    await serve(post(rpc("tools/list")), fakeApi(), observe);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      tool: "session_get",
      era: "legacy",
      session_id: ID,
      auth: "service_token",
      outcome: "not_found",
    });
    expect(typeof calls[0]?.["bytes_sent"]).toBe("number");
    expect(requests).toEqual([{ method: "tools/list", era: "legacy" }]);
  });
});

describe("the Modern lane", () => {
  it("serves tools/list and tools/call from the header and _meta alone, with no initialize", async () => {
    const meta = {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "modern-client", version: "2" },
      "io.modelcontextprotocol/clientCapabilities": {},
    };

    const headers = { "mcp-protocol-version": "2026-07-28" };

    const list = await messageOf(
      await serve(
        post(rpc("tools/list", { _meta: meta }), { ...headers, "mcp-method": "tools/list" }),
      ),
    );

    expect(list.result?.["tools"]).toHaveLength(4);

    const observed: Array<Record<string, unknown>> = [];

    const observe: McpObserver = {
      request: () => undefined,
      call: (attributes, run) => {
        observed.push(attributes);

        return run(() => undefined);
      },
    };

    const response = await serve(
      post(rpc("tools/call", { name: "environments_list", arguments: {}, _meta: meta }), {
        ...headers,
        "mcp-method": "tools/call",
        "mcp-name": "environments_list",
      }),
      fakeApi(),
      observe,
    );

    const message = await messageOf(response);

    expect(message.result?.["structuredContent"]["environments"][0]["id"]).toBe("default");
    expect(observed[0]).toMatchObject({ era: "modern", "client.name": "modern-client" });
  });
});

describe("the client's name", () => {
  const headers = (init: Record<string, string>) => new Headers(init);

  it("is the X-Cloudpid-Client header first, then the body's client info, then a User-Agent product", () => {
    const body = { params: { clientInfo: { name: "from-body", version: "9" } } };

    expect(
      clientOf(headers({ "x-cloudpid-client": "pi/1.5", "user-agent": "Foo/1" }), body),
    ).toEqual({
      name: "pi",
      version: "1.5",
    });
    expect(clientOf(headers({ "user-agent": "Foo/1" }), body)).toEqual({
      name: "from-body",
      version: "9",
    });
    expect(
      clientOf(headers({ "user-agent": "claude-code/2.0 (external, cli)" }), undefined),
    ).toEqual({
      name: "claude-code",
      version: "2.0",
    });
  });

  it("skips libraries and browsers, and says none when nothing names the client", () => {
    expect(clientOf(headers({ "user-agent": "node" }), undefined)).toBeUndefined();
    expect(clientOf(headers({ "user-agent": "undici" }), undefined)).toBeUndefined();
    expect(
      clientOf(headers({ "user-agent": "Mozilla/5.0 (X11) Chrome/120 Safari/537" }), undefined),
    ).toBeUndefined();
    expect(clientOf(headers({}), undefined)).toBeUndefined();
  });

  it("is short and printable, and never carries markup", () => {
    const named = clientOf(
      headers({ "x-cloudpid-client": `<script>"${"a".repeat(80)}"</script>/1` }),
      undefined,
    );

    expect(named?.name).not.toMatch(/[<>"\n]/);
    expect(named?.name.length).toBeLessThanOrEqual(40);
  });
});

describe("the renderings", () => {
  it("say an empty page, the default model, and an empty transcript", () => {
    expect(renderSessions({ sessions: [] })).toBe("No Sessions match.");
    expect(
      renderEnvironments({ environments: [], models: { available: ["a", "b"], default: "a" } }),
    ).toContain("a, b (default a)");
    expect(renderTranscript({ session_id: ID, entries: [], newer: "n" })).toContain("(no entries)");
  });
});
