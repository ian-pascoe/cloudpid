// How a call of an MCP tool ends without a result, as the model reads it and `details` records it
// (`docs/architecture/mcp-in-a-session.md` → Calls and results): the one map, for the engine's answers (`describeError`,
// used by `./result.ts`) and for a result stream the Session could not read (`streamEnd`, from `./stream.ts`'s outcomes),
// so the same end says the same thing from either.
import { MCP_LARGE_RESULT_BYTES, type McpErrorWire, mayHaveRun, MiB } from "@cloudpid/mcp/types";
import * as Match from "effect/Match";
import type { McpDetails } from "./details.ts";

/** An end: what the model reads, and the `details` keys that say how the call ended. */
export type Ended = {
  readonly message: string;
  readonly cut?: McpDetails["cut"];
  readonly error?: McpDetails["error"];
};

/** A result over `limit` bytes, dropped: the tool may have run. */
const tooLargeEnd = (limit: number): Ended => ({
  message: `The tool's result was over ${limit / MiB} MiB and was dropped; the tool may have run.`,
  error: "too_large",
});

/** A result lost between the MCP engine and the Session: the tool may have run. */
const engineLostEnd: Ended = {
  message: "The tool's result was lost on its way from the MCP engine; the tool may have run.",
  cut: "engine_lost",
};

/**
 * A result the engine let go of before the Session could read it, the Session being busy with other large results for
 * as long as the engine holds a stream unread. The tool ran, and its result was dropped.
 */
const waitedEnd: Ended = {
  message:
    "The tool's result was dropped unread: the Session was reading other large results, and the MCP engine lets a result go after 60 s. The tool ran.",
  cut: "engine_lost",
};

/** A result the Session cannot read. */
const unreadableEnd: Ended = {
  message: "The server answered with a result this build cannot read",
};

/** How each way a result's stream failed ended. */
const STREAM_ENDS = {
  too_large: tooLargeEnd(MCP_LARGE_RESULT_BYTES),
  lost: engineLostEnd,
  waited: waitedEnd,
  unreadable: unreadableEnd,
} as const satisfies Record<string, Ended>;

/** The ways a result's stream failed. */
export type StreamFailure = keyof typeof STREAM_ENDS;

/** How a stream that could not be read ended. */
export const streamEnd = (kind: StreamFailure): Ended => STREAM_ENDS[kind];

/** The words for a result the Session cannot read, for a result that is not a `tools/call` result at all. */
export const unreadableMessage: string = unreadableEnd.message;

/** What a call that ended without a result says, and what `details` records of how. */
export const describeError = (error: McpErrorWire): Ended =>
  Match.value(error).pipe(
    Match.tag("Cut", (cut): Ended => {
      const message = cut.mayHaveRun
        ? `The call was cut before its answer arrived; it may or may not have run. ${cut.message}`
        : cut.message;

      return cut.lost === "engine" ? { message, cut: engineLostEnd.cut } : { message };
    }),
    Match.tag("TooLarge", (large) => tooLargeEnd(large.limit)),
    Match.tag("TimedOut", (timed): Ended => ({
      message: `The call timed out: ${timed.message}. It may or may not have run.`,
    })),
    Match.orElse((other): Ended => ({
      message: mayHaveRun(other, "tools/call")
        ? `${other.message} It may or may not have run.`
        : other.message,
    })),
  );
