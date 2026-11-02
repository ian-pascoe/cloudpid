// The MCP bridge's forwarding rules (docs/architecture/mcp-connections.md → The stdio bridge) over fakes, where the
// workerd tests (`mcp-bridge.workerd.test.ts`) have the real Workspace DO: when the health is polled, how a failed poll is
// remembered, and the fallback refusal.
// @effect-diagnostics asyncFunction:off preferEffectArray:off newPromise:off globalTimers:off
import {
  MCP_BRIDGE_CONTAINER_HEADER,
  MCP_BRIDGE_HEALTH_PATH,
  mcpBridgeRefusalCode,
} from "@cloudpid/sandbox-image/mcp-bridge";
import { describe, expect, it, vi } from "vitest";
import { McpBridge, type McpBridgeDeps, mcpBridgeRefusal } from "./mcp-bridge.ts";

type Fake = {
  recorded: () => boolean;
  running: boolean;
  tokens: Array<string | undefined>;
  /** How many health polls find nothing listening before one answers; Infinity for a bridge that never does. */
  deaf: number;
  health: number;
  forwards: string[];
  starts: number;
  warnings: string[];
  /** The body of the bridge's answer to a request, when it is not `{ ok: true }`. */
  body: (() => ReadableStream<Uint8Array>) | undefined;
  /** The holds begun and ended on the Container. */
  holds: { begun: number; ended: number };
};

const open = (overrides: Partial<Fake> = {}) => {
  const fake: Fake = {
    recorded: () => true,
    running: false,
    tokens: ["token-1"],
    deaf: 0,
    health: 0,
    forwards: [],
    starts: 0,
    warnings: [],
    body: undefined,
    holds: { begun: 0, ended: 0 },
    ...overrides,
  };

  const deps: McpBridgeDeps = {
    recorded: () => fake.recorded(),
    running: () => fake.running,
    start: async () => {
      fake.starts++;
      fake.running = true;
    },
    // The last token stays: the record is saved, once.
    token: async () => (fake.tokens.length > 1 ? fake.tokens.shift() : fake.tokens[0]),
    port: () => ({
      fetch: async (input: RequestInfo | URL) => {
        const url = new URL(input instanceof Request ? input.url : input);

        if (url.pathname === MCP_BRIDGE_HEALTH_PATH) {
          fake.health++;

          if (fake.deaf === Infinity || fake.health <= fake.deaf) throw new Error("not listening");

          return Response.json({ status: "ok" });
        }

        fake.forwards.push(url.pathname);

        return fake.body === undefined ? Response.json({ ok: true }) : new Response(fake.body());
      },
      connect: () => {
        throw new Error("no sockets");
      },
    }),
    activity: () => ({
      touch: async () => undefined,
      hold: () => {
        fake.holds.begun++;

        return {
          begun: Promise.resolve(),
          end: async () => {
            fake.holds.ended++;
          },
        };
      },
    }),
    used: () => undefined,
    healthPoll: () => ({ intervalMs: 1, timeoutMs: 5 }),
    warn: (message) => fake.warnings.push(message),
  };

  return { fake, bridge: new McpBridge(deps) };
};

const call = () => new Request("http://bridge.internal/mcp", { method: "POST", body: "{}" });

const errorOf = async (response: Response) => (await response.json<{ error: string }>()).error;

describe("the refusals", () => {
  it("are built in one place, with their statuses, no-store, and the Container header for `stopped` only", async () => {
    const answers = [
      ["no_workspace", 404],
      ["stopped", 503],
      ["start_failed", 502],
      ["bridge_unreachable", 502],
      ["bridge_failed", 502],
    ] as const;

    for (const [code, status] of answers) {
      const response = mcpBridgeRefusal(code);

      expect(response.status, code).toBe(status);
      expect(response.headers.get("cache-control"), code).toBe("no-store");
      expect(response.headers.get(MCP_BRIDGE_CONTAINER_HEADER), code).toBe(
        code === "stopped" ? "stopped" : null,
      );
      expect(mcpBridgeRefusalCode(await errorOf(response)), code).toBe(code);
    }
  });

  it("say `container_restart` where a new bridge is what mends it", async () => {
    const response = mcpBridgeRefusal("bridge_unreachable");

    expect((await response.json<{ message: string }>()).message).toContain("container_restart");
  });
});

describe("the health poll", () => {
  it("is for a Container this request started: one found running is forwarded to at once, however deaf its bridge", async () => {
    const { fake, bridge } = open({ running: true, deaf: 3 });

    const response = await bridge.serve(call(), { start: true, use: false });

    expect(response.status).toBe(200);
    expect(fake.health).toBe(0);
    expect(fake.starts).toBe(0);
  });

  it("runs until the bridge answers, reading the token again at each attempt", async () => {
    // The launch is recorded after the platform has started the Container: the token shows at the third attempt.
    const { fake, bridge } = open({ tokens: [undefined, undefined, "token-1"], deaf: 0 });

    const response = await bridge.serve(call(), { start: true, use: false });

    expect(response.status).toBe(200);
    expect(fake.health).toBe(1);
    expect(fake.forwards).toEqual(["/mcp"]);
  });

  it("is attempted for as long as the poll's time allows, then answers `bridge_unreachable`", async () => {
    const { fake, bridge } = open({ deaf: Infinity });

    const response = await bridge.serve(call(), { start: true, use: false });

    expect(response.status).toBe(502);
    expect(await errorOf(response)).toBe("bridge_unreachable");
    expect(fake.health).toBe(5);
    expect(fake.forwards).toEqual([]);
  });

  it("is remembered when it failed: later requests for that launch answer `bridge_unreachable` at once, polling no more", async () => {
    const { fake, bridge } = open({ deaf: Infinity });

    await bridge.serve(call(), { start: true, use: false });

    const polled = fake.health;

    for (const options of [
      { start: false, use: false },
      { start: true, use: true },
    ]) {
      const response = await bridge.serve(call(), options);

      expect(await errorOf(response)).toBe("bridge_unreachable");
    }

    expect(fake.health).toBe(polled);
    expect(fake.forwards).toEqual([]);
  });

  it("is forgotten at the next launch, whose token is its own", async () => {
    const { fake, bridge } = open({ deaf: Infinity });

    await bridge.serve(call(), { start: true, use: false });

    // `container_restart`, and a command that starts a Container with a new token and a bridge that answers.
    fake.running = false;
    fake.tokens = ["token-2"];
    fake.deaf = 0;

    const response = await bridge.serve(call(), { start: true, use: false });

    expect(response.status).toBe(200);
    expect(fake.starts).toBe(2);
  });

  it("is not run for a Container whose launch kept no token: it runs no bridge", async () => {
    const { fake, bridge } = open({ running: true, tokens: [undefined] });

    const response = await bridge.serve(call(), { start: true, use: true });

    expect(await errorOf(response)).toBe("bridge_unreachable");
    expect(fake.health).toBe(0);
  });
});

describe("a use of the bridge", () => {
  const chunks = (...texts: string[]) =>
    new ReadableStream<Uint8Array>({
      start: (controller) => {
        for (const text of texts) controller.enqueue(new TextEncoder().encode(text));

        controller.close();
      },
    });

  it("holds the Container until its body has ended, and passes the body on whole", async () => {
    const { fake, bridge } = open({ running: true, body: () => chunks("a", "b") });

    const response = await bridge.serve(call(), { start: false, use: true });

    expect(fake.holds).toEqual({ begun: 1, ended: 0 });
    expect(await response.text()).toBe("ab");
    await vi.waitFor(() => expect(fake.holds).toEqual({ begun: 1, ended: 1 }));
  });

  it("ends its hold when the body fails, and the failure reaches the caller", async () => {
    const { fake, bridge } = open({
      running: true,
      body: () =>
        new ReadableStream<Uint8Array>({
          pull: (controller) => controller.error(new Error("the child went away")),
        }),
    });

    const response = await bridge.serve(call(), { start: false, use: true });

    await expect(response.text()).rejects.toThrow("the child went away");
    await vi.waitFor(() => expect(fake.holds).toEqual({ begun: 1, ended: 1 }));
  });

  it("holds nothing for a request that is no use", async () => {
    const { fake, bridge } = open({ running: true });

    await (await bridge.serve(call(), { start: false, use: false })).text();

    expect(fake.holds).toEqual({ begun: 0, ended: 0 });
  });
});

describe("a request that fails in a way nothing foresaw", () => {
  it("answers the fallback refusal, `bridge_failed`, and logs it", async () => {
    const { fake, bridge } = open({
      recorded: () => {
        throw new Error("storage is gone");
      },
    });

    const response = await bridge.serve(call(), { start: false, use: true });

    expect(response.status).toBe(502);
    expect(await errorOf(response)).toBe("bridge_failed");
    expect(fake.warnings.join("\n")).toContain("storage is gone");
  });
});
