// A stdio MCP server for the bridge's tests (`mcp-bridge.test.ts`), in either era, written without the SDK as a server
// from npm would be: `node mcp-stdio.fixture.mjs legacy|modern`. Legacy is the 2025-11-25 protocol (an `initialize`
// handshake); Modern is 2026-07-28 (no handshake, `server/discover`, a `_meta` envelope on every request, `subscriptions/listen`).
// `FIXTURE_DISCOVER` is what a Legacy server does with `server/discover`: `silent` (the default), `error` or `exit`.
import { createInterface } from "node:readline";

const era = process.argv[2] === "modern" ? "modern" : "legacy";
const PROTOCOL_VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
const SUBSCRIPTION_ID_KEY = "io.modelcontextprotocol/subscriptionId";

const cancelled = [];
const listens = new Set();
const answers = new Map();
let discoverCalls = 0;

const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

const reply = (id, result) => send({ id, result });
const fail = (id, code, message) => send({ id, error: { code, message } });

const text = (value, extra = {}) => ({
  content: [{ type: "text", text: String(value) }],
  ...extra,
});

const tools = [
  "echo",
  "pid",
  "env",
  "progress",
  "ask",
  "later",
  "poke",
  "hang",
  "cancelled",
  "stats",
  "crash",
];

const call = (id, params) => {
  const { name, arguments: args = {} } = params;
  const progressToken = params._meta?.progressToken;

  switch (name) {
    case "echo":
      // `id` is the id this server saw: the bridge's own, not the caller's.
      return reply(
        id,
        text(args.text, { structuredContent: { seenId: id, meta: params._meta ?? null } }),
      );
    case "pid":
      return reply(id, text(process.pid, { structuredContent: { pid: process.pid } }));
    case "env":
      return reply(
        id,
        text(process.env[args.name] ?? "", {
          structuredContent: { value: process.env[args.name] ?? null },
        }),
      );
    case "progress":
      send({
        method: "notifications/progress",
        params: { progressToken, progress: 1, message: "halfway" },
      });

      return setTimeout(() => reply(id, text("done")), 30);
    case "ask": {
      // A question for the caller: Legacy answers it by a POST; Modern has no such request, and the bridge drops it.
      send({
        id: "q1",
        method: "elicitation/create",
        params: { message: "sure?", requestedSchema: { type: "object", properties: {} } },
      });
      answers.set("q1", (answer) => reply(id, text("asked", { structuredContent: { answer } })));

      return era === "modern" ? setTimeout(() => reply(id, text("asked")), 50) : undefined;
    }

    case "later":
      reply(id, text("ok"));

      return setTimeout(() => send({ method: "notifications/tools/list_changed" }), 150);
    case "poke":
      // Every open listen hears of it, named by the id of its request.
      for (const listen of listens)
        send({
          method: "notifications/tools/list_changed",
          params: { _meta: { [SUBSCRIPTION_ID_KEY]: listen } },
        });

      return reply(id, text("poked"));
    case "hang":
      return undefined;
    case "cancelled":
      return reply(id, text("cancelled", { structuredContent: { cancelled } }));
    case "stats":
      return reply(id, text("stats", { structuredContent: { discoverCalls } }));
    case "crash":
      process.stderr.write("fixture crashing\n");

      return process.exit(3);
    default:
      return fail(id, -32602, `unknown tool ${name}`);
  }
};

const legacy = (message) => {
  const { id, method, params = {} } = message;

  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "legacy-fixture", version: "1" },
      });
    case "notifications/initialized":
      return undefined;
    case "tools/list":
      return reply(id, { tools: tools.map((name) => ({ name, inputSchema: { type: "object" } })) });
    case "tools/call":
      return call(id, params);
    default:
      if (method === "server/discover" && process.env.FIXTURE_DISCOVER === "exit")
        return process.exit(1);

      if (method === "server/discover" && (process.env.FIXTURE_DISCOVER ?? "silent") === "silent")
        return undefined;

      return id === undefined ? undefined : fail(id, -32601, "method not found");
  }
};

const modern = (message) => {
  const { id, method, params = {} } = message;

  switch (method) {
    case "server/discover":
      discoverCalls += 1;

      return reply(id, {
        supportedVersions: ["2026-07-28"],
        capabilities: { tools: {} },
        serverInfo: { name: "modern-fixture", version: "1" },
      });
    case "tools/list":
      return reply(id, { tools: tools.map((name) => ({ name, inputSchema: { type: "object" } })) });
    case "tools/call":
      return call(id, params);
    case "subscriptions/listen":
      listens.add(id);

      return send({
        method: "notifications/subscriptions/acknowledged",
        params: { _meta: { [SUBSCRIPTION_ID_KEY]: id }, notifications: {} },
      });
    case "notifications/cancelled":
      cancelled.push({
        requestId: params.requestId,
        version: params._meta?.[PROTOCOL_VERSION_KEY] ?? null,
      });

      return undefined;
    default:
      return id === undefined ? undefined : fail(id, -32601, "method not found");
  }
};

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);

  if (message.method === undefined) {
    // The caller's answer to a question of the server's.
    answers.get(message.id)?.(message.result);

    return;
  }

  if (message.method === "notifications/cancelled" && era === "legacy")
    cancelled.push(message.params.requestId);
  (era === "modern" ? modern : legacy)(message);
});
