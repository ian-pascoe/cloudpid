// docs/architecture/mcp-apps.md → Lifecycle (Mounting), App Views in the transcript. The arguments of a call that is still
// streaming, handed to its View as `tool-input-partial`: the latest at most every 250 ms, only when they changed, and
// never past 1 MiB of them (a View that wants more waits for `tool-input`). The arguments are parsed already: the Session's
// streaming JSON parser (pi-ai's) made them, and the transcript keeps them as the call streams (`reduceView`'s streamed
// tools), so this only paces what it is given. Pure over its clock, which a test supplies.
// @effect-diagnostics missingPipeableSignature:off globalTimers:off globalDate:off -- a small throttle over an injected clock.

/** The least time between two `tool-input-partial` of one call. */
export const PARTIAL_INPUT_INTERVAL_MS = 250;

/** The most bytes of arguments (their JSON, in UTF-8) a `tool-input-partial` is sent for. */
export const MAX_PARTIAL_INPUT_BYTES = 1024 * 1024;

import type { McpAppRecord } from "@cloudpid/protocol";

/** The arguments of a call, as JSON. */
export type ToolArguments = McpAppRecord["arguments"];

/** The clock a feed paces itself by. */
export interface FeedClock {
  readonly now: () => number;
  readonly setTimeout: (run: () => void, ms: number) => ReturnType<typeof setTimeout>;
  readonly clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
}

export const REAL_CLOCK: FeedClock = {
  now: () => Date.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (timer) => {
    clearTimeout(timer);
  },
};

export interface PartialFeed {
  /** The call's arguments as they are now: the latest is sent when the interval allows. Cheap: nothing is measured until then. */
  readonly push: (args: ToolArguments) => void;
  /** No more partials: what waits is dropped (the final `tool-input` is coming, or the call ended). */
  readonly stop: () => void;
}

/** Whether `json` is within the cap in UTF-8 bytes, measured only when its length alone does not say. */
const withinCap = (json: string): boolean => {
  if (json.length > MAX_PARTIAL_INPUT_BYTES) return false;

  // A UTF-16 unit is at most three bytes.
  if (json.length * 3 <= MAX_PARTIAL_INPUT_BYTES) return true;

  return new TextEncoder().encode(json).byteLength <= MAX_PARTIAL_INPUT_BYTES;
};

export const createPartialFeed = (
  send: (args: ToolArguments) => void,
  clock: FeedClock = REAL_CLOCK,
): PartialFeed => {
  let latest: ToolArguments | undefined;
  let lastJson: string | undefined;
  let lastAt: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let waiting = false;
  let over = false;
  let stopped = false;

  const flush = (): void => {
    waiting = false;
    timer = undefined;

    if (stopped || over || latest === undefined) return;

    const json = JSON.stringify(latest);

    // Past the cap the View gets no more partials: they only grow.
    if (!withinCap(json)) {
      over = true;

      return;
    }

    if (json === lastJson) return;

    lastJson = json;
    lastAt = clock.now();
    send(latest);
  };

  return {
    push: (args) => {
      if (stopped || over) return;

      latest = args;

      if (waiting) return;

      const since = lastAt === undefined ? PARTIAL_INPUT_INTERVAL_MS : clock.now() - lastAt;

      if (since >= PARTIAL_INPUT_INTERVAL_MS) {
        flush();

        return;
      }

      waiting = true;
      timer = clock.setTimeout(flush, PARTIAL_INPUT_INTERVAL_MS - since);
    },
    stop: () => {
      stopped = true;
      waiting = false;

      if (timer !== undefined) clock.clearTimeout(timer);

      timer = undefined;
    },
  };
};
