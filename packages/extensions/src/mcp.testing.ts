// @effect-diagnostics missingPipeableSignature:off -- a test double's methods, not combinators.
// An in-memory `McpHostClient` for Session tests (`docs/architecture/mcp-in-a-session.md`): an inventory the test sets
// (its servers with their tools, its features), answered by `requestStart` and `servers` with content-hash-like
// versions (the same inventory always answers the same version), every call recorded, and `request` answered by a
// function the test gives, with the call's hooks.
import {
  HostFailed,
  type JsonObject,
  MCP_HOST_FEATURES,
  McpHostCompleted,
  type McpHostRequest,
  type McpHostRequestHooks,
  type McpHostRequestResult,
  type McpRequestStart,
  type McpServerInventory,
  type McpServersRequest,
  UnknownServer,
} from "@cloudpid/mcp/types";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Record from "effect/Record";
import type { Mutable } from "effect/Types";
import type { HostLost, McpHostClientService } from "./mcp.ts";

/** One server of the fake inventory: its name, its tools as the server lists them, and its entry's Exposure keys. */
export type FakeMcpServer = {
  readonly name: string;
  readonly tools: ReadonlyArray<{
    readonly name: string;
    readonly title?: string;
    readonly description?: string;
    readonly inputSchema?: JsonObject;
    readonly outputSchema?: JsonObject;
    readonly annotations?: JsonObject;
    readonly _meta?: JsonObject;
  }>;
  readonly exposure?: string;
  readonly toolExposure?: Readonly<Record<string, string>>;
  /** Absent: `connected`, with an inventory. */
  readonly state?: string;
  /** The entry's `description`. */
  readonly description?: string;
  /** The entry's `timeout`, in seconds. */
  readonly timeout?: number;
  /** What the server says of itself at `initialize`. */
  readonly instructions?: string;
  /** More keys of the entry, as a definition spells them (`headers`, `oauth`, ...). */
  readonly entry?: JsonObject;
};

/** What the fake was asked, in order. */
export type FakeMcpCall =
  | { readonly method: "requestStart"; readonly input: McpRequestStart }
  | { readonly method: "servers"; readonly input: McpServersRequest }
  | { readonly method: "request"; readonly input: McpHostRequest };

/** How the fake answers a request: by default, the tool's name and its arguments as text. */
export type FakeMcpAnswer = (
  input: McpHostRequest,
  hooks: McpHostRequestHooks,
) => Promise<McpHostRequestResult | HostLost>;

const echo: FakeMcpAnswer = (input) =>
  Promise.resolve(
    McpHostCompleted.make({
      result: {
        kind: "inline",
        value: {
          content: [
            {
              type: "text",
              text: `${input.params.name} ${JSON.stringify(input.params.arguments ?? {})}`,
            },
          ],
        },
      },
    }),
  );

/** An inventory of `servers` as `servers` answers it, with the parts asked for. */
const inventoryOf = (
  servers: ReadonlyArray<FakeMcpServer>,
  parts: ReadonlyArray<string>,
): ReadonlyArray<McpServerInventory> =>
  Arr.map(servers, (server) => {
    const tools: ReadonlyArray<JsonObject> = Arr.map(server.tools, (tool) => ({
      inputSchema: { type: "object" },
      ...tool,
    }));

    const discovered = server.state === undefined || server.state === "connected";

    const inventory: Mutable<McpServerInventory> = {
      name: server.name,
      source: { kind: "environment" },
      server: {
        ...server.entry,
        type: "http",
        url: `https://${server.name}.test/mcp`,
        exposure: server.exposure ?? "codemode",
        toolExposure: server.toolExposure ?? {},
      },
      conn: `conn-${server.name}`,
      state: server.state ?? "connected",
      toolsHash: JSON.stringify(tools),
      promptsHash: "",
      counts: { tools: tools.length, prompts: 0 },
      resources: false,
      problems: [],
    };

    if (server.description !== undefined) {
      inventory.server = { ...inventory.server, description: server.description };
    }

    if (server.timeout !== undefined) {
      inventory.server = { ...inventory.server, timeout: server.timeout };
    }

    if (discovered) inventory.discoveredAt = 1;

    if (discovered && server.instructions !== undefined && parts.includes("instructions")) {
      inventory.instructions = server.instructions;
    }

    if (discovered && parts.includes("tools")) inventory.tools = tools;

    return inventory;
  });

/** The fake's version: the same inventory always answers the same one, as the host's content hashes do. */
const versionOf = (servers: ReadonlyArray<FakeMcpServer>) => {
  let hash = 5381;

  for (const char of JSON.stringify(servers)) hash = ((hash * 33) ^ char.charCodeAt(0)) >>> 0;

  return `v-${hash.toString(16)}`;
};

/**
 * An in-memory host. `set` replaces its inventory, `features` what `requestStart` lists (the host's own by default),
 * `fail` makes every method answer `HostFailed`, and `answer` how requests are answered.
 */
export const fakeMcpHost = (initial: ReadonlyArray<FakeMcpServer> = []) => {
  let servers = initial;
  let features: ReadonlyArray<string> = MCP_HOST_FEATURES;
  let failing = false;
  let answer = echo;
  const calls: Array<FakeMcpCall> = [];

  const failed = HostFailed.make({ message: "The fake host fails" });

  const client: McpHostClientService = {
    requestStart: (input) =>
      Effect.sync(() => {
        calls.push({ method: "requestStart", input });

        return failing
          ? failed
          : {
              version: versionOf(servers),
              promptsVersion: "",
              features,
              servers: Record.fromEntries(
                Arr.map(inventoryOf(servers, []), (server) => [
                  server.name,
                  { toolsHash: server.toolsHash, promptsHash: "", state: server.state },
                ]),
              ),
              watches: { changed: [], ended: [] },
            };
      }),
    servers: (input) =>
      Effect.sync(() => {
        calls.push({ method: "servers", input });

        return failing
          ? failed
          : {
              version: versionOf(servers),
              promptsVersion: "",
              servers: inventoryOf(servers, input.parts),
            };
      }),
    request: (input, hooks) =>
      Effect.suspend(() => {
        calls.push({ method: "request", input });

        if (failing) return Effect.succeed(failed);

        if (!Arr.some(servers, (server) => server.name === input.server)) {
          return Effect.succeed(UnknownServer.make({ message: `No MCP server ${input.server}` }));
        }

        return Effect.promise(() => answer(input, hooks));
      }),
  };

  return {
    client,
    calls,
    set: (next: ReadonlyArray<FakeMcpServer>) => {
      servers = next;
    },
    features: (next: ReadonlyArray<string>) => {
      features = next;
    },
    fail: (next: boolean) => {
      failing = next;
    },
    answer: (next: FakeMcpAnswer) => {
      answer = next;
    },
  };
};
