// A stand-in for the Workspaces Worker, as an auxiliary Worker for the engine's workerd tests (`vitest.config.ts`): its
// `WorkspaceMcpBridge` answers `mcpBridge(workspace, request, { start, use })` as the real one does, over a fake MCP server
// standing in for the Container's bridge and the child behind it (`docs/architecture/mcp-connections.md` → The stdio
// bridge; `apps/server/src/workspace/mcp-bridge.ts`). A Workspace is `ws:<kind>-<key>`, `kind` being the era of its fake
// (`legacy`, a server with sessions, or `modern`); each is made fresh per name. Its Container starts only when a request says
// `start` and stops on demand, forgetting its sessions as a stopped Container does.
//
// `GET https://workspaces.test/<workspace>/<op>` controls and reads one Workspace: `_stop` stops its Container, `_gone` makes
// it a Workspace with no record (404 `no_workspace`), `_level?value=<n>` sets the level the bridge answers (0: none),
// `_cut?how=exited|stopped|silent` ends the next `tools/call`'s stream with no answer, the child having exited (code 1, with
// a stderr tail) or the Container having stopped, or neither, and `_seen` answers what reached it.
// @effect-diagnostics asyncFunction:off globalFetch:off preferEffectArray:off newPromise:off missingPipeableSignature:off
import { WorkerEntrypoint } from "cloudflare:workers";
import { type FakeServer, legacyStatefulServer, modernServer } from "@cloudpid/mcp/testing";
import {
  MCP_BRIDGE_CONFIG_HEADER,
  MCP_BRIDGE_CONTAINER_HEADER,
  MCP_BRIDGE_ERA_HEADER,
  MCP_BRIDGE_LEVEL_HEADER,
  MCP_BRIDGE_SPAWN_HEADER,
  MCP_BRIDGE_STATUS_PATH,
  type McpBridgeConfig,
  type McpBridgeOptions,
  mcpBridgeKey,
} from "@cloudpid/sandbox-image/mcp-bridge";

/** What the child writes to stderr when it exits, with a Secret in it, so a test sees it scrubbed. */
const STDERR = "boom: could not open /data with SECRET-IN-STDERR-1234\n";

interface Seen {
  readonly method: string;
  readonly path: string;
  readonly start: boolean;
  readonly use: boolean;
  readonly era: string | null;
  readonly config: McpBridgeConfig | undefined;
}

interface Container {
  readonly kind: "legacy" | "modern";
  running: boolean;
  spawn: number;
  server: FakeServer | undefined;
  level: number | undefined;
  gone: boolean;
  cut: "exited" | "stopped" | "silent" | undefined;
  exited: boolean;
  config: McpBridgeConfig | undefined;
  readonly seen: Array<Seen>;
  /** The JSON-RPC methods that reached the child, over every spawn. */
  readonly methods: Array<string>;
  /** The capabilities the client declared at each `initialize`. */
  readonly declared: Array<unknown>;
}

const containers = new Map<string, Container>();

const containerOf = (workspace: string): Container => {
  const known = containers.get(workspace);

  if (known !== undefined) return known;

  const container: Container = {
    kind: workspace.startsWith("ws:modern") ? "modern" : "legacy",
    running: false,
    spawn: 0,
    server: undefined,
    level: 1,
    gone: false,
    cut: undefined,
    exited: false,
    config: undefined,
    seen: [],
    methods: [],
    declared: [],
  };

  containers.set(workspace, container);

  return container;
};

const refusal = (status: number, error: string, extra: Readonly<Record<string, string>> = {}) =>
  Response.json(
    { error, message: `The stand-in refuses: ${error}` },
    { status, headers: new Headers({ "cache-control": "no-store", ...extra }) },
  );

const stopped = () => refusal(503, "stopped", { [MCP_BRIDGE_CONTAINER_HEADER]: "stopped" });

const start = (container: Container) => {
  container.running = true;
  container.spawn += 1;
  container.exited = false;
  container.server =
    container.kind === "modern"
      ? modernServer({ listMore: true })
      : legacyStatefulServer({ listMore: true });
};

/** `response` as the bridge answers: with its level and the child's spawn id. */
const asBridge = (container: Container, response: Response) => {
  const answered = new Response(response.body, response);

  if (container.level !== undefined && container.level > 0) {
    answered.headers.set(MCP_BRIDGE_LEVEL_HEADER, String(container.level));
  }

  answered.headers.set(MCP_BRIDGE_SPAWN_HEADER, `spawn-${container.spawn}`);

  return answered;
};

const decodeConfig = (header: string | null): McpBridgeConfig | undefined => {
  if (header === null) return undefined;

  const bytes = Uint8Array.from(atob(header.replaceAll("-", "+").replaceAll("_", "/")), (char) =>
    char.charCodeAt(0),
  );

  // SAFETY: the engine's `mcpBridgeConfigHeader` made it.
  return JSON.parse(new TextDecoder().decode(bytes)) as McpBridgeConfig;
};

const statusOf = async (container: Container) => ({
  level: container.level ?? 0,
  children:
    container.config === undefined || !container.exited
      ? []
      : [
          {
            key: await mcpBridgeKey(container.config),
            spawnId: `spawn-${container.spawn}`,
            state: "exited",
            exit: { code: 1, signal: null, at: "2026-01-01T00:00:00.000Z" },
            stderrTail: STDERR,
          },
        ],
});

export class WorkspaceMcpBridge extends WorkerEntrypoint {
  async mcpBridge(workspace: string, request: Request, options: McpBridgeOptions) {
    const container = containerOf(workspace);
    const url = new URL(request.url);

    const config = decodeConfig(request.headers.get(MCP_BRIDGE_CONFIG_HEADER));

    if (config !== undefined) container.config = config;

    container.seen.push({
      method: request.method,
      path: url.pathname,
      start: options.start,
      use: options.use,
      era: request.headers.get(MCP_BRIDGE_ERA_HEADER),
      config,
    });

    if (container.gone) return refusal(404, "no_workspace");

    if (!container.running && (url.pathname === MCP_BRIDGE_STATUS_PATH || !options.start)) {
      return stopped();
    }

    if (url.pathname === MCP_BRIDGE_STATUS_PATH) {
      return asBridge(container, Response.json(await statusOf(container)));
    }

    if (!container.running) start(container);

    // SAFETY: the engine's own JSON-RPC request, whose shape the fake server it reaches reads the same way.
    const rpc = (request.method === "POST" ? await request.clone().json() : undefined) as
      | { method?: string; params?: { capabilities?: unknown } }
      | undefined;

    const method = rpc?.method;

    if (method === "initialize") container.declared.push(rpc?.params?.capabilities);

    if (method === "tools/call" && container.cut !== undefined) {
      const how = container.cut;

      container.cut = undefined;

      if (how === "exited") container.exited = true;

      if (how === "stopped") container.running = false;

      // The stream opens and ends with no answer.
      return asBridge(
        container,
        new Response("", { headers: { "content-type": "text/event-stream" } }),
      );
    }

    // SAFETY: `start` above made the server of a Container that was not running.
    const answered = await (container.server as FakeServer).handle(request);

    // What the child ran: a request its server turned away for a session it never had (404) did not reach it.
    if (method !== undefined && answered.status !== 404) container.methods.push(method);

    return asBridge(container, answered);
  }
}

export default {
  fetch: async (request: Request) => {
    const url = new URL(request.url);
    const [, workspace = "", op = ""] = url.pathname.split("/").map(decodeURIComponent);
    const container = containerOf(workspace);

    switch (op) {
      case "_stop":
        container.running = false;
        container.server = undefined;

        return new Response("ok");
      case "_gone":
        container.gone = true;

        return new Response("ok");
      case "_level":
        container.level = Number(url.searchParams.get("value"));

        return new Response("ok");
      case "_cut":
        // SAFETY: the test's own control, which names one of the cuts.
        container.cut = url.searchParams.get("how") as Container["cut"];

        return new Response("ok");
      case "_seen":
        return Response.json({
          running: container.running,
          spawn: container.spawn,
          methods: container.methods,
          declared: container.declared,
          seen: container.seen,
        });
      default:
        return new Response("no such control", { status: 404 });
    }
  },
};
