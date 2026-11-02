// The Container MCP bridge (docs/architecture/mcp-connections.md → The stdio bridge): stdio MCP servers served as
// Streamable HTTP on one port, one child per server config, spawned lazily at the first request for it. The image's
// supervisor starts it at each Container start (`supervise`) with Node's type stripping, so this file is plain Node: no
// dependencies, no MCP SDK (the SDK is only `packages/mcp`'s), no state kept across a stop. The values it shares with the
// Workspaces Worker are `@cloudpid/sandbox-image/mcp-bridge`'s; `mcp-bridge.test.ts` fails when they differ.
//
// - A request names its server by `x-cloudpid-stdio-config` (base64url of its JSON config); the server's key is the hash
//   of that config. Every request carries `Authorization: Bearer <token>`, the token the Workspace DO minted for this
//   launch (`CLOUDPID_MCP_BRIDGE_TOKEN`), and is refused without it.
// - Legacy (2025-11-25): an `initialize` without a session spawns the child (replacing a live one of its key) and
//   answers `Mcp-Session-Id` = the spawn id; a request of another session gets 404. Modern (2026-07-28): a request
//   without a session goes to its key's child, spawned if none. `x-cloudpid-era` hints the host's cached era; without
//   it a fresh child is probed on stdin with `server/discover` (15 s of silence, an exit or any error mean Legacy).
// - Request ids are rewritten to the bridge's own, so callers never collide on a shared child. A request is answered on
//   its own SSE stream, which also carries the child's messages for it; a caller that disconnects cancels its request.
//   A child that exits ends the streams of its requests without an answer: the caller sees a cut and reads why from
//   `GET /_bridge/status`.
// - `x-cloudpid-spawn` (the spawn id, where a child is concerned) and `x-cloudpid-bridge` (the level) are on every
//   response. `/_bridge/health`, `/_bridge/status` and `POST /_bridge/stop { key }` never spawn a child.
// @effect-diagnostics nodeBuiltinImport:off processEnv:off globalConsole:off globalTimers:off globalDate:off globalRandom:off preferEffectArray:off preferEffectRecord:off strictBooleanExpressions:off newPromise:off asyncFunction:off unnecessaryArrowBlock:off schemaSync:off preferSchemaOverJson:off
/* oxlint-disable anti-slop/no-runtime-typeof -- this file's JSON guards are where the bridge's input is decoded, and it has no dependency to decode it with */
import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createInterface } from "node:readline";
// Erased by type stripping: the image needs no workspace file.
import type { McpBridgeChild, McpBridgeEra, McpBridgeStatus } from "../src/mcp-bridge.ts";

// These repeat `@cloudpid/sandbox-image/mcp-bridge`.
const LEVEL = 1;
const DEFAULT_PORT = 17_781;
const STDERR_LIMIT = 65_536;
const DEFAULT_PROBE_MS = 15_000;
const TOKEN_ENV = "CLOUDPID_MCP_BRIDGE_TOKEN";
const CONFIG_HEADER = "x-cloudpid-stdio-config";
const ERA_HEADER = "x-cloudpid-era";
const SPAWN_HEADER = "x-cloudpid-spawn";
const LEVEL_HEADER = "x-cloudpid-bridge";
const MCP_PATH = "/mcp";
const HEALTH_PATH = "/_bridge/health";
const STATUS_PATH = "/_bridge/status";
const STOP_PATH = "/_bridge/stop";

const KEEPALIVE_MS = 15_000;

// A request's body: larger is refused. A tool call's arguments are far below it.
const MAX_BODY_BYTES = 32 * 1024 * 1024;

// The start-up of a stdio server is the bridge's to wait for, but a stopped child that ignores SIGTERM is not.
const KILL_AFTER_MS = 2000;

// How long a child's exit waits for its output to end before it is settled anyway (a grandchild may hold the pipe).
const DRAIN_MS = 1000;

// Server messages that have no stream to go to wait for one, up to this many.
const QUEUE_LIMIT = 256;
const EXITED_LIMIT = 50;

// The `_meta` keys of a Modern request's envelope (the 2026-07-28 revision's).
const PROTOCOL_VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
const CLIENT_INFO_KEY = "io.modelcontextprotocol/clientInfo";
const CLIENT_CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities";
const SUBSCRIPTION_ID_KEY = "io.modelcontextprotocol/subscriptionId";
const MODERN_VERSION = "2026-07-28";

type Json = string | number | boolean | null | Json[] | JsonObject;

type JsonObject = { [key: string]: Json };

type RequestId = string | number;

type Era = McpBridgeEra;

type Config = {
  readonly command: string;
  readonly args: string[];
  readonly env: { [name: string]: string };
  readonly cwd: string | undefined;
};

type Incoming =
  | {
      readonly kind: "request";
      readonly id: RequestId;
      readonly method: string;
      readonly body: JsonObject;
    }
  | { readonly kind: "notification"; readonly method: string; readonly body: JsonObject }
  | { readonly kind: "response"; readonly body: JsonObject };

type Pending = {
  readonly res: ServerResponse;
  readonly clientId: RequestId;
  readonly method: string;
  readonly progressToken: RequestId | undefined;
  readonly listen: boolean;
  /** The Modern envelope the request carried, for the cancel the bridge sends if its caller goes away. */
  readonly envelope: JsonObject | undefined;
};

type Exit = {
  code: number | null;
  signal: string | null;
  reason: "stopped" | "replaced" | undefined;
  error: string | undefined;
  at: string;
};

type Child = {
  readonly key: string;
  readonly spawnId: string;
  readonly config: Config;
  readonly proc: ChildProcess;
  readonly startedAt: string;
  era: Era | undefined;
  probe: Promise<Era> | undefined;
  discover: Json | undefined;
  readonly pending: Map<number, Pending>;
  readonly probes: Map<number, (message: JsonObject) => void>;
  readonly queued: JsonObject[];
  readonly exitWaiters: Array<() => void>;
  getStream: ServerResponse | undefined;
  // The end of what it wrote to stderr (and the bridge's notes), at most STDERR_LIMIT bytes.
  stderr: Buffer;
  exit: Exit | undefined;
  // What was asked of the process (it has not exited yet), so its exit says why.
  asked: "stopped" | "replaced" | undefined;
  // Killed by the bridge's own verdict (a Legacy server probed): not an exit to report.
  discarded: boolean;
  settled: boolean;
};

// ---- JSON ----

const isString = (value: Json | undefined): value is string => typeof value === "string";

const isObject = (value: Json | undefined): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isId = (value: Json | undefined): value is RequestId =>
  typeof value === "string" || typeof value === "number";

const parseJson = (text: string): Json | undefined => {
  try {
    // SAFETY: JSON.parse returns JSON, which `Json` describes; callers narrow it with the guards above.
    return JSON.parse(text) as Json;
  } catch {
    return undefined;
  }
};

const objectField = (object: JsonObject, name: string): JsonObject | undefined => {
  const value = object[name];

  return isObject(value) ? value : undefined;
};

const classify = (body: JsonObject): Incoming | undefined => {
  const { id, method } = body;

  if (isString(method)) {
    return isId(id)
      ? { kind: "request", id, method, body }
      : { kind: "notification", method, body };
  }

  return isId(id) ? { kind: "response", body } : undefined;
};

const parseConfig = (header: string | undefined): Config | undefined => {
  if (header === undefined) return undefined;

  const parsed = parseJson(Buffer.from(header, "base64url").toString("utf8"));

  if (!isObject(parsed)) return undefined;

  const { command, args, env, cwd } = parsed;
  const argv = args === undefined ? [] : args;
  const environment = env === undefined ? {} : env;

  if (!isString(command) || command === "") return undefined;

  if (!Array.isArray(argv) || !argv.every(isString)) return undefined;

  if (!isObject(environment) || !Object.values(environment).every(isString)) return undefined;

  if (cwd !== undefined && !isString(cwd)) return undefined;

  // SAFETY: the checks above proved the arguments are strings and every `env` value is a string.
  return { command, args: argv as string[], env: environment as { [name: string]: string }, cwd };
};

// Repeats `mcpBridgeKey` (`@cloudpid/sandbox-image/mcp-bridge`).
const keyOf = (config: Config): string => {
  const entries = Object.entries(config.env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return createHash("sha256")
    .update(JSON.stringify([config.command, config.args, entries, config.cwd ?? null]))
    .digest("hex");
};

// ---- State ----

const token = process.env[TOKEN_ENV] ?? "";
const tokenDigest = createHash("sha256").update(token).digest();
const probeMs = Number(process.env["CLOUDPID_MCP_BRIDGE_PROBE_MS"] ?? DEFAULT_PROBE_MS);
const children = new Map<string, Child>();

// The last exit of each key's child (a replaced or stopped one included), for `GET /_bridge/status`.
const exited = new Map<string, Child>();

// Keys whose child was probed and found Legacy: a request without a session for them is 400 until the host says otherwise.
const eras = new Map<string, Era>();
let nextBridgeId = 1;

const log = (message: string): void => {
  console.log(`cloudpid-mcp-bridge: ${message}`);
};

// ---- Responses ----

const writeSse = (res: ServerResponse, message: Json): void => {
  if (!res.destroyed) res.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
};

const openSse = (res: ServerResponse, headers: { [name: string]: string } = {}): void => {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    ...headers,
  });
  res.flushHeaders();

  const timer = setInterval(() => {
    if (!res.destroyed) res.write(": ping\n\n");
  }, KEEPALIVE_MS);

  res.on("close", () => clearInterval(timer));
};

const fail = (
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
  id: RequestId | null = null,
): void => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
};

const accepted = (res: ServerResponse): void => {
  res.writeHead(202);
  res.end();
};

const json = (res: ServerResponse, status: number, body: Json): void => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

// ---- Children ----

const send = (child: Child, message: JsonObject): void => {
  if (child.exit === undefined && child.proc.stdin?.writable) {
    child.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }
};

const signalGroup = (child: Child, signal: NodeJS.Signals): void => {
  try {
    // The child leads a process group of its own, so a launcher's children (`npx`, `uvx`) are stopped with it.
    if (child.proc.pid !== undefined) process.kill(-child.proc.pid, signal);
  } catch {
    child.proc.kill(signal);
  }
};

const stderrAppend = (child: Child, chunk: Buffer): void => {
  const all = Buffer.concat([child.stderr, chunk]);

  if (all.length <= STDERR_LIMIT) {
    child.stderr = all;

    return;
  }

  // Cut on a character: past the continuation bytes (10xxxxxx) the cut may have landed among.
  let start = all.length - STDERR_LIMIT;

  while (start < all.length && (all[start] ?? 0) >> 6 === 0b10) start += 1;
  child.stderr = all.subarray(start);
};

const stderrNote = (child: Child, text: string): void => {
  stderrAppend(child, Buffer.from(text));
};

/** The child's exit, settled once its output has ended: every request of it is cut, nothing is answered. */
const settle = (child: Child): void => {
  if (child.settled) return;

  child.settled = true;
  child.exit ??= {
    code: null,
    signal: null,
    reason: undefined,
    error: undefined,
    at: new Date().toISOString(),
  };
  child.exit.reason = child.asked;

  if (children.get(child.key) === child) children.delete(child.key);
  // What is left of the process's group goes too.
  signalGroup(child, "SIGKILL");

  // A child's exit is kept for the status unless it was probed away or another took its key.
  if (!child.discarded && !children.has(child.key)) {
    exited.delete(child.key);
    exited.set(child.key, child);

    for (const oldest of [...exited.keys()].slice(0, Math.max(0, exited.size - EXITED_LIMIT))) {
      exited.delete(oldest);
    }
  }

  log(
    `exit ${child.spawnId}: ${child.exit.error ?? child.exit.signal ?? `code ${child.exit.code}`}`,
  );

  for (const pending of child.pending.values()) pending.res.end();
  child.pending.clear();
  child.getStream?.end();
  child.getStream = undefined;

  for (const waiter of child.exitWaiters.splice(0)) waiter();
};

const stopChild = (child: Child, reason: "stopped" | "replaced"): Promise<void> =>
  new Promise<void>((resolve) => {
    if (child.settled) return resolve();

    child.asked ??= reason;
    child.exitWaiters.push(resolve);
    signalGroup(child, "SIGTERM");
    setTimeout(() => {
      if (!child.settled) signalGroup(child, "SIGKILL");
    }, KILL_AFTER_MS).unref();
  });

const routeTarget = (
  child: Child,
  message: JsonObject,
): { readonly res: ServerResponse; readonly message: JsonObject } | undefined => {
  const params = objectField(message, "params");
  const meta = params === undefined ? undefined : objectField(params, "_meta");
  const pendings = [...child.pending.entries()];

  // A listen's notifications name it by its id, which the bridge rewrote: back to the caller's own.
  const subscription = meta?.[SUBSCRIPTION_ID_KEY];

  if (params !== undefined && meta !== undefined && isId(subscription)) {
    const found = pendings.find(([id]) => String(id) === String(subscription));

    if (found !== undefined) {
      return {
        res: found[1].res,
        message: {
          ...message,
          params: { ...params, _meta: { ...meta, [SUBSCRIPTION_ID_KEY]: found[1].clientId } },
        },
      };
    }
  }

  const progressToken = params?.["progressToken"];

  if (isId(progressToken)) {
    const found = pendings.findLast(([, pending]) => pending.progressToken === progressToken);

    if (found !== undefined) return { res: found[1].res, message };
  }

  // A Modern child's listens carry only their own notifications.
  const newest = pendings.findLast(([, pending]) => child.era !== "modern" || !pending.listen);

  if (newest !== undefined) return { res: newest[1].res, message };

  if (child.getStream !== undefined) return { res: child.getStream, message };

  return undefined;
};

const onChildMessage = (child: Child, message: JsonObject): void => {
  const incoming = classify(message);

  if (incoming?.kind === "response") {
    const id = Number(message["id"]);
    const probe = child.probes.get(id);
    const pending = child.pending.get(id);

    if (probe !== undefined) {
      child.probes.delete(id);
      probe(message);
    } else if (pending !== undefined) {
      child.pending.delete(id);
      writeSse(pending.res, { ...message, id: pending.clientId });
      pending.res.end();
    } else {
      stderrNote(child, `[bridge] an answer for no request: ${JSON.stringify(message["id"])}\n`);
    }

    return;
  }

  if (incoming === undefined) {
    stderrNote(
      child,
      `[bridge] a message that is none of the three: ${JSON.stringify(message).slice(0, 200)}\n`,
    );

    return;
  }

  // A Modern server asks nothing of its caller: what it sends as a request goes to the stderr tail.
  if (incoming.kind === "request" && child.era === "modern") {
    stderrNote(child, `[bridge] a request of the server's was dropped: ${incoming.method}\n`);

    return;
  }

  const target = routeTarget(child, message);

  if (target !== undefined) {
    writeSse(target.res, target.message);
  } else if (child.era === "modern") {
    stderrNote(child, `[bridge] a message for no stream was dropped: ${incoming.method}\n`);
  } else {
    child.queued.push(message);

    if (child.queued.length > QUEUE_LIMIT) child.queued.shift();
  }
};

const onChildLine = (child: Child, line: string): void => {
  if (line.trim() === "") return;

  const message = parseJson(line);

  if (isObject(message)) onChildMessage(child, message);
  else stderrNote(child, `[stdout, not JSON] ${line.slice(0, 500)}\n`);
};

const spawnChild = (key: string, config: Config, era: Era | undefined): Child => {
  const old = children.get(key);

  if (old !== undefined) void stopChild(old, "replaced");

  exited.delete(key);

  const spawnId = `${key.slice(0, 16)}.${randomBytes(6).toString("hex")}`;

  const proc = spawn(config.command, config.args, {
    cwd: config.cwd,
    // The bridge's own environment (its token among it) never reaches a server.
    env: { PATH: process.env["PATH"], HOME: process.env["HOME"], ...config.env },
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });

  const child: Child = {
    key,
    spawnId,
    config,
    proc,
    startedAt: new Date().toISOString(),
    era,
    probe: undefined,
    discover: undefined,
    pending: new Map(),
    probes: new Map(),
    queued: [],
    exitWaiters: [],
    getStream: undefined,
    stderr: Buffer.alloc(0),
    exit: undefined,
    asked: undefined,
    discarded: false,
    settled: false,
  };

  children.set(key, child);
  log(`spawn ${spawnId}: ${config.command}`);

  proc.stdin?.on("error", () => {});
  proc.stderr?.on("data", (chunk: Buffer) => stderrAppend(child, chunk));

  if (proc.stdout !== null) {
    createInterface({ input: proc.stdout, crlfDelay: Infinity }).on("line", (line) =>
      onChildLine(child, line),
    );
  }

  let drain: NodeJS.Timeout | undefined;

  proc.on("exit", (code, signal) => {
    child.exit = {
      code,
      signal,
      reason: undefined,
      error: undefined,
      at: new Date().toISOString(),
    };
    // The output a child left in its pipe is read before its requests are cut.
    drain = setTimeout(() => settle(child), DRAIN_MS);
  });
  proc.on("close", () => {
    clearTimeout(drain);
    settle(child);
  });
  proc.on("error", (error) => {
    child.exit = {
      code: null,
      signal: null,
      reason: undefined,
      error: `spawn failed: ${error.message}`,
      at: new Date().toISOString(),
    };
    stderrNote(child, `${child.exit.error}\n`);
    settle(child);
  });

  return child;
};

/** Asks a fresh child what era it speaks: `server/discover` once, on stdin. A result is Modern; anything else, Legacy. */
const probeEra = (child: Child): Promise<Era> => {
  child.probe ??= new Promise<Era>((resolve) => {
    const id = nextBridgeId++;
    let done = false;

    const finish = (era: Era, discover: Json | undefined) => {
      if (done) return;

      done = true;
      clearTimeout(timer);
      child.probes.delete(id);
      child.discover = discover;
      resolve(era);
    };

    const timer = setTimeout(() => finish("legacy", undefined), probeMs);

    child.probes.set(id, (message) =>
      finish(
        message["error"] === undefined && message["result"] !== undefined ? "modern" : "legacy",
        message["result"],
      ),
    );
    child.exitWaiters.push(() => finish("legacy", undefined));

    send(child, {
      jsonrpc: "2.0",
      id,
      method: "server/discover",
      params: {
        _meta: {
          [PROTOCOL_VERSION_KEY]: MODERN_VERSION,
          [CLIENT_INFO_KEY]: { name: "cloudpid-bridge", version: String(LEVEL) },
          [CLIENT_CAPABILITIES_KEY]: {},
        },
      },
    });
  }).then((era) => {
    child.era = era;

    if (era === "modern") {
      eras.delete(child.key);
    } else {
      eras.set(child.key, "legacy");

      // A Legacy server that was sent what it does not know is not kept: its handshake comes on a fresh process.
      if (!child.settled) {
        child.discarded = true;
        void stopChild(child, "replaced");
      }
    }

    return era;
  });

  return child.probe;
};

// ---- Requests ----

const readBody = (req: IncomingMessage, res: ServerResponse): Promise<string | undefined> =>
  new Promise<string | undefined>((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;

      if (size > MAX_BODY_BYTES) {
        fail(res, 413, -32600, "the request is too large");
        req.destroy();
        resolve(undefined);
      } else {
        chunks.push(chunk);
      }
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(undefined));
  });

const envelopeOf = (body: JsonObject): JsonObject | undefined => {
  const meta = objectField(objectField(body, "params") ?? {}, "_meta");

  if (meta === undefined) return undefined;

  const envelope: JsonObject = {};

  for (const key of [PROTOCOL_VERSION_KEY, CLIENT_INFO_KEY, CLIENT_CAPABILITIES_KEY]) {
    const value = meta[key];

    if (value !== undefined) envelope[key] = value;
  }

  return envelope;
};

/** A request of a caller: its id rewritten, its answer (and the child's messages for it) on its own stream. */
const forwardRequest = (
  child: Child,
  message: Extract<Incoming, { kind: "request" }>,
  res: ServerResponse,
  headers: { [name: string]: string } = {},
): void => {
  const bridgeId = nextBridgeId++;

  const progressToken = objectField(objectField(message.body, "params") ?? {}, "_meta")?.[
    "progressToken"
  ];

  const envelope = child.era === "modern" ? envelopeOf(message.body) : undefined;

  openSse(res, headers);

  if (child.settled) {
    res.end();

    return;
  }

  child.pending.set(bridgeId, {
    res,
    clientId: message.id,
    method: message.method,
    progressToken: isId(progressToken) ? progressToken : undefined,
    listen: message.method === "subscriptions/listen",
    envelope,
  });

  // The caller went away before the answer: the spec's cancel.
  res.on("close", () => {
    if (child.pending.delete(bridgeId)) {
      send(child, {
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { _meta: envelope ?? {}, requestId: bridgeId, reason: "the caller disconnected" },
      });
    }
  });

  send(child, { ...message.body, id: bridgeId });
};

/** A notification or an answer to a server request, which the child takes as it is: 202. */
const forwardPlain = (child: Child, message: Incoming, res: ServerResponse): void => {
  let body = message.body;

  // The caller's `requestId` is its own: it names the one request of that id in flight, when there is one.
  if (message.kind === "notification" && message.method === "notifications/cancelled") {
    const params = objectField(body, "params");
    const requestId = params?.["requestId"];

    const found = [...child.pending.entries()].filter(
      ([, pending]) => pending.clientId === requestId,
    );

    const only = found.length === 1 ? found[0] : undefined;

    if (params === undefined || only === undefined) {
      accepted(res);

      return;
    }

    body = { ...body, params: { ...params, requestId: only[0] } };
  }

  send(child, body);
  accepted(res);
};

const deliver = (
  child: Child,
  message: Incoming,
  res: ServerResponse,
  headers?: { [name: string]: string },
): void => {
  if (message.kind === "request") forwardRequest(child, message, res, headers);
  else forwardPlain(child, message, res);
};

const legacyOnly = (res: ServerResponse, message: Incoming): void => {
  // No Modern error: the 2025 era's plain 400, which a client that probed reads as Legacy.
  fail(
    res,
    400,
    -32600,
    "this stdio server speaks the 2025 protocol: send initialize first",
    message.kind === "request" ? message.id : null,
  );
};

type Call = {
  readonly key: string;
  readonly config: Config;
  readonly sessionId: string | undefined;
  readonly hint: Era | undefined;
};

const handleModern = async (call: Call, message: Incoming, res: ServerResponse): Promise<void> => {
  const { key, config, hint } = call;
  const live = children.get(key);

  if (live !== undefined) res.setHeader(SPAWN_HEADER, live.spawnId);

  if (
    live?.era === "legacy" ||
    (live === undefined &&
      (hint === "legacy" || (hint === undefined && eras.get(key) === "legacy")))
  ) {
    legacyOnly(res, message);

    return;
  }

  if (message.kind !== "request") {
    // Nothing to cancel or answer at a child that is not there.
    if (live === undefined) {
      accepted(res);
    } else {
      res.setHeader(SPAWN_HEADER, live.spawnId);
      forwardPlain(live, message, res);
    }

    return;
  }

  if (live === undefined && hint === "modern") eras.delete(key);

  const child = live ?? spawnChild(key, config, hint);

  res.setHeader(SPAWN_HEADER, child.spawnId);

  if ((child.era ?? (await probeEra(child))) === "legacy") {
    legacyOnly(res, message);

    return;
  }

  if (res.destroyed) return;

  // Probed once per spawn: its answer is the child's, for the host's `server/discover` too.
  if (message.method === "server/discover" && child.discover !== undefined) {
    openSse(res);
    writeSse(res, { jsonrpc: "2.0", id: message.id, result: child.discover });
    res.end();

    return;
  }

  forwardRequest(child, message, res);
};

/** A session that is not the live child's: 404, which the spec has a client answer with a new `initialize`. */
const staleSession = (res: ServerResponse, live: Child | undefined, id: RequestId | null): void => {
  if (live !== undefined) res.setHeader(SPAWN_HEADER, live.spawnId);
  fail(res, 404, -32001, "session not found", id);
};

const handlePost = async (req: IncomingMessage, res: ServerResponse, call: Call): Promise<void> => {
  const text = await readBody(req, res);

  if (text === undefined) return;

  const body = parseJson(text);

  if (!isObject(body)) {
    fail(
      res,
      400,
      Array.isArray(body) ? -32600 : -32700,
      Array.isArray(body) ? "batches are not supported" : "the body is not a JSON-RPC message",
    );

    return;
  }

  const message = classify(body);

  if (message === undefined) {
    fail(res, 400, -32600, "the body is not a JSON-RPC message");

    return;
  }

  const live = children.get(call.key);

  if (call.sessionId !== undefined) {
    if (live === undefined || live.spawnId !== call.sessionId) {
      staleSession(res, live, message.kind === "request" ? message.id : null);

      return;
    }

    res.setHeader(SPAWN_HEADER, live.spawnId);
    deliver(live, message, res);

    return;
  }

  if (message.kind === "request" && message.method === "initialize") {
    const child = spawnChild(call.key, call.config, "legacy");

    res.setHeader(SPAWN_HEADER, child.spawnId);
    eras.set(call.key, "legacy");
    deliver(child, message, res, { "mcp-session-id": child.spawnId });

    return;
  }

  await handleModern(call, message, res);
};

const handleGet = (res: ServerResponse, call: Call): void => {
  const live = children.get(call.key);

  if (call.sessionId === undefined) {
    res.writeHead(405, { allow: "POST", "content-type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32000, message: "no stream without a session" },
      }),
    );

    return;
  }

  if (live === undefined || live.spawnId !== call.sessionId) {
    staleSession(res, live, null);

    return;
  }

  res.setHeader(SPAWN_HEADER, live.spawnId);
  // A new stream replaces the old one: a reconnect may come before the old one is seen to have closed.
  live.getStream?.end();
  openSse(res);
  live.getStream = res;
  res.on("close", () => {
    if (live.getStream === res) live.getStream = undefined;
  });

  for (const message of live.queued.splice(0)) writeSse(res, message);
};

const handleMcp = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
  const config = parseConfig(firstHeader(req, CONFIG_HEADER));

  if (config === undefined) {
    fail(res, 400, -32600, `a valid ${CONFIG_HEADER} header is required`);

    return;
  }

  const era = firstHeader(req, ERA_HEADER);

  const call: Call = {
    key: keyOf(config),
    config,
    sessionId: firstHeader(req, "mcp-session-id"),
    hint: era === "legacy" || era === "modern" ? era : undefined,
  };

  if (req.method === "POST") await handlePost(req, res, call);
  else if (req.method === "GET") handleGet(res, call);
  else {
    // A shared child is not ended by one caller's session: the control call stops it.
    res.writeHead(405, { allow: "GET, POST" });
    res.end();
  }
};

const firstHeader = (req: IncomingMessage, name: string): string | undefined => {
  const value = req.headers[name];

  return Array.isArray(value) ? value[0] : value;
};

// ---- Control ----

// What `GET /_bridge/status` lists (`McpBridgeChild`): a property that is `undefined` is left out of the JSON.
const statusOf = (child: Child): McpBridgeChild => ({
  key: child.key,
  spawnId: child.spawnId,
  command: child.config.command,
  args: child.config.args,
  cwd: child.config.cwd,
  pid: child.proc.pid,
  era: child.era ?? "unknown",
  state: child.settled ? "exited" : "running",
  startedAt: child.startedAt,
  inFlight: [...child.pending.values()].filter((pending) => !pending.listen).length,
  listens: [...child.pending.values()].filter((pending) => pending.listen).length,
  getStream: child.getStream !== undefined,
  queued: child.queued.length,
  exit: child.exit,
  stderrTail: child.stderr.toString("utf8"),
});

const handleControl = async (
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
): Promise<void> => {
  if (path === HEALTH_PATH && req.method === "GET") {
    json(res, 200, { status: "ok" });
  } else if (path === STATUS_PATH && req.method === "GET") {
    // Never spawns: the live children, then the last exit of each key without one.
    const all = [...children.values(), ...exited.values()];

    const status: McpBridgeStatus = { level: LEVEL, children: all.map(statusOf) };

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(status));
  } else if (path === STOP_PATH && req.method === "POST") {
    const body = parseJson((await readBody(req, res)) ?? "");
    const key = isObject(body) ? body["key"] : undefined;
    const live = isString(key) ? children.get(key) : undefined;

    if (!isString(key)) {
      json(res, 400, { error: "a key is required" });
    } else if (live === undefined) {
      json(res, 200, { stopped: false });
    } else {
      await stopChild(live, "stopped");
      json(res, 200, { stopped: true });
    }
  } else {
    json(res, 404, { error: "not found" });
  }
};

const authorised = (req: IncomingMessage): boolean => {
  const header = firstHeader(req, "authorization") ?? "";

  if (!header.startsWith("Bearer ")) return false;

  return timingSafeEqual(
    createHash("sha256").update(header.slice("Bearer ".length)).digest(),
    tokenDigest,
  );
};

const server = createServer({ maxHeaderSize: 128 * 1024 }, (req, res) => {
  res.setHeader(LEVEL_HEADER, String(LEVEL));

  if (!authorised(req)) {
    res.setHeader("www-authenticate", "Bearer");
    json(res, 401, { error: "unauthorised" });

    return;
  }

  const path = new URL(req.url ?? "/", "http://bridge").pathname;

  const run =
    path === MCP_PATH
      ? handleMcp(req, res)
      : path.startsWith("/_bridge/")
        ? handleControl(req, res, path)
        : Promise.resolve(json(res, 404, { error: "not found" }));

  run.catch((error: Error) => {
    log(`a request failed: ${error.message}`);

    if (res.headersSent) res.end();
    else json(res, 500, { error: "the bridge failed" });
  });
});

// ---- Start ----

process.title = "cloudpid-mcp-bridge";

if (token === "") {
  console.error(`cloudpid-mcp-bridge: ${TOKEN_ENV} is not set, so it serves nothing`);
  process.exit(1);
}

const shutdown = (): void => {
  for (const child of children.values()) signalGroup(child, "SIGKILL");
  process.exit(0);
};

process.on("SIGTERM", shutdown);

process.on("SIGINT", shutdown);

server.listen(Number(process.env["CLOUDPID_MCP_BRIDGE_PORT"] ?? DEFAULT_PORT), "0.0.0.0", () => {
  // SAFETY: a server listening on a TCP port has an `AddressInfo` address.
  log(`listening on :${(server.address() as AddressInfo).port}`);
});
