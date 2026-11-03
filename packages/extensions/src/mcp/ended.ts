// How a call of an MCP tool ends without a result, as the model reads it and `details` records it
// (`docs/architecture/mcp-in-a-session.md` → Calls and results): one map, for the engine's answers (`./result.ts`) and
// for a result stream the Session could not read (`./stream.ts`), so the same end says the same thing from either.
import type { McpDetails } from "./details.ts";

export const MiB = 1024 * 1024;

/** The most the engine lets a `tools/call` result weigh (`packages/mcp/src/tap.ts`); a larger one is `TooLarge`. */
export const RESULT_LIMIT_BYTES = 16 * MiB;

/** An end: what the model reads, and the `details` keys that say how the call ended. */
export type Ended = {
  readonly message: string;
  readonly cut?: McpDetails["cut"];
  readonly error?: McpDetails["error"];
};

/** A result over `limit` bytes, dropped: the tool may have run. */
export const tooLargeEnd = (limit: number): Ended => ({
  message: `The tool's result was over ${limit / MiB} MiB and was dropped; the tool may have run.`,
  error: "too_large",
});

/** A result lost between the MCP engine and the Session: the tool may have run. */
export const engineLostEnd: Ended = {
  message: "The tool's result was lost on its way from the MCP engine; the tool may have run.",
  cut: "engine_lost",
};

/** A result the Session cannot read. */
export const unreadableEnd: Ended = {
  message: "The server answered with a result this build cannot read",
};
