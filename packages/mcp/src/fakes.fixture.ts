/**
 * Fake MCP servers behind the injected `fetch`, on the SDK server (`docs/architecture/mcp.md` → Testing and tracing):
 * Modern, Legacy stateless, Legacy stateful with a GET stream, and a hostile wrapper that answers chosen requests
 * itself. Each records what reached it, so tests can see what the core sent.
 */
// @effect-diagnostics asyncFunction:off globalFetch:off preferEffectArray:off missingPipeableSignature:off schemaSync:off newPromise:off
import {
  createMcpHandler,
  inputRequired,
  Server,
  type Tool,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import * as Schema from "effect/Schema";

/** One request that reached a fake: its HTTP method, URL, headers and, for a POST, its JSON-RPC body. */
export interface Received {
  readonly method: string;
  readonly url: string;
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

/** The fakes' tool that echoes its text. */
export const ECHO_TOOL = {
  name: "echo",
  description: "Echo its text.",
  inputSchema: { type: "object" as const },
};

/** The fakes' tool that echoes its text in capitals. */
export const SHOUT_TOOL = {
  name: "shout",
  description: "Echo its text in capitals.",
  inputSchema: { type: "object" as const },
};

const EchoArguments = Schema.Struct({ text: Schema.String });

const BigArguments = Schema.Struct({ bytes: Schema.Int });

const TypedArguments = Schema.Struct({ structured: Schema.optionalKey(Schema.Json) });

/** The fakes' tool that answers with `bytes` bytes of text, for byte limits and large results. */
export const BIG_TOOL = {
  name: "big",
  description: "Answer with that many bytes of text.",
  inputSchema: { type: "object" as const },
};

/** The fakes' tool that never answers: it waits for the request to be cancelled, and records that it was. */
export const HANG_TOOL = {
  name: "hang",
  description: "Wait until cancelled.",
  inputSchema: { type: "object" as const },
};

/**
 * The fakes' tool that reports progress: `steps` notices (`1/steps`, with a message), then answers `done`, or with
 * `hang`, waits until cancelled, as `hang` does. A request that asked for no progress gets none.
 */
export const PROGRESS_TOOL = {
  name: "progress",
  description: "Report progress, then answer or wait until cancelled.",
  inputSchema: {
    type: "object" as const,
    properties: { steps: { type: "number" }, hang: { type: "boolean" } },
  },
};

const ProgressArguments = Schema.Struct({
  steps: Schema.Int,
  hang: Schema.optionalKey(Schema.Boolean),
});

/** The fakes' tool with an `outputSchema`: it answers with the `structuredContent` it is given. */
export const TYPED_TOOL = {
  name: "typed",
  description: "Answer with the structured content given.",
  inputSchema: { type: "object" as const },
  outputSchema: {
    type: "object" as const,
    properties: { count: { type: "number" } },
    required: ["count"],
  },
};

/**
 * The fakes' tool with an `x-mcp-header`: its `region` goes in an `Mcp-Param-Region` header on Modern, and it answers
 * with the region.
 */
export const REGION_TOOL = {
  name: "region",
  description: "Answer with the region.",
  inputSchema: {
    type: "object" as const,
    properties: { region: { type: "string", "x-mcp-header": "Region" } },
  },
};

const RegionArguments = Schema.Struct({ region: Schema.String });

/** The fakes' tool that asks the client for its Roots (`roots/list`) and answers with what it was told, as JSON text. Never listed. */
export const ROOTS_TOOL = {
  name: "roots",
  description: "Answer with the client's Roots.",
  inputSchema: { type: "object" as const },
};

/** What a fake MCP server offers besides the echo tools, and where it records what happened to its calls. */
export interface FakeOptions {
  /** List `big`, `hang`, `typed` and `region` after `echo` and `shout`; they answer whether listed or not. */
  readonly listMore?: boolean;
  /** What the server says of itself: its `instructions` (default `Use the echo tool.`) and the name in its `serverInfo`. */
  readonly instructions?: string;
  readonly serverName?: string;
  /** The names of the calls whose request was cancelled while they ran. */
  readonly cancelled?: Array<string>;
  /** Further tools listed last, which answer as `echo` does unless something in front of the server answers first. */
  readonly moreTools?: ReadonlyArray<Tool>;
  /**
   * Declares `logging`, and sends these as `notifications/message` with every `tools/call` and every first page of `tools/list`, each only where the client's
   * level lets it through (Legacy: its `logging/setLevel`; Modern: its `_meta` `logLevel`, none without one).
   */
  readonly logs?:
    | ReadonlyArray<{
        readonly level: "debug" | "info" | "notice" | "warning" | "error";
        readonly data: unknown;
        readonly logger?: string;
      }>
    | undefined;
}

/**
 * Waits until `signal` aborts, then calls `aborted` and rejects. `aborted` runs in the abort itself, since the
 * call's own request may be gone by the time a continuation would run (a Worker cancels a disconnected request's).
 */
const untilAborted = (signal: AbortSignal, aborted: () => void) =>
  new Promise<never>((_resolve, reject) => {
    signal.addEventListener(
      "abort",
      () => {
        aborted();
        reject(new Error("cancelled"));
      },
      { once: true },
    );
  });

/**
 * An SDK server answering `tools/list` a page at a time and `tools/call` for its tools: `echo` and `shout`, and
 * `big`, `hang`, `typed` and `region`, listed only with `listMore`, and `progress`, listed only in `moreTools`.
 */
const fakeMcp = (
  sends?: (server: Server) => Promise<void>,
  options: FakeOptions = {},
  modern = false,
) => {
  const server = new Server(
    { name: options.serverName ?? "fake", version: "1.0.0" },
    {
      capabilities:
        options.logs === undefined
          ? { tools: { listChanged: true } }
          : { tools: { listChanged: true }, logging: {} },
      instructions: options.instructions ?? "Use the echo tool.",
    },
  );

  server.setRequestHandler("tools/list", async (request, ctx) => {
    if (request.params?.cursor === undefined) {
      for (const log of options.logs ?? []) {
        await ctx.mcpReq.log(log.level, log.data, log.logger);
      }
    }

    return request.params?.cursor === "page-2"
      ? {
          tools: [
            ...(options.listMore === true
              ? [SHOUT_TOOL, BIG_TOOL, HANG_TOOL, TYPED_TOOL, REGION_TOOL]
              : [SHOUT_TOOL]),
            ...(options.moreTools ?? []),
          ],
        }
      : { tools: [ECHO_TOOL], nextCursor: "page-2" };
  });
  server.setRequestHandler("tools/call", async (request, ctx) => {
    await sends?.(server);

    for (const log of options.logs ?? []) {
      await ctx.mcpReq.log(log.level, log.data, log.logger);
    }

    switch (request.params.name) {
      case "big": {
        const { bytes } = Schema.decodeUnknownSync(BigArguments)(request.params.arguments);

        return { content: [{ type: "text", text: "x".repeat(bytes) }] };
      }

      case "hang":
        return untilAborted(ctx.mcpReq.signal, () => options.cancelled?.push(request.params.name));

      case "progress": {
        const { steps, hang } = Schema.decodeUnknownSync(ProgressArguments)(
          request.params.arguments,
        );

        const token = ctx.mcpReq._meta?.progressToken;

        for (let step = 1; token !== undefined && step <= steps; step++) {
          await ctx.mcpReq.notify({
            method: "notifications/progress",
            params: { progressToken: token, progress: step, total: steps, message: `step ${step}` },
          });
        }

        if (hang === true) {
          return untilAborted(ctx.mcpReq.signal, () =>
            options.cancelled?.push(request.params.name),
          );
        }

        return { content: [{ type: "text", text: "done" }] };
      }

      case "roots": {
        // Modern asks in an `input_required` round and reads the answer from the retry; Legacy asks on the call's stream.
        if (modern) {
          const answered = ctx.mcpReq.inputResponses?.["roots"];

          return answered === undefined
            ? inputRequired({ inputRequests: { roots: inputRequired.listRoots() } })
            : { content: [{ type: "text", text: JSON.stringify(answered) }] };
        }

        return { content: [{ type: "text", text: JSON.stringify(await server.listRoots()) }] };
      }

      case "region": {
        const { region } = Schema.decodeUnknownSync(RegionArguments)(request.params.arguments);

        return { content: [{ type: "text", text: region }] };
      }

      case "typed": {
        const { structured } = Schema.decodeUnknownSync(TypedArguments)(request.params.arguments);
        const content = [{ type: "text" as const, text: JSON.stringify(structured ?? null) }];

        return structured === undefined ? { content } : { content, structuredContent: structured };
      }

      default: {
        const { text } = Schema.decodeUnknownSync(EchoArguments)(request.params.arguments);

        return {
          content: [
            { type: "text", text: request.params.name === "shout" ? text.toUpperCase() : text },
          ],
        };
      }
    }
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
        url: request.url,
        headers: new Headers(request.headers),
        rpc: await readRpc(request),
      });

      return handle(request);
    },
  };
};

/** A Modern (`2026-07-28`) server: stateless, and answering any Legacy request as unsupported. */
export const modernServer = (options?: FakeOptions): FakeServer =>
  recording(createMcpHandler(() => fakeMcp(undefined, options, true), { legacy: "reject" }).fetch);

/** A Legacy server with no sessions: each POST is answered by a fresh server; GET and DELETE are 405. */
export const legacyStatelessServer = (options?: FakeOptions): FakeServer =>
  recording(async (request) => {
    if (request.method !== "POST") {
      return new Response(null, { status: 405 });
    }

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    await fakeMcp(undefined, options).connect(transport);

    return transport.handleRequest(request);
  });

/**
 * A Legacy server with sessions: answers on SSE, keeps a GET stream per session (recording what the client reads of
 * it), and forgets sessions on demand.
 */
export const legacyStatefulServer = (options?: FakeOptions) => {
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
  const streamed: Array<string> = [];
  let next = 0;

  /** `response`, with what the client reads of a GET stream recorded in `streamed`. */
  const recordStream = (request: Request, response: Response) => {
    if (request.method !== "GET" || response.body === null) {
      return response;
    }

    const decoder = new TextDecoder();

    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform: (chunk, controller) => {
          streamed.push(decoder.decode(chunk, { stream: true }));
          controller.enqueue(chunk);
        },
      }),
    );

    return new Response(body, response);
  };

  const fake = recording(async (request) => {
    const id = request.headers.get("mcp-session-id");

    if (id !== null) {
      const transport = sessions.get(id);

      return transport === undefined
        ? Response.json(
            { jsonrpc: "2.0", id: null, error: { code: -32001, message: "Session not found" } },
            { status: 404 },
          )
        : recordStream(request, await transport.handleRequest(request));
    }

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => `session-${++next}`,
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, transport);
      },
    });

    // A notification on the GET stream with every call, as servers announcing changes do.
    await fakeMcp(
      (server) => server.notification({ method: "notifications/tools/list_changed" }),
      options,
    ).connect(transport);

    return transport.handleRequest(request);
  });

  return {
    ...fake,
    sessions,
    /** The text the client has read of the GET streams. */
    streamed,
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
