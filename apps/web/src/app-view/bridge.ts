// docs/architecture/mcp-apps.md → The bridge. cloudpid's own small bridge to an App View, on ext-apps' `spec.types.ts` wire
// types (`import type` only: nothing of ext-apps' host code is bundled). It speaks JSON-RPC over `postMessage` to the
// sandbox's proxy frame: the proxy announces itself, the page sends the HTML, the View initializes, and the host then
// sends `tool-input`, `tool-result` or `tool-cancelled`, `host-context-changed` as it changes, and a teardown request before
// the frame goes. It knows nothing of React, the DOM or the Session socket: the window it posts to and the messages it is
// handed are injected, so a fake iframe tests it (`bridge.test.ts`).
//
// Security is its own concern: a message counts only when it comes from the proxy frame's window and from the sandbox
// origin, both; the bridge posts to that origin only, never `"*"`; and it answers a View's request only through a handler it
// was given, `-32601` for any other method.
/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type, anti-slop/no-known-value-widening -- the bridge is where a View's `postMessage` data is decoded (`receive`, against `Envelope`); the `params` of a request are the View's own JSON, which the handler that serves the method decodes, and a JSON-RPC message of the host's is posted as it is built */
// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off preferEffectRecord:off extendsNativeError:off globalTimers:off newPromise:off -- a
// synchronous state machine over `postMessage` events: its queue is a native array mutated in place, its two timers
// (the View's 10 s, the teardown's 2 s) and its promise are the browser's, and `RpcError` is a JSON-RPC error, never an
// Effect failure.
import type {
  McpUiHostCapabilities,
  McpUiHostContext,
  McpUiHostContextChangedNotification,
  McpUiInitializeRequest,
  McpUiInitializeResult,
  McpUiInitializedNotification,
  McpUiResourcePermissions,
  McpUiRequestDisplayModeRequest,
  McpUiResourceCsp,
  McpUiResourceTeardownRequest,
  McpUiSandboxProxyReadyNotification,
  McpUiSandboxResourceReadyNotification,
  McpUiSizeChangedNotification,
  McpUiToolCancelledNotification,
  McpUiToolInputNotification,
  McpUiToolInputPartialNotification,
  McpUiToolResultNotification,
} from "@modelcontextprotocol/ext-apps";
import {
  MCP_APP_INTERNAL_ERROR,
  MCP_APP_INVALID_PARAMS,
  MCP_APP_METHOD_NOT_FOUND,
} from "@cloudpid/protocol";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Types from "effect/Types";

// Each method is typed by the spec's own literal, so a rename in ext-apps breaks the build here.
const PROXY_READY =
  "ui/notifications/sandbox-proxy-ready" satisfies McpUiSandboxProxyReadyNotification["method"];

const RESOURCE_READY =
  "ui/notifications/sandbox-resource-ready" satisfies McpUiSandboxResourceReadyNotification["method"];

const INITIALIZE = "ui/initialize" satisfies McpUiInitializeRequest["method"];
const INITIALIZED = "ui/notifications/initialized" satisfies McpUiInitializedNotification["method"];

const SIZE_CHANGED =
  "ui/notifications/size-changed" satisfies McpUiSizeChangedNotification["method"];

const TOOL_INPUT = "ui/notifications/tool-input" satisfies McpUiToolInputNotification["method"];

const TOOL_INPUT_PARTIAL =
  "ui/notifications/tool-input-partial" satisfies McpUiToolInputPartialNotification["method"];

const TOOL_RESULT = "ui/notifications/tool-result" satisfies McpUiToolResultNotification["method"];

const TOOL_CANCELLED =
  "ui/notifications/tool-cancelled" satisfies McpUiToolCancelledNotification["method"];

const HOST_CONTEXT_CHANGED =
  "ui/notifications/host-context-changed" satisfies McpUiHostContextChangedNotification["method"];

const RESOURCE_TEARDOWN = "ui/resource-teardown" satisfies McpUiResourceTeardownRequest["method"];

/** The View's log line (MCP's `notifications/message`), which goes to `options.logs` and nowhere else. */
const LOG_MESSAGE = "notifications/message";

const REQUEST_DISPLAY_MODE =
  "ui/request-display-mode" satisfies McpUiRequestDisplayModeRequest["method"];

/** The MCP Apps revision cloudpid hosts (`docs/architecture/mcp-apps.md` → Declaring and reading Apps); ext-apps' `LATEST_PROTOCOL_VERSION`. */
export const MCP_APPS_PROTOCOL_VERSION = "2026-01-26";

/** How long a View has to send `ui/initialize` once it is mounted (`docs/architecture/mcp-apps.md` → Lifecycle: Load failure). */
export const INITIALIZE_TIMEOUT_MS = 10_000;

/** How long a teardown waits for the View's answer before the frame goes anyway (`docs/architecture/mcp-apps.md` → App Views in the transcript: Teardown). */
export const TEARDOWN_TIMEOUT_MS = 2000;

/** What the page's `window` gives a message: the window it came from, the origin of that window's document, and the data. */
export interface IncomingMessage {
  readonly source: unknown;
  readonly origin: string;
  readonly data: unknown;
}

/** The proxy frame's window, which the bridge posts to. */
export interface FrameWindow {
  readonly postMessage: (message: unknown, targetOrigin: string) => void;
}

/** JSON-RPC's implementation-defined error that answers a request the host would not take: a refusal that is no fault of the View's. */
export const HOST_REFUSED = -32000;

/** A failure a handler answers a View's request with, as JSON-RPC does: its `code` and `message`. */
export class RpcError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = "RpcError";
    this.code = code;
  }
}

/** A handler of one of a View's requests: its `params` as the View sent them, and a signal that aborts at teardown. */
export type RequestHandler = (
  params: unknown,
  context: { readonly signal: AbortSignal },
) => Promise<unknown>;

/** What the bridge tells its owner. */
export type BridgeEvent =
  /** The View sent `ui/initialize` and then `initialized`: it takes the tool's notifications now. */
  | { readonly type: "ready" }
  /** The View's `size-changed`: its content's size in CSS pixels, whichever it sent. */
  | { readonly type: "size"; readonly width?: number; readonly height?: number }
  /** The View did not come up: why, as the card says it ("App couldn't load: …"). */
  | { readonly type: "failed"; readonly reason: string }
  /** A message that was not the proxy frame's at the sandbox origin, or not a message of the protocol, and was dropped. */
  | { readonly type: "rejected"; readonly reason: string };

export interface BridgeOptions {
  /** The proxy frame's window: the only source a message may come from. */
  readonly frame: FrameWindow;
  /** The sandbox origin the proxy frame is at: the only origin a message may come from, and the only one posted to. */
  readonly origin: string;
  /** Subscribe to the page's `message` events; returns the unsubscribe. */
  readonly listen: (handler: (message: IncomingMessage) => void) => () => void;
  /**
   * What `sandbox-resource-ready` carries: the View's HTML, the CSP it declared (which the proxy's header already enforces)
   * and the browser permissions it declared, which the proxy puts on its inner frame's `allow` (`apps/app-sandbox`).
   */
  readonly page: {
    readonly html: string;
    readonly csp?: McpUiResourceCsp;
    readonly permissions?: McpUiResourcePermissions;
  };
  /** The host's context as it is now, which `ui/initialize` is answered with. */
  readonly hostContext: () => McpUiHostContext;
  readonly capabilities: McpUiHostCapabilities;
  readonly hostInfo: { readonly name: string; readonly version: string };
  /** Handlers of a View's requests, by method: the seam the tickets that serve more of them plug into. */
  readonly handlers?: Readonly<Record<string, RequestHandler>> | undefined;
  /** The `params` of each `notifications/message` the View sends, for telemetry (`requests.ts`); dropped when there is none. */
  readonly logs?: ((params: unknown) => void) | undefined;
  readonly onEvent: (event: BridgeEvent) => void;
}

export interface Bridge {
  /** Begin listening and wait for the proxy: the 10 s for `ui/initialize` run from here. */
  readonly start: () => void;
  /**
   * `tool-input-partial`, the latest arguments so far (`docs/architecture/mcp-apps.md` → Lifecycle). Held until the View is
   * ready, and then only the latest of the held ones is sent; none after `tool-input`, `tool-result` or `tool-cancelled`.
   */
  readonly toolInputPartial: (args: Readonly<Record<string, unknown>>) => void;
  /** `tool-input`, once, with the final arguments. */
  readonly toolInput: (args: Readonly<Record<string, unknown>>) => void;
  /** `tool-result` with the call's whole result, an `isError` one too. Once. */
  readonly toolResult: (result: McpUiToolResultNotification["params"]) => void;
  /** `tool-cancelled`: Stop, a timeout, an eviction or a cut ended the call. Once. */
  readonly toolCancelled: (reason?: string) => void;
  /** `host-context-changed` with only what changed. */
  readonly hostContextChanged: (change: McpUiHostContext) => void;
  /**
   * Send `ui/resource-teardown` and wait for its answer for at most {@link TEARDOWN_TIMEOUT_MS}, then close; the in-flight
   * requests' signals abort. Resolves when the frame may go.
   */
  readonly teardown: () => Promise<void>;
  /** Stop listening, abort the in-flight requests and drop what is queued; nothing is posted after it. */
  readonly close: () => void;
}

const RpcId = Schema.Union([Schema.String, Schema.Finite]);

/** A JSON-RPC 2.0 message of either direction: a request or notification (`method`), or a response (`result` or `error`). */
const Envelope = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.optionalKey(RpcId),
  method: Schema.optionalKey(Schema.String),
  params: Schema.optionalKey(Schema.Unknown),
  result: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.Struct({ code: Schema.Finite, message: Schema.String })),
});

const decodeEnvelope = Schema.decodeUnknownOption(Envelope);

/** What `ui/initialize` and `size-changed` carry that the bridge reads; the rest is the View's own. */
const decodeInitialize = Schema.decodeUnknownOption(
  Schema.Struct({ protocolVersion: Schema.String }),
);

const decodeSize = Schema.decodeUnknownOption(
  Schema.Struct({
    width: Schema.optionalKey(Schema.Finite),
    height: Schema.optionalKey(Schema.Finite),
  }),
);

/** A notification the host sends after the View's `initialized`, held until then. */
type Notification = { readonly method: string; readonly params: unknown };

export const createBridge = (options: BridgeOptions): Bridge => {
  const { frame, origin } = options;

  let stop: (() => void) | undefined;
  let closed = false;
  let proxyReady = false;
  let initialized = false;
  let initializeTimer: ReturnType<typeof setTimeout> | undefined;
  let nextId = 1;
  let queue: Notification[] = [];
  let tearing: Promise<void> | undefined;
  // What the View was told of the call: each of its final input, its result and its cancellation at most once.
  let inputSent = false;
  let resultSent = false;
  let cancelSent = false;

  const aborts = new AbortController();
  const pending = new Map<string | number, (answer: { readonly ok: boolean }) => void>();

  /** Every post goes to the sandbox origin, never to `"*"`. */
  const post = (message: unknown): void => {
    if (!closed) frame.postMessage(message, origin);
  };

  const notify = (method: string, params: unknown): void => {
    post({ jsonrpc: "2.0", method, params });
  };

  const fail = (reason: string): void => {
    if (closed || initialized) return;

    clearTimeout(initializeTimer);
    options.onEvent({ type: "failed", reason });
  };

  /** Held until the View is ready, in order, and sent at once after. */
  const send = (method: string, params: unknown): void => {
    if (closed) return;

    if (initialized) notify(method, params);
    else queue.push({ method, params });
  };

  const respond = (
    id: string | number,
    body: { readonly result: unknown } | { readonly error: RpcError },
  ): void => {
    if ("error" in body) {
      post({ jsonrpc: "2.0", id, error: { code: body.error.code, message: body.error.message } });
    } else {
      post({ jsonrpc: "2.0", id, result: body.result });
    }
  };

  const builtIns: Readonly<Record<string, RequestHandler>> = {
    [INITIALIZE]: (params) => {
      const asked = decodeInitialize(params);

      if (Option.isNone(asked)) {
        return Promise.reject(
          new RpcError(MCP_APP_INVALID_PARAMS, "ui/initialize needs a protocolVersion"),
        );
      }

      const result: McpUiInitializeResult = {
        protocolVersion: MCP_APPS_PROTOCOL_VERSION,
        hostInfo: options.hostInfo,
        hostCapabilities: options.capabilities,
        hostContext: options.hostContext(),
      };

      return Promise.resolve(result);
    },
    ping: () => Promise.resolve({}),
    // Only the inline display mode is offered here: the answer is the mode that is set, whichever was asked (`pip` is
    // refused the same way); the App Pane's fullscreen is a handler the Pane's ticket supplies.
    [REQUEST_DISPLAY_MODE]: () =>
      Promise.resolve({ mode: options.hostContext().displayMode ?? "inline" }),
  };

  // Own properties only: a View chooses the method, and `constructor`, `toString` and `__proto__` are on every object.
  const ownHandler = (
    handlers: Readonly<Record<string, RequestHandler>> | undefined,
    method: string,
  ): RequestHandler | undefined =>
    handlers !== undefined && Object.hasOwn(handlers, method) ? handlers[method] : undefined;

  const handlerOf = (method: string): RequestHandler | undefined =>
    ownHandler(options.handlers, method) ?? ownHandler(builtIns, method);

  const ready = (): void => {
    if (initialized || closed) return;

    initialized = true;
    clearTimeout(initializeTimer);

    const held = queue;

    queue = [];

    options.onEvent({ type: "ready" });

    for (const each of held) notify(each.method, each.params);
  };

  const onRequest = (id: string | number, method: string, params: unknown): void => {
    const handler = handlerOf(method);

    if (handler === undefined) {
      respond(id, { error: new RpcError(MCP_APP_METHOD_NOT_FOUND, `Method not found: ${method}`) });

      return;
    }

    handler(params, { signal: aborts.signal }).then(
      (result) => {
        respond(id, { result });
      },
      (error: unknown) => {
        respond(id, {
          error:
            error instanceof RpcError
              ? error
              : new RpcError(MCP_APP_INTERNAL_ERROR, "The host could not answer"),
        });
      },
    );
  };

  const onNotification = (method: string, params: unknown): void => {
    if (method === INITIALIZED) {
      // Only after the View asked to initialize and was answered: a notification out of turn is not the handshake.
      if (initializeAnswered) ready();

      return;
    }

    if (method === SIZE_CHANGED) {
      const size = decodeSize(params);

      if (Option.isSome(size)) options.onEvent({ type: "size", ...size.value });
    }

    if (method === LOG_MESSAGE) {
      options.logs?.(params);

      return;
    }

    // Any other notification is nothing the host serves yet; it is dropped.
  };

  let initializeAnswered = false;

  const receive = (message: IncomingMessage): void => {
    if (closed) return;

    // Both: the proxy frame's window, and the sandbox's origin. Either alone can be forged by another frame or window.
    if (message.source !== frame) {
      options.onEvent({ type: "rejected", reason: "not the proxy frame" });

      return;
    }

    if (message.origin !== origin) {
      options.onEvent({ type: "rejected", reason: `from ${message.origin}, not the sandbox` });

      return;
    }

    const decoded = decodeEnvelope(message.data);

    if (Option.isNone(decoded)) {
      options.onEvent({ type: "rejected", reason: "not a JSON-RPC message" });

      return;
    }

    const { id, method, params, error } = decoded.value;

    if (method === undefined) {
      // A response to a request of the host's: the teardown's.
      if (id !== undefined) {
        const waiting = pending.get(id);

        pending.delete(id);
        waiting?.({ ok: error === undefined });
      }

      return;
    }

    if (method === PROXY_READY) {
      if (proxyReady) return;

      proxyReady = true;

      const { csp, permissions } = options.page;

      const resource: Types.Mutable<McpUiSandboxResourceReadyNotification["params"]> = {
        html: options.page.html,
      };

      if (csp !== undefined) resource.csp = csp;

      if (permissions !== undefined) resource.permissions = permissions;

      notify(RESOURCE_READY, resource);

      return;
    }

    // Nothing from the View counts before the proxy has been given its page: the View does not exist until then.
    if (!proxyReady) {
      options.onEvent({ type: "rejected", reason: `${method} before the proxy was ready` });

      return;
    }

    if (id === undefined) {
      onNotification(method, params);

      return;
    }

    if (method === INITIALIZE) {
      initializeAnswered = true;
      clearTimeout(initializeTimer);
    }

    onRequest(id, method, params);
  };

  const close = (): void => {
    if (closed) return;

    closed = true;
    clearTimeout(initializeTimer);
    stop?.();
    aborts.abort();
    queue = [];

    for (const waiting of pending.values()) waiting({ ok: false });

    pending.clear();
  };

  return {
    start: () => {
      if (stop !== undefined || closed) return;

      stop = options.listen(receive);

      initializeTimer = setTimeout(() => {
        fail(
          proxyReady
            ? "The App did not start within 10 seconds"
            : "The App sandbox did not answer within 10 seconds",
        );
      }, INITIALIZE_TIMEOUT_MS);
    },
    toolInputPartial: (args) => {
      // Only before the final input, and of those the View has not been told yet only the latest.
      if (inputSent || resultSent || cancelSent) return;

      queue = queue.filter((held) => held.method !== TOOL_INPUT_PARTIAL);
      send(TOOL_INPUT_PARTIAL, { arguments: args });
    },
    toolInput: (args) => {
      if (inputSent) return;

      inputSent = true;
      send(TOOL_INPUT, { arguments: args });
    },
    toolResult: (result) => {
      if (resultSent) return;

      resultSent = true;
      send(TOOL_RESULT, result);
    },
    toolCancelled: (reason) => {
      // Once: the card says it when the call ends, and its teardown asks again.
      if (cancelSent) return;

      cancelSent = true;
      send(TOOL_CANCELLED, reason === undefined ? {} : { reason });
    },
    hostContextChanged: (change) => {
      send(HOST_CONTEXT_CHANGED, change);
    },
    // Once: a second call, while the first waits for its answer, waits for the same one.
    teardown: () =>
      (tearing ??= new Promise<void>((resolve) => {
        if (closed || !initialized) {
          close();
          resolve();

          return;
        }

        const id = nextId++;

        const timer = setTimeout(() => {
          pending.delete(id);
          close();
          resolve();
        }, TEARDOWN_TIMEOUT_MS);

        pending.set(id, () => {
          clearTimeout(timer);
          close();
          resolve();
        });

        post({ jsonrpc: "2.0", id, method: RESOURCE_TEARDOWN, params: {} });
      })),
    close,
  };
};

/**
 * End a View's life the way the spec asks of a host that is about to remove its frame: `tool-cancelled` first when the call
 * did not finish (`cancelled` is its reason), then `ui/resource-teardown`, waited for at most {@link TEARDOWN_TIMEOUT_MS}.
 * Resolves when the frame may go; the owner removes the frame only then.
 */
export const retire = (bridge: Bridge, cancelled?: string): Promise<void> => {
  if (cancelled !== undefined) bridge.toolCancelled(cancelled);

  return bridge.teardown();
};
