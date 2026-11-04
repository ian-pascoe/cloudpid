// @effect-diagnostics asyncFunction:off
import { MCP_COMPLETION_STATUS, type McpCompletion } from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
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
  it("answers what the request answers, and keeps nothing after it", async () => {
    const completions = socketCompletions(() => 0);
    const one = socket();
    const asked = waiting();

    const answer = Effect.runPromise(
      completions.complete(one, { requestId: "r1", field: "repo" }, asked.run),
    );

    asked.release();
    expect(await answer).toEqual(ok);
  });

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

  it("ends a request on cancel, and every request of a socket that goes", async () => {
    const completions = socketCompletions(() => 0);
    const one = socket();
    const first = waiting();
    const second = waiting();

    void Effect.runPromise(completions.complete(one, { requestId: "r1", field: "a" }, first.run));
    void Effect.runPromise(completions.complete(one, { requestId: "r2", field: "b" }, second.run));
    completions.cancel(one, "r1");
    expect(first.signals[0]?.aborted).toBe(true);
    expect(second.signals[0]?.aborted).toBe(false);
    completions.end(one);
    expect(second.signals[0]?.aborted).toBe(true);
  });

  it("sends nothing for a request over the minute's limit, or one already in flight, until the minute has passed", async () => {
    let at = 0;
    const completions = socketCompletions(() => at);
    const one = socket();
    let sent = 0;

    const run = () => {
      sent += 1;

      return Effect.succeed(ok);
    };

    for (let index = 0; index < 600; index += 1) {
      await Effect.runPromise(
        completions.complete(one, { requestId: `r${String(index)}`, field: "a" }, run),
      );
    }

    expect(sent).toBe(600);
    expect(
      (await Effect.runPromise(completions.complete(one, { requestId: "late", field: "a" }, run)))
        .status,
    ).toBe("failed");
    expect(sent).toBe(600);

    at = 61_000;
    expect(
      await Effect.runPromise(completions.complete(one, { requestId: "next", field: "a" }, run)),
    ).toEqual(ok);
  });

  it("answers failed when the request fails, never a failure", async () => {
    const completions = socketCompletions(() => 0);

    const answer = await Effect.runPromise(
      completions.complete(socket(), { requestId: "r1", field: "a" }, () => Effect.die("boom")),
    );

    expect(answer.status).toBe("failed");
  });
});
