/**
 * A stdio server reached through the Container bridge (`docs/architecture/mcp-connections.md` → The stdio bridge,
 * Failures and cuts; #382 D5): the `fetch` the core is given for a stdio target, which hands each request to the
 * Workspaces Worker's `WorkspaceMcpBridge` (`MCP_BRIDGE`), and what the engine does with what comes back.
 *
 * - **Every response must be the bridge's:** it carries `x-cloudpid-bridge: <level>`. One below `MCP_BRIDGE_MIN_LEVEL`
 *   (or with none) fails the call as `Unsupported`, "this Container runs an older bridge; restart it", which the host reads as the
 *   server being `failed`. A response without a level is `WorkspaceMcpBridge`'s own refusal (`{ error, message }`) or an
 *   older bridge's.
 * - **Refusals** (`McpBridgeRefusal`) are thrown as the core's failures, which its tap believes: `no_workspace` as
 *   `Unreachable` with status 404, `stopped`, `start_failed` and `bridge_unreachable` as `Unreachable` with none (the request
 *   never reached the server), and `bridge_failed`, or a code this build does not know, as `Unreachable` with status 502,
 *   which may have run.
 * - **A cut is named** from the bridge's status, asked with `start: false` so it never starts a Container: "Container
 *   stopped", "stdio server exited (code or signal)" with the last 2 KiB of its stderr, or the cut as it was.
 * - **The spawn id** of the last response about the child (`x-cloudpid-spawn`) goes back to the host, which learns of a
 *   restart from it.
 * - **Uses:** a POST is a use of the Container and may start it when the target says `start`; a GET (the Legacy stream) never does either.
 *   A listen's connection is `quiet`: none of its requests is a use or starts a Container, a POST included
 *   (`docs/architecture/mcp-in-a-session.md` → Resource watches, Stdio).
 */
// @effect-diagnostics asyncFunction:off globalFetch:off newPromise:off globalJsonInEffect:off missingPipeableSignature:off preferEffectArray:off globalTimers:off -- the bridge is reached with Promises, over Requests and Responses, and a status read is bounded by a timer.
import type { McpDeps } from "@cloudpid/mcp";
import {
  Cut,
  MCP_CONTAINER_STOPPED_CUT,
  type McpEngineStdioTarget,
  Unreachable,
  Unsupported,
} from "@cloudpid/mcp/types";
import {
  MCP_BRIDGE_CONFIG_HEADER,
  MCP_BRIDGE_CONTAINER_HEADER,
  MCP_BRIDGE_ERA_HEADER,
  MCP_BRIDGE_LEVEL_HEADER,
  MCP_BRIDGE_MCP_PATH,
  MCP_BRIDGE_SPAWN_HEADER,
  MCP_BRIDGE_STATUS_PATH,
  type McpBridgeConfig,
  mcpBridgeConfigHeader,
  mcpBridgeKey,
  mcpBridgeRefusalCode,
} from "@cloudpid/sandbox-image/mcp-bridge";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { Mutable } from "effect/Types";
import type { McpBridgeBinding } from "./binding.ts";

/**
 * The lowest bridge level the engine talks to. It rises, at least 7 days after the image that carries the new level
 * reached prod, when a change of the bridge's wire contract has to be told from an older bridge
 * (`docs/architecture/mcp.md` → Deploys).
 */
export const MCP_BRIDGE_MIN_LEVEL = 1;

/** What a server on a bridge that is below the minimum fails with. */
export const OLD_BRIDGE_MESSAGE = "this Container runs an older bridge; restart it";

/** The URL the core connects a stdio server at: the binding takes the request whatever its origin is. */
const BRIDGE_ORIGIN = "https://container.bridge.invalid";

export const STDIO_URL = `${BRIDGE_ORIGIN}${MCP_BRIDGE_MCP_PATH}`;

/** How long a probe or an `initialize` may take through the bridge: the Container may start and the server spawn (60 s). */
export const STDIO_CONNECT_TIMEOUT_MS = 60_000;

/** How long the status read that names a cut may take. */
const STATUS_TIMEOUT_MS = 5_000;

/** The most of a child's stderr a cut quotes: the end of it. */
const STDERR_QUOTE_BYTES = 2_048;

type FetchLike = McpDeps["fetch"];

/** The bridge's config for a stdio target. */
export const configOf = (target: McpEngineStdioTarget): McpBridgeConfig => {
  const config: Mutable<McpBridgeConfig> = { command: target.command };

  if (target.args !== undefined) config.args = target.args;

  if (target.env !== undefined) config.env = target.env;

  if (target.cwd !== undefined) config.cwd = target.cwd;

  return config;
};

const oldBridge = () => Unsupported.make({ message: OLD_BRIDGE_MESSAGE });

const levelOf = (response: Response): number | undefined => {
  const header = response.headers.get(MCP_BRIDGE_LEVEL_HEADER);
  const level = header === null ? Number.NaN : Number(header);

  return Number.isInteger(level) ? level : undefined;
};

/** What a refusal of `WorkspaceMcpBridge` is to the core: the failure for its code. */
const refusalOf = (code: string | undefined, message: string | undefined) => {
  const said = message === undefined || message === "" ? undefined : message;

  switch (mcpBridgeRefusalCode(code)) {
    case "no_workspace":
      return Unreachable.make({ message: "The Workspace no longer exists", status: 404 });
    case "stopped":
      return Unreachable.make({
        message: said ?? "The Workspace's Container is stopped",
        stopped: true,
      });
    case "start_failed":
      return Unreachable.make({ message: said ?? "The Workspace's Container did not start" });
    case "bridge_unreachable":
      return Unreachable.make({ message: said ?? "The Container's MCP bridge does not answer" });
    case "bridge_failed":
      return Unreachable.make({
        message: said ?? "The Container's MCP bridge failed",
        status: 502,
      });
  }
};

/** `WorkspaceMcpBridge`'s refusal as it is written: `{ error, message }`. */
const Refusal = Schema.Struct({ error: Schema.String, message: Schema.optionalKey(Schema.String) });

const decodeRefusal = Schema.decodeUnknownOption(Schema.fromJsonString(Refusal));

/** A response with no bridge level: `WorkspaceMcpBridge`'s refusal if it reads as one, else an older bridge's. */
const oldOrRefused = async (response: Response) => {
  const text = await response.text().catch(() => "");
  const refusal = response.ok ? Option.none() : decodeRefusal(text);

  return Option.match(refusal, {
    onNone: oldBridge,
    onSome: ({ error, message }) => refusalOf(error, message),
  });
};

/** `response` with a body that fails when `signal` aborts, as a `fetch`'s does; the call's abort reaches the stream. */
const abortable = (response: Response, signal: AbortSignal | null | undefined) => {
  if (signal === null || signal === undefined || response.body === null) return response;

  return new Response(response.body.pipeThrough(new TransformStream(), { signal }), response);
};

/** `work`, but settled with the signal's reason once it aborts; what `work` gives after that is dropped, its body cancelled. */
const raceAbort = (work: Promise<Response>, signal: AbortSignal | null | undefined) => {
  if (signal === null || signal === undefined) return work;

  return new Promise<Response>((resolve, reject) => {
    const abort = () => reject(signal.reason);

    if (signal.aborted) abort();

    signal.addEventListener("abort", abort, { once: true });

    work.then(
      (response) => {
        signal.removeEventListener("abort", abort);

        if (signal.aborted) void response.body?.cancel().catch(() => undefined);
        else resolve(response);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
};

/** The bridge's status (`GET /_bridge/status`) as far as naming a cut reads it: each child's key, state, exit and stderr. */
const Status = Schema.Struct({
  children: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      state: Schema.String,
      stderrTail: Schema.optionalKey(Schema.String),
      exit: Schema.optionalKey(
        Schema.Struct({
          code: Schema.Finite.pipe(Schema.NullOr, Schema.optionalKey),
          signal: Schema.String.pipe(Schema.NullOr, Schema.optionalKey),
          error: Schema.optionalKey(Schema.String),
        }),
      ),
    }),
  ),
});

type StatusChild = (typeof Status.Type)["children"][number];

const decodeStatus = Schema.decodeUnknownOption(Status);

const NEWLINE = 0x0a;

/** Takes the secrets a call keeps out of `text`. */
type Scrub = (text: string) => string;

/**
 * The end of `tail` a cut quotes: `tail` scrubbed whole first (a secret cut by the quote's start would not be found), then
 * its last `STDERR_QUOTE_BYTES`, cut on a character and, when the cut falls inside a line, from the next line on (the
 * slice as it is when no line follows).
 */
const quoted = (tail: string, scrub: Scrub) => {
  const bytes = new TextEncoder().encode(scrub(tail));

  if (bytes.byteLength <= STDERR_QUOTE_BYTES) return new TextDecoder().decode(bytes).trim();

  const from = bytes.byteLength - STDERR_QUOTE_BYTES;
  const slice = new TextDecoder().decode(bytes.slice(from));
  const whole = slice.trim();

  if (bytes[from - 1] === NEWLINE) return whole;

  // The cut fell inside a line: quote from the next one, unless that leaves nothing (one long last line).
  const nextLines = slice.slice(slice.indexOf("\n") + 1).trim();

  return slice.includes("\n") && nextLines !== "" ? nextLines : whole;
};

/** How an exited child is named: its code or signal, and the end of its stderr. */
const exitedAs = (child: StatusChild, scrub: Scrub) => {
  const { exit } = child;

  const how =
    exit?.error !== undefined
      ? exit.error
      : exit?.signal !== undefined && exit.signal !== null
        ? `signal ${exit.signal}`
        : `code ${exit?.code ?? "unknown"}`;

  const tail = child.stderrTail === undefined ? "" : quoted(child.stderrTail, scrub);

  return tail === ""
    ? `stdio server exited (${how})`
    : `stdio server exited (${how}); its stderr ended:\n${tail}`;
};

/** What a stdio call goes through: the `fetch` for the core, the child's spawn id, and the naming of a cut. */
export interface StdioBridge {
  readonly fetch: FetchLike;
  /** The spawn id the last response about the child carried. */
  readonly spawn: () => string | undefined;
  /** `cut` with what the bridge's status (`start: false`) says ended the call, or as it was when the status says nothing more. */
  readonly explainCut: (cut: Cut) => Promise<Cut>;
}

/** The bridge of `target`'s Workspace for one call, from the era row's hint (`legacy` or `modern`) if it has one. */
export const stdioBridge = (
  binding: McpBridgeBinding,
  target: McpEngineStdioTarget,
  era: "legacy" | "modern" | undefined,
  scrub: Scrub,
  quiet = false,
): StdioBridge => {
  const config = configOf(target);
  const header = mcpBridgeConfigHeader(config);
  let spawn: string | undefined;

  /** The bridge's answer to `request`, vetted: its own, at or above the minimum level, or a failure. */
  const vetted = async (response: Response) => {
    const level = levelOf(response);

    if (level === undefined) throw await oldOrRefused(response);

    if (level < MCP_BRIDGE_MIN_LEVEL) {
      void response.body?.cancel().catch(() => undefined);

      throw oldBridge();
    }

    spawn = response.headers.get(MCP_BRIDGE_SPAWN_HEADER) ?? spawn;

    return response;
  };

  const fetch: FetchLike = async (input, init) => {
    const sent = new Request(input, init);
    const headers = new Headers(sent.headers);

    headers.set(MCP_BRIDGE_CONFIG_HEADER, header);

    if (era !== undefined) headers.set(MCP_BRIDGE_ERA_HEADER, era);

    // A signal cannot cross RPC: the request goes without one, and the abort is honoured here.
    const forwarded = new Request(sent.url, {
      method: sent.method,
      headers,
      body: sent.body,
    });

    const post = sent.method === "POST" && !quiet;

    const answered = binding.mcpBridge(target.workspace, forwarded, {
      start: post && target.start,
      use: post,
    });

    const response = await raceAbort(answered, init?.signal);

    return abortable(await vetted(response), init?.signal);
  };

  const status = async (): Promise<Cut | undefined> => {
    const response = await binding.mcpBridge(
      target.workspace,
      new Request(`${BRIDGE_ORIGIN}${MCP_BRIDGE_STATUS_PATH}`),
      { start: false, use: false },
    );

    if (response.headers.get(MCP_BRIDGE_CONTAINER_HEADER) === "stopped") {
      void response.body?.cancel().catch(() => undefined);

      return Cut.make({ message: MCP_CONTAINER_STOPPED_CUT, mayHaveRun: true });
    }

    if (levelOf(response) === undefined || !response.ok) {
      void response.body?.cancel().catch(() => undefined);

      return undefined;
    }

    const body: unknown = await response.json();

    const children = Option.match(decodeStatus(body), {
      onNone: () => [],
      onSome: (status) => status.children,
    });

    const key = await mcpBridgeKey(config);
    const child = Arr.findFirst(children, (each) => each.key === key);

    return Option.isSome(child) &&
      (child.value.state === "exited" || child.value.exit !== undefined)
      ? Cut.make({ message: exitedAs(child.value, scrub), mayHaveRun: true })
      : undefined;
  };

  return {
    fetch,
    spawn: () => spawn,
    explainCut: async (cut) => {
      const timeout = new Promise<undefined>((resolve) => {
        setTimeout(() => resolve(undefined), STATUS_TIMEOUT_MS);
      });

      const ended = await Promise.race([status().catch(() => undefined), timeout]);

      // The status knows what ended the call, not whether the server had run it: that is the cut's own.
      return ended === undefined
        ? cut
        : Cut.make({ message: ended.message, mayHaveRun: cut.mayHaveRun });
    },
  };
};
