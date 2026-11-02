/**
 * Fake MCP servers behind the injected `fetch`, on the SDK server (`docs/architecture/mcp.md` → Testing and tracing):
 * Modern, Legacy stateless, Legacy stateful with a GET stream, and a hostile wrapper that answers chosen requests
 * itself. Each records what reached it, so tests can see what the core sent.
 */
// @effect-diagnostics asyncFunction:off globalFetch:off preferEffectArray:off missingPipeableSignature:off schemaSync:off
import {
  createMcpHandler,
  Server,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import * as Schema from "effect/Schema";

/** One request that reached a fake: its HTTP method, headers and, for a POST, its JSON-RPC body. */
export interface Received {
  readonly method: string;
  readonly headers: Headers;
  readonly rpc: RpcBody | undefined;
}

/** The parts of a JSON-RPC message the tests look at. */
export interface RpcBody {
  readonly id?: string | number;
  readonly method?: string;
  readonly params?: { readonly [key: string]: Json };
}

type Json =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<Json>
  | { readonly [key: string]: Json };

/** A fake MCP server: a `fetch` handler and the requests it received. */
export interface FakeServer {
  readonly handle: (request: Request) => Promise<Response>;
  readonly received: Array<Received>;
}

/** The tools every fake offers, on two pages. */
export const FAKE_TOOLS = [
  { name: "echo", description: "Echo its text.", inputSchema: { type: "object" as const } },
  {
    name: "shout",
    description: "Echo its text in capitals.",
    inputSchema: { type: "object" as const },
  },
];

const EchoArguments = Schema.Struct({ text: Schema.String });

/** An SDK server answering `tools/list` a page at a time and `tools/call` for both tools. */
const fakeMcp = (sends?: (server: Server) => Promise<void>) => {
  const server = new Server(
    { name: "fake", version: "1.0.0" },
    { capabilities: { tools: { listChanged: true } }, instructions: "Use the echo tool." },
  );

  server.setRequestHandler("tools/list", async (request) =>
    request.params?.cursor === "page-2"
      ? { tools: [FAKE_TOOLS[1]!] }
      : { tools: [FAKE_TOOLS[0]!], nextCursor: "page-2" },
  );
  server.setRequestHandler("tools/call", async (request) => {
    await sends?.(server);
    const { text } = Schema.decodeUnknownSync(EchoArguments)(request.params.arguments);

    return {
      content: [
        { type: "text", text: request.params.name === "shout" ? text.toUpperCase() : text },
      ],
    };
  });

  return server;
};

const readRpc = async (request: Request): Promise<RpcBody | undefined> => {
  if (request.method !== "POST") {
    return undefined;
  }

  try {
    // SAFETY: a fake reads the body only to record it; malformed bodies record as absent.
    return (await request.clone().json()) as RpcBody;
  } catch {
    return undefined;
  }
};

const recording = (handle: (request: Request) => Promise<Response>): FakeServer => {
  const received: Array<Received> = [];

  return {
    received,
    handle: async (request) => {
      received.push({
        method: request.method,
        headers: new Headers(request.headers),
        rpc: await readRpc(request),
      });

      return handle(request);
    },
  };
};

/** A Modern (`2026-07-28`) server: stateless, and answering any Legacy request as unsupported. */
export const modernServer = (): FakeServer =>
  recording(createMcpHandler(() => fakeMcp(), { legacy: "reject" }).fetch);

/** A Legacy server with no sessions: each POST is answered by a fresh server; GET and DELETE are 405. */
export const legacyStatelessServer = (): FakeServer =>
  recording(async (request) => {
    if (request.method !== "POST") {
      return new Response(null, { status: 405 });
    }

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    await fakeMcp().connect(transport);

    return transport.handleRequest(request);
  });

/** A Legacy server with sessions: answers on SSE, keeps a GET stream per session, and forgets sessions on demand. */
export const legacyStatefulServer = () => {
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
  let next = 0;

  const fake = recording(async (request) => {
    const id = request.headers.get("mcp-session-id");

    if (id !== null) {
      const transport = sessions.get(id);

      return transport === undefined
        ? Response.json(
            { jsonrpc: "2.0", id: null, error: { code: -32001, message: "Session not found" } },
            { status: 404 },
          )
        : transport.handleRequest(request);
    }

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => `session-${++next}`,
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, transport);
      },
    });

    // A notification on the GET stream with every call, as servers announcing changes do.
    await fakeMcp((server) =>
      server.notification({ method: "notifications/tools/list_changed" }),
    ).connect(transport);

    return transport.handleRequest(request);
  });

  return {
    ...fake,
    sessions,
    /** Forget every session, as a restarted server does. */
    forget: () => sessions.clear(),
  };
};

/**
 * A hostile server: `answer` may answer a request itself (by its JSON-RPC body), else `base` does. Used for cut
 * streams, oversize bodies, bad headers and odd error bodies.
 */
export const hostileServer = (
  base: FakeServer,
  answer: (request: Request, rpc: RpcBody | undefined) => Response | undefined,
): FakeServer =>
  recording(async (request) => answer(request, await readRpc(request)) ?? base.handle(request));

/** The `fetch` the core is given: every request goes to `server`, by any URL. */
export const fetchTo =
  (server: FakeServer): typeof fetch =>
  async (input, init) =>
    server.handle(new Request(input, init));

/** The JSON-RPC requests (not notifications) a fake received, by method. */
export const rpcMethods = (server: FakeServer) =>
  server.received.flatMap((received) =>
    received.rpc?.method !== undefined && received.rpc.id !== undefined
      ? [received.rpc.method]
      : [],
  );

/** An SSE response carrying `events` as `message` events, then ending. */
export const sse = (events: ReadonlyArray<Json>) =>
  new Response(
    events.map((event) => `event: message\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
