// The Workspace DO's side of the Container MCP bridge (`docs/architecture/mcp-connections.md` → The stdio bridge, #382
// D5.1): a request the MCP engine made, which the Workspaces Worker's `WorkspaceMcpBridge` entrypoint hands here, and
// which is forwarded to the bridge in the Container (`getTcpPort(MCP_BRIDGE_PORT)`, as the Container previews are) with
// the bridge token as its bearer. The token is the launch's (`ContainerLaunch.bridgeToken`); it is added here and goes
// nowhere else: no caller is given it, no line logs it.
//
// - A Workspace with no record of itself (a destroyed one: its storage is wiped) answers 404 `no_workspace`, and starts
//   no Container.
// - A stopped Container answers 503 `stopped` with `x-cloudpid-container: stopped` when `start` is false. With `start`
//   true it is started as a command starts it (`true`, which writes nothing, single-flight), and the bridge's health is
//   polled until it answers, since the supervisor starts the bridge beside computerd.
// - `use: true` (a call, a prompt get, a read, a completion, discovery, an MCP task poll) is a use of the Container
//   (`IdleStop.touch`) and holds it, as a command that may write does (a stdio server may write the disk), until the
//   response's body ends, fails or is cancelled. `use: false` (the GET stream, listens, subscribe, bridge control) neither
//   touches nor holds. Neither is activity (`noteActivity`): an open session, an idle child, a stream and the server's own
//   messages are not uses, so a stdio server never keeps the Container awake between requests.
// - A bridge that does not answer (it exited, and nothing restarts it; or the Container has none) answers 502
//   `bridge_unreachable`, which says that `container_restart` starts a new one.
// @effect-diagnostics asyncFunction:off globalTimers:off newPromise:off preferSchemaOverJson:off
import { MCP_BRIDGE_HEALTH_PATH, MCP_BRIDGE_PORT } from "@cloudpid/sandbox-image/mcp-bridge";
import type { IdleStop } from "./idle.ts";

/** How often the bridge's health is polled after a start. */
export const MCP_BRIDGE_HEALTH_INTERVAL_MS = 250;

/** How long the bridge's health is polled after a start before it is taken for dead, inside the engine's 60 s. */
export const MCP_BRIDGE_HEALTH_TIMEOUT_MS = 15_000;

/** The response header of a 503: the Container is `stopped` (and the request did not ask to start it). */
export const MCP_BRIDGE_CONTAINER_HEADER = "x-cloudpid-container";

/**
 * Why `WorkspaceMcpBridge` answered itself instead of the bridge: `no_workspace` (404), `stopped` (503), and the
 * failures that get 502: `start_failed` and `bridge_unreachable`. A caller reads a code it does not know as a generic
 * failure (every RPC edge only gains, docs/architecture/mcp.md → Deploys), and any other status as the bridge's.
 */
export type McpBridgeRefusal = "no_workspace" | "stopped" | "start_failed" | "bridge_unreachable";

/** How a request reaches the bridge: whether it may start a stopped Container, and whether it is a use of it. */
export type McpBridgeOptions = {
  readonly start: boolean;
  readonly use: boolean;
};

/** The use of the Container an MCP bridge request makes, as the idle stop counts it (`IdleStop`). */
export type McpBridgeActivity = Pick<IdleStop, "touch" | "hold">;

/** How the bridge's health is polled after a start. */
export type McpBridgeHealthPoll = {
  readonly intervalMs: number;
  readonly timeoutMs: number;
};

export type McpBridgeDeps = {
  /** Whether the Workspace has a record of itself: false for a destroyed one, whose storage is wiped. */
  readonly recorded: () => boolean;
  /** Whether the Container runs now. */
  readonly running: () => boolean;
  /** Start the Container as a command does (`true`, `writes: false`), rejecting when it did not come up. */
  readonly start: () => Promise<void>;
  /** The bridge token of the launch that runs; undefined where there is none (a launch from before tokens were kept). */
  readonly token: () => Promise<string | undefined>;
  /** The Container's port `port`, as `ctx.container.getTcpPort` gives it. */
  readonly port: (port: number) => Fetcher;
  readonly activity: () => McpBridgeActivity;
  /** A request that is a use is a use of the Workspace (a spare's is no longer a spare). */
  readonly used: () => void;
  readonly now: () => number;
  readonly healthPoll: () => McpBridgeHealthPoll;
  readonly warn: (message: string) => void;
};

const refusal = (
  status: number,
  error: McpBridgeRefusal,
  message: string,
  headers: Record<string, string> = {},
): Response =>
  Response.json(
    { error, message },
    { status, headers: { "cache-control": "no-store", ...headers } },
  );

const UNREACHABLE =
  "The Container's MCP bridge did not answer. If it has exited, `container_restart` starts a new one.";

/** Headers not passed on: the host is the bridge's own, and the bearer is ours, whatever the caller put in its place. */
const DROPPED_HEADERS = ["host", "authorization"];

export class McpBridge {
  readonly #deps: McpBridgeDeps;
  /** The start in progress, so requests that arrive while it runs share it. */
  #starting: Promise<void> | undefined;
  /** The health poll in progress, and the token it is for. */
  #polling: { readonly token: string; readonly answered: Promise<boolean> } | undefined;
  /** The token whose bridge answered its health: asked once for each launch that this instance has seen. */
  #verified: string | undefined;

  constructor(deps: McpBridgeDeps) {
    this.#deps = deps;
  }

  /** Answer `request` from the Container's bridge. */
  async serve(request: Request, options: McpBridgeOptions): Promise<Response> {
    if (!this.#deps.recorded()) {
      return refusal(404, "no_workspace", "This Workspace does not exist");
    }

    if (!this.#deps.running()) {
      if (!options.start) {
        return refusal(503, "stopped", "The Workspace's Container is stopped", {
          [MCP_BRIDGE_CONTAINER_HEADER]: "stopped",
        });
      }

      try {
        await this.#started();
      } catch (cause) {
        this.#deps.warn(`MCP bridge: the Container did not start: ${String(cause)}`);

        return refusal(502, "start_failed", "The Workspace's Container did not start");
      }
    }

    const token = await this.#deps.token();

    // A Container launched before tokens were kept runs no bridge, and gets one from its next launch.
    if (token === undefined) return refusal(502, "bridge_unreachable", UNREACHABLE);

    // A Container just launched has its bridge a little after computerd: wait for it once per launch.
    if (this.#verified !== token && !(await this.#healthy(token))) {
      return refusal(502, "bridge_unreachable", UNREACHABLE);
    }

    return options.use ? this.#used(request, token) : this.#forward(request, token);
  }

  /** The Container started, by this request or one that arrived before it finished. */
  #started(): Promise<void> {
    this.#starting ??= this.#deps.start().finally(() => {
      this.#starting = undefined;
    });

    return this.#starting;
  }

  /** Whether the bridge answered its health within the poll's time, which one poll answers for every request. */
  #healthy(token: string): Promise<boolean> {
    if (this.#polling?.token !== token) {
      const answered = this.#poll(token).finally(() => {
        if (this.#polling?.answered === answered) this.#polling = undefined;
      });

      this.#polling = { token, answered };
    }

    return this.#polling.answered;
  }

  async #poll(token: string): Promise<boolean> {
    const { intervalMs, timeoutMs } = this.#deps.healthPoll();
    const until = this.#deps.now() + timeoutMs;
    const url = `http://localhost:${MCP_BRIDGE_PORT}${MCP_BRIDGE_HEALTH_PATH}`;

    for (;;) {
      try {
        const response = await this.#deps
          .port(MCP_BRIDGE_PORT)
          .fetch(url, { headers: { authorization: `Bearer ${token}` } });

        await response.body?.cancel();

        if (response.ok) {
          this.#verified = token;

          return true;
        }
      } catch {
        // Nothing listens yet.
      }

      if (this.#deps.now() + intervalMs > until) return false;

      await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  /** `request` as a use: the Container touched and held (it may write) until the response's body ends. */
  async #used(request: Request, token: string): Promise<Response> {
    const activity = this.#deps.activity();

    this.#deps.used();
    await activity.touch();

    const hold = activity.hold({ writes: true });
    let ended = false;

    const end = () => {
      if (ended) return;

      ended = true;
      hold.end().catch((cause: unknown) => {
        this.#deps.warn(`MCP bridge: ending a hold failed: ${String(cause)}`);
      });
    };

    try {
      await hold.begun;

      const response = await this.#forward(request, token);

      return this.#endingWith(response, end);
    } catch (cause) {
      end();

      throw cause;
    }
  }

  /** `response`, its body passed on as it comes, and `end` called once the body has ended, failed or been cancelled. */
  #endingWith(response: Response, end: () => void): Response {
    const upstream = response.body;

    if (upstream === null) {
      end();

      return response;
    }

    // Not `pipeTo`: a pipe notices its destination's cancel only when the next chunk comes, and a call that is quiet for
    // minutes must be cancelled at once, which tells the bridge to cancel the child's request. The writer's `closed`
    // fails as soon as the reader of the body is gone.
    const { readable: body, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const reader = upstream.getReader();

    writer.closed.catch(() => {
      end();
      reader.cancel().catch(() => undefined);
    });

    void (async () => {
      try {
        for (;;) {
          const chunk = await reader.read();

          if (chunk.done) {
            await writer.close();

            return;
          }

          await writer.write(chunk.value);
        }
      } catch (cause) {
        await writer.abort(cause).catch(() => undefined);
      } finally {
        end();
      }
    })();

    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  /** `request` to the bridge, as the bearer's holder. A bridge that cannot be reached answers 502. */
  async #forward(request: Request, token: string): Promise<Response> {
    const source = new URL(request.url);
    const headers = new Headers(request.headers);

    for (const name of DROPPED_HEADERS) headers.delete(name);

    headers.set("authorization", `Bearer ${token}`);

    try {
      return await this.#deps
        .port(MCP_BRIDGE_PORT)
        .fetch(`http://localhost:${MCP_BRIDGE_PORT}${source.pathname}${source.search}`, {
          method: request.method,
          headers,
          body: request.body,
          redirect: "manual",
        });
    } catch (cause) {
      this.#deps.warn(`MCP bridge: nothing answered on port ${MCP_BRIDGE_PORT}: ${String(cause)}`);

      return refusal(502, "bridge_unreachable", UNREACHABLE);
    }
  }
}
