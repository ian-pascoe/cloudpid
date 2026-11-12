// docs/architecture/mcp-apps.md → An App View's calls. A View's `tools/call` and `resources/read` as the bridge's handlers:
// each is one `mcp_app_request` to the Session, answered with its result or the error the View is answered with; the View
// giving up cancels it; the card hears of a sign-in that is needed and of the audit entry kept.
/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type -- a View's params are whatever it posts */
// @effect-diagnostics preferEffectArray:off asyncFunction:off -- fakes: a log of calls, and promises the handlers answer.
import type { McpAppAuditEntry, McpAppRequestAnswer } from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import * as Record from "effect/Record";
import { describe, expect, it } from "vite-plus/test";
import { RpcError } from "../sandbox-frame/frame-protocol.ts";
import { SessionCommandError } from "../session/client.ts";
import { auditLog, viewLogSink, viewRequestHandlers, type AppRequestClient } from "./requests.ts";

type Asked = {
  readonly callId: string;
  readonly requestId: string;
  readonly method: string;
  readonly params: unknown;
};

const audit: McpAppAuditEntry = { at: 1, kind: "tools/call", summary: "tools/call weather → ok" };

/** A client whose Session answers with `answer`, or never (until interrupted) when there is none. */
const fakeClient = (answer: McpAppRequestAnswer | undefined) => {
  const asked: Asked[] = [];
  const cancelled: string[] = [];
  const logged: Array<readonly [string, string, string | undefined, string]> = [];

  const client: AppRequestClient = {
    appLog: (callId, level, logger, message) => {
      logged.push([callId, level, logger, message]);
    },
    appRequest: (callId, requestId, method, params) => {
      asked.push({ callId, requestId, method, params });

      return answer === undefined
        ? Effect.never.pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                cancelled.push(requestId);
              }),
            ),
          )
        : Effect.succeed(answer);
    },
  };

  return { client, asked, cancelled, logged };
};

const reports = () => {
  const signIns: Array<{ server: string; stepUp: boolean }> = [];
  const audits: McpAppAuditEntry[] = [];

  return {
    signIns,
    audits,
    on: {
      onSignIn: (need: { server: string; stepUp: boolean }) => {
        signIns.push(need);
      },
      onAudit: (entry: McpAppAuditEntry) => {
        audits.push(entry);
      },
    },
  };
};

const signal = () => new AbortController().signal;

describe("a View's requests", () => {
  it("hands tools/call and resources/read to the Session for its call, and answers with the result", async () => {
    const { client, asked } = fakeClient({
      status: "result",
      result: { content: [{ type: "text", text: "sunny" }] },
      audit,
    });

    const seen = reports();
    const handlers = viewRequestHandlers(client, "call-1", seen.on);

    await expect(
      handlers["tools/call"]?.(
        { name: "weather", arguments: { city: "Oslo" } },
        { signal: signal() },
      ),
    ).resolves.toEqual({ content: [{ type: "text", text: "sunny" }] });

    await handlers["resources/read"]?.({ uri: "ui://x" }, { signal: signal() });

    expect(asked.map((each) => [each.callId, each.method, each.params])).toEqual([
      ["call-1", "tools/call", { name: "weather", arguments: { city: "Oslo" } }],
      ["call-1", "resources/read", { uri: "ui://x" }],
    ]);
    expect(new Set(asked.map((each) => each.requestId)).size).toBe(2);
    expect(seen.audits).toEqual([audit, audit]);
  });

  it("serves only those two methods", () => {
    const handlers = viewRequestHandlers(fakeClient(undefined).client, "c", reports().on);

    expect(Record.keys(handlers).sort()).toEqual(["resources/read", "tools/call"]);
  });

  it("serves only resources/read to a View that may only read, and so answers tools/call as not found", () => {
    const handlers = viewRequestHandlers(fakeClient(undefined).client, "c", reports().on, {
      readOnly: true,
    });

    expect(Record.keys(handlers)).toEqual(["resources/read"]);
  });

  it("answers params that are not an object of JSON with -32602, without asking the Session", async () => {
    const { client, asked } = fakeClient({ status: "result", result: {} });
    const handlers = viewRequestHandlers(client, "c", reports().on);

    for (const params of ["text", 7, ["a"], null, { when: () => 1 }]) {
      const failure = await handlers["tools/call"]?.(params, { signal: signal() }).catch(
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(RpcError);
      expect(failure).toMatchObject({ code: -32_602 });
    }

    expect(asked).toEqual([]);
  });

  it("lets no params through as none", async () => {
    const { client, asked } = fakeClient({ status: "result", result: {} });

    await viewRequestHandlers(client, "c", reports().on)["resources/read"]?.(undefined, {
      signal: signal(),
    });

    expect(asked[0]?.params).toBeUndefined();
  });

  it("answers the Session's error as the View's JSON-RPC error", async () => {
    const { client } = fakeClient({
      status: "error",
      code: -32_000,
      message: "Not allowed",
      reason: "hidden",
    });

    const failure = await viewRequestHandlers(client, "c", reports().on)
      ["tools/call"]?.({ name: "x" }, { signal: signal() })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RpcError);
    expect(failure).toMatchObject({ code: -32_000, message: "Not allowed" });
  });

  it("tells the card of a sign-in the server needs, and of a step-up", async () => {
    const seen = reports();

    const { client } = fakeClient({
      status: "error",
      code: -32_000,
      message: "Sign in",
      reason: "sign_in",
      server: "notes",
      stepUp: true,
      audit,
    });

    await viewRequestHandlers(client, "c", seen.on)
      ["tools/call"]?.({}, { signal: signal() })
      .catch(() => undefined);

    expect(seen.signIns).toEqual([{ server: "notes", stepUp: true }]);
    expect(seen.audits).toEqual([audit]);
  });

  it("answers an answer it does not know as an internal error", async () => {
    const { client } = fakeClient({ status: "from-the-future" });

    const failure = await viewRequestHandlers(client, "c", reports().on)
      ["tools/call"]?.({}, { signal: signal() })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: -32_603 });
  });

  it("cancels the request at the Session when the View's frame goes", async () => {
    const { client, asked, cancelled } = fakeClient(undefined);
    const aborts = new AbortController();
    const handlers = viewRequestHandlers(client, "c", reports().on);

    const pending = handlers["tools/call"]?.({ name: "slow" }, { signal: aborts.signal }).catch(
      (error: unknown) => error,
    );

    await Effect.runPromise(Effect.sleep("10 millis"));
    aborts.abort();

    expect(await pending).toBeInstanceOf(RpcError);
    expect(cancelled).toEqual([asked[0]?.requestId]);
  });
});

describe("a request the connection ends", () => {
  it("is answered as lost, in the View's own error", async () => {
    const client: AppRequestClient = {
      appLog: () => undefined,
      appRequest: () =>
        Effect.fail(
          SessionCommandError.make({
            message: "The connection was lost; try again once it is back.",
          }),
        ),
    };

    const failure = await viewRequestHandlers(client, "c", reports().on)
      ["tools/call"]?.({ name: "x" }, { signal: signal() })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RpcError);
    expect(failure).toMatchObject({
      code: -32_603,
      message: expect.stringContaining("Connection lost"),
    });
  });
});

describe("the audit log of the details", () => {
  const entry = (at: number): McpAppAuditEntry => ({
    at,
    kind: "tools/call",
    summary: `call ${at}`,
  });

  it("is the last 50 of what the record kept and what has come since", () => {
    const kept = Array.from({ length: 50 }, (_, at) => entry(at));
    const merged = auditLog(kept, [entry(50), entry(51)]);

    expect(merged).toHaveLength(50);
    expect(merged[0]).toEqual(entry(2));
    expect(merged.at(-1)).toEqual(entry(51));
    expect(auditLog([entry(1)], [entry(2)])).toEqual([entry(1), entry(2)]);
  });
});

describe("a View's log lines", () => {
  const sinkOf = () => {
    const { client, logged } = fakeClient(undefined);

    return { sink: viewLogSink(client, "call-1"), logged };
  };

  it("go to the Session with their level, logger and text, a JSON value as its text", () => {
    const { sink, logged } = sinkOf();

    sink({ level: "warning", logger: "view", data: "careful" });
    sink({ level: "error", data: { code: 7 } });

    expect(logged).toEqual([
      ["call-1", "warning", "view", "careful"],
      ["call-1", "error", undefined, '{"code":7}'],
    ]);
  });

  it("are cut to what the Session takes", () => {
    const { sink, logged } = sinkOf();

    sink({ level: "w".repeat(500), logger: "l".repeat(500), data: "x".repeat(10_000) });

    expect(logged[0]?.[1]).toHaveLength(128);
    expect(logged[0]?.[2]).toHaveLength(128);
    expect(logged[0]?.[3]).toHaveLength(2048);
  });

  it("are dropped when they are not log lines", () => {
    const { sink, logged } = sinkOf();

    sink(undefined);
    sink("text");
    sink({ data: "no level" });
    sink({ level: "info", data: () => 1 });

    expect(logged).toEqual([]);
  });
});
