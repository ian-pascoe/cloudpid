// The fake MCP servers as an auxiliary Worker for the engine's workerd tests (`docs/architecture/mcp.md` → Testing):
// the engine's outbound `fetch`es all come here (`vitest.config.ts`). A server is picked by host and made fresh per
// key, the URL's first path segment, so each test has its own: `https://<kind>.test/<key>/mcp`. `GET
// https://<kind>.test/<key>/_seen` answers what that server received and which of its calls were cancelled.
// @effect-diagnostics asyncFunction:off globalFetch:off preferEffectArray:off -- a fetch handler, Promise-based at its seam.
import {
  APP_MIME_TYPE,
  appTool,
  type FakeOptions,
  type FakeServer,
  hostileServer,
  legacyStatefulServer,
  legacyStatelessServer,
  modernServer,
  type RpcBody,
  rpcMethods,
} from "@cloudpid/mcp/testing";

/** A tool whose `outputSchema` TypeBox cannot compile: its `pattern` is not a regular expression. */
const UNCOMPILABLE_TOOL = {
  name: "uncompilable",
  inputSchema: { type: "object" as const },
  outputSchema: {
    type: "object" as const,
    properties: { id: { type: "string", pattern: "(" } },
  },
};

/** A tool the server refuses every call to as a header mismatch, however often its tools are listed. */
const STUBBORN_TOOL = { name: "stubborn", inputSchema: { type: "object" as const } };

/** A tool the server answers with a JSON-RPC error whose message is the call's `text`, echoed. */
const COMPLAIN_TOOL = { name: "complain", inputSchema: { type: "object" as const } };

const complaint = (rpc: RpcBody) =>
  Response.json({
    jsonrpc: "2.0",
    id: rpc.id ?? null,
    error: { code: -32000, message: `Refused: ${JSON.stringify(rpc.params?.["arguments"])}` },
  });

const headerMismatch = (id: string | number | null) =>
  Response.json(
    { jsonrpc: "2.0", id, error: { code: -32020, message: "Header mismatch" } },
    { status: 400 },
  );

/**
 * A Modern server that refuses a `region` call without its `Mcp-Param-Region` header (`-32020`), as one whose tool
 * changed, and every `stubborn` call; it lists both, and a tool whose `outputSchema` cannot be compiled. A `complain`
 * call fails with its arguments in the error's message.
 */
const headersServer = (options: FakeOptions) =>
  hostileServer(
    modernServer({ ...options, moreTools: [UNCOMPILABLE_TOOL, STUBBORN_TOOL] }),
    (request, rpc) => {
      if (rpc?.method !== "tools/call") {
        return undefined;
      }

      const name = rpc.params?.["name"];

      if (name === COMPLAIN_TOOL.name) {
        return complaint(rpc);
      }

      return name === STUBBORN_TOOL.name ||
        (name === "region" && request.headers.get("mcp-param-region") === null)
        ? headerMismatch(rpc.id ?? null)
        : undefined;
    },
  );

/** The secret the `logging` server echoes in a log, as one that logs the header it was sent (`calls.test.ts` knows it by its text). */
const ECHOED_SECRET = "sk-echoed-secret-0123456789";

/** A Modern server that declares `logging` and sends three logs with every first page of `tools/list` and every call. */
const loggingServer = (options: FakeOptions) =>
  modernServer({
    ...options,
    logs: [
      { level: "info", data: "quiet" },
      { level: "warning", data: `rejected Bearer ${ECHOED_SECRET}`, logger: "auth" },
      { level: "error", data: { big: "x".repeat(5000) } },
    ],
  });

/** A server that answers every request with `status` and a `WWW-Authenticate` challenge, as an OAuth wall does. */
const wallServer = (status: 401 | 403, challenge: string) => (options: FakeOptions) =>
  hostileServer(
    modernServer(options),
    () => new Response("denied", { status, headers: { "www-authenticate": challenge } }),
  );

/** A Modern App server: its `app` tool has the App `ui://docs/app`, whose HTML echoes a token its server must not leak. */
const appServer = (options: FakeOptions) =>
  modernServer({
    ...options,
    resources: [
      {
        uri: "ui://docs/app",
        name: "app",
        mimeType: APP_MIME_TYPE,
        contents: [
          {
            uri: "ui://docs/app",
            mimeType: APP_MIME_TYPE,
            text: `<p>${ECHOED_SECRET}</p>`,
            _meta: { ui: { prefersBorder: true } },
          },
        ],
      },
    ],
    moreTools: [appTool("app", "ui://docs/app")],
  });

/**
 * A Modern server with resources: two listed one to a page, a template, the lists' cache hints, and a read whose text
 * echoes a token its server must not leak.
 */
const resourcesServer = (options: FakeOptions) =>
  modernServer({
    ...options,
    resourcePageSize: 1,
    listCache: { ttlMs: 60_000 },
    resourceTemplates: [{ uriTemplate: "file:///{path}", name: "files" }],
    resources: [
      {
        uri: "file:///notes.md",
        name: "notes",
        mimeType: "text/markdown",
        contents: [
          { uri: "file:///notes.md", mimeType: "text/markdown", text: `key ${ECHOED_SECRET}` },
        ],
      },
      {
        uri: "file:///logo.png",
        name: "logo",
        description: `for ${ECHOED_SECRET}`,
        mimeType: "image/png",
        contents: [{ uri: "file:///logo.png", mimeType: "image/png", blob: "iVBORw0KGgo=" }],
      },
    ],
  });

const KINDS: ReadonlyMap<string, (options: FakeOptions) => FakeServer> = new Map([
  ["modern.test", modernServer],
  ["apps.test", appServer],
  ["resources.test", resourcesServer],
  ["legacy.test", legacyStatelessServer],
  ["stateful.test", legacyStatefulServer],
  ["headers.test", headersServer],
  ["logging.test", loggingServer],
  [
    "unauthorized.test",
    wallServer(
      401,
      'Bearer error="invalid_token", error_description="expired", resource_metadata="https://unauthorized.test/.well-known/oauth-protected-resource"',
    ),
  ],
  [
    "forbidden.test",
    wallServer(
      403,
      'Bearer error="insufficient_scope", scope="write", error_description="Needs write", resource_metadata="https://forbidden.test/.well-known/oauth-protected-resource"',
    ),
  ],
]);

interface Fake {
  readonly server: FakeServer;
  readonly cancelled: Array<string>;
}

const fakes = new Map<string, Fake>();

const fakeFor = (host: string, key: string) => {
  const id = `${host}/${key}`;
  const known = fakes.get(id);

  if (known !== undefined) {
    return known;
  }

  const make = KINDS.get(host);

  if (make === undefined) {
    return undefined;
  }

  const cancelled: Array<string> = [];
  const fake = { server: make({ listMore: true, cancelled }), cancelled };

  fakes.set(id, fake);

  return fake;
};

export default {
  fetch: async (request: Request) => {
    const url = new URL(request.url);
    const [, key = "", path = ""] = url.pathname.split("/");
    const fake = fakeFor(url.host, key);

    if (fake === undefined) {
      return new Response("no such fake", { status: 404 });
    }

    if (path === "_seen") {
      return Response.json({
        methods: rpcMethods(fake.server),
        notifications: fake.server.received.flatMap((received) =>
          received.rpc?.method !== undefined && received.rpc.id === undefined
            ? [received.rpc.method]
            : [],
        ),
        cancelled: fake.cancelled,
        // The capabilities the client declared at each `initialize`.
        declared: fake.server.received.flatMap((received) =>
          received.rpc?.method === "initialize" ? [received.rpc.params?.["capabilities"]] : [],
        ),
      });
    }

    return fake.server.handle(request);
  },
};
