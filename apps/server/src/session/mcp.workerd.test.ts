// The Session object's RPC for the MCP endpoint, against real Durable Object storage (`docs/architecture/mcp-endpoint.md`
// → Following a Run, Transcripts, Starting, sending and stopping): wait wake-ups, cursors, pages and the marks.
// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off globalDate:off preferEffectArray:off
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  type ApiResult,
  decodeCursor,
  encodeCursor,
  type SubmitRequest,
  type SessionVia,
} from "@cloudpid/protocol";
import * as Option from "effect/Option";
import { describe, expect, it, vi } from "vitest";
import type { TestRegistry } from "../registry/store.fixture.ts";
import type { TestSession } from "./host.fixture.ts";

declare global {
  namespace Cloudflare {
    /** The bindings `vitest.config.ts` gives the test Worker. */
    interface Env {
      readonly SESSIONS: DurableObjectNamespace<TestSession>;
      readonly REGISTRIES: DurableObjectNamespace<TestRegistry>;
    }
  }
}

const via: SessionVia = { auth: "oauth", client: { name: "claude-code" } };

const fresh = () => env.SESSIONS.get(env.SESSIONS.newUniqueId());

const script = (stub: DurableObjectStub<TestSession>, ...responses: string[]) =>
  runInDurableObject(stub, (instance: TestSession) => instance.script(responses));

/** The value of an `ok` result: a failure fails the test with its error. */
const okValue = <T>(result: ApiResult<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);

  return result.value;
};

const send = async (stub: DurableObjectStub<TestSession>, request: Partial<SubmitRequest> = {}) =>
  okValue(await stub.mcpSubmit({ input: "Do the thing", via, ...request }));

/** Wait (to a deadline `ms` from now) for something to change after `after`. */
const wait = (stub: DurableObjectStub<TestSession>, after: string | undefined, ms = 10_000) =>
  after === undefined
    ? stub.mcpWait({ deadline: Date.now() + ms })
    : stub.mcpWait({ after, deadline: Date.now() + ms });

const settled = (stub: DurableObjectStub<TestSession>) =>
  vi.waitFor(async () => expect(okValue(await stub.mcpStatus()).status).toBe("idle"), {
    timeout: 10_000,
    interval: 50,
  });

describe("submit", () => {
  it("starts a Run, marks the input with who sent it, and answers a cursor to wait from", async () => {
    const stub = fresh();

    await script(stub, "All done");

    const sent = await send(stub);

    expect(sent.delivery).toBe("started");
    expect(Option.isSome(decodeCursor(sent.cursor))).toBe(true);

    const ended = okValue(await wait(stub, sent.cursor));

    expect(ended).toMatchObject({
      status: "idle",
      ended_by: "run_ended",
      outcome: { result: "answered" },
      answer: { text: "All done", truncated: false },
    });

    // The transcript keeps the mark: the client's name and no more.
    const page = okValue(await stub.mcpTranscript({}));

    expect(page.entries[0]?.text).toMatch(
      /^### user · \d\d:\d\d · via claude-code \(MCP\)\nDo the thing$/,
    );
    expect(JSON.stringify(page)).not.toContain("@");
  });

  it("finds the first input again for a request id", async () => {
    const stub = fresh();

    await script(stub, "once");

    const first = await send(stub, { requestId: "req-1" });

    await settled(stub);

    const again = await send(stub, { requestId: "req-1" });

    expect(again.delivery).toBe("started");
    // The cursor's mark of the input is the same; the transcript only moved on.
    expect(Option.getOrThrow(decodeCursor(again.cursor)).s).toBe(
      Option.getOrThrow(decodeCursor(first.cursor)).s,
    );

    const page = okValue(await stub.mcpTranscript({}));

    expect(page.entries.filter((entry) => entry.role === "user")).toHaveLength(1);
  });

  it("says how a send met a Run that is going: queued, steered, or refused", async () => {
    const stub = fresh();

    await script(stub, "hang", "second", "third");
    await send(stub);
    await runInDurableObject(stub, (instance: TestSession) => instance.hanging.promise);

    expect((await stub.mcpSubmit({ input: "no", via, whenBusy: "reject" })).ok).toBe(false);
    expect(await stub.mcpSubmit({ input: "no", via, whenBusy: "reject" })).toMatchObject({
      error: { code: "session_busy", retryable: true },
    });

    expect((await send(stub, { whenBusy: "followUp" })).delivery).toBe("queued");
    expect((await send(stub, { whenBusy: "steer" })).delivery).toBe("steered");

    await stub.mcpStop({ via });
  });

  it("reports the first send's delivery when a request id comes again", async () => {
    const stub = fresh();

    await script(stub, "hang", "second");

    await send(stub, { requestId: "req-first" });
    await runInDurableObject(stub, (instance: TestSession) => instance.hanging.promise);

    // A repeat of the send that started the Run still says it started it, steering or not.
    expect((await send(stub, { requestId: "req-first", whenBusy: "steer" })).delivery).toBe(
      "started",
    );

    const steered = await send(stub, { requestId: "req-late", whenBusy: "steer" });

    expect(steered.delivery).toBe("steered");

    // The same request id again, whatever it now says about the busy Run, is the first send's delivery.
    expect((await send(stub, { requestId: "req-late", whenBusy: "followUp" })).delivery).toBe(
      "steered",
    );
    expect((await send(stub, { requestId: "req-late" })).delivery).toBe("steered");

    await stub.mcpStop({ via });
  });

  it("refuses input that is too large, and input to an archived Session", async () => {
    const stub = fresh();

    expect(await stub.mcpSubmit({ input: "x".repeat(1_900_001), via })).toMatchObject({
      error: { code: "input_too_large", retryable: false },
    });

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.kv.put("archived", true);
    });

    expect(await stub.mcpSubmit({ input: "hi", via })).toMatchObject({
      error: { code: "session_archived" },
    });
  });
});

describe("a repeated request id of an archived Session", () => {
  it("answers the first send's result, and refuses a new input", async () => {
    const stub = fresh();

    await script(stub, "once");

    const first = await send(stub, { requestId: "req-1" });

    await settled(stub);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.kv.put("archived", true);
    });

    const again = await send(stub, { requestId: "req-1" });

    expect(again.delivery).toBe(first.delivery);
    expect(Option.getOrThrow(decodeCursor(again.cursor)).s).toBe(
      Option.getOrThrow(decodeCursor(first.cursor)).s,
    );
    expect(await stub.mcpSubmit({ input: "new", via, requestId: "req-2" })).toMatchObject({
      error: { code: "session_archived" },
    });
  });
});

describe("waitForChange", () => {
  it("wakes the moment the Run ends, with its answer", async () => {
    const stub = fresh();

    await script(stub, "gate:Finished");

    const sent = await send(stub);
    const waited = wait(stub, sent.cursor);

    // Still waiting while the Run is.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(okValue(await stub.mcpStatus()).status).toBe("running");

    const started = Date.now();

    await runInDurableObject(stub, (instance: TestSession) => instance.open());

    const ended = okValue(await waited);

    expect(ended).toMatchObject({ ended_by: "run_ended", answer: { text: "Finished" } });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(ended.activity.entries).toBeGreaterThan(0);
  });

  it("returns at once for a Run that ended after the cursor, and waits out one that ended before", async () => {
    const stub = fresh();

    await script(stub, "one", "two");

    const first = await send(stub);

    okValue(await wait(stub, first.cursor));

    const idle = okValue(await stub.mcpStatus());

    // The cursor of an idle Session waits for what is new: nothing, so it ends at its deadline.
    const quiet = okValue(await wait(stub, idle.cursor, 200));

    expect(quiet).toMatchObject({ ended_by: "timeout", status: "idle", cursor: idle.cursor });

    // The first input's cursor still finds its Run ended, at once.
    const late = okValue(await wait(stub, first.cursor, 200));

    expect(late.ended_by).toBe("run_ended");

    const second = await send(stub);

    expect(okValue(await wait(stub, second.cursor)).ended_by).toBe("run_ended");
  });

  it("tells a failed Run as its outcome, never an error", async () => {
    const stub = fresh();

    await script(stub, "error:invalid request: the prompt is bad");

    const sent = await send(stub);
    const ended = okValue(await wait(stub, sent.cursor));

    expect(ended.ended_by).toBe("run_ended");
    expect(ended.outcome).toMatchObject({ result: "failed" });
    expect(ended.error).toContain("the prompt is bad");
  });

  it("returns at once without a cursor unless a Run is going and nothing waits", async () => {
    const stub = fresh();

    // Nothing has run: nothing to wait for.
    expect(okValue(await wait(stub, undefined)).ended_by).toBe("timeout");

    await script(stub, "hang");
    await send(stub);
    await runInDurableObject(stub, (instance: TestSession) => instance.hanging.promise);

    const started = Date.now();

    expect(okValue(await wait(stub, undefined, 300)).ended_by).toBe("timeout");
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);

    await stub.mcpStop({ via });
  });

  it("says a waiting request ended it once, and a request already seen does not end the next wait", async () => {
    const stub = fresh();

    await script(
      stub,
      `call:secret_ask:${JSON.stringify({ names: ["API_KEY"], reason: "call the API" })}`,
      "done",
    );

    const sent = await send(stub);
    const needed = okValue(await wait(stub, sent.cursor));

    expect(needed).toMatchObject({ ended_by: "owner_needed", status: "waiting_for_owner" });
    expect(needed.waiting).toHaveLength(1);
    expect(needed.waiting[0]).toMatchObject({
      kind: "secret",
      agent_id: "root",
      summary: "Secret request: API_KEY",
    });
    expect(needed.waiting[0]?.url).toMatch(/^\/sessions\/[^?]*\?request=/);

    // The cursor remembers it: the Run is blocked on the owner, and the next wait does not spin.
    const started = Date.now();
    const next = okValue(await wait(stub, needed.cursor, 300));

    expect(next.ended_by).toBe("timeout");
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(next.waiting).toEqual(needed.waiting);

    const status = okValue(await stub.mcpStatus());

    expect(status.status).toBe("waiting_for_owner");
    expect(status.waiting).toEqual(needed.waiting);

    await stub.mcpStop({ via });
  });

  it("holds at most eight waits at once", async () => {
    const stub = fresh();
    const open = Array.from({ length: 8 }, () => wait(stub, undefined, 1_500));

    // No Run: each of the first eight answers at once, so hold them with an input going.
    await Promise.all(open);

    await script(stub, "hang");
    await send(stub);
    await runInDurableObject(stub, (instance: TestSession) => instance.hanging.promise);

    const holding = Array.from({ length: 8 }, () => wait(stub, undefined, 1_500));

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await wait(stub, undefined, 1_500)).toMatchObject({
      error: { code: "too_many_waits", retryable: true },
    });

    await stub.mcpStop({ via });
    await Promise.all(holding);
  });

  it("refuses what is not a cursor", async () => {
    const stub = fresh();

    expect(await wait(stub, "not-a-cursor")).toMatchObject({ error: { code: "invalid_cursor" } });
    expect(await stub.mcpStatus({ after: "!" })).toMatchObject({
      error: { code: "invalid_cursor" },
    });
    expect(await stub.mcpTranscript({ after: "!" })).toMatchObject({
      error: { code: "invalid_cursor" },
    });
  });

  it("refuses a well-formed cursor of a conversation this Session does not have, which no retry mends", async () => {
    const stub = fresh();
    const elsewhere = encodeCursor({ c: 9_999, e: 0, w: 0, s: 0 });

    expect(await wait(stub, elsewhere)).toMatchObject({
      ok: false,
      error: { code: "invalid_cursor", retryable: false },
    });
    expect(await stub.mcpTranscript({ before: elsewhere })).toMatchObject({
      ok: false,
      error: { code: "invalid_cursor", retryable: false },
    });
    expect(await stub.mcpTranscript({ after: elsewhere })).toMatchObject({
      error: { code: "invalid_cursor" },
    });
  });

  it("keeps following the branch a cursor was made on", async () => {
    const stub = fresh();

    await script(stub, "one");

    const sent = await send(stub);

    okValue(await wait(stub, sent.cursor));

    // A cursor of a conversation that is no longer the active branch says so.
    const state = Option.getOrThrow(decodeCursor(sent.cursor));
    const other = encodeCursor({ ...state, c: state.c + 1000 });

    expect(await stub.mcpStatus({ after: other })).toMatchObject({
      ok: true,
      value: { branch_changed: true },
    });
  });
});

describe("transcriptPage", () => {
  const longRun = async () => {
    const stub = fresh();

    await script(
      stub,
      ...Array.from({ length: 6 }, (_, index) => `answer ${String(index)} ${"w".repeat(900)}`),
    );

    for (let index = 0; index < 6; index++) {
      const sent = await send(stub, { input: `question ${String(index)} ${"q".repeat(900)}` });

      okValue(await wait(stub, sent.cursor));
    }

    return stub;
  };

  it("pages the latest entries, then older ones, then newer, by cursors", async () => {
    const stub = await longRun();
    const latest = okValue(await stub.mcpTranscript({ max_chars: 2_000 }));

    expect(latest.entries.length).toBeGreaterThanOrEqual(1);
    expect(latest.entries.at(-1)?.role).toBe("assistant");

    const oldest = latest.older;

    if (oldest === undefined) throw new Error("No older page");

    const older = okValue(await stub.mcpTranscript({ before: oldest, max_chars: 2_000 }));

    expect(older.entries.at(-1)?.entry_id).toBeLessThan(latest.entries[0]?.entry_id ?? 0);

    // Reading forward from the older page reaches the latest one again.
    const newer = okValue(await stub.mcpTranscript({ after: older.newer, max_chars: 40_000 }));

    expect(newer.entries[0]?.entry_id).toBeGreaterThan(older.entries.at(-1)?.entry_id ?? Infinity);
    expect(newer.entries.at(-1)?.entry_id).toBe(latest.entries.at(-1)?.entry_id);
    expect(newer.older).toBeUndefined();

    // At the end of the transcript, `newer` waits for more: nothing yet.
    const nothing = okValue(await stub.mcpTranscript({ after: newer.newer }));

    expect(nothing.entries).toEqual([]);
    expect(nothing.newer).toBe(newer.newer);
  });

  it("holds the whole of a short transcript, oldest first, with no older page", async () => {
    const stub = fresh();

    await script(stub, "short");
    okValue(await wait(stub, (await send(stub)).cursor));

    const page = okValue(await stub.mcpTranscript({}));

    expect(page.entries.map((entry) => entry.role)).toEqual(["user", "assistant"]);
    expect(page.older).toBeUndefined();
    expect(page.entries[1]?.text).toBe(
      `### assistant · ${page.entries[1]?.at.slice(11, 16)}\nshort`,
    );
  });

  it("redacts GitHub tokens and held Secrets from every text it shows", async () => {
    const stub = fresh();
    const token = `ghs_${"Ab1".repeat(10)}`;

    await script(stub, `the token was ${token}`);
    okValue(await wait(stub, (await send(stub, { input: `use ${token}` })).cursor));

    const page = okValue(await stub.mcpTranscript({}));
    const ended = okValue(await wait(stub, undefined, 200));

    expect(JSON.stringify(page)).not.toContain(token);
    expect(page.entries.map((entry) => entry.text).join("\n")).toContain("[REDACTED github token]");
    expect(JSON.stringify(ended)).not.toContain(token);
    expect(JSON.stringify(okValue(await stub.mcpStatus()))).not.toContain(token);
  });

  it("refuses an agent the Session does not have", async () => {
    expect(await fresh().mcpTranscript({ agent_id: "agent-9" })).toMatchObject({
      error: { code: "not_found" },
    });
  });
});

describe("stop", () => {
  it("stops the Run, leaves a notice that names the client, and is idempotent", async () => {
    const stub = fresh();

    await script(stub, "hang");
    await send(stub);
    await runInDurableObject(stub, (instance: TestSession) => instance.hanging.promise);

    const stopped = okValue(await stub.mcpStop({ via }));

    expect(stopped).toEqual({ status: "idle" });

    const page = okValue(await stub.mcpTranscript({}));

    expect(page.entries.map((entry) => entry.text)).toContain("· Stopped from claude-code (MCP)");

    // A second stop finds it idle, and adds no notice.
    expect(okValue(await stub.mcpStop({ via }))).toEqual({ status: "idle" });
    expect(
      okValue(await stub.mcpTranscript({})).entries.filter((entry) =>
        entry.text.includes("Stopped from"),
      ),
    ).toHaveLength(1);

    // The Run's outcome is a stop.
    expect(okValue(await stub.mcpStatus())).toMatchObject({
      status: "idle",
      outcome: { result: "stopped" },
    });
  });
});

describe("stop, from a caller with no name", () => {
  it("leaves the notice Stopped over MCP", async () => {
    const stub = fresh();

    await script(stub, "hang");
    await send(stub);
    await runInDurableObject(stub, (instance: TestSession) => instance.hanging.promise);
    await stub.mcpStop({ via: { auth: "service_token" } });

    expect(okValue(await stub.mcpTranscript({})).entries.map((entry) => entry.text)).toContain(
      "· Stopped over MCP",
    );
  });
});

describe("configure", () => {
  it("picks the model and thinking level the first Run uses, as a socket's configure does", async () => {
    const stub = fresh();

    await script(stub, "done");
    expect(
      await stub.mcpConfigure({ model: "anthropic/claude-haiku-5-5", thinkingLevel: "low" }),
    ).toEqual({ ok: true, value: null });

    await send(stub);
    await settled(stub);

    expect(await stub.requests()).toEqual([{ model: "claude-haiku-5-5", thinking: "low" }]);
  });

  it("leaves a field it is not given as it is", async () => {
    const stub = fresh();

    await script(stub, "done");
    await stub.mcpConfigure({ thinkingLevel: "minimal" });
    await send(stub);
    await settled(stub);

    expect((await stub.requests())[0]?.thinking).toBe("minimal");
  });
});

describe("redaction", () => {
  const SECRET = "hunter2-the-long-value";
  /** What a held Secret shows as. */
  const PLACEHOLDER = "{" + "{secret:API_KEY}}";

  /** Run `responses[0]` to its end, then hold `SECRET`: what the Run said is stored as the model said it. */
  const heldAfter = async (response: string) => {
    const stub = fresh();

    await script(stub, response);

    const sent = await send(stub);

    okValue(await wait(stub, sent.cursor));
    await runInDurableObject(stub, (instance: TestSession) => instance.hold({ API_KEY: SECRET }));

    return { stub, sent };
  };

  it("redacts a held Secret from the answer, the last answer and the latest activity", async () => {
    const { stub, sent } = await heldAfter(`the key is ${SECRET}`);
    const ended = okValue(await wait(stub, sent.cursor));
    const status = okValue(await stub.mcpStatus());

    expect(ended.answer?.text).toContain(PLACEHOLDER);
    expect(status.last_answer?.text).toContain(PLACEHOLDER);
    expect(ended.activity.latest.join("\n")).toContain(PLACEHOLDER);
    expect(JSON.stringify([ended, status])).not.toContain(SECRET);
  });

  it("redacts a held Secret from the error of a failed Run, and from its outcome", async () => {
    const { stub, sent } = await heldAfter(`error:invalid request: the key ${SECRET} is bad`);
    const ended = okValue(await wait(stub, sent.cursor));
    const status = okValue(await stub.mcpStatus());

    expect(ended.error).toContain("is bad");
    expect(status.outcome).toMatchObject({ result: "failed" });
    expect(JSON.stringify([ended, status])).not.toContain(SECRET);
  });

  it("withholds the Session's text, saying why, while the kept Secrets cannot be read", async () => {
    const stub = fresh();

    await runInDurableObject(stub, (instance: TestSession) => instance.keptFails(true));
    await script(stub, `the key is ${SECRET}`);

    const sent = await send(stub);
    const ended = okValue(await wait(stub, sent.cursor));
    const status = okValue(await stub.mcpStatus());

    expect(ended).toMatchObject({ ended_by: "run_ended", text_withheld: "secrets_unavailable" });
    expect(ended.answer).toBeUndefined();
    expect(ended.activity.latest).toEqual([]);
    expect(ended.activity.entries).toBeGreaterThan(0);
    expect(status).toMatchObject({ status: "idle", text_withheld: "secrets_unavailable" });
    expect(status.last_answer).toBeUndefined();
    expect(await stub.mcpTranscript({})).toMatchObject({
      ok: false,
      error: { code: "unavailable", retryable: true },
    });
  });

  it("says text was withheld however the wait ended, and in a status while a Run is going", async () => {
    const stub = fresh();

    await runInDurableObject(stub, (instance: TestSession) => instance.keptFails(true));
    await script(stub, "hang");

    const sent = await send(stub);

    await runInDurableObject(stub, (instance: TestSession) => instance.hanging.promise);

    const timedOut = okValue(await wait(stub, sent.cursor, 200));

    expect(timedOut).toMatchObject({ ended_by: "timeout", text_withheld: "secrets_unavailable" });
    expect(timedOut.activity.latest).toEqual([]);
    expect(okValue(await stub.mcpStatus())).toMatchObject({
      status: "running",
      text_withheld: "secrets_unavailable",
    });

    await stub.mcpStop({ via });
  });

  it("withholds the message of a failed Run while the kept Secrets cannot be read", async () => {
    const stub = fresh();

    await runInDurableObject(stub, (instance: TestSession) => instance.keptFails(true));
    await script(stub, "error:invalid request: the prompt is bad");

    const ended = okValue(await wait(stub, (await send(stub)).cursor));

    expect(ended.outcome).toMatchObject({ result: "failed" });
    expect(ended.outcome?.message).toBeUndefined();
    expect(ended.error).toBeUndefined();
    expect(ended.text_withheld).toBe("secrets_unavailable");
  });

  it("answers stopped, not retryable, to a send Stop withdrew before it was placed, and to its resend", async () => {
    const stub = fresh();

    // A message held while it is prepared, as an Attached page's read or a template's expansion holds it.
    const held = stub.submitHeld({ requestId: "r-1", text: "held" });

    await new Promise((resolve) => setTimeout(resolve, 50));

    // The Session shows no Run, yet the message in its line is stopped: it does not count as idle.
    expect(okValue(await stub.mcpStop({ via })).status).toBe("idle");
    expect(await held).toBe("withdrawn");

    const resent = await stub.mcpSubmit({ input: "held", requestId: "r-1", via });

    expect(resent).toMatchObject({ ok: false, error: { code: "stopped", retryable: false } });
    // Nothing was placed: a new message is the first of the conversation.
    expect(await send(stub, { requestId: "r-2" })).toMatchObject({ delivery: "started" });
  });
});
