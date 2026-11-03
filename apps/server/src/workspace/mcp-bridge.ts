// The Workspace DO's side of the Container MCP bridge (`docs/architecture/mcp-connections.md` → The stdio bridge, #382
// D5.1): a request the MCP engine made, which the Workspaces Worker's `WorkspaceMcpBridge` entrypoint hands here, and
// which is forwarded to the bridge in the Container (`getTcpPort(MCP_BRIDGE_PORT)`, as the Container previews are) with
// the bridge token as its bearer. The token is the launch's (`ContainerLaunch.bridgeToken`); it is added here and goes
// nowhere else: no caller is given it, no line logs it. The contract (the options, the refusals' codes, the header) is
// `@cloudpid/sandbox-image/mcp-bridge`'s, which the engine imports too.
//
// - A Workspace with no record of itself (a destroyed one: its storage is wiped) answers 404 `no_workspace`, and starts
//   no Container.
// - A stopped Container answers 503 `stopped` with `x-cloudpid-container: stopped` when `start` is false. With `start`
//   true it is started as a command starts it (`true`, which writes nothing, single-flight), and the bridge's health is
//   polled until it answers, since the supervisor starts the bridge beside computerd. A Container found running is
//   not polled, so a status check never waits for a bridge. A poll that fails is remembered for that launch: later
//   requests answer `bridge_unreachable` at once until a new launch (`container_restart`) has a token of its own.
// - `use: true` (a call, a prompt get, a read, a completion, discovery, an MCP task poll) is a use of the Container
//   (`IdleStop.touch`) and holds it, as a command that may write does (a stdio server may write the disk), until the
//   response's body ends, fails or is cancelled. `use: false` (the GET stream, listens, subscribe, bridge control) neither
//   touches nor holds. Neither is activity (`noteActivity`): an open session, an idle child, a stream and the server's own
//   messages are not uses, so a stdio server never keeps the Container awake between requests.
// - A bridge that does not answer (it exited, and nothing restarts it; the Container has none; or it refuses the launch's
//   token) answers 502 `bridge_unreachable`, which says that `container_restart` starts a new one.
// @effect-diagnostics asyncFunction:off globalTimers:off newPromise:off preferSchemaOverJson:off preferEffectRecord:off missingPipeableSignature:off
import {
  MCP_BRIDGE_CONTAINER_HEADER,
  MCP_BRIDGE_HEALTH_PATH,
  MCP_BRIDGE_PORT,
  type McpBridgeOptions,
  type McpBridgeRefusal,
} from "@cloudpid/sandbox-image/mcp-bridge";
import type { ContainerActivity } from "./idle.ts";

/** How often the bridge's health is polled after a start. */
export const MCP_BRIDGE_HEALTH_INTERVAL_MS = 250;

/** How long the bridge's health is polled after a start before it is taken for dead, inside the engine's 60 s. */
export const MCP_BRIDGE_HEALTH_TIMEOUT_MS = 15_000;

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
  /**
   * The bridge token of the launch that runs; undefined where there is none (a launch from before tokens were kept, or
   * one whose record is not saved yet). Asked again at each attempt of a poll, since a launch is recorded after the
   * platform has started the Container.
   */
  readonly token: () => Promise<string | undefined>;
  /** The Container's port `port`, as `ctx.container.getTcpPort` gives it. */
  readonly port: (port: number) => Fetcher;
  readonly activity: () => ContainerActivity;
  /** When the launch that runs was recorded (epoch milliseconds); undefined where there is no record. */
  readonly launchedAt: () => Promise<number | undefined>;
  readonly now: () => number;
  /** A request that is a use is a use of the Workspace (a spare's is no longer a spare). */
  readonly used: () => void;
  /** How the health is polled; the one seam for a test's timing. */
  readonly healthPoll: () => McpBridgeHealthPoll;
  readonly warn: (message: string) => void;
};

const STATUS: Record<McpBridgeRefusal, number> = {
  no_workspace: 404,
  stopped: 503,
  start_failed: 502,
  bridge_unreachable: 502,
  bridge_failed: 502,
};

const MESSAGE: Record<McpBridgeRefusal, string> = {
  no_workspace: "This Workspace does not exist",
  stopped: "The Workspace's Container is stopped",
  start_failed: "The Workspace's Container did not start",
  bridge_unreachable:
    "The Container's MCP bridge did not answer. If it has exited, `container_restart` starts a new one.",
  bridge_failed: "The Container's MCP bridge could not be reached",
};

/** The answer of `WorkspaceMcpBridge` itself, in place of the bridge's: every refusal is built here. */
export const mcpBridgeRefusal = (error: McpBridgeRefusal): Response => {
  const headers = new Headers({ "cache-control": "no-store" });

  if (error === "stopped") headers.set(MCP_BRIDGE_CONTAINER_HEADER, "stopped");

  return Response.json({ error, message: MESSAGE[error] }, { status: STATUS[error], headers });
};

/** A refusal of `request`, whose body nothing will read: cancelled, so the caller's stream is not left open. */
export const refuse = async (request: Request, code: McpBridgeRefusal): Promise<Response> => {
  await request.body?.cancel().catch(() => undefined);

  return mcpBridgeRefusal(code);
};

/** Headers not passed on: the host is the bridge's own, and the bearer is ours, whatever the caller put in its place. */
const DROPPED_HEADERS = ["host", "authorization"];

export class McpBridge {
  readonly #deps: McpBridgeDeps;
  /** The start in progress, so requests that arrive while it runs share it. */
  #starting: Promise<void> | undefined;
  /** The health poll in progress, so requests that arrive while it runs share it. */
  #polling: Promise<boolean> | undefined;
  /** The token of the launch whose health answered, which is asked once. */
  #verified: string | undefined;
  /** The token of the launch whose health poll failed: its bridge never answered, and answers at once until another launch. */
  #failed: string | undefined;

  constructor(deps: McpBridgeDeps) {
    this.#deps = deps;
  }

  /** Answer `request` from the Container's bridge. Anything unforeseen is the fallback refusal, `bridge_failed`. */
  async serve(request: Request, options: McpBridgeOptions): Promise<Response> {
    try {
      return await this.#serve(request, options);
    } catch (cause) {
      this.#deps.warn(`MCP bridge: the request failed: ${String(cause)}`);

      return refuse(request, "bridge_failed");
    }
  }

  async #serve(request: Request, options: McpBridgeOptions): Promise<Response> {
    if (!this.#deps.recorded()) return refuse(request, "no_workspace");

    let started = false;

    if (!this.#deps.running()) {
      if (!options.start) return refuse(request, "stopped");

      try {
        await this.#started();
      } catch (cause) {
        this.#deps.warn(`MCP bridge: the Container did not start: ${String(cause)}`);

        return refuse(request, "start_failed");
      }

      started = true;
    }

    // A Container this call started has its bridge a little after computerd: wait for it (and for the poll another call's
    // start began, which this call may have arrived in the middle of). So has one a command or `container_restart` has
    // only just started, whose launch is younger than the poll's time. Any other found running is not waited for.
    if (
      (started || this.#polling !== undefined || (await this.#launchedRecently())) &&
      !(await this.#healthy())
    ) {
      return refuse(request, "bridge_unreachable");
    }

    const token = await this.#deps.token();

    // A Container launched before tokens were kept runs no bridge, and gets one from its next launch; one whose bridge
    // never answered stays unreachable until it does.
    if (token === undefined || token === this.#failed) {
      return refuse(request, "bridge_unreachable");
    }

    return options.use ? this.#used(request, token) : this.#forward(request, token);
  }

  /** Whether the launch that runs is younger than the poll's time, and not one whose bridge has answered or failed already. */
  async #launchedRecently(): Promise<boolean> {
    const [token, launchedAt] = await Promise.all([this.#deps.token(), this.#deps.launchedAt()]);

    if (token === undefined || launchedAt === undefined) return false;

    if (token === this.#verified || token === this.#failed) return false;

    return this.#deps.now() - launchedAt < this.#deps.healthPoll().timeoutMs;
  }

  /** The Container started, by this request or one that arrived before it finished. */
  #started(): Promise<void> {
    this.#starting ??= this.#deps.start().finally(() => {
      this.#starting = undefined;
    });

    return this.#starting;
  }

  /** Whether the bridge answered its health within the poll's time, which one poll answers for every request. */
  #healthy(): Promise<boolean> {
    this.#polling ??= this.#poll().finally(() => {
      this.#polling = undefined;
    });

    return this.#polling;
  }

  /**
   * Poll the health until it answers or the poll's time has passed, counted in attempts. The token is read again at
   * each attempt, since the launch is recorded after the platform has started the Container. A poll that fails
   * remembers the launch it failed for.
   */
  async #poll(): Promise<boolean> {
    const { intervalMs, timeoutMs } = this.#deps.healthPoll();
    const attempts = Math.max(1, Math.ceil(timeoutMs / intervalMs));
    const url = `http://localhost:${MCP_BRIDGE_PORT}${MCP_BRIDGE_HEALTH_PATH}`;

    let last: string | undefined;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      const token = await this.#deps.token();

      last = token ?? last;

      if (token !== undefined) {
        try {
          const response = await this.#deps.port(MCP_BRIDGE_PORT).fetch(url, {
            headers: { authorization: `Bearer ${token}` },
            // An attempt takes no longer than the interval, so the attempts bound the poll's time.
            signal: AbortSignal.timeout(intervalMs),
          });

          await response.body?.cancel();

          if (response.ok) {
            this.#verified = token;

            return true;
          }
        } catch {
          // Nothing listens yet.
        }
      }

      if (attempt < attempts) await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
    }

    this.#failed = last;

    return false;
  }

  /** `request` as a use: the Container touched and held (it may write) until the response's body ends. */
  async #used(request: Request, token: string): Promise<Response> {
    const activity = this.#deps.activity();

    this.#deps.used();

    // A hold that fails to be recorded only shortens the idle time (`ContainerHold`): the request goes on.
    await activity.touch().catch((cause: unknown) => {
      this.#deps.warn(`MCP bridge: touching the Container failed: ${String(cause)}`);
    });

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
      await hold.begun.catch((cause: unknown) => {
        this.#deps.warn(`MCP bridge: beginning a hold failed: ${String(cause)}`);
      });

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

    // An upstream that fails is read as such below; its `closed` is not a second report of it.
    reader.closed.catch(() => undefined);

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

    let response: Response;

    try {
      response = await this.#deps
        .port(MCP_BRIDGE_PORT)
        .fetch(`http://localhost:${MCP_BRIDGE_PORT}${source.pathname}${source.search}`, {
          method: request.method,
          headers,
          body: request.body,
          redirect: "manual",
        });
    } catch (cause) {
      this.#deps.warn(`MCP bridge: nothing answered on port ${MCP_BRIDGE_PORT}: ${String(cause)}`);

      return mcpBridgeRefusal("bridge_unreachable");
    }

    // The token is the launch's, so a bridge that refuses it is another launch's (or not ours): as good as none.
    if (response.status === 401) {
      await response.body?.cancel().catch(() => undefined);

      return mcpBridgeRefusal("bridge_unreachable");
    }

    return response;
  }
}
