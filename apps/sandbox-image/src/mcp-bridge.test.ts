// The Container MCP bridge (docs/architecture/mcp-connections.md → The stdio bridge): the image's script, run as the image
// runs it (Node's type stripping) with the token in its environment, driven over HTTP the way the MCP engine drives it,
// with Legacy and Modern stdio servers (`mcp-stdio.fixture.mjs`) as its children. The supervisor's side is
// `supervisor.test.ts`.
// @effect-diagnostics nodeBuiltinImport:off processEnv:off preferEffectArray:off preferEffectRecord:off asyncFunction:off globalTimers:off globalFetch:off globalDate:off newPromise:off strictBooleanExpressions:off
/* oxlint-disable anti-slop/no-runtime-typeof -- `at` digs in JSON the bridge answered with */
import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sandboxImageContext } from "@cloudpid/sandbox-image";
import {
  type McpBridgeConfig,
  type McpBridgeStatus,
  MCP_BRIDGE_CONFIG_HEADER,
  MCP_BRIDGE_ERA_HEADER,
  MCP_BRIDGE_HEALTH_PATH,
  MCP_BRIDGE_LEVEL,
  MCP_BRIDGE_LEVEL_HEADER,
  MCP_BRIDGE_MCP_PATH,
  MCP_BRIDGE_PORT,
  MCP_BRIDGE_PROBE_MS,
  MCP_BRIDGE_SCRIPT,
  MCP_BRIDGE_SPAWN_HEADER,
  MCP_BRIDGE_STATUS_PATH,
  MCP_BRIDGE_STDERR_LIMIT,
  MCP_BRIDGE_STOP_PATH,
  MCP_BRIDGE_TOKEN_ENV,
  mcpBridgeConfigHeader,
  mcpBridgeKey,
  mcpBridgeRefusalCode,
} from "@cloudpid/sandbox-image/mcp-bridge";

const script = join(sandboxImageContext, "cloudpid-mcp-bridge.ts");
const source = readFileSync(script, "utf8");
const dockerfile = readFileSync(join(sandboxImageContext, "Dockerfile"), "utf8");
const fixture = join(import.meta.dirname, "mcp-stdio.fixture.mjs");

const TOKEN = "a-token-of-this-launch";

describe("the refusals of WorkspaceMcpBridge", () => {
  it("are read by their code, and a code this version does not know as the fallback, bridge_failed", () => {
    expect(mcpBridgeRefusalCode("stopped")).toBe("stopped");
    expect(mcpBridgeRefusalCode("no_workspace")).toBe("no_workspace");
    expect(mcpBridgeRefusalCode("a_later_code")).toBe("bridge_failed");
    expect(mcpBridgeRefusalCode(undefined)).toBe("bridge_failed");
  });
});

describe("the bridge's contract with the Workspaces Worker", () => {
  /** The value of `const <name> = <value>;` in the script. */
  const constant = (name: string): string | undefined =>
    new RegExp(`^const ${name} = (.+);$`, "m").exec(source)?.[1];

  it("repeats the values @cloudpid/sandbox-image/mcp-bridge exports", () => {
    expect(constant("LEVEL")).toBe(String(MCP_BRIDGE_LEVEL));
    expect(constant("DEFAULT_PORT")).toBe("17_781");
    expect(MCP_BRIDGE_PORT).toBe(17_781);
    expect(constant("STDERR_LIMIT")).toBe("65_536");
    expect(MCP_BRIDGE_STDERR_LIMIT).toBe(65_536);
    expect(constant("DEFAULT_PROBE_MS")).toBe("15_000");
    expect(MCP_BRIDGE_PROBE_MS).toBe(15_000);

    for (const [name, value] of [
      ["TOKEN_ENV", MCP_BRIDGE_TOKEN_ENV],
      ["CONFIG_HEADER", MCP_BRIDGE_CONFIG_HEADER],
      ["ERA_HEADER", MCP_BRIDGE_ERA_HEADER],
      ["SPAWN_HEADER", MCP_BRIDGE_SPAWN_HEADER],
      ["LEVEL_HEADER", MCP_BRIDGE_LEVEL_HEADER],
      ["MCP_PATH", MCP_BRIDGE_MCP_PATH],
      ["HEALTH_PATH", MCP_BRIDGE_HEALTH_PATH],
      ["STATUS_PATH", MCP_BRIDGE_STATUS_PATH],
      ["STOP_PATH", MCP_BRIDGE_STOP_PATH],
    ] as const) {
      expect(constant(name)).toBe(JSON.stringify(value));
    }
  });

  it("is a port outside computerd's and the Container preview ports", () => {
    expect([8080, 3000, 3001, 4173, 4321, 5173, 5174, 8000, 8787]).not.toContain(MCP_BRIDGE_PORT);
  });
});

describe("the image", () => {
  it("has the bridge's script where the supervisor looks for it", () => {
    expect(dockerfile).toContain(`COPY --chmod=644 cloudpid-mcp-bridge.ts ${MCP_BRIDGE_SCRIPT}\n`);
  });
});

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** The value at `path` below `value`, `undefined` where there is none. */
const at = (value: Json | undefined, ...path: ReadonlyArray<string | number>): Json | undefined => {
  let current = value;

  for (const step of path) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;

    // SAFETY: the object is indexed by a string or a number, as JSON values are.
    current = (current as { [key: string]: Json })[step];
  }

  return current;
};

type Stream = {
  readonly status: number;
  readonly headers: Headers;
  /** The next SSE message, `undefined` once the stream has ended. */
  readonly next: () => Promise<Json | undefined>;
  /** Every message until the stream ends. */
  readonly rest: () => Promise<Json[]>;
  readonly abort: () => void;
};

let bridgeProcess: ChildProcess | undefined;
let base = "";
let counter = 0;

beforeAll(async () => {
  const proc = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", script], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      [MCP_BRIDGE_TOKEN_ENV]: TOKEN,
      CLOUDPID_MCP_BRIDGE_PORT: "0",
      // A Legacy server's silence, shortened.
      CLOUDPID_MCP_BRIDGE_PROBE_MS: "400",
    },
    stdio: ["ignore", "pipe", "inherit"],
  });

  bridgeProcess = proc;
  proc.stdout?.setEncoding("utf8");

  base = await new Promise<string>((resolve, reject) => {
    let output = "";

    proc.stdout?.on("data", (chunk: string) => {
      output += chunk;

      const port = /listening on :(\d+)/.exec(output)?.[1];

      if (port !== undefined) resolve(`http://127.0.0.1:${port}`);
    });
    proc.on("exit", () => reject(new Error(`the bridge exited: ${output}`)));
  });
});

afterAll(() => {
  bridgeProcess?.kill("SIGTERM");
});

/** A config for a fixture server, unique to its test so that no two share a child. */
const config = (
  era: "legacy" | "modern",
  env: Readonly<Record<string, string>> = {},
): McpBridgeConfig => ({
  command: process.execPath,
  args: [fixture, era],
  env: { FIXTURE_NONCE: String((counter += 1)), ...env },
});

type Call = {
  readonly session?: string;
  readonly era?: "legacy" | "modern";
  readonly token?: string | null;
  readonly method?: string;
  readonly body?: Json;
};

const authorization = (token: string | null | undefined) =>
  token === null ? {} : { authorization: `Bearer ${token ?? TOKEN}` };

/** One request to the bridge's MCP endpoint, as a stream of its SSE messages. */
const open = async (server: McpBridgeConfig, call: Call = {}): Promise<Stream> => {
  const controller = new AbortController();

  const headers = new Headers({
    ...authorization(call.token),
    [MCP_BRIDGE_CONFIG_HEADER]: mcpBridgeConfigHeader(server),
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  });

  if (call.session !== undefined) headers.set("mcp-session-id", call.session);

  if (call.era !== undefined) headers.set(MCP_BRIDGE_ERA_HEADER, call.era);

  const response = await fetch(`${base}${MCP_BRIDGE_MCP_PATH}`, {
    method: call.method ?? "POST",
    headers,
    body: call.body === undefined ? null : JSON.stringify(call.body),
    signal: controller.signal,
  });

  // A refusal is a JSON-RPC error as plain JSON, an answer an SSE stream.
  if (response.headers.get("content-type")?.startsWith("application/json") === true) {
    // SAFETY: the bridge's JSON bodies are JSON-RPC errors.
    const body = (await response.json()) as Json;
    const messages: Json[] = [body];

    return {
      status: response.status,
      headers: response.headers,
      next: () => Promise.resolve(messages.shift()),
      rest: () => Promise.resolve(messages.splice(0)),
      abort: () => controller.abort(),
    };
  }

  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const messages: Json[] = [];
  let done = reader === undefined;

  const next = async (): Promise<Json | undefined> => {
    while (messages.length === 0 && !done) {
      const chunk = await reader?.read().catch(() => ({ done: true, value: undefined }));

      if (chunk === undefined || chunk.done) {
        done = true;
      } else {
        buffer += decoder.decode(chunk.value, { stream: true });

        for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
          const data = buffer
            .slice(0, end)
            .split("\n")
            .filter((line) => line.startsWith("data: "))
            .map((line) => line.slice("data: ".length))
            .join("");

          buffer = buffer.slice(end + 2);

          if (data !== "") {
            // SAFETY: the bridge writes each SSE message as one JSON-RPC message.
            messages.push(JSON.parse(data) as Json);
          }
        }
      }
    }

    return messages.shift();
  };

  const rest = async (): Promise<Json[]> => {
    const all: Json[] = [];

    for (let message = await next(); message !== undefined; message = await next()) {
      all.push(message);
    }

    return all;
  };

  return {
    status: response.status,
    headers: response.headers,
    next,
    rest,
    abort: () => controller.abort(),
  };
};

type Reply = {
  readonly status: number;
  readonly headers: Headers;
  readonly messages: Json[];
};

/** A request, answered in full. */
const post = async (server: McpBridgeConfig, body: Json, call: Call = {}): Promise<Reply> => {
  const stream = await open(server, { ...call, body });

  return { status: stream.status, headers: stream.headers, messages: await stream.rest() };
};

const control = async (
  path: string,
  init: { method?: string; token?: string | null; body?: Json } = {},
) => {
  const response = await fetch(`${base}${path}`, {
    method: init.method ?? "GET",
    headers: { ...authorization(init.token), "content-type": "application/json" },
    body: init.body === undefined ? null : JSON.stringify(init.body),
  });

  // SAFETY: the bridge answers its control calls in JSON.
  const body = (await response.json()) as Json;

  return { status: response.status, headers: response.headers, body };
};

const status = async (): Promise<McpBridgeStatus> => {
  const response = await fetch(`${base}${MCP_BRIDGE_STATUS_PATH}`, {
    headers: authorization(undefined),
  });

  // SAFETY: the bridge's status is `McpBridgeStatus`.
  return (await response.json()) as McpBridgeStatus;
};

/** The children the bridge lists for `server`. */
const childrenOf = async (server: McpBridgeConfig) => {
  const key = await mcpBridgeKey(server);

  return (await status()).children.filter((child) => child.key === key);
};

const rpc = (id: number | string, method: string, params: Json = {}): Json => ({
  jsonrpc: "2.0",
  id,
  method,
  params,
});

const callTool = (id: number, name: string, args: Json = {}, meta: Json = {}): Json =>
  rpc(id, "tools/call", { name, arguments: args, _meta: meta });

const envelope = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

/** A Legacy handshake: the session the bridge answers `initialize` with. */
const initialize = async (server: McpBridgeConfig): Promise<string> => {
  const reply = await post(
    server,
    rpc(1, "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    }),
  );

  expect(reply.status).toBe(200);
  expect(at(reply.messages[0], "result", "serverInfo", "name")).toBe("legacy-fixture");

  const session = reply.headers.get("mcp-session-id");

  expect(session).toBe(reply.headers.get(MCP_BRIDGE_SPAWN_HEADER));

  return session ?? "";
};

const alive = (pid: Json | undefined): boolean => {
  try {
    process.kill(Number(pid), 0);

    return true;
  } catch {
    return false;
  }
};

describe("the bridge's token", () => {
  it("is checked on every request: a wrong token, none, or another scheme is refused, and nothing is spawned", async () => {
    const server = config("modern");

    for (const token of ["wrong-token", `${TOKEN}x`, TOKEN.slice(0, -1), "", null]) {
      const mcp = await open(server, {
        token,
        era: "modern",
        body: callTool(1, "echo", { text: "hi" }, envelope),
      });

      expect(mcp.status).toBe(401);
      expect(mcp.headers.get(MCP_BRIDGE_LEVEL_HEADER)).toBe(String(MCP_BRIDGE_LEVEL));

      for (const [path, init] of [
        [MCP_BRIDGE_HEALTH_PATH, {}],
        [MCP_BRIDGE_STATUS_PATH, {}],
        [MCP_BRIDGE_STOP_PATH, { method: "POST", body: { key: "x" } }],
        ["/anything", {}],
      ] as const) {
        expect((await control(path, { ...init, token })).status).toBe(401);
      }
    }

    const basic = await fetch(`${base}${MCP_BRIDGE_HEALTH_PATH}`, {
      headers: { authorization: `Basic ${TOKEN}` },
    });

    expect(basic.status).toBe(401);
    expect(await childrenOf(server)).toEqual([]);
  });

  it("lets the right token through, and is never in a child's environment", async () => {
    const server = config("modern", { FIXTURE_VALUE: "kept" });

    const reply = await post(server, callTool(1, "env", { name: MCP_BRIDGE_TOKEN_ENV }), {
      era: "modern",
    });

    expect(at(reply.messages[0], "result", "structuredContent", "value")).toBeNull();

    const kept = await post(server, callTool(2, "env", { name: "FIXTURE_VALUE" }), {
      era: "modern",
    });

    expect(at(kept.messages[0], "result", "structuredContent", "value")).toBe("kept");
  });

  it("does not start the bridge without one", async () => {
    const run = spawn(process.execPath, [script], {
      env: { PATH: process.env.PATH, CLOUDPID_MCP_BRIDGE_PORT: "0" },
      stdio: "ignore",
    });

    const code = await new Promise((resolve) => run.on("exit", resolve));

    expect(code).toBe(1);
  });
});

describe("every response", () => {
  it("carries the bridge's level, and the spawn id of the child it is about", async () => {
    const health = await control(MCP_BRIDGE_HEALTH_PATH);

    expect(health.status).toBe(200);
    expect(health.headers.get(MCP_BRIDGE_LEVEL_HEADER)).toBe(String(MCP_BRIDGE_LEVEL));
    expect(health.headers.get(MCP_BRIDGE_SPAWN_HEADER)).toBeNull();

    const server = config("legacy");
    const session = await initialize(server);

    const answered = await post(server, rpc(2, "tools/list"), { session });

    expect(answered.headers.get(MCP_BRIDGE_LEVEL_HEADER)).toBe(String(MCP_BRIDGE_LEVEL));
    expect(answered.headers.get(MCP_BRIDGE_SPAWN_HEADER)).toBe(session);

    // Also where the answer is no: a stale session names the child that is there.
    const stale = await post(server, rpc(3, "tools/list"), { session: "gone" });

    expect(stale.status).toBe(404);
    expect(stale.headers.get(MCP_BRIDGE_LEVEL_HEADER)).toBe(String(MCP_BRIDGE_LEVEL));
    expect(stale.headers.get(MCP_BRIDGE_SPAWN_HEADER)).toBe(session);

    const status400 = await open(server, { body: [] });

    expect(status400.status).toBe(400);
    expect(status400.headers.get(MCP_BRIDGE_LEVEL_HEADER)).toBe(String(MCP_BRIDGE_LEVEL));
  });
});

describe("a Legacy stdio server", () => {
  it("is spawned by `initialize`, which answers the spawn as the session; a stale session gets 404", async () => {
    const server = config("legacy");

    expect(await childrenOf(server)).toEqual([]);

    const session = await initialize(server);
    const [listed] = await childrenOf(server);

    expect(listed).toMatchObject({
      spawnId: session,
      state: "running",
      era: "legacy",
      command: process.execPath,
    });

    const tools = await post(server, rpc(2, "tools/list"), { session });

    expect(at(tools.messages[0], "result", "tools", 0, "name")).toBe("echo");

    for (const stale of [`${session}x`, "gone"]) {
      const refused = await post(server, rpc(3, "tools/list"), { session: stale });

      expect(refused.status).toBe(404);
      expect(refused.messages).toEqual([
        { jsonrpc: "2.0", id: 3, error: { code: -32001, message: "session not found" } },
      ]);
    }
  });

  it("answers a notification with 202, and a second `initialize` replaces the child", async () => {
    const server = config("legacy");
    const first = await initialize(server);

    const notified = await open(server, {
      session: first,
      body: { jsonrpc: "2.0", method: "notifications/initialized" },
    });

    expect(notified.status).toBe(202);

    const pid = at(
      (await post(server, callTool(2, "pid"), { session: first })).messages[0],
      "result",
      "structuredContent",
      "pid",
    );

    const second = await initialize(server);

    expect(second).not.toBe(first);
    // The old child is stopped, and its exit is not listed beside the new child.
    await vi.waitFor(() => expect(alive(pid)).toBe(false));
    expect(await childrenOf(server)).toHaveLength(1);
    expect((await post(server, rpc(3, "tools/list"), { session: first })).status).toBe(404);
    expect((await post(server, rpc(3, "tools/list"), { session: second })).status).toBe(200);
  });

  it("rewrites ids, so callers that share the child never collide", async () => {
    const server = config("legacy");
    const session = await initialize(server);

    const [a, b] = await Promise.all([
      post(server, callTool(7, "echo", { text: "a" }), { session }),
      post(server, callTool(7, "echo", { text: "b" }), { session }),
    ]);

    // Each caller gets its own id back; the server saw the bridge's two different ones.
    expect(at(a.messages[0], "id")).toBe(7);
    expect(at(b.messages[0], "id")).toBe(7);
    expect(at(a.messages[0], "result", "content", 0, "text")).toBe("a");
    expect(at(b.messages[0], "result", "content", 0, "text")).toBe("b");

    const seenA = at(a.messages[0], "result", "structuredContent", "seenId");
    const seenB = at(b.messages[0], "result", "structuredContent", "seenId");

    expect(seenA).not.toBe(seenB);
    expect(seenA).not.toBe(7);
  });

  it("sends progress to the stream of the request its token names", async () => {
    const server = config("legacy");
    const session = await initialize(server);

    const reply = await post(server, callTool(2, "progress", {}, { progressToken: "p1" }), {
      session,
    });

    expect(at(reply.messages[0], "method")).toBe("notifications/progress");
    expect(at(reply.messages[0], "params", "progressToken")).toBe("p1");
    expect(at(reply.messages[1], "id")).toBe(2);
  });

  it("carries the server's own request on the call's stream, and takes the answer as a POST (202)", async () => {
    const server = config("legacy");
    const session = await initialize(server);

    const call = await open(server, { session, body: callTool(2, "ask") });
    const question = await call.next();

    expect(at(question, "method")).toBe("elicitation/create");
    expect(at(question, "id")).toBe("q1");

    const answered = await open(server, {
      session,
      body: { jsonrpc: "2.0", id: "q1", result: { action: "accept" } },
    });

    expect(answered.status).toBe(202);

    const result = await call.next();

    expect(at(result, "id")).toBe(2);
    expect(at(result, "result", "structuredContent", "answer", "action")).toBe("accept");
    expect(await call.next()).toBeUndefined();
  });

  it("sends what no request is waiting for to the GET stream, and keeps it for one until it opens", async () => {
    const server = config("legacy");
    const session = await initialize(server);

    // A GET stream is open: the server's own notification reaches it.
    const stream = await open(server, { session, method: "GET" });

    expect(stream.status).toBe(200);
    await post(server, callTool(2, "later"), { session });
    expect(at(await stream.next(), "method")).toBe("notifications/tools/list_changed");
    stream.abort();

    // None: it waits, and is there when a stream opens.
    await post(server, callTool(3, "later"), { session });
    await vi.waitFor(async () => expect((await childrenOf(server))[0]?.queued).toBe(1));

    const late = await open(server, { session, method: "GET" });

    expect(at(await late.next(), "method")).toBe("notifications/tools/list_changed");
    late.abort();

    // No stream without a session, or of one that is not the child's.
    expect((await open(server, { method: "GET" })).status).toBe(405);
    expect((await open(server, { session: "gone", method: "GET" })).status).toBe(404);
  });

  it("cancels a request whose caller goes away, with the bridge's id for it", async () => {
    const server = config("legacy");
    const session = await initialize(server);

    const hung = await open(server, { session, body: callTool(77, "hang") });

    hung.abort();

    await vi.waitFor(async () => {
      const reply = await post(server, callTool(3, "cancelled"), { session });
      const cancelled = at(reply.messages[0], "result", "structuredContent", "cancelled");

      expect(cancelled).toHaveLength(1);
      // Not the caller's own id: the one the bridge sent the child the request with.
      expect(at(cancelled, 0)).not.toBe(77);
    });
  });

  it("refuses a Modern request, `server/discover` included, with a 400 that is no Modern error", async () => {
    const server = config("legacy");
    const session = await initialize(server);

    // Sessionless and Modern in shape, at a child that speaks Legacy.
    const refused = await post(server, rpc(5, "server/discover", envelope));

    expect(refused.status).toBe(400);
    expect(at(refused.messages[0], "error", "code")).toBe(-32600);
    expect(refused.headers.get(MCP_BRIDGE_SPAWN_HEADER)).toBe(session);
    expect(await childrenOf(server)).toHaveLength(1);
  });

  it("reads a silent server, an erroring one and one that exits as Legacy, and a fresh process takes the handshake", async () => {
    for (const behaviour of ["silent", "error", "exit"]) {
      const server = config("legacy", { FIXTURE_DISCOVER: behaviour });
      const started = Date.now();
      const probed = await post(server, rpc(1, "server/discover", envelope));

      expect(probed.status).toBe(400);

      // The silence took the probe's time (400 ms here, 15 s in the image); the others answered at once.
      if (behaviour === "silent") expect(Date.now() - started).toBeGreaterThanOrEqual(350);

      // The verdict is kept: no spawn for a Modern request without a hint.
      const again = await post(server, callTool(2, "echo", {}, envelope));

      expect(again.status).toBe(400);

      const session = await initialize(server);
      const children = await childrenOf(server);

      expect(children).toHaveLength(1);
      expect(children[0]).toMatchObject({ spawnId: session, era: "legacy", state: "running" });
    }
  });
});

describe("a Modern stdio server", () => {
  it("is probed once with `server/discover`, and answers the host's with its own result", async () => {
    const server = config("modern");
    const reply = await post(server, rpc(1, "server/discover", envelope));

    expect(reply.status).toBe(200);
    expect(reply.messages).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        result: {
          supportedVersions: ["2026-07-28"],
          capabilities: { tools: {} },
          serverInfo: { name: "modern-fixture", version: "1" },
        },
      },
    ]);
    expect(reply.headers.get("mcp-session-id")).toBeNull();

    const [child] = await childrenOf(server);

    expect(child).toMatchObject({ era: "modern", state: "running" });
    expect(reply.headers.get(MCP_BRIDGE_SPAWN_HEADER)).toBe(child?.spawnId);

    // The probe was the one `server/discover` the child saw.
    const stats = await post(server, callTool(2, "stats", {}, envelope));

    expect(at(stats.messages[0], "result", "structuredContent", "discoverCalls")).toBe(1);
  });

  it("is not probed when the host's hint names its era, and gets bodies as they are, with ids rewritten", async () => {
    const server = config("modern");

    const reply = await post(server, callTool(41, "echo", { text: "hi" }, envelope), {
      era: "modern",
    });

    expect(at(reply.messages[0], "id")).toBe(41);
    expect(at(reply.messages[0], "result", "structuredContent", "meta")).toEqual(envelope);
    expect(at(reply.messages[0], "result", "structuredContent", "seenId")).not.toBe(41);

    const stats = await post(server, callTool(42, "stats", {}, envelope), { era: "modern" });

    expect(at(stats.messages[0], "result", "structuredContent", "discoverCalls")).toBe(0);
    expect((await childrenOf(server))[0]).toMatchObject({ era: "modern" });
  });

  it("is spawned lazily by a request, shared by every caller, and keyed by its config, not by the order of its env", async () => {
    const server = config("modern", { FIXTURE_A: "1", FIXTURE_B: "2" });

    const reordered: McpBridgeConfig = {
      ...server,
      env: { FIXTURE_B: "2", FIXTURE_A: "1", ...server.env },
    };

    expect(await mcpBridgeKey(reordered)).toBe(await mcpBridgeKey(server));
    expect(await childrenOf(server)).toEqual([]);

    const first = await post(server, callTool(1, "pid", {}, envelope), { era: "modern" });
    const second = await post(reordered, callTool(1, "pid", {}, envelope), { era: "modern" });

    expect(second.headers.get(MCP_BRIDGE_SPAWN_HEADER)).toBe(
      first.headers.get(MCP_BRIDGE_SPAWN_HEADER),
    );
    expect(at(second.messages[0], "result", "structuredContent", "pid")).toBe(
      at(first.messages[0], "result", "structuredContent", "pid"),
    );

    // A changed config is another server.
    const changed = await post(
      { ...server, env: { ...server.env, FIXTURE_A: "changed" } },
      callTool(1, "pid", {}, envelope),
      { era: "modern" },
    );

    expect(changed.headers.get(MCP_BRIDGE_SPAWN_HEADER)).not.toBe(
      first.headers.get(MCP_BRIDGE_SPAWN_HEADER),
    );
  });

  it("answers 400 to a hint of Legacy, without spawning", async () => {
    const server = config("modern");
    const reply = await post(server, rpc(1, "server/discover", envelope), { era: "legacy" });

    expect(reply.status).toBe(400);
    expect(await childrenOf(server)).toEqual([]);
  });

  it("takes progress on the call's stream, and drops the request it sends to the stderr tail", async () => {
    const server = config("modern");

    const progress = await post(
      server,
      callTool(1, "progress", {}, { ...envelope, progressToken: 5 }),
      {
        era: "modern",
      },
    );

    expect(at(progress.messages[0], "method")).toBe("notifications/progress");
    expect(at(progress.messages[0], "params", "progressToken")).toBe(5);
    expect(at(progress.messages[1], "id")).toBe(1);

    const asked = await post(server, callTool(2, "ask", {}, envelope), { era: "modern" });

    expect(asked.messages).toHaveLength(1);
    expect(at(asked.messages[0], "result", "content", 0, "text")).toBe("asked");
    expect((await childrenOf(server))[0]?.stderrTail).toContain("elicitation/create");
  });

  it("streams a listen's notifications back under its own id, and ends it when the child exits", async () => {
    const server = config("modern");

    const listen = await open(server, {
      era: "modern",
      body: rpc(5, "subscriptions/listen", envelope),
    });

    expect(listen.status).toBe(200);

    const acknowledged = await listen.next();

    expect(at(acknowledged, "method")).toBe("notifications/subscriptions/acknowledged");
    expect(at(acknowledged, "params", "_meta", "io.modelcontextprotocol/subscriptionId")).toBe(5);
    expect((await childrenOf(server))[0]).toMatchObject({ listens: 1, inFlight: 0 });

    await post(server, callTool(6, "poke", {}, envelope), { era: "modern" });

    const poked = await listen.next();

    expect(at(poked, "method")).toBe("notifications/tools/list_changed");
    expect(at(poked, "params", "_meta", "io.modelcontextprotocol/subscriptionId")).toBe(5);

    // The child exits: the listen ends with nothing more, which the host reads as `remote`.
    const crashed = await post(server, callTool(7, "crash", {}, envelope), { era: "modern" });

    expect(crashed.messages).toEqual([]);
    expect(await listen.next()).toBeUndefined();
  });

  it("cancels a request whose caller goes away, in the era's own shape", async () => {
    const server = config("modern");
    const hung = await open(server, { era: "modern", body: callTool(77, "hang", {}, envelope) });

    hung.abort();

    await vi.waitFor(async () => {
      const reply = await post(server, callTool(3, "cancelled", {}, envelope), { era: "modern" });
      const cancelled = at(reply.messages[0], "result", "structuredContent", "cancelled");

      expect(at(cancelled, 0, "version")).toBe("2026-07-28");
      expect(at(cancelled, 0, "requestId")).not.toBe(77);
    });
  });
});

describe("a child that crashes", () => {
  it("cuts the calls in flight with no answer, and the status says why; a Legacy session is then stale", async () => {
    const server = config("legacy");
    const session = await initialize(server);
    const pid = (await childrenOf(server))[0]?.pid;

    const [crashed, bystander] = await Promise.all([
      post(server, callTool(2, "crash"), { session }),
      open(server, { session, body: callTool(3, "hang") }),
    ]);

    // The stream ends without its answer, as a cut.
    expect(crashed.status).toBe(200);
    expect(crashed.messages).toEqual([]);
    expect(await bystander.rest()).toEqual([]);

    const [child] = await childrenOf(server);

    expect(child).toMatchObject({
      spawnId: session,
      state: "exited",
      exit: { code: 3, signal: null },
    });
    expect(child?.stderrTail).toContain("fixture crashing");
    expect(alive(pid)).toBe(false);

    const stale = await post(server, rpc(4, "tools/list"), { session });

    expect(stale.status).toBe(404);

    const fresh = await initialize(server);

    expect(fresh).not.toBe(session);
    expect(await childrenOf(server)).toHaveLength(1);
  });

  it("is spawned again by the next Modern request, under a new spawn id", async () => {
    const server = config("modern");
    const first = await post(server, callTool(1, "crash", {}, envelope), { era: "modern" });

    expect(first.messages).toEqual([]);

    const [dead] = await childrenOf(server);

    expect(dead).toMatchObject({ state: "exited", exit: { code: 3 } });

    const second = await post(server, callTool(2, "echo", { text: "again" }, envelope), {
      era: "modern",
    });

    expect(at(second.messages[0], "result", "content", 0, "text")).toBe("again");
    expect(second.headers.get(MCP_BRIDGE_SPAWN_HEADER)).not.toBe(
      first.headers.get(MCP_BRIDGE_SPAWN_HEADER),
    );
    expect(await childrenOf(server)).toHaveLength(1);
  });

  it("is named when it never started: the spawn error is its exit", async () => {
    const server: McpBridgeConfig = {
      command: "/nonexistent/cloudpid-mcp-server",
      env: { FIXTURE_NONCE: String((counter += 1)) },
    };

    const reply = await post(server, callTool(1, "echo", {}, envelope), { era: "modern" });

    expect(reply.messages).toEqual([]);

    const [child] = await childrenOf(server);

    expect(child?.state).toBe("exited");
    expect(child?.exit?.error).toContain("spawn failed");
  });
});

describe("a child's stderr tail", () => {
  it("is bounded in bytes, not characters, and cut on a character", async () => {
    const server = config("modern");

    await post(server, callTool(1, "noisy", {}, envelope), { era: "modern" });

    const tail = (await childrenOf(server))[0]?.stderrTail ?? "";
    const bytes = Buffer.byteLength(tail);

    expect(bytes).toBeLessThanOrEqual(MCP_BRIDGE_STDERR_LIMIT);
    // Most of the limit is kept, and what is kept is the end, with no character cut in two.
    expect(bytes).toBeGreaterThan(MCP_BRIDGE_STDERR_LIMIT - 4);
    expect(tail).not.toContain("\uFFFD");
    expect(tail.endsWith("é".repeat(100) + "end\n")).toBe(true);
  });
});

describe("the control calls", () => {
  it("list every child with its spawn id, exit and stderr tail, and never spawn one", async () => {
    const server = config("legacy");
    const before = (await status()).children.length;

    expect((await status()).level).toBe(MCP_BRIDGE_LEVEL);
    expect((await status()).children).toHaveLength(before);
    expect(await childrenOf(server)).toEqual([]);

    await initialize(server);

    expect((await status()).children).toHaveLength(before + 1);
    // The key is the hash of the config, which the Workers' side can make too.
    expect((await childrenOf(server))[0]?.key).toBe(await mcpBridgeKey(server));
  });

  it("stop one child by its key, which the next call then spawns anew", async () => {
    const server = config("legacy");
    const session = await initialize(server);
    const [child] = await childrenOf(server);

    expect(child?.key).toBeDefined();

    const stopped = await control(MCP_BRIDGE_STOP_PATH, {
      method: "POST",
      body: { key: child?.key ?? "" },
    });

    expect(stopped.status).toBe(200);
    expect(stopped.body).toEqual({ stopped: true });
    expect(alive(child?.pid)).toBe(false);
    expect((await childrenOf(server))[0]).toMatchObject({
      state: "exited",
      exit: { reason: "stopped" },
    });
    expect((await post(server, rpc(2, "tools/list"), { session })).status).toBe(404);

    // Nothing to stop, and nothing spawned by asking.
    const again = await control(MCP_BRIDGE_STOP_PATH, {
      method: "POST",
      body: { key: child?.key ?? "" },
    });

    const unknown = await control(MCP_BRIDGE_STOP_PATH, {
      method: "POST",
      body: { key: "nothing" },
    });

    expect(again.body).toEqual({ stopped: false });
    expect(unknown.body).toEqual({ stopped: false });
    expect((await control(MCP_BRIDGE_STOP_PATH, { method: "POST", body: {} })).status).toBe(400);
    expect((await childrenOf(server))[0]?.state).toBe("exited");

    expect(await initialize(server)).not.toBe(session);
  });

  it("answers health at once, and 404 or 405 for what it does not serve", async () => {
    expect((await control(MCP_BRIDGE_HEALTH_PATH)).body).toEqual({ status: "ok" });
    expect((await control("/nothing")).status).toBe(404);
    expect((await control("/_bridge/nothing")).status).toBe(404);
    expect((await control(MCP_BRIDGE_STATUS_PATH, { method: "POST", body: {} })).status).toBe(404);
  });
});

describe("a request the bridge cannot take", () => {
  it("is refused with a 400 for a missing or bad config, a batch or a body that is not JSON-RPC", async () => {
    const withHeader = (header: string | undefined, body: string) =>
      fetch(`${base}${MCP_BRIDGE_MCP_PATH}`, {
        method: "POST",
        headers: new Headers({
          ...authorization(undefined),
          [MCP_BRIDGE_CONFIG_HEADER]: header ?? "",
        }),
        body,
      });

    const good = mcpBridgeConfigHeader(config("modern"));
    const encode = (value: string) => Buffer.from(value).toString("base64url");

    expect((await withHeader(undefined, "{}")).status).toBe(400);
    expect((await withHeader("not base64 json", "{}")).status).toBe(400);
    expect((await withHeader(encode("[]"), "{}")).status).toBe(400);
    expect((await withHeader(encode('{"command":""}'), "{}")).status).toBe(400);
    expect((await withHeader(encode('{"command":"x","args":[1]}'), "{}")).status).toBe(400);
    expect((await withHeader(encode('{"command":"x","env":{"a":1}}'), "{}")).status).toBe(400);
    expect((await withHeader(good, "not json")).status).toBe(400);
    expect((await withHeader(good, "[]")).status).toBe(400);
    expect((await withHeader(good, '{"no":"method or id"}')).status).toBe(400);
    expect((await open(config("modern"), { method: "DELETE", session: "x" })).status).toBe(405);
  });
});
