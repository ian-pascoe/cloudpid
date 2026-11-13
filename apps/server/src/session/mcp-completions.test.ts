// @effect-diagnostics asyncFunction:off
import { MCP_COMPLETION_STATUS, type McpCompletion } from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";
import { socketCompletions } from "./mcp-completions.ts";

// A socket is only a key here.
// SAFETY: the completions only key a socket in a map and a registry; nothing here reads a WebSocket.
const socket = () => ({}) as WebSocket;

const ok: McpCompletion = { status: MCP_COMPLETION_STATUS.ok, values: ["a"], hasMore: false };

/** A request that waits until its signal aborts (answering what the form is told) or `release` is called. */
const waiting = () => {
  let release: (answer: McpCompletion) => void = () => {};
  const signals: Array<AbortSignal> = [];

  const run = (signal: AbortSignal) => {
    signals.push(signal);

    return Effect.callback<McpCompletion>((resume) => {
      release = (answer) => {
        resume(Effect.succeed(answer));
      };

      signal.addEventListener("abort", () => {
        resume(Effect.succeed({ status: "failed", values: [], hasMore: false }));
      });
    });
  };

  return { run, signals, release: (answer: McpCompletion = ok) => release(answer) };
};

describe("a socket's completions", () => {
  it("ends the older request of a field when a newer one comes, and not another field's", async () => {
    const completions = socketCompletions(() => 0);
    const one = socket();
    const first = waiting();
    const other = waiting();
    const second = waiting();

    const older = Effect.runPromise(
      completions.complete(one, { requestId: "r1", field: "repo" }, first.run),
    );

    void Effect.runPromise(
      completions.complete(one, { requestId: "r2", field: "owner" }, other.run),
    );
    void Effect.runPromise(
      completions.complete(one, { requestId: "r3", field: "repo" }, second.run),
    );

    expect((await older).status).toBe("failed");
    expect(first.signals[0]?.aborted).toBe(true);
    expect(other.signals[0]?.aborted).toBe(false);
    expect(second.signals[0]?.aborted).toBe(false);
  });

  it("answers failed when the request fails, never a failure", async () => {
    const completions = socketCompletions(() => 0);

    const answer = await Effect.runPromise(
      completions.complete(socket(), { requestId: "r1", field: "a" }, () => Effect.die("boom")),
    );

    expect(answer.status).toBe("failed");
  });
});
