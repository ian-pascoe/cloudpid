// docs/architecture/mcp-apps.md → The bridge. cloudpid's own small bridge to an App View: the frame protocol it speaks
// (`sandbox-frame/frame-protocol.ts`, shared with Visuals: the handshake, the source and origin checks, the 10 s start, the
// teardown, the queue until the View is ready and the handler seam) and what an App View is told of its tool call, on
// ext-apps' `spec.types.ts` wire types (`import type` only). After the handshake the host sends `tool-input-partial`,
// `tool-input`, `tool-result` or `tool-cancelled`, each at most as the spec allows, and `host-context-changed` as it
// changes. It knows nothing of React, the DOM or the Session socket: the window it posts to and the messages it is handed
// are injected, so a fake iframe tests it (`bridge.test.ts`).
/* oxlint-disable anti-slop/no-unsafe-dictionary-type -- a tool call's arguments are the model's own JSON, passed to the View as they are */
// @effect-diagnostics missingPipeableSignature:off -- `retire` is a plain function over a bridge.
import type {
  McpUiHostContext,
  McpUiToolCancelledNotification,
  McpUiToolInputNotification,
  McpUiToolInputPartialNotification,
  McpUiToolResultNotification,
} from "@modelcontextprotocol/ext-apps";
import {
  createFrameProtocol,
  type FrameEvent,
  type FrameOptions,
} from "../sandbox-frame/frame-protocol.ts";

// Each method is typed by the spec's own literal, so a rename in ext-apps breaks the build here.
const TOOL_INPUT = "ui/notifications/tool-input" satisfies McpUiToolInputNotification["method"];

const TOOL_INPUT_PARTIAL =
  "ui/notifications/tool-input-partial" satisfies McpUiToolInputPartialNotification["method"];

const TOOL_RESULT = "ui/notifications/tool-result" satisfies McpUiToolResultNotification["method"];

const TOOL_CANCELLED =
  "ui/notifications/tool-cancelled" satisfies McpUiToolCancelledNotification["method"];

/** What an App View's bridge takes, and tells its owner: what the frame protocol does. */
export type BridgeOptions = FrameOptions;

export type BridgeEvent = FrameEvent;

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
   * Send `ui/resource-teardown` and wait for its answer for at most `TEARDOWN_TIMEOUT_MS` (`sandbox-frame/frame-protocol.ts`), then close; the in-flight
   * requests' signals abort. Resolves when the frame may go.
   */
  readonly teardown: () => Promise<void>;
  /** Stop listening, abort the in-flight requests and drop what is queued; nothing is posted after it. */
  readonly close: () => void;
}

export const createBridge = (options: BridgeOptions): Bridge => {
  const frame = createFrameProtocol(options);

  // What the View was told of the call: each of its final input, its result and its cancellation at most once.
  let inputSent = false;
  let resultSent = false;
  let cancelSent = false;

  return {
    start: frame.start,
    hostContextChanged: frame.hostContextChanged,
    teardown: frame.teardown,
    close: frame.close,
    toolInputPartial: (args) => {
      // Only before the final input, and of those the View has not been told yet only the latest.
      if (inputSent || resultSent || cancelSent) return;

      frame.send(TOOL_INPUT_PARTIAL, { arguments: args }, { latest: true });
    },
    toolInput: (args) => {
      // `tool-cancelled` is the end of the call: nothing follows it.
      if (inputSent || cancelSent) return;

      inputSent = true;
      frame.send(TOOL_INPUT, { arguments: args });
    },
    toolResult: (result) => {
      if (resultSent || cancelSent) return;

      resultSent = true;
      frame.send(TOOL_RESULT, result);
    },
    toolCancelled: (reason) => {
      // Once: the card says it when the call ends, and its teardown asks again.
      if (cancelSent) return;

      cancelSent = true;
      frame.send(TOOL_CANCELLED, reason === undefined ? {} : { reason });
    },
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
