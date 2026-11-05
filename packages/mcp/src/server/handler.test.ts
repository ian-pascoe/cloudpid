// docs/architecture/mcp-endpoint.md → The handler, Tools, Limits and errors, Telemetry and testing: `serveMcp` on a fake `api`.
// @effect-diagnostics asyncFunction:off preferEffectArray:off missedPipeableOpportunity:off globalDate:off preferEffectRecord:off newPromise:off
import { apiFailure, apiOk, MAX_MCP_RUNNING, MCP_API_LIMITS } from "@cloudpid/protocol/mcp-api";
import type * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vitest";
import { clientOf } from "./caller.ts";
import {
  DESCRIBE_TTL_MS,
  instructionsFor,
  type Attributes,
  type McpObserver,
  type McpServerApi,
  serveMcp,
  toolGate,
  unobserved,
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

const WRITE_OPERATIONS = [...OPERATIONS, "start", "send", "stop"];

const ALL_OPERATIONS = [...WRITE_OPERATIONS, "wait"];

const CURSOR = "cur-1";

/** `describe()` listing `operations`, and the deploy id when `Server` sends one. */
const describing =
  (operations: ReadonlyArray<string>, version?: string): McpServerApi["describe"] =>
  () => {
    const description = { operations, limits: MCP_API_LIMITS };

    return version === undefined ? description : { ...description, version };
  };

const fakeApi = (overrides: Partial<McpServerApi> = {}): McpServerApi => ({
  describe: describing(OPERATIONS),
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
  start: () => Promise.resolve(apiFailure("unsupported", "No.")),
  send: () => Promise.resolve(apiFailure("unsupported", "No.")),
  stop: () => Promise.resolve(apiFailure("unsupported", "No.")),
  wait: () => Promise.resolve(apiFailure("unsupported", "No.")),
  importBegin: () => Promise.resolve(apiFailure("unsupported", "No.")),
  importAppend: () => Promise.resolve(apiFailure("unsupported", "No.")),
  importFinish: () => Promise.resolve(apiFailure("unsupported", "No.")),
  importCancel: () => Promise.resolve(apiFailure("unsupported", "No.")),
  auth: "service_token",
  ...overrides,
});

const post = (body: Schema.Json, headers: Readonly<Record<string, string>> = {}) =>
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

const rpc = (method: string, params: Schema.Json = {}, id = 1) => ({
  jsonrpc: "2.0",
  id,
  method,
  params,
});

/** A tool as `tools/list` shows it. */
interface ListedTool {
  readonly name: string;
  readonly annotations: { readonly readOnlyHint?: boolean; readonly openWorldHint?: boolean };
  readonly inputSchema: { readonly type: string };
  readonly outputSchema: { readonly type: string };
}

/** What `structuredContent` holds of the results these tests read. */
interface Structured {
  readonly error?: { readonly code: string; readonly retryable: boolean };
  readonly next?: string;
  readonly sessions?: ReadonlyArray<{ readonly session_id: string }>;
  readonly environments?: ReadonlyArray<{ readonly id: string }>;
}

/** The result of `tools/call`. */
interface CallResult {
  readonly isError?: boolean;
  readonly content: ReadonlyArray<{ readonly type: string; readonly text: string }>;
  readonly structuredContent: Structured;
}

/** The JSON-RPC message of a response, as far as these tests read it. */
interface Message {
  readonly result?: Partial<CallResult> & {
    readonly tools?: ReadonlyArray<ListedTool>;
    readonly serverInfo?: { readonly name: string; readonly version: string };
    readonly capabilities?: { readonly tools?: { readonly listChanged: boolean } };
    readonly instructions?: string;
  };
  readonly error?: { readonly code: number; readonly message: string };
}

/** The one JSON-RPC message of a response, whether it came as JSON or as one SSE event. */
const messageOf = async (response: Response): Promise<Message> => {
  const text = await response.text();

  const data = text.startsWith("{")
    ? text
    : (text
        .split("\n")
        .find((line) => line.startsWith("data:"))
        ?.slice(5) ?? "{}");

  // SAFETY: the endpoint's own JSON-RPC answer, read as far as `Message` says.
  return JSON.parse(data) as Message;
};

const gate = () => toolGate();

const serve = (request: Request, api = fakeApi(), observe: McpObserver = unobserved) =>
  serveMcp(request, { api, version: "v1", gate: gate(), observe });

const call = async (
  name: string,
  args: Schema.Json,
  api = fakeApi(),
  observe?: McpObserver,
): Promise<CallResult> => {
  const response = await serve(post(rpc("tools/call", { name, arguments: args })), api, observe);

  // SAFETY: a `tools/call` that reached the tool answers a result; the tests that expect an error read `messageOf`.
  return (await messageOf(response)).result as CallResult;
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
    const tools = result?.tools ?? [];

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

  it("adds session_start, session_send and session_stop once the deployed Server lists them, with their annotations", async () => {
    const api = fakeApi({ describe: describing(WRITE_OPERATIONS) });
    const { result } = await messageOf(await serve(post(rpc("tools/list")), api));
    const tools = result?.tools ?? [];

    expect(tools.map((tool) => tool.name)).toEqual([
      "environments_list",
      "sessions_list",
      "session_get",
      "session_transcript",
      "session_start",
      "session_send",
      "session_stop",
    ]);

    const annotated = Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations]));

    // W: a write that is not idempotent, open-world; D·idem: destructive and idempotent.
    expect(annotated["session_start"]).toMatchObject({
      readOnlyHint: false,
      idempotentHint: false,
      destructiveHint: false,
      openWorldHint: true,
    });
    expect(annotated["session_send"]).toMatchObject({ readOnlyHint: false, openWorldHint: true });
    expect(annotated["session_stop"]).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(annotated["sessions_list"]).toMatchObject({ readOnlyHint: true, openWorldHint: false });
  });

  it("leaves the three out one by one when an older Server lacks their operations", async () => {
    const api = fakeApi({ describe: describing([...OPERATIONS, "send"]) });
    const { result } = await messageOf(await serve(post(rpc("tools/list")), api));

    const names = (result?.tools ?? []).map((tool) => tool.name);

    expect(names).toContain("session_send");
    expect(names).not.toContain("session_start");
    expect(names).not.toContain("session_stop");
  });

  it("leaves a tool out when the deployed Server does not list its operation", async () => {
    const api = fakeApi({
      describe: describing(["environments", "sessions", "session"]),
    });

    const { result } = await messageOf(await serve(post(rpc("tools/list")), api));

    const names = (result?.tools ?? []).map((tool: { name: string }) => tool.name);

    expect(names).not.toContain("session_transcript");
  });

  it("serves no tools when describe() fails", async () => {
    const api = fakeApi({ describe: () => Promise.reject(new Error("rpc down")) });
    const { result } = await messageOf(await serve(post(rpc("tools/list")), api));

    expect(result?.tools).toEqual([]);
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

    expect(result?.serverInfo).toMatchObject({ name: "cloudpid", version: "v1" });
    expect(Object.keys(result?.capabilities ?? {})).toEqual(["tools"]);
    expect(result?.capabilities?.tools).toEqual({ listChanged: false });

    const instructions = result?.instructions ?? "";

    expect(instructions.length).toBeLessThanOrEqual(1500);
    expect(instructions.split("\n")[0]).toMatch(/^cloudpid: /);
  });
});

describe("serverInfo.version", () => {
  const initialize = (api: McpServerApi) =>
    serve(
      post(
        rpc("initialize", {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        }),
      ),
      api,
    ).then(messageOf);

  it("is Server's deploy id when its describe() sends one", async () => {
    const { result } = await initialize(
      fakeApi({
        describe: describing(OPERATIONS, "server-9"),
      }),
    );

    expect(result?.serverInfo?.version).toBe("server-9");
  });

  it("is McpWorker's own version id when an older Server sends none", async () => {
    const { result } = await initialize(fakeApi());

    expect(result?.serverInfo?.version).toBe("v1");
  });
});

describe("the instructions", () => {
  it("are one line when only environments_list is served, and name no tool that is not", () => {
    const text = instructionsFor(new Set(["environments_list"]));

    expect(text).not.toContain("session_start");
    expect(text).not.toContain("session_wait");
    expect(text).not.toContain("session_get");
  });

  it("name the write tools and request_id only when they are served", () => {
    const writes = instructionsFor(
      new Set(["environments_list", "session_start", "session_send", "session_stop"]),
    );

    expect(writes).toContain("request_id");
    expect(writes).toContain("session_stop");
    expect(instructionsFor(new Set(["environments_list"]))).not.toContain("request_id");
    expect(instructionsFor(new Set(["environments_list", "session_get"]))).not.toContain(
      "session_stop",
    );
  });

  it("stay within 1,500 characters with every tool served", () => {
    const all = new Set(TOOLS.map((tool) => tool.name));

    expect(instructionsFor(all).length).toBeLessThanOrEqual(1500);
    expect(instructionsFor(all).split("\n")[0]?.length).toBeLessThan(200);
  });
});

describe("the write tools", () => {
  const started = {
    session_id: ID,
    title: null,
    url: `https://cloudpid.test/sessions/${ID}`,
    status: "running" as const,
    cursor: CURSOR,
    environment: { id: "default", name: "Default", repos: ["app"] },
  };

  const writing = (overrides: Partial<McpServerApi> = {}) =>
    fakeApi({ describe: describing(WRITE_OPERATIONS), ...overrides });

  it("session_start tells the api who is calling, from the client's name and the era, and names session_wait next only when it is served", async () => {
    const start = vi.fn(() => Promise.resolve(apiOk(started)));

    const response = await serve(
      post(
        rpc("tools/call", {
          name: "session_start",
          arguments: { text: "Fix it", environment: "Default", request_id: "r-1" },
        }),
        { "x-cloudpid-client": "pi/1.5" },
      ),
      writing({ start }),
    );

    // SAFETY: a `tools/call` that reached the tool answers a result, as `call` reads it.
    const result = (await messageOf(response)).result as CallResult;

    expect(start).toHaveBeenCalledWith({
      text: "Fix it",
      environment: "Default",
      request_id: "r-1",
      via: { client: { name: "pi", version: "1.5" }, era: "legacy" },
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ session_id: ID, cursor: CURSOR });
    expect(result.content[0]?.text).toContain(`Started Session (untitled) [${ID}]`);
    // `session_wait` is not served by this Server yet, so no sentence names it.
    expect(result.structuredContent.next).not.toContain("session_wait");
    expect(result.structuredContent.next).toContain("session_get");
  });

  it("session_start answers too_many_running and branch_taken as domain failures", async () => {
    const cap = await call(
      "session_start",
      { text: "go" },
      writing({
        start: () =>
          Promise.resolve(
            apiFailure("too_many_running", "10 Sessions started over MCP are running.", {
              retryable: true,
              details: { limit: 10 },
            }),
          ),
      }),
    );

    expect(cap.isError).toBe(true);
    expect(cap.structuredContent.error).toMatchObject({
      code: "too_many_running",
      retryable: true,
    });
    expect(cap.content[0]?.text).toContain("10 Sessions");
  });

  it("session_send passes when_busy and request_id, and says how it was delivered", async () => {
    const send = vi.fn(() =>
      Promise.resolve(apiOk({ delivery: "steered" as const, cursor: CURSOR })),
    );

    const result = await call(
      "session_send",
      { session_id: ID, text: "more", when_busy: "steer", request_id: "r-2" },
      writing({ send }),
    );

    expect(send).toHaveBeenCalledWith({
      session_id: ID,
      text: "more",
      when_busy: "steer",
      request_id: "r-2",
      via: { era: "legacy" },
    });
    expect(result.content[0]?.text).toContain("Steered");
    expect(result.structuredContent).toMatchObject({ delivery: "steered", cursor: CURSOR });
  });

  it("session_send answers a Stop's withdrawal as stopped, not retryable, and a busy Run as session_busy", async () => {
    const stopped = await call(
      "session_send",
      { session_id: ID, text: "x" },
      writing({
        send: () =>
          Promise.resolve(
            apiFailure("stopped", "Stopped before it was sent.", { retryable: false }),
          ),
      }),
    );

    const busy = await call(
      "session_send",
      { session_id: ID, text: "x", when_busy: "reject" },
      writing({ send: () => Promise.resolve(apiFailure("session_busy", "The Run is busy.")) }),
    );

    expect(stopped.structuredContent.error).toMatchObject({ code: "stopped", retryable: false });
    expect(busy.structuredContent.error).toMatchObject({ code: "session_busy", retryable: true });
  });

  it("session_stop passes subagents, and says stopping when the Session had not gone idle", async () => {
    const stop = vi
      .fn()
      .mockResolvedValueOnce(apiOk({ status: "idle" }))
      .mockResolvedValueOnce(apiOk({ status: "running", stopping: true }));

    const api = writing({ stop });

    const done = await call("session_stop", { session_id: ID }, api);
    const going = await call("session_stop", { session_id: ID, subagents: true }, api);

    expect(stop).toHaveBeenNthCalledWith(1, { session_id: ID, via: { era: "legacy" } });
    expect(stop).toHaveBeenNthCalledWith(2, {
      session_id: ID,
      subagents: true,
      via: { era: "legacy" },
    });
    expect(done.content[0]?.text).toContain("The Session is idle.");
    expect(going.content[0]?.text).toContain("Stopping");
    expect(going.structuredContent).toMatchObject({ status: "running", stopping: true });
    expect(going.structuredContent.next).toContain("session_get");
  });

  it("names session_wait nowhere while the Server does not serve it: descriptions, next sentences, instructions", async () => {
    const api = writing({
      start: () => Promise.resolve(apiOk(started)),
      send: () => Promise.resolve(apiOk({ delivery: "started" as const, cursor: CURSOR })),
      stop: () => Promise.resolve(apiOk({ status: "running" as const, stopping: true })),
    });

    const { result } = await messageOf(await serve(post(rpc("tools/list")), api));

    for (const tool of result?.tools ?? []) {
      expect(JSON.stringify(tool)).not.toContain("session_wait");
    }

    for (const [name, args] of [
      ["session_start", { text: "go" }],
      ["session_send", { session_id: ID, text: "go" }],
      ["session_stop", { session_id: ID }],
    ] as const) {
      const called = await call(name, args, api);

      expect(JSON.stringify(called)).not.toContain("session_wait");
    }

    const init = await messageOf(
      await serve(
        post(
          rpc("initialize", {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "t", version: "1" },
          }),
        ),
        api,
      ),
    );

    expect(init.result?.instructions).not.toContain("session_wait");
  });

  it("says how many Sessions may run at once from the contract's own number", async () => {
    const { result } = await messageOf(await serve(post(rpc("tools/list")), writing()));

    const start = (result?.tools ?? []).find((tool) => tool.name === "session_start");

    expect(JSON.stringify(start)).toContain(`At most ${String(MAX_MCP_RUNNING)} Sessions`);
  });

  it("refuses an empty message, a made-up when_busy and a long request_id before calling the api", async () => {
    const send = vi.fn();
    const start = vi.fn();
    const api = writing({ send, start });

    for (const [name, args] of [
      ["session_start", { text: "" }],
      ["session_send", { session_id: ID, text: "" }],
      ["session_send", { session_id: ID, text: "x", when_busy: "now" }],
      ["session_start", { text: "x", request_id: "r".repeat(300) }],
    ] as const) {
      const result = await call(name, args, api);

      expect(result.isError).toBe(true);
    }

    expect(send).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it("answers an api without the operation as unsupported", async () => {
    const result = await call(
      "session_start",
      { text: "go" },
      writing({
        start: () =>
          Promise.reject(new TypeError('The RPC receiver does not implement the method "start".')),
      }),
    );

    expect(result.structuredContent.error).toMatchObject({ code: "unsupported" });
  });
});

describe("the import tools", () => {
  const IMPORT_OPERATIONS = [
    ...ALL_OPERATIONS,
    "importBegin",
    "importAppend",
    "importFinish",
    "importCancel",
  ];

  const importing = (overrides: Partial<McpServerApi> = {}) =>
    fakeApi({ describe: describing(IMPORT_OPERATIONS), ...overrides });

  const begun = {
    import_id: ID,
    session_id: ID,
    url: `https://cloudpid.test/sessions/${ID}`,
    received: 0,
    max_slice_bytes: 2_097_152,
    expires_at: "2026-01-01T01:00:00.000Z",
    carry_ref: "refs/cloudpid/carry/feature/x",
  };

  it("lists them last, with their annotations, once the deployed Server lists their operations", async () => {
    const { result } = await messageOf(await serve(post(rpc("tools/list")), importing()));
    const tools = result?.tools ?? [];

    expect(tools.map((tool) => tool.name).slice(-4)).toEqual([
      "session_import_begin",
      "session_import_append",
      "session_import_finish",
      "session_import_cancel",
    ]);

    const annotated = Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations]));

    expect(annotated["session_import_begin"]).toMatchObject({
      idempotentHint: false,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect(annotated["session_import_append"]).toMatchObject({
      idempotentHint: true,
      destructiveHint: false,
    });
    expect(annotated["session_import_finish"]).toMatchObject({ idempotentHint: true });
    expect(annotated["session_import_cancel"]).toMatchObject({
      destructiveHint: true,
      idempotentHint: true,
    });
  });

  it("leaves them out of an older Server's tools", async () => {
    const old = await serve(
      post(rpc("tools/list")),
      fakeApi({ describe: describing(ALL_OPERATIONS) }),
    );

    expect(((await messageOf(old)).result?.tools ?? []).map((tool) => tool.name)).not.toContain(
      "session_import_begin",
    );
  });

  it("session_import_begin passes the arguments and who is calling, and says where to push", async () => {
    const importBegin = vi.fn(() => Promise.resolve(apiOk(begun)));

    const result = await call(
      "session_import_begin",
      {
        environment: "Default",
        format: "pi-session-jsonl",
        size_bytes: 1200,
        branch: "feature/x",
        text: "carry on",
        request_id: "r-1",
      },
      importing({ importBegin }),
    );

    expect(importBegin).toHaveBeenCalledWith({
      environment: "Default",
      format: "pi-session-jsonl",
      size_bytes: 1200,
      branch: "feature/x",
      text: "carry on",
      request_id: "r-1",
      via: { era: "legacy" },
    });
    expect(result.structuredContent).toMatchObject({ import_id: ID, carry_ref: begun.carry_ref });
    expect(result.content[0]?.text).toContain(`carry_ref ${begun.carry_ref}`);
    expect(result.structuredContent.next).toContain(begun.carry_ref);
    expect(result.structuredContent.next).toContain("session_import_append");
  });

  it("session_import_append sends a slice whole and answers received", async () => {
    const data = "é".repeat(1_000_000);
    const importAppend = vi.fn(() => Promise.resolve(apiOk({ received: 2_000_000 })));

    const result = await call(
      "session_import_append",
      { import_id: ID, offset: 0, data },
      importing({ importAppend }),
    );

    expect(importAppend).toHaveBeenCalledWith({ import_id: ID, offset: 0, data });
    expect(result.structuredContent).toMatchObject({ received: 2_000_000 });
    expect(result.structuredContent.next).toContain("offset=2000000");
  });

  it("answers an offset_mismatch with the received count, so the Local agent resends from it", async () => {
    const result = await call(
      "session_import_append",
      { import_id: ID, offset: 10, data: "x" },
      importing({
        importAppend: () =>
          Promise.resolve(
            apiFailure("offset_mismatch", "Resend from byte 4.", {
              retryable: true,
              details: { received: 4 },
            }),
          ),
      }),
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent.error).toMatchObject({
      code: "offset_mismatch",
      retryable: true,
      details: { received: 4 },
    });
  });

  it("session_import_begin answers branch_taken with the Sessions on the branch", async () => {
    const result = await call(
      "session_import_begin",
      { environment: "Default", format: "pi-session-jsonl", size_bytes: 1 },
      importing({
        importBegin: () =>
          Promise.resolve(
            apiFailure("branch_taken", "Another Workspace is on feature/x.", {
              details: {
                workspace: "w1",
                sessions: [{ id: ID, url: begun.url, title: "Old", status: "idle" }],
              },
            }),
          ),
      }),
    );

    expect(result.structuredContent.error).toMatchObject({
      code: "branch_taken",
      details: { workspace: "w1", sessions: [{ id: ID, title: "Old" }] },
    });
  });

  it("session_import_finish advertises an optional boolean changes_carried and passes it to the api", async () => {
    const { result } = await messageOf(await serve(post(rpc("tools/list")), importing()));
    const finish = result?.tools?.find((tool) => tool.name === "session_import_finish");

    expect(finish?.inputSchema).toMatchObject({
      properties: { changes_carried: { type: "boolean" } },
      required: ["import_id", "sha256"],
    });

    const importFinish = vi.fn(() =>
      Promise.resolve(
        apiOk({
          session_id: ID,
          status: "idle" as const,
          url: begun.url,
          cursor: CURSOR,
          warnings: [],
        }),
      ),
    );

    await call(
      "session_import_finish",
      { import_id: ID, sha256: "a".repeat(64), changes_carried: true },
      importing({ importFinish }),
    );

    expect(importFinish).toHaveBeenCalledWith({
      import_id: ID,
      sha256: "a".repeat(64),
      changes_carried: true,
    });
  });

  it("session_import_finish renders the summary and warnings, and names session_wait only for an import that goes on", async () => {
    const finished = {
      session_id: ID,
      status: "idle" as const,
      url: begun.url,
      cursor: CURSOR,
      summary: { cut: 1, dropped: { "custom:x": 2 }, closed: 3 },
      warnings: ["The model m is not available: used m1."],
    };

    const done = await call(
      "session_import_finish",
      { import_id: ID, sha256: "a".repeat(64) },
      importing({ importFinish: () => Promise.resolve(apiOk(finished)) }),
    );

    expect(done.content[0]?.text).toContain("summary: 1 cut, 3 closed, dropped custom:x 2");
    expect(done.content[0]?.text).toContain("warning: The model m is not available");
    expect(done.structuredContent.next).not.toContain("session_wait with");
    expect(done.structuredContent.next).toContain("session_send");

    const going = await call(
      "session_import_finish",
      { import_id: ID, sha256: "a".repeat(64) },
      importing({
        importFinish: () => Promise.resolve(apiOk({ ...finished, status: "importing" as const })),
      }),
    );

    expect(going.structuredContent.next).toContain(`session_wait with session_id="${ID}"`);
    expect(going.structuredContent.next).toContain(`after="${CURSOR}"`);
  });

  it("session_import_cancel answers cancelled, and an api without the operation is unsupported", async () => {
    const cancelled = await call(
      "session_import_cancel",
      { import_id: ID },
      importing({ importCancel: () => Promise.resolve(apiOk({ cancelled: true as const })) }),
    );

    expect(cancelled.structuredContent).toMatchObject({ cancelled: true });

    const missing = await call(
      "session_import_cancel",
      { import_id: ID },
      importing({
        importCancel: () =>
          Promise.reject(
            new TypeError('The RPC receiver does not implement the method "importCancel".'),
          ),
      }),
    );

    expect(missing.structuredContent.error).toMatchObject({ code: "unsupported" });
  });

  it("records the import's Session in the span, as the import_id is the Session's id", async () => {
    const attributes: Array<Parameters<McpObserver["call"]>[0]> = [];

    const observe: McpObserver = {
      ...unobserved,
      call: (attrs, run) => {
        attributes.push(attrs);

        return run(() => undefined);
      },
    };

    await call(
      "session_import_cancel",
      { import_id: ID },
      importing({ importCancel: () => Promise.resolve(apiOk({ cancelled: true as const })) }),
      observe,
    );

    expect(attributes[0]).toMatchObject({ tool: "session_import_cancel", session_id: ID });
  });
});

describe("session_wait", () => {
  const ended = {
    session_id: ID,
    status: "idle" as const,
    ended_by: "run_ended" as const,
    outcome: { result: "answered" as const },
    waiting: [],
    activity: { entries: 3, tool_calls: 1, latest: ["assistant: done"] },
    answer: { text: "All done", truncated: false },
    cursor: "cur-2",
  };

  const waiting = (overrides: Partial<McpServerApi> = {}) =>
    fakeApi({ describe: describing(ALL_OPERATIONS), ...overrides });

  it("is listed, read-only, after session_get, once the Server lists the wait operation", async () => {
    const { result } = await messageOf(await serve(post(rpc("tools/list")), waiting()));
    const tools = result?.tools ?? [];

    expect(tools.map((tool) => tool.name)).toEqual([
      "environments_list",
      "sessions_list",
      "session_get",
      "session_wait",
      "session_transcript",
      "session_start",
      "session_send",
      "session_stop",
    ]);
    expect(tools.find((tool) => tool.name === "session_wait")?.annotations).toMatchObject({
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it("is left out while the Server does not list it, as are the words that name it", async () => {
    const { result } = await messageOf(await serve(post(rpc("tools/list")), fakeApi()));

    expect((result?.tools ?? []).map((tool) => tool.name)).not.toContain("session_wait");
  });

  it("passes the cursor and timeout to the api, and answers the Run's end with its text and a next sentence", async () => {
    const wait = vi.fn(() => Promise.resolve(apiOk(ended)));

    const result = await call(
      "session_wait",
      { session_id: ID, after: CURSOR, timeout_s: 120 },
      waiting({ wait }),
    );

    expect(wait).toHaveBeenCalledWith({ session_id: ID, after: CURSOR, timeout_s: 120 });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("the Run ended");
    expect(result.content[0]?.text).toContain("All done");
    expect(result.content[0]?.text).toContain("cursor cur-2");
    expect(result.content[0]?.text.endsWith(result.structuredContent.next ?? "")).toBe(true);
    expect(result.structuredContent.next).toContain("session_transcript");
  });

  it("refuses a timeout over 300 s or under 0 before calling the api, and takes a fraction of a second", async () => {
    const wait = vi.fn(() => Promise.resolve(apiOk(ended)));

    for (const timeout_s of [301, -1, 300.5]) {
      const result = await call("session_wait", { session_id: ID, timeout_s }, waiting({ wait }));

      expect(result.isError).toBe(true);
    }

    expect(wait).not.toHaveBeenCalled();

    const fraction = await call(
      "session_wait",
      { session_id: ID, timeout_s: 1.5 },
      waiting({ wait }),
    );

    expect(fraction.isError).toBeUndefined();
    expect(wait).toHaveBeenCalledWith({ session_id: ID, timeout_s: 1.5 });
  });

  it.each([
    ["owner_needed", "cloudpid", /you cannot/],
    ["timeout", "keep waiting", /session_wait again/],
    ["import_ended", "session_get", /session_get/],
  ] as const)(
    "says what to do after %s, with the cursor to wait from",
    async (ended_by, _word, pattern) => {
      const result = await call(
        "session_wait",
        { session_id: ID },
        waiting({ wait: () => Promise.resolve(apiOk({ ...ended, ended_by, cursor: "cur-9" })) }),
      );

      expect(result.structuredContent.next).toMatch(pattern);

      if (ended_by === "timeout" || ended_by === "owner_needed") {
        expect(result.structuredContent.next).toContain('after="cur-9"');
      }
    },
  );

  it("says an interrupted wait kept the cursor and did not touch the Run", async () => {
    const result = await call(
      "session_wait",
      { session_id: ID },
      waiting({
        wait: () =>
          Promise.resolve(
            apiOk({ ...ended, ended_by: "timeout" as const, interrupted: true, cursor: CURSOR }),
          ),
      }),
    );

    expect(result.structuredContent).toMatchObject({ interrupted: true, cursor: CURSOR });
    expect(result.content[0]?.text).toContain("connection to the Session was cut");
    expect(result.structuredContent.next).toContain('after="cur-1"');
  });

  it("shows the waiting requests it ended for, with the page the owner answers them at", async () => {
    const result = await call(
      "session_wait",
      { session_id: ID },
      waiting({
        wait: () =>
          Promise.resolve(
            apiOk({
              ...ended,
              status: "waiting_for_owner" as const,
              ended_by: "owner_needed" as const,
              waiting: [
                {
                  kind: "approval" as const,
                  request_id: "req-1",
                  agent_id: "root",
                  summary: "Run: npm test",
                  since: 1,
                  url: `https://cloudpid.test/sessions/${ID}?request=req-1`,
                },
              ],
            }),
          ),
      }),
    );

    expect(result.content[0]?.text).toContain(`${ID}?request=req-1`);
    expect(result.structuredContent).toMatchObject({ waiting: [{ request_id: "req-1" }] });
  });

  it("points the other tools' texts at session_wait only while it is served", async () => {
    const withWait = waiting({
      start: () =>
        Promise.resolve(
          apiOk({
            session_id: ID,
            title: null,
            url: "u",
            status: "running" as const,
            cursor: CURSOR,
            environment: { id: "default", name: "Default", repos: [] },
          }),
        ),
    });

    const { result } = await messageOf(await serve(post(rpc("tools/list")), withWait));

    for (const name of ["session_start", "session_send"]) {
      const listed = (result?.tools ?? []).find((tool) => tool.name === name);

      expect(JSON.stringify(listed)).toContain("session_wait");
    }

    const started = await call("session_start", { text: "go" }, withWait);

    expect(started.structuredContent.next).toContain(`session_wait with session_id="${ID}"`);
    expect(started.structuredContent.next).toContain(`after="${CURSOR}"`);

    const init = await messageOf(
      await serve(
        post(
          rpc("initialize", {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "t", version: "1" },
          }),
        ),
        withWait,
      ),
    );

    expect(init.result?.instructions).toContain("loop session_wait");
    expect(init.result?.instructions?.length).toBeLessThanOrEqual(1500);
  });

  describe("while it waits", () => {
    /** The messages of a stream that these cases read. */
    interface Frame {
      readonly method?: string;
      readonly params?: {
        readonly progress: number;
        readonly progressToken: string;
        readonly message: string;
      };
    }

    // SAFETY: the endpoint's own JSON-RPC messages, read as far as `Frame` says.
    const frameOf = (line: string): Frame => JSON.parse(line.slice(5)) as Frame;

    /** The SSE events of a response, as the data of each message and the comments between them. */
    const framesOf = (text: string) => ({
      messages: text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map(frameOf),
      keepAlives: text.split("\n").filter((line) => line.startsWith(": keepalive")).length,
    });

    const open = async (meta: Schema.Json | undefined) => {
      let finish: () => void = () => undefined;

      const api = waiting({
        wait: () =>
          new Promise((resolve) => {
            finish = () => {
              resolve(apiOk(ended));
            };
          }),
      });

      const call_ = { name: "session_wait", arguments: { session_id: ID, timeout_s: 300 } };

      const response = await serve(
        post(rpc("tools/call", meta === undefined ? call_ : { ...call_, _meta: meta })),
        api,
      );

      return { text: response.text(), finish: () => finish() };
    };

    it("sends progress at the start and every 10 s, and keep-alive comments every 15 s", async () => {
      vi.useFakeTimers();

      try {
        const { text, finish } = await open({ progressToken: "p1" });

        await vi.advanceTimersByTimeAsync(31_000);
        finish();

        const { messages, keepAlives } = framesOf(await text);
        const progress = messages.filter((message) => message.method === "notifications/progress");

        expect(progress.map((message) => message.params?.progress)).toEqual([0, 10, 20, 30]);
        expect(progress.every((message) => message.params?.progressToken === "p1")).toBe(true);
        expect(progress[3]?.params?.message).toBe("Waiting for the Run · 30s");
        expect(keepAlives).toBe(2);
        expect(messages.at(-1)).toMatchObject({
          result: { structuredContent: { cursor: "cur-2" } },
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("says minutes once a wait runs past one", async () => {
      vi.useFakeTimers();

      try {
        const { text, finish } = await open({ progressToken: 7 });

        await vi.advanceTimersByTimeAsync(130_000);
        finish();

        const { messages } = framesOf(await text);
        const progress = messages.filter((message) => message.method === "notifications/progress");

        expect(progress.at(-1)?.params?.message).toBe("Waiting for the Run · 2m10s");
      } finally {
        vi.useRealTimers();
      }
    });

    it("sends no progress without a progressToken, and finishes on the keep-alives alone", async () => {
      vi.useFakeTimers();

      try {
        const { text, finish } = await open(undefined);

        await vi.advanceTimersByTimeAsync(305_000);
        finish();

        const { messages, keepAlives } = framesOf(await text);

        expect(messages.filter((message) => message.method === "notifications/progress")).toEqual(
          [],
        );
        expect(keepAlives).toBe(20);
        expect(messages.at(-1)).toMatchObject({
          result: { structuredContent: { cursor: "cur-2" } },
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("stops sending progress once the wait has answered", async () => {
      vi.useFakeTimers();

      try {
        const { text, finish } = await open({ progressToken: "p1" });

        await vi.advanceTimersByTimeAsync(11_000);
        finish();

        const { messages } = framesOf(await text);

        expect(vi.getTimerCount()).toBe(0);
        expect(
          messages.filter((message) => message.method === "notifications/progress"),
        ).toHaveLength(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

describe("the tool gate", () => {
  it("keeps describe() for its TTL, then asks again", async () => {
    let now = 0;
    const describe_ = vi.fn(describing(OPERATIONS));
    const api = fakeApi({ describe: describe_ });
    const keep = toolGate({ now: () => now });

    expect((await keep(api)).enabled.size).toBe(4);
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

    expect((await keep(fakeApi({ describe: describe_ }))).enabled.size).toBe(0);
    expect((await keep(fakeApi({ describe: describe_ }))).enabled.size).toBe(4);
  });
});

describe("tools/call", () => {
  it("answers text and structuredContent that say the same, with the next sentence in both", async () => {
    const result = await call("sessions_list", {});

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("Fix the thing");
    expect(result.content[0]?.text).toContain(`Call sessions_list again with cursor "cur"`);
    expect(result.structuredContent.next).toContain(`cursor "cur"`);
    expect(result.content[0]?.text.endsWith(result.structuredContent.next ?? "")).toBe(true);
    expect(result.structuredContent.sessions?.[0]?.session_id).toBe(ID);
  });

  it("names only the tools that are served in the next sentence", async () => {
    const api = fakeApi({
      describe: describing(["environments", "sessions"]),
    });

    const result = await call("sessions_list", {}, api);

    expect(result.content[0]?.text).not.toContain("session_get");
    expect(result.content[0]?.text).not.toContain("session_transcript");
  });

  it("answers a domain failure as isError with its code, whose text is its sentence", async () => {
    const result = await call("session_get", { session_id: ID });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("No Session.");
    expect(result.structuredContent.error).toMatchObject({
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

  it.each([
    ["CJK text", "漢"],
    ["control characters", "\u0001"],
  ])(
    "answers a transcript page of %s whose JSON passes 64 KiB with a non-retryable invalid_argument",
    async (_name, character) => {
      const result = await call(
        "session_transcript",
        { session_id: ID, max_chars: 40_000 },
        fakeApi({
          transcript: (request) =>
            Promise.resolve(
              apiOk({
                session_id: request.session_id,
                entries: [
                  { entry_id: 1, role: "user" as const, at: "", text: character.repeat(40_000) },
                ],
                newer: "n1",
              }),
            ),
        }),
      );

      expect(result.isError).toBe(true);
      expect(result.structuredContent.error).toMatchObject({
        code: "invalid_argument",
        retryable: false,
      });
      expect(result.content[0]?.text).toContain("lower max_chars");
    },
  );

  it("serves a transcript page that fits, at the largest max_chars, as it is", async () => {
    const result = await call(
      "session_transcript",
      { session_id: ID, max_chars: 40_000 },
      fakeApi({
        transcript: (request) =>
          Promise.resolve(
            apiOk({
              session_id: request.session_id,
              entries: [{ entry_id: 1, role: "user" as const, at: "", text: "x".repeat(40_000) }],
              newer: "n1",
            }),
          ),
      }),
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text.length).toBeGreaterThan(40_000);
  });

  it("answers rate_limited with retry_after_s, without calling the operation", async () => {
    const environments = vi.fn();

    const result = await call(
      "environments_list",
      {},
      fakeApi({ environments, limited: { retryAfterS: 60 } }),
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent.error).toMatchObject({
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

    expect(result.structuredContent.error).toMatchObject({ code: "unsupported" });
  });

  it("answers an answer it cannot read as unavailable", async () => {
    const result = await call(
      "sessions_list",
      {},
      // SAFETY: the point is an answer that is not an `ApiResult` of sessions, as an `api` of another version could send.
      fakeApi({ sessions: () => Promise.resolve({ ok: true, value: 7 } as never) }),
    );

    expect(result.structuredContent.error).toMatchObject({ code: "unavailable" });
  });

  it("refuses arguments that do not match the schema", async () => {
    const response = await serve(post(rpc("tools/call", { name: "session_get", arguments: {} })));
    const message = await messageOf(response);

    expect(message.error !== undefined || message.result?.["isError"] === true).toBe(true);
  });
});

describe("the telemetry", () => {
  it("is a span per tools/call and a count for every other request, with no argument text", async () => {
    const calls: Array<Attributes> = [];
    const requests: Array<Attributes> = [];

    const observe: McpObserver = {
      request: (attributes) => void requests.push(attributes),
      call: async (attributes, run) => {
        const record = { ...attributes };

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
    expect(calls[0]?.["bytes_sent"]).toEqual(expect.any(Number));
    expect(requests).toEqual([{ method: "tools/list", era: "legacy" }]);
  });

  it("records how a wait ended and how long it waited, and nothing of its text", async () => {
    const calls: Array<Attributes> = [];

    const observe: McpObserver = {
      request: () => undefined,
      call: async (attributes, run) => {
        const record = { ...attributes };

        calls.push(record);

        return run((more) => void Object.assign(record, more));
      },
    };

    await call(
      "session_wait",
      { session_id: ID, after: CURSOR },
      fakeApi({
        describe: describing(ALL_OPERATIONS),
        wait: () =>
          Promise.resolve(
            apiOk({
              session_id: ID,
              status: "waiting_for_owner" as const,
              ended_by: "owner_needed" as const,
              interrupted: true,
              waiting: [],
              activity: { entries: 0, tool_calls: 0, latest: ["secret words"] },
              answer: { text: "secret words", truncated: false },
              cursor: "cur-2",
            }),
          ),
      }),
      observe,
    );

    expect(calls[0]).toMatchObject({
      tool: "session_wait",
      session_id: ID,
      outcome: "ok",
      ended_by: "owner_needed",
      interrupted: true,
      waited_ms: expect.any(Number),
    });
    expect(JSON.stringify(calls)).not.toContain("secret words");
    expect(JSON.stringify(calls)).not.toContain(CURSOR);
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

    expect(list.result?.tools).toHaveLength(4);

    const observed: Array<Attributes> = [];

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

    expect(message.result?.structuredContent?.environments?.[0]?.id).toBe("default");
    expect(observed[0]).toMatchObject({ era: "modern", "client.name": "modern-client" });
  });

  it("reports a wait's progress and keep-alives on its stream, as the Legacy lane does", async () => {
    vi.useFakeTimers();

    try {
      let finish: () => void = () => undefined;

      const api = fakeApi({
        describe: describing(ALL_OPERATIONS),
        wait: () =>
          new Promise((resolve) => {
            finish = () => {
              resolve(
                apiOk({
                  session_id: ID,
                  status: "idle" as const,
                  ended_by: "timeout" as const,
                  waiting: [],
                  activity: { entries: 0, tool_calls: 0, latest: [] },
                  cursor: "cur-2",
                }),
              );
            };
          }),
      });

      const response = await serve(
        post(
          rpc("tools/call", {
            name: "session_wait",
            arguments: { session_id: ID, timeout_s: 300 },
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientInfo": { name: "modern-client", version: "2" },
              "io.modelcontextprotocol/clientCapabilities": {},
              progressToken: 1,
            },
          }),
          {
            "mcp-protocol-version": "2026-07-28",
            "mcp-method": "tools/call",
            "mcp-name": "session_wait",
          },
        ),
        api,
      );

      const text = response.text();

      await vi.advanceTimersByTimeAsync(21_000);
      finish();

      const body = await text;

      expect(body.match(/notifications\/progress/g)).toHaveLength(3);
      expect(body.match(/: keepalive/g)).toHaveLength(1);
      expect(body).toContain('"progressToken":1');
    } finally {
      vi.useRealTimers();
    }
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
