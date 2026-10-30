#!/usr/bin/env node
// PROTOTYPE (#383), throwaway: never merged. A bridge that serves stdio MCP servers as Streamable HTTP on one port,
// spawning each server lazily on the first request for it. Plain Node, no dependencies, so it runs on the sandbox image.
//
// - A request names its server by `x-bridge-server: base64url(JSON {command, args, env, cwd})`; the server's key is
//   the SHA-256 of that JSON. The bridge keeps nothing else: after a restart (an idle stop) it knows no server.
// - 2025-11-25 era: `initialize` without `Mcp-Session-Id` spawns the server (replacing a live one of the same key) and
//   answers with `Mcp-Session-Id: <key>.<spawn>`. A request whose session is not the live spawn gets 404, which the
//   spec tells a client to answer with a new `initialize`.
// - 2026-07-28 era (no sessions): a request without `Mcp-Session-Id` goes to the server of its key, spawned if none.
// - A request is answered as SSE: the response ends the stream. The client's request ids are rewritten to the bridge's
//   own, so clients never collide on one shared child. Server→client requests and notifications go on the stream of
//   the request their progress token names, else the newest request in flight, else the GET stream, else wait for one.
// - A server that exits answers each request in flight with a JSON-RPC error and ends the GET stream.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createInterface } from "node:readline";

const PORT = Number(process.env.BRIDGE_PORT ?? 8790);
const TOKEN = process.env.BRIDGE_TOKEN ?? "";
const KEEPALIVE_MS = 15_000;
const STDERR_LINES = 50;

/** @type {Map<string, Child>} live children by key */
const children = new Map();
let nextBridgeId = 1;
const log = (...args) => console.log(new Date().toISOString(), ...args);

/**
 * @typedef {{ key: string, spawnId: string, config: any, proc: import("node:child_process").ChildProcess,
 *   spawnedAt: number, firstLineAt?: number, pending: Map<number, Pending>, getStream?: import("node:http").ServerResponse,
 *   queued: string[], stderr: string[], exited?: string, lastTraffic: number }} Child
 * @typedef {{ res: import("node:http").ServerResponse, clientId: any, method: string, progressToken?: any, startedAt: number }} Pending
 */

const sse = (res, message) => res.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);

const openSse = (res, headers = {}) => {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    ...headers,
  });
  res.flushHeaders();
  const timer = setInterval(() => res.write(": ping\n\n"), KEEPALIVE_MS);
  res.on("close", () => clearInterval(timer));
};

const spawnChild = (key, config) => {
  const old = children.get(key);
  if (old) {
    log(`replace ${old.spawnId}`);
    old.proc.kill();
  }
  const spawnId = `${key.slice(0, 16)}.${randomBytes(6).toString("hex")}`;
  const proc = spawn(config.command, config.args ?? [], {
    cwd: config.cwd,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...config.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  /** @type {Child} */
  const child = {
    key,
    spawnId,
    config,
    proc,
    spawnedAt: Date.now(),
    pending: new Map(),
    queued: [],
    stderr: [],
    lastTraffic: Date.now(),
  };
  children.set(key, child);
  log(`spawn ${spawnId}: ${config.command} ${(config.args ?? []).join(" ")} (pid ${proc.pid})`);

  createInterface({ input: proc.stdout }).on("line", (line) => onChildLine(child, line));
  createInterface({ input: proc.stderr }).on("line", (line) => {
    child.stderr.push(line);
    if (child.stderr.length > STDERR_LINES) child.stderr.shift();
  });
  const onExit = (why) => {
    if (child.exited) return;
    child.exited = why;
    log(`exit ${spawnId}: ${why}`);
    if (children.get(key) === child) children.delete(key);
    for (const pending of child.pending.values()) {
      sse(pending.res, {
        jsonrpc: "2.0",
        id: pending.clientId,
        error: {
          code: -32000,
          message: `stdio server exited (${why})`,
          data: { stderr: child.stderr.slice(-10) },
        },
      });
      pending.res.end();
    }
    child.pending.clear();
    child.getStream?.end();
  };
  proc.on("exit", (code, signal) => onExit(signal ? `signal ${signal}` : `code ${code}`));
  proc.on("error", (error) => onExit(`spawn failed: ${error.message}`));
  return child;
};

const onChildLine = (child, line) => {
  child.lastTraffic = Date.now();
  if (child.firstLineAt === undefined) {
    child.firstLineAt = Date.now();
    log(`first line from ${child.spawnId} after ${child.firstLineAt - child.spawnedAt} ms`);
  }
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    child.stderr.push(`[stdout, not JSON] ${line}`);
    return;
  }
  // A response to a client request: back on its own stream, with the client's id.
  if (message.method === undefined && message.id !== undefined) {
    const pending = child.pending.get(message.id);
    if (!pending) return log(`response for unknown id ${message.id} from ${child.spawnId}`);
    child.pending.delete(message.id);
    sse(pending.res, { ...message, id: pending.clientId });
    pending.res.end();
    log(`${pending.method} answered in ${Date.now() - pending.startedAt} ms`);
    return;
  }
  // A server→client request or notification: the stream it belongs to, the newest in flight, the GET stream, or wait.
  const token = message.params?.progressToken;
  const pendings = [...child.pending.values()];
  const target =
    (token === undefined ? undefined : pendings.find((p) => p.progressToken === token)?.res) ??
    pendings.at(-1)?.res ??
    child.getStream;
  if (target) sse(target, message);
  else child.queued.push(JSON.stringify(message));
  log(
    `server ${message.id !== undefined ? "request" : "notification"} ${message.method} → ${target ? "stream" : "queued"}`,
  );
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

const fail = (res, status, message) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message } }));
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://bridge");
  if (TOKEN && req.headers["x-bridge-token"] !== TOKEN) return fail(res, 401, "bad bridge token");

  if (url.pathname === "/status") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(
      JSON.stringify(
        [...children.values()].map((c) => ({
          spawnId: c.spawnId,
          command: `${c.config.command} ${(c.config.args ?? []).join(" ")}`,
          pid: c.proc.pid,
          upMs: Date.now() - c.spawnedAt,
          firstLineMs: c.firstLineAt === undefined ? null : c.firstLineAt - c.spawnedAt,
          inFlight: [...c.pending.values()].map((p) => p.method),
          getStream: Boolean(c.getStream),
          queued: c.queued.length,
          idleMs: Date.now() - c.lastTraffic,
          stderrTail: c.stderr.slice(-5),
        })),
        null,
        2,
      ),
    );
  }
  if (url.pathname !== "/mcp") return fail(res, 404, "not found");

  const header = req.headers["x-bridge-server"];
  if (typeof header !== "string") return fail(res, 400, "missing x-bridge-server");
  const json = Buffer.from(header, "base64url").toString("utf8");
  const config = JSON.parse(json);
  const key = createHash("sha256").update(json).digest("hex");
  const sessionId = req.headers["mcp-session-id"];
  const live = children.get(key);
  const sessionLive = () =>
    typeof sessionId !== "string" || (live !== undefined && live.spawnId === sessionId);

  if (req.method === "DELETE") {
    if (live && live.spawnId === sessionId) live.proc.kill();
    res.writeHead(200);
    return res.end();
  }

  if (req.method === "GET") {
    if (typeof sessionId !== "string" || !sessionLive()) return fail(res, 404, "session not found");
    openSse(res);
    live.getStream = res;
    res.on("close", () => {
      if (live.getStream === res) live.getStream = undefined;
    });
    for (const line of live.queued.splice(0)) res.write(`event: message\ndata: ${line}\n\n`);
    return;
  }

  if (req.method !== "POST") return fail(res, 405, "method not allowed");
  const message = JSON.parse(await readBody(req));
  if (Array.isArray(message)) return fail(res, 400, "batches are not supported");

  let child;
  if (message.method === "initialize" && typeof sessionId !== "string")
    child = spawnChild(key, config);
  else if (!sessionLive()) return fail(res, 404, "session not found");
  else child = live ?? spawnChild(key, config); // 2026-07-28: no session, spawn lazily
  child.lastTraffic = Date.now();

  // A notification, or the client's answer to a server request: to stdin, 202.
  if (message.method === undefined || message.id === undefined) {
    child.proc.stdin.write(`${JSON.stringify(message)}\n`);
    res.writeHead(202);
    return res.end();
  }

  // A request: rewrite its id, answer on SSE.
  const bridgeId = nextBridgeId++;
  openSse(res, message.method === "initialize" ? { "mcp-session-id": child.spawnId } : {});
  child.pending.set(bridgeId, {
    res,
    clientId: message.id,
    method: message.method,
    progressToken: message.params?._meta?.progressToken,
    startedAt: Date.now(),
  });
  res.on("close", () => {
    // The client went away before the answer: the spec's cancel.
    if (child.pending.delete(bridgeId) && !child.exited) {
      child.proc.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: bridgeId, reason: "client disconnected" } })}\n`,
      );
      log(`${message.method} cancelled: client disconnected`);
    }
  });
  child.proc.stdin.write(`${JSON.stringify({ ...message, id: bridgeId })}\n`);
});

server.listen(PORT, "0.0.0.0", () => log(`bridge on :${PORT}${TOKEN ? " (token required)" : ""}`));
