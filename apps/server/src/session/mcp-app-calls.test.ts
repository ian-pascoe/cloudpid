// An App View's calls in the Session (`docs/architecture/mcp-apps.md` → An App View's calls): what the Session refuses before
// anything is sent (a hidden page, the limits, a method or params it does not serve, a call with no record, an archived
// Session's tool call), what it passes on (the server is the record's), how a cancel and a closed socket end a request,
// and what it logs and redacts. The request itself is a stand-in: the MCP tools' own checks are the extension's tests.
// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off globalTimers:off asyncFunction:off newPromise:off
import type { McpAppRequestInput } from "@cloudpid/extensions/mcp";
import type { McpAppAuditEntry, McpAppRequestAnswer } from "@cloudpid/protocol";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { describe, expect, it } from "vitest";
import { type AppViewRequest, appCallsOver } from "./mcp-app-calls.ts";

const ok: McpAppRequestAnswer = {
  status: "result",
  result: { content: [{ type: "text", text: "hello hunter2" }] },
};

/** A Session whose `request` is `answer`, with call `c1` of server `docs` recorded. */
const session = (
  options: {
    readonly answer?: (input: McpAppRequestInput) => Effect.Effect<McpAppRequestAnswer>;
    readonly archived?: boolean;
    readonly records?: ReadonlyArray<string>;
  } = {},
) => {
  let now = 1_000_000;
  const sent: McpAppRequestInput[] = [];
  const audit: Array<readonly [string, McpAppAuditEntry]> = [];

  const calls = appCallsOver({
    record: (callId) =>
      (options.records ?? ["c1"]).includes(callId)
        ? Option.some({ server: "docs", conversation: "7", viewHash: "viewhash" })
        : Option.none(),
    request: (input) => {
      sent.push(input);

      return options.answer === undefined ? Effect.succeed(ok) : options.answer(input);
    },
    audit: (callId, entry) =>
      Effect.sync(() => {
        audit.push([callId, entry]);
      }),
    secrets: Effect.succeed({
      redact: <A>(value: A): A =>
        JSON.parse(JSON.stringify(value).replaceAll("hunter2", "[secret]")),
    }),
    archived: options.archived === undefined ? undefined : Effect.succeed(options.archived),
    now: () => now,
  });

  return {
    calls,
    sent,
    audit,
    advance: (ms: number) => {
      now += ms;
    },
  };
};

let counter = 0;

// SAFETY: a stand-in for a page's socket, which the calls only use as a key.
const socket = () => Object.assign(Object.create(null), { counter: counter++ }) as WebSocket;

const toolCall = (
  view: WebSocket,
  requestId: string,
  more: Partial<AppViewRequest> = {},
): AppViewRequest => ({
  view,
  visible: true,
  callId: "c1",
  requestId,
  method: "tools/call",
  params: { name: "echo", arguments: { text: "hi" } },
  workspaceOf: () => Effect.succeed("ws:w"),
  ...more,
});

const run = (calls: ReturnType<typeof session>["calls"], input: AppViewRequest) =>
  Effect.runPromise(calls.request(input));

describe("a request from an App View", () => {
  it("is passed to the call's own server, whatever the message says, with the record's conversation and view hash", async () => {
    const { calls, sent } = session();

    const answer = await run(
      calls,
      toolCall(socket(), "r1", {
        params: { name: "echo", arguments: { text: "hi" }, server: "other", callId: "c2" },
      }),
    );

    expect(answer).toMatchObject({ status: "result" });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      method: "tools/call",
      server: "docs",
      name: "echo",
      arguments: { text: "hi" },
      callId: "c1",
      conversation: "7",
      viewHash: "viewhash",
    });

    // Nothing of the View's own `server` or `callId` is read.
    expect(JSON.stringify(sent[0])).not.toContain("other");
  });

  it("reads a resource as the View's own", async () => {
    const { calls, sent } = session();

    await run(
      calls,
      toolCall(socket(), "r1", { method: "resources/read", params: { uri: "ui://docs/page" } }),
    );

    expect(sent[0]).toMatchObject({
      method: "resources/read",
      uri: "ui://docs/page",
      server: "docs",
    });
  });

  it("is refused while the page is hidden, and nothing is sent", async () => {
    const { calls, sent } = session();

    expect(await run(calls, toolCall(socket(), "r1", { visible: false }))).toMatchObject({
      status: "error",
      reason: "hidden",
    });

    expect(sent).toEqual([]);
  });

  it("is refused for a method the Session does not serve, with JSON-RPC's code, and for params of the wrong shape", async () => {
    const { calls, sent } = session();
    const view = socket();

    expect(
      await run(calls, toolCall(view, "r1", { method: "tools/list", params: {} })),
    ).toMatchObject({ status: "error", code: -32_601 });

    expect(
      await run(calls, toolCall(view, "r2", { method: "sampling/createMessage", params: {} })),
    ).toMatchObject({ status: "error", code: -32_601 });

    for (const params of [undefined, {}, { name: 3 }, { name: "x", arguments: [1] }, "x"]) {
      expect(await run(calls, toolCall(view, "r3", { params }))).toMatchObject({
        status: "error",
        code: -32_602,
      });
    }

    expect(
      await run(calls, toolCall(view, "r4", { method: "resources/read", params: {} })),
    ).toMatchObject({ status: "error", code: -32_602 });

    expect(sent).toEqual([]);
  });

  it("is refused for a call with no record kept, and nothing is sent", async () => {
    const { calls, sent, audit } = session();

    expect(await run(calls, toolCall(socket(), "r1", { callId: "gone" }))).toMatchObject({
      status: "error",
      reason: "unavailable",
    });

    expect(sent).toEqual([]);
    expect(audit).toEqual([]);
  });

  it("is refused a tool call in an archived Session, which can still read", async () => {
    const { calls, sent } = session({ archived: true });
    const view = socket();

    expect(await run(calls, toolCall(view, "r1"))).toMatchObject({
      status: "error",
      reason: "refused",
    });

    expect(sent).toEqual([]);

    expect(
      await run(
        calls,
        toolCall(view, "r2", { method: "resources/read", params: { uri: "ui://x" } }),
      ),
    ).toMatchObject({ status: "result" });
  });

  it("is limited to four in flight for each View, and a finished request frees its place", async () => {
    const gates: Array<Deferred.Deferred<McpAppRequestAnswer>> = [];

    const { calls, sent } = session({
      answer: (input) =>
        input.method === "resources/read"
          ? Effect.succeed(ok)
          : Deferred.make<McpAppRequestAnswer>().pipe(
              Effect.tap((gate) => Effect.sync(() => gates.push(gate))),
              Effect.flatMap(Deferred.await),
            ),
    });

    const view = socket();
    const running = [1, 2, 3, 4].map((each) => run(calls, toolCall(view, `r${each}`)));

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sent).toHaveLength(4);

    expect(await run(calls, toolCall(view, "r5"))).toMatchObject({
      status: "error",
      reason: "limit",
    });

    // Another View of the same call, on another socket, has its own four.
    const other = run(calls, toolCall(socket(), "r1"));

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sent).toHaveLength(5);

    // The same request id twice is refused too.
    expect(await run(calls, toolCall(view, "r1"))).toMatchObject({
      status: "error",
      reason: "limit",
    });

    for (const gate of gates) Effect.runSync(Deferred.succeed(gate, ok));

    expect(await Promise.all([...running, other])).toHaveLength(5);

    // The places are free again.
    expect(
      await run(
        calls,
        toolCall(view, "r6", { method: "resources/read", params: { uri: "ui://x" } }),
      ),
    ).toMatchObject({ status: "result" });
  });

  it("is limited to sixty a minute for each View, counting the ones it was refused, until the minute passes", async () => {
    const { calls, sent, advance } = session();
    const view = socket();

    for (let each = 0; each < 60; each++) {
      expect(await run(calls, toolCall(view, `r${each}`))).toMatchObject({ status: "result" });
    }

    expect(await run(calls, toolCall(view, "r60"))).toMatchObject({
      status: "error",
      reason: "limit",
    });
    expect(sent).toHaveLength(60);

    // Another View of the same call, and another call of the same View, have their own.
    expect(await run(calls, toolCall(socket(), "r0"))).toMatchObject({ status: "result" });

    advance(60_001);

    expect(await run(calls, toolCall(view, "r61"))).toMatchObject({ status: "result" });
  });

  it("aborts the request when the View cancels it, and every request when its socket goes", async () => {
    const signals: AbortSignal[] = [];

    const { calls } = session({
      answer: (input) =>
        Effect.callback<McpAppRequestAnswer>((resume) => {
          signals.push(input.signal);
          input.signal.addEventListener("abort", () => {
            resume(
              Effect.succeed({
                status: "error",
                code: -32_000,
                message: "cancelled",
                reason: "cancelled",
              }),
            );
          });
        }),
    });

    const view = socket();
    const first = run(calls, toolCall(view, "r1"));
    const second = run(calls, toolCall(view, "r2"));

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(signals).toHaveLength(2);

    // Only the named request, and only the socket's own.
    await Effect.runPromise(calls.cancel(socket(), "c1", "r1"));
    await Effect.runPromise(calls.cancel(view, "c1", "nope"));
    expect(signals.map((signal) => signal.aborted)).toEqual([false, false]);

    await Effect.runPromise(calls.cancel(view, "c1", "r1"));
    expect(await first).toMatchObject({ reason: "cancelled" });
    expect(signals.map((signal) => signal.aborted)).toEqual([true, false]);

    await Effect.runPromise(calls.endViews(view));
    expect(await second).toMatchObject({ reason: "cancelled" });
  });

  it("keeps a line of the audit log for each call, redacted, with the arguments and the text cut", async () => {
    const { calls, audit } = session({
      answer: () =>
        Effect.succeed({
          status: "result",
          result: { content: [{ type: "text", text: `hunter2 ${"x".repeat(900)}` }] },
        }),
    });

    const answer = await run(
      calls,
      toolCall(socket(), "r1", {
        params: { name: "echo", arguments: { text: "hunter2", big: "y".repeat(5000) } },
      }),
    );

    expect(audit).toHaveLength(1);

    const [callId, entry] = audit[0] ?? ["", { at: 0, kind: "", summary: "" }];

    expect(callId).toBe("c1");
    expect(entry).toMatchObject({ at: 1_000_000, kind: "tools/call" });
    expect(entry.summary).toMatch(/^tools\/call echo \{/);
    expect(entry.summary).toContain("[secret]");
    expect(entry.summary).not.toContain("hunter2");
    // 2 KiB of arguments and 500 characters of text, and a little else.
    expect(entry.summary.length).toBeLessThan(2048 + 500 + 100);

    // The View gets the line too, for the card's details, and its answer is redacted.
    expect(answer).toMatchObject({ status: "result", audit: entry });
    expect(JSON.stringify(answer)).not.toContain("hunter2");
  });

  it("logs a refused call and a failed one, but not a request refused before it was a call", async () => {
    const { calls, audit } = session({
      answer: () =>
        Effect.succeed({
          status: "error",
          code: -32_000,
          message: "Tool echo is not for App Views",
          reason: "refused",
        }),
    });

    const view = socket();

    await run(calls, toolCall(view, "r1"));
    await run(calls, toolCall(view, "r2", { visible: false }));
    await run(calls, toolCall(view, "r3", { method: "tools/list" }));

    expect(audit.map(([, entry]) => entry.summary)).toEqual([
      expect.stringMatching(/^tools\/call echo .* → refused: Tool echo is not for App Views$/),
    ]);
  });
});
