// The contract of the Container MCP bridge (docs/architecture/mcp-connections.md → The stdio bridge), the Node script the
// image runs beside computerd (`image/cloudpid-mcp-bridge.ts`), with the Workspaces Worker and the MCP engine, which
// import it: no Node built-ins and no MCP SDK here, since it runs in a Worker. The script repeats these values (it is
// copied into the image on its own); `mcp-bridge.test.ts` fails when they differ.
// @effect-diagnostics asyncFunction:off preferEffectRecord:off preferEffectArray:off

/**
 * The port the bridge listens on, on `0.0.0.0` (computerd's is 8080, and the Container preview ports are
 * `CONTAINER_PREVIEW_PORTS`, `@cloudpid/extensions/browser`). Outside the range of the dev servers a project starts.
 */
export const MCP_BRIDGE_PORT = 17_781;

/** Where the image has the bridge's script, which the supervisor starts when the launch has a token. */
export const MCP_BRIDGE_SCRIPT = "/usr/local/share/cloudpid/mcp-bridge.ts";

/**
 * The variable of the Container's launch environment that carries the bridge token the Workspace DO minted for this
 * launch. The bridge exits without it, and the supervisor starts none; the bridge never passes it to a child.
 */
export const MCP_BRIDGE_TOKEN_ENV = "CLOUDPID_MCP_BRIDGE_TOKEN";

/**
 * The bridge's level, on every response as `x-cloudpid-bridge`. It rises when a change of the bridge's wire contract
 * has to be told from an older bridge: the engine fails a server whose bridge answers a level below its minimum.
 */
export const MCP_BRIDGE_LEVEL = 1;

/** The response header that carries `MCP_BRIDGE_LEVEL`. */
export const MCP_BRIDGE_LEVEL_HEADER = "x-cloudpid-bridge";

/**
 * The response header that carries the spawn id of the child a response is about (also the Legacy `Mcp-Session-Id`):
 * it changes when the child is spawned again, so a caller learns of a restart. Absent where no child is concerned.
 */
export const MCP_BRIDGE_SPAWN_HEADER = "x-cloudpid-spawn";

/**
 * The request header that names the stdio server: `mcpBridgeConfigHeader(config)`. The bridge's key for the server is
 * the hash of its config, so a changed config is another server.
 */
export const MCP_BRIDGE_CONFIG_HEADER = "x-cloudpid-stdio-config";

/** The request header that carries the host's cached era of the server, `legacy` or `modern`, so the bridge need not probe. */
export const MCP_BRIDGE_ERA_HEADER = "x-cloudpid-era";

/** The path of the Streamable HTTP endpoint: POST, and GET for a Legacy session's stream. */
export const MCP_BRIDGE_MCP_PATH = "/mcp";

/** `GET`: readiness, 200 once the bridge serves. Never spawns a child. */
export const MCP_BRIDGE_HEALTH_PATH = "/_bridge/health";

/** `GET`: every child (`McpBridgeStatus`). Never spawns a child. */
export const MCP_BRIDGE_STATUS_PATH = "/_bridge/status";

/** `POST` `{ key }`: stops one child (`{ stopped }`). Never spawns a child. */
export const MCP_BRIDGE_STOP_PATH = "/_bridge/stop";

/** The most of a child's stderr the bridge keeps and reports, in bytes (the end of it, cut on a UTF-8 character). */
export const MCP_BRIDGE_STDERR_LIMIT = 65_536;

/** How long the bridge waits for a child's answer to its `server/discover` probe before it reads the child as Legacy. */
export const MCP_BRIDGE_PROBE_MS = 15_000;

/** A stdio server's config: what the bridge spawns. A server's `env` is added to the bridge's `PATH` and `HOME` only. */
export type McpBridgeConfig = {
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
};

export type McpBridgeEra = "legacy" | "modern";

/** What a child's last exit was. */
export type McpBridgeExit = {
  readonly code: number | null;
  readonly signal: string | null;
  /** `stopped` for `POST /_bridge/stop`, `replaced` for a Legacy `initialize` that spawned again, else absent. */
  readonly reason?: "stopped" | "replaced" | undefined;
  /** A spawn that failed (`ENOENT` and the like). */
  readonly error?: string | undefined;
  readonly at: string;
};

/** One child in `GET /_bridge/status`. */
export type McpBridgeChild = {
  readonly key: string;
  readonly spawnId: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string | undefined;
  readonly pid?: number | undefined;
  /** `unknown` until the child was probed or the host's hint named it. */
  readonly era: McpBridgeEra | "unknown";
  readonly state: "running" | "exited";
  readonly startedAt: string;
  readonly inFlight: number;
  readonly listens: number;
  readonly getStream: boolean;
  readonly queued: number;
  readonly exit?: McpBridgeExit | undefined;
  readonly stderrTail: string;
};

export type McpBridgeStatus = {
  readonly level: number;
  readonly children: ReadonlyArray<McpBridgeChild>;
};

/** The body of `x-cloudpid-stdio-config` for `config`: base64url of its JSON. */
export const mcpBridgeConfigHeader = (config: McpBridgeConfig): string => {
  const bytes = new TextEncoder().encode(JSON.stringify(config));

  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
};

/**
 * The bridge's key for a server: the SHA-256, in hex, of its config's canonical form (`command`, `args`, the `env`
 * entries by name, `cwd`), which `GET /_bridge/status` lists and `POST /_bridge/stop` takes.
 */
export const mcpBridgeKey = async (config: McpBridgeConfig): Promise<string> => {
  const entries = Object.entries(config.env ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const canonical = JSON.stringify([
    config.command,
    config.args ?? [],
    entries,
    config.cwd ?? null,
  ]);

  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));

  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};
