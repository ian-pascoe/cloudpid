#!/usr/bin/env node
/**
 * cloudpid's own MCP endpoint, served for the official conformance suite (`docs/architecture/mcp-endpoint.md` →
 * Telemetry and testing; `docs/architecture/mcp.md` → Testing and tracing → Conformance): `serveMcp` over `node:http`
 * with a fixed in-memory `api`, so the runner's `server` scenarios talk to the handler production runs, minus Workers.
 * Prints `listening <url>` once it accepts connections; `run.ts` starts it, runs the scenarios and stops it.
 */
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off processEnv:off preferEffectRecord:off newPromise:off preferEffectArray:off missingPipeableSignature:off asyncFunction:off -- a Node script over `node:http`.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { apiFailure, apiOk, MCP_API_LIMITS } from "@cloudpid/protocol/mcp-api";
import { type McpServerApi, serveMcp, toolGate } from "../src/server/index.ts";

const ID = "0190f0a8-1b2c-7d3e-8f40-123456789abc";

/** The Registry's and the Sessions' answers: one Environment, one Session, one transcript entry. */
const api: McpServerApi = {
  describe: () => ({
    operations: [
      "environments",
      "sessions",
      "session",
      "transcript",
      "start",
      "send",
      "stop",
      "wait",
    ],
    limits: MCP_API_LIMITS,
  }),
  environments: () =>
    Promise.resolve(
      apiOk({
        environments: [
          {
            id: "default",
            name: "Default",
            default: true,
            repos: [{ name: "app", url: "https://github.com/example/app" }],
            running_sessions: 0,
          },
        ],
        models: { available: ["model-a"], default: "model-a" },
      }),
    ),
  sessions: () =>
    Promise.resolve(
      apiOk({
        sessions: [
          {
            session_id: ID,
            title: "A Session",
            environment: { id: "default", name: "Default" },
            status: "idle" as const,
            updated_at: "2026-01-01T00:00:00.000Z",
            archived: false,
            url: `http://127.0.0.1/sessions/${ID}`,
          },
        ],
      }),
    ),
  session: () =>
    Promise.resolve(
      apiOk({
        session_id: ID,
        title: "A Session",
        environment: { id: "default", name: "Default" },
        status: "idle" as const,
        updated_at: "2026-01-01T00:00:00.000Z",
        archived: false,
        url: `http://127.0.0.1/sessions/${ID}`,
        waiting: [],
        cursor: "c1",
        agents: [],
        workspace: { branch: "cloudpid/abcd1234", base: null, repos: ["app"] },
      }),
    ),
  transcript: () =>
    Promise.resolve(
      apiOk({
        session_id: ID,
        entries: [{ entry_id: 1, role: "user" as const, at: "", text: "Hello" }],
        newer: "n1",
      }),
    ),
  start: () =>
    Promise.resolve(
      apiOk({
        session_id: ID,
        title: null,
        url: `http://127.0.0.1/sessions/${ID}`,
        status: "running" as const,
        cursor: "c2",
        environment: { id: "default", name: "Default", repos: ["app"] },
      }),
    ),
  send: () => Promise.resolve(apiOk({ delivery: "started" as const, cursor: "c3" })),
  stop: () => Promise.resolve(apiOk({ status: "idle" as const })),
  wait: () =>
    Promise.resolve(
      apiOk({
        session_id: ID,
        status: "idle" as const,
        ended_by: "run_ended" as const,
        outcome: { result: "answered" as const },
        waiting: [],
        activity: { entries: 1, tool_calls: 0, latest: [] },
        cursor: "c4",
      }),
    ),
  // The import tools are not listed by `describe()`, so no scenario reaches these.
  importBegin: () => Promise.resolve(apiFailure("unsupported", "Not served here.")),
  importAppend: () => Promise.resolve(apiFailure("unsupported", "Not served here.")),
  importFinish: () => Promise.resolve(apiFailure("unsupported", "Not served here.")),
  importCancel: () => Promise.resolve(apiFailure("unsupported", "Not served here.")),
  auth: "local",
};

const gate = toolGate();

/** The port this server listens on. */
const portOf = (): number => {
  // SAFETY: a server listening on a port (never a pipe) has an address with one.
  const { port } = server.address() as AddressInfo;

  return port;
};

/** The Node request as the Workers runtime would hand it: a web `Request`, at this server's own origin. */
const requestOf = async (incoming: IncomingMessage): Promise<Request> => {
  const headers = new Headers();

  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }

  const method = incoming.method ?? "GET";
  const chunks: Array<Buffer> = [];

  for await (const chunk of incoming) chunks.push(Buffer.from(chunk));

  const hasBody = method !== "GET" && method !== "HEAD";

  return new Request(new URL(incoming.url ?? "/", `http://127.0.0.1:${portOf()}`), {
    method,
    headers,
    body: hasBody ? Buffer.concat(chunks) : null,
  });
};

const send = async (response: Response, outgoing: ServerResponse): Promise<void> => {
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));

  if (response.body === null) {
    outgoing.end();

    return;
  }

  const reader = response.body.getReader();

  for (;;) {
    const { done, value } = await reader.read();

    if (done) break;

    outgoing.write(value);
  }

  outgoing.end();
};

const server = createServer((incoming, outgoing) => {
  requestOf(incoming)
    .then((request) => serveMcp(request, { api, version: "conformance", gate }))
    .then((response) => send(response, outgoing))
    .catch((error) => {
      console.error(error);
      outgoing.writeHead(500).end();
    });
});

server.listen(Number(process.env["PORT"] ?? 0), "127.0.0.1", () => {
  console.log(`listening http://127.0.0.1:${portOf()}/mcp`);
});
