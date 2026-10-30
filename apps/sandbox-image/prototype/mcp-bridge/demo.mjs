#!/usr/bin/env node
// PROTOTYPE (#383), throwaway. Drives bridge.mjs the way the Environment's MCP host object would, with the 2025-11-25
// SDK client, and prints what happens at each step. Run from this directory after `npm install`:
//
//   node demo.mjs                      # everything server via npx, warm npm cache
//   COLD=1 node demo.mjs               # the same with an empty npm cache (the first call after a fresh Container)
//
// The bridge is a child of this script, so "the Container stops" is the bridge killed with its stdio servers.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CreateMessageRequestSchema,
  ElicitRequestSchema,
  ListRootsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const PORT = 8790;
const TOKEN = "prototype-token";
const npmCache = process.env.COLD ? mkdtempSync(join(tmpdir(), "p383-npm-")) : undefined;
const SERVER = {
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-everything@2.1.0"],
  env: npmCache ? { npm_config_cache: npmCache } : {},
};

const t0 = Date.now();
const step = (title) =>
  console.log(`\n=== ${title}  [+${((Date.now() - t0) / 1000).toFixed(1)} s]`);
const show = (label, value) => console.log(`  ${label}:`, value);
const time = async (label, fn) => {
  const start = Date.now();
  try {
    const result = await fn();
    show(label, `${Date.now() - start} ms`);
    return result;
  } catch (error) {
    show(label, `FAILED after ${Date.now() - start} ms: ${error.code ?? ""} ${error.message}`);
    throw error;
  }
};

// --- The Container: the bridge, killed and started again like an idle stop and a cold start.
let bridge;
const startBridge = async () => {
  bridge = spawn(process.execPath, [new URL("./bridge.mjs", import.meta.url).pathname], {
    env: { ...process.env, BRIDGE_PORT: String(PORT), BRIDGE_TOKEN: TOKEN },
    stdio: ["ignore", "pipe", "inherit"],
    detached: true, // its own process group, so the stop takes its stdio servers too
  });
  bridge.stdout.on("data", (d) => process.stdout.write(`  | bridge ${d}`));
  await new Promise((resolve) => bridge.stdout.once("data", resolve));
};
const stopContainer = async () => {
  process.kill(-bridge.pid, "SIGKILL");
  await new Promise((resolve) => bridge.once("exit", resolve));
};
const status = async () =>
  (await fetch(`http://127.0.0.1:${PORT}/status`, { headers: { "x-bridge-token": TOKEN } })).json();

// --- The host's side: one client per server, re-initialized on a 404 (the bridge forgot the session).
const serverRequests = [];
const newClient = () => {
  const client = new Client(
    { name: "cloudpid-prototype", version: "0.0.0" },
    { capabilities: { sampling: {}, elicitation: { form: {} }, roots: { listChanged: true } } },
  );
  client.setRequestHandler(CreateMessageRequestSchema, async (req) => {
    serverRequests.push("sampling/createMessage");
    return {
      role: "assistant",
      model: "prototype-small",
      content: { type: "text", text: `sampled: ${req.params.messages[0].content.text}` },
    };
  });
  client.setRequestHandler(ElicitRequestSchema, async (req) => {
    serverRequests.push("elicitation/create");
    show("elicitation asked", req.params.message);
    const content = {};
    for (const [name, schema] of Object.entries(req.params.requestedSchema?.properties ?? {}))
      content[name] =
        schema.type === "boolean"
          ? true
          : schema.type === "number" || schema.type === "integer"
            ? 1
            : (schema.enum?.[0] ?? "prototype");
    return { action: "accept", content };
  });
  client.setRequestHandler(ListRootsRequestSchema, async () => {
    serverRequests.push("roots/list");
    return { roots: [{ uri: "file:///workspace/cloudpid", name: "cloudpid" }] };
  });
  return client;
};
const connect = async () => {
  const client = newClient();
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), {
    requestInit: {
      headers: {
        "x-bridge-token": TOKEN,
        "x-bridge-server": Buffer.from(JSON.stringify(SERVER)).toString("base64url"),
      },
    },
  });
  await client.connect(transport);
  show("session", transport.sessionId);
  return client;
};
let client;
/** A request the host retries once after a re-initialize when the bridge no longer knows the session. */
const request = async (fn) => {
  try {
    return await fn(client);
  } catch (error) {
    if (error.code !== 404) throw error;
    show("bridge answered 404", "session gone; re-initializing");
    client = await time("re-initialize", connect);
    return fn(client);
  }
};
const text = (result) => result.content?.map((c) => c.text ?? `[${c.type}]`).join(" ");

try {
  step(
    `Container start (bridge only; no stdio server yet)${npmCache ? `, empty npm cache ${npmCache}` : ""}`,
  );
  await startBridge();
  show("bridge status", await status());

  step("Discovery: initialize spawns the server lazily, then list everything");
  client = await time("initialize (spawn + npx)", connect);
  const tools = await time("tools/list", () => client.listTools());
  const resources = await time("resources/list", () => client.listResources());
  const templates = await time("resources/templates/list", () => client.listResourceTemplates());
  const prompts = await time("prompts/list", () => client.listPrompts());
  show(
    "inventory",
    `${tools.tools.length} tools, ${resources.resources.length} resources, ${templates.resourceTemplates.length} templates, ${prompts.prompts.length} prompts`,
  );
  show("tools", tools.tools.map((t) => t.name).join(", "));
  show("bridge status", await status());

  step(
    "Idle stop: the Container stops, the server with it (the host keeps its inventory and session id)",
  );
  await stopContainer();

  step("A later call: cold start, the bridge answers 404, the host re-initializes and retries");
  await time("Container start (bridge)", startBridge);
  const echoed = await time("tools/call echo (404 + re-initialize + call)", () =>
    request((c) => c.callTool({ name: "echo", arguments: { message: "after the idle stop" } })),
  );
  show("result", text(echoed));

  step("Server→client requests mid-call: sampling, elicitation, roots");
  const sampled = await time("tools/call trigger-sampling-request", () =>
    request((c) =>
      c.callTool({ name: "trigger-sampling-request", arguments: { prompt: "hello" } }),
    ),
  );
  show("result", text(sampled));
  const elicited = await time("tools/call trigger-elicitation-request", () =>
    request((c) => c.callTool({ name: "trigger-elicitation-request", arguments: {} })),
  ).catch((e) => ({ content: [{ text: `error: ${e.message}` }] }));
  show("result", text(elicited)?.slice(0, 200));
  const roots = await time("tools/call get-roots-list", () =>
    request((c) => c.callTool({ name: "get-roots-list", arguments: {} })),
  );
  show("result", text(roots)?.slice(0, 200));
  show("server requests the host answered", serverRequests);

  step("Progress on the call's own stream");
  const progress = [];
  await time("tools/call trigger-long-running-operation (3 s, 3 steps)", () =>
    request((c) =>
      c.callTool(
        { name: "trigger-long-running-operation", arguments: { duration: 3, steps: 3 } },
        undefined,
        {
          onprogress: (p) => progress.push(`${p.progress}/${p.total}`),
        },
      ),
    ),
  );
  show("progress seen", progress);

  step("A call cut by the server's exit (OOM kill, crash): the bridge answers it with an error");
  const call = request((c) =>
    c.callTool({ name: "trigger-long-running-operation", arguments: { duration: 10, steps: 5 } }),
  );
  await new Promise((r) => setTimeout(r, 1500));
  const [live] = await status();
  show("in flight", live.inFlight);
  process.kill(live.pid, "SIGKILL");
  await call.then(
    (r) => show("result", text(r)),
    (e) => show("call failed", `${e.code} ${e.message}`),
  );
  show("bridge status", await status());
  const after = await time("next call (404 + re-initialize + call)", () =>
    request((c) => c.callTool({ name: "echo", arguments: { message: "after the crash" } })),
  );
  show("result", text(after));

  step("A call cut by a Container stop (held stop, container_restart): the stream breaks");
  const cut = request((c) =>
    c.callTool({ name: "trigger-long-running-operation", arguments: { duration: 10, steps: 5 } }),
  );
  await new Promise((r) => setTimeout(r, 1500));
  await stopContainer();
  await cut.then(
    (r) => show("result", text(r)),
    (e) => show("call failed", `${e.code ?? ""} ${e.message}`),
  );

  step("A call while the Container is stopped and nothing starts it");
  await request((c) => c.callTool({ name: "echo", arguments: { message: "x" } })).then(
    (r) => show("result", text(r)),
    (e) => show("call failed", `${e.code ?? ""} ${e.message}`),
  );
} finally {
  try {
    process.kill(-bridge.pid, "SIGKILL");
  } catch {}
  process.exit(0);
}
