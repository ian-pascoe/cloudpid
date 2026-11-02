// The fake MCP servers as an auxiliary Worker for the engine's workerd tests (`docs/architecture/mcp.md` → Testing):
// the engine's outbound `fetch`es all come here (`vitest.config.ts`). A server is picked by host and made fresh per
// key, the URL's first path segment, so each test has its own: `https://<kind>.test/<key>/mcp`. `GET
// https://<kind>.test/<key>/_seen` answers what that server received and which of its calls were cancelled.
// @effect-diagnostics asyncFunction:off globalFetch:off preferEffectArray:off -- a fetch handler, Promise-based at its seam.
import {
  type FakeOptions,
  type FakeServer,
  hostileServer,
  legacyStatefulServer,
  legacyStatelessServer,
  modernServer,
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

const headerMismatch = (id: string | number | null) =>
  Response.json(
    { jsonrpc: "2.0", id, error: { code: -32020, message: "Header mismatch" } },
    { status: 400 },
  );

/**
 * A Modern server that refuses a `region` call without its `Mcp-Param-Region` header (`-32020`), as one whose tool
 * changed, and every `stubborn` call; it lists both, and a tool whose `outputSchema` cannot be compiled.
 */
const headersServer = (options: FakeOptions) =>
  hostileServer(
    modernServer({ ...options, moreTools: [UNCOMPILABLE_TOOL, STUBBORN_TOOL] }),
    (request, rpc) => {
      if (rpc?.method !== "tools/call") {
        return undefined;
      }

      const name = rpc.params?.["name"];

      return name === STUBBORN_TOOL.name ||
        (name === "region" && request.headers.get("mcp-param-region") === null)
        ? headerMismatch(rpc.id ?? null)
        : undefined;
    },
  );

const KINDS: ReadonlyMap<string, (options: FakeOptions) => FakeServer> = new Map([
  ["modern.test", modernServer],
  ["legacy.test", legacyStatelessServer],
  ["stateful.test", legacyStatefulServer],
  ["headers.test", headersServer],
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
      });
    }

    return fake.server.handle(request);
  },
};
