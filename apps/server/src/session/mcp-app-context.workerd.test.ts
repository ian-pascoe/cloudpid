// App context and App messages in a Session end to end (`docs/architecture/mcp-apps.md` → App messages and App context): a View's
// `ui/update-model-context` is held pending in the Session (`mcp_app_context`) and reaches the model only as an untrusted
// notice, a `write` of its own kind written when input is admitted to its conversation, or at the next boundary while that is
// busy, and never starting a Run; an App message goes with the owner's own send (`submit.app`) as a part of its own. Real
// Durable Object storage, the real host and engine over a fake App server.
// workerd's Durable Object, WebSocket and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off globalDate:off preferEffectArray:off schemaSync:off
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { APP_MIME_TYPE, appTool, modernServer } from "@cloudpid/mcp/testing";
import { secretReference } from "@cloudpid/extensions/secrets";
import type { McpApplySet } from "@cloudpid/mcp/types";
import {
  type ClientMessage,
  type ConversationId,
  McpAppContextAnswer,
  type McpAppEntry,
  projectEntry,
  ServerMessageJson,
  type ServerMessage,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Types from "effect/Types";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TestMcpHost } from "../mcp/host.fixture.ts";
import { poll } from "../poll.fixture.ts";
import type { TestSession } from "./host.fixture.ts";

declare global {
  namespace Cloudflare {
    /** The bindings `vitest.config.ts` gives the test Worker. */
    interface Env {
      readonly MCP_HOSTS: DurableObjectNamespace<TestMcpHost>;
      readonly SESSIONS: DurableObjectNamespace<TestSession>;
    }
  }
}

const settles = <A>(check: () => Promise<A>) =>
  vi.waitFor(check, { timeout: 10_000, interval: 50 });

let counter = 0;

const URI = "ui://docs/app";
const PAGE = "<main>fixture</main>";
const KIND = "cloudpid.mcp-app-context";

const SET: McpApplySet = {
  kind: "set",
  hash: "h1",
  revision: 1,
  entries: [
    {
      name: "docs",
      source: { kind: "global" },
      server: { type: "http", url: "https://docs.example/mcp", headers: {}, exposure: "direct" },
      hash: "hash-docs",
      conn: "conn-docs",
      identity: "identity-docs",
    },
  ],
};

const appServer = () =>
  modernServer({
    resources: [
      {
        uri: URI,
        name: "app",
        mimeType: APP_MIME_TYPE,
        contents: [{ uri: URI, mimeType: APP_MIME_TYPE, text: PAGE }],
      },
    ],
    moreTools: [appTool("app", URI)],
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

const idle = (stub: DurableObjectStub<TestSession>) =>
  settles(async () =>
    expect(await runInDurableObject(stub, (instance: TestSession) => instance.idle())).toBe(true),
  );

const decode = Schema.decodeUnknownEffect(ServerMessageJson);

const decodeAnswer = Schema.decodeUnknownSync(McpAppContextAnswer);

/** A client of a Session's socket that keeps every message the Session sent it. */
const connect = async (stub: DurableObjectStub<TestSession>) => {
  const response = await stub.fetch("http://session/socket", { headers: { Upgrade: "websocket" } });
  const socket = response.webSocket;

  if (socket === null) throw new Error(`No socket: ${response.status}`);
  socket.accept();

  const received: ServerMessage[] = [];

  socket.addEventListener("message", (event) => {
    received.push(Effect.runSync(decode(event.data)));
  });

  const until = async (done: (messages: readonly ServerMessage[]) => boolean) => {
    await poll(
      () => done(received),
      () => `Never received the expected messages: ${JSON.stringify(received)}`,
    );

    return received;
  };

  const send = (message: ClientMessage) => socket.send(JSON.stringify(message));

  const answer = async (id: string) => {
    const answered = (message: ServerMessage) => message.type === "result" && message.id === id;

    const messages = await until(Arr.some(answered));

    return Arr.findFirst(messages, answered).pipe(Option.getOrUndefined);
  };

  const hello = async () => {
    const [first] = await until((messages) => messages[0]?.type === "hello");

    if (first?.type !== "hello") throw new Error("No hello");

    return first;
  };

  return { received, send, until, answer, hello };
};

/** A Session over the real engine whose model has called the App tool once: its App call, a client, and the socket's helpers. */
const withApp = async () => {
  const server = appServer();

  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
    server.handle(new Request(input, init)),
  );

  const environment = `env-${counter++}`;
  const host = env.MCP_HOSTS.getByName(`mcp:${environment}`);

  await host.useRealEngine();
  await host.apply(SET);

  const stub = env.SESSIONS.getByName(`mcp-${environment}`);

  await runInDurableObject(stub, async (instance: TestSession) => {
    instance.mcpEnvironment(environment, 1);
    instance.script([`call:mcp__docs__app:${JSON.stringify({ text: "hi" })}`, "done"]);
    await instance.submit({ requestId: "turn-0", text: "call app" });
  });
  await idle(stub);

  const entry = (await runInDurableObject(stub, (instance: TestSession) => instance.appCalls())).at(
    -1,
  );

  if (entry === undefined) throw new Error("No App call was recorded");

  const client = await connect(stub);

  await client.hello();

  /** An App View's context, as its page forwards it: the answer. */
  const context = async (text: string, callId = entry.callId, conversationId?: ConversationId) => {
    const id = `ctx-${counter++}`;

    client.send(
      conversationId === undefined
        ? { type: "mcp_app_context", id, callId, text }
        : { type: "mcp_app_context", id, callId, text, conversationId },
    );

    const answered = await client.answer(id);

    return decodeAnswer(answered?.type === "result" ? answered.result : undefined);
  };

  /** The owner's send over the socket, with App messages: its answer. */
  const send = async (message: {
    readonly text: string;
    readonly app?: ReadonlyArray<{ readonly callId: string; readonly text: string }>;
  }) => {
    const id = `submit-${counter++}`;

    const submit: Types.Mutable<Extract<ClientMessage, { type: "submit" }>> = {
      type: "submit",
      id,
      input: message.text,
      requestId: id,
    };

    if (message.app !== undefined) submit.app = message.app;

    client.send(submit);

    return client.answer(id);
  };

  return { stub, host, entry, client, context, send };
};

type Rig = Awaited<ReturnType<typeof withApp>>;

const entries = (stub: DurableObjectStub<TestSession>, conversationId?: ConversationId) =>
  runInDurableObject(stub, (instance: TestSession) => instance.rootEntries(conversationId));

const callOf = async (rig: Rig): Promise<McpAppEntry | undefined> =>
  (await runInDurableObject(rig.stub, (instance: TestSession) => instance.appCalls())).find(
    (each) => each.callId === rig.entry.callId,
  );

const requests = (stub: DurableObjectStub<TestSession>) =>
  runInDurableObject(stub, (instance: TestSession) => instance.requestMessages());

describe("an App View's context in a Session", () => {
  it("says in hello that it takes mcp_app_context and submit.app, so a client sends them only to a Session that does", async () => {
    const { client } = await withApp();

    expect(await client.hello()).toMatchObject({ appMessages: true, appContext: true });
  });

  it("is held while the conversation is idle, writing nothing and starting no Run, and reaches the model with the owner's next input as an untrusted notice", async () => {
    const rig = await withApp();
    const { stub } = rig;
    const before = await entries(stub);
    const asked = (await requests(stub)).length;

    expect(await rig.context("The owner picked the red chart")).toMatchObject({
      status: "held",
      context: { text: "The owner picked the red chart" },
    });

    // Nothing was written, no Run began, and the model was asked nothing.
    expect(await entries(stub)).toEqual(before);
    expect(await runInDurableObject(stub, (instance: TestSession) => instance.idle())).toBe(true);
    expect((await requests(stub)).length).toBe(asked);

    // The card's chip: the last context, pending.
    expect((await callOf(rig))?.context).toMatchObject({ text: "The owner picked the red chart" });
    expect((await callOf(rig))?.context?.delivered).toBeUndefined();

    await runInDurableObject(stub, async (instance: TestSession) => {
      instance.script(["Noted."]);
      await instance.submit({ requestId: "turn-1", text: "what next?" });
    });
    await idle(stub);

    const all = await entries(stub);
    const notice = all.findIndex((each) => each.kind === KIND);
    const owner = all.findIndex((each, at) => at > notice && each.text === "what next?");

    // Written before the owner's input, which is placed after it.
    expect(notice).toBeGreaterThan(-1);
    expect(owner).toBe(notice + 1);
    expect(all[notice]?.data).toMatchObject({ notice: "App context", untrusted: true });
    expect(all[notice]?.text).toContain("untrusted");
    expect(all[notice]?.text).toContain(
      '<app server="docs" tool="app">The owner picked the red chart</app>',
    );

    // The model read the context in that notice and nowhere else: never in the owner's words nor in a tool result.
    const last = (await requests(stub)).at(-1) ?? "";

    const messages: ReadonlyArray<{ role: string; content: unknown }> = JSON.parse(last);

    const holding = messages.filter((message) =>
      JSON.stringify(message.content).includes("picked the red chart"),
    );

    expect(holding).toHaveLength(1);
    expect(holding[0]?.role).toBe("user");
    expect(JSON.stringify(holding[0]?.content)).toContain("<mcp_app_context>");
    expect(JSON.stringify(holding[0]?.content)).not.toContain("what next?");

    // The transcript shows it as a notice, and the chip says it was delivered.
    expect(projected(KIND, all[notice]?.data, all[notice]?.text ?? "")).toMatchObject({
      role: "notice",
      title: "App context",
    });
    expect((await callOf(rig))?.context).toMatchObject({ delivered: true });
  });

  it("is not given again: the same text (a remount) and what was delivered stay out, and a changed text goes", async () => {
    const rig = await withApp();
    const { stub } = rig;

    await rig.context("state one");
    await runInDurableObject(stub, async (instance: TestSession) => {
      instance.script(["a", "b", "c"]);
      await instance.submit({ requestId: "t-1", text: "first" });
    });
    await idle(stub);

    // The View is mounted again and sends the same context: held once, delivered already.
    expect(await rig.context("state one")).toMatchObject({ status: "held" });
    await runInDurableObject(stub, (instance: TestSession) =>
      instance.submit({ requestId: "t-2", text: "second" }),
    );
    await idle(stub);

    expect(Arr.filter(await entries(stub), (each) => each.kind === KIND)).toHaveLength(1);

    await rig.context("state two");
    await runInDurableObject(stub, (instance: TestSession) =>
      instance.submit({ requestId: "t-3", text: "third" }),
    );
    await idle(stub);

    const notices = Arr.filter(await entries(stub), (each) => each.kind === KIND);

    expect(notices).toHaveLength(2);
    expect(notices[1]?.text).toContain("state two");
    expect(notices[1]?.text).not.toContain("state one");
  });

  it("is cleaned, redacted of a held Secret and cut to 4 KB before it is held", async () => {
    const rig = await withApp();

    await runInDurableObject(rig.stub, (instance: TestSession) =>
      instance.hold({ TOKEN: "s3cr3t-value" }),
    );

    const answer = await rig.context(`a\u0000b\u0007 key s3cr3t-value ${"x".repeat(5000)}`);

    if (answer.status !== "held" || !("context" in answer) || answer.context === undefined) {
      throw new Error(`not held: ${JSON.stringify(answer)}`);
    }

    expect(answer.context.text).toContain(`ab key ${secretReference("TOKEN")} `);
    expect(answer.context.text).not.toContain("s3cr3t-value");
    expect(new TextEncoder().encode(answer.context.text).length).toBeLessThanOrEqual(4096);
  });

  it("is written at the next boundary of a busy conversation, one write in flight, and starts no Run", async () => {
    const rig = await withApp();
    const { stub } = rig;

    await runInDurableObject(stub, async (instance: TestSession) => {
      instance.script(["gate:Working on it."]);
      await instance.submit({ requestId: "busy-1", text: "go" });
      await instance.gated.promise;
    });

    expect(await runInDurableObject(stub, (instance: TestSession) => instance.idle())).toBe(false);

    await rig.context("while busy: one");
    // A second one while the first waits for its boundary stays pending: one write in flight.
    await rig.context("while busy: two");

    await runInDurableObject(stub, (instance: TestSession) => instance.open());
    await idle(stub);

    const notices = Arr.filter(await entries(stub), (each) => each.kind === KIND);

    expect(notices).toHaveLength(1);
    expect(notices[0]?.text).toContain("while busy: one");
    expect(notices[0]?.text).not.toContain("while busy: two");

    // The notice started no Run: the model was asked once for it, to answer the owner's message.
    expect((await requests(stub)).length).toBeGreaterThan(0);
    expect(
      await runInDurableObject(stub, (instance: TestSession) => instance.requests()),
    ).toHaveLength((await requests(stub)).length);
    expect((await callOf(rig))?.context).toMatchObject({ text: "while busy: two" });
    expect((await callOf(rig))?.context?.delivered).toBeUndefined();
  });

  it("is delivered for a collapsed View too, and is refused for a call the Session has no record of", async () => {
    const rig = await withApp();

    // A collapsed View is not mounted; what it sent before stays pending in the Session all the same.
    await rig.context("sent before it collapsed");
    expect(await rig.context("x", "no-such-call")).toMatchObject({ status: "refused" });

    await runInDurableObject(rig.stub, async (instance: TestSession) => {
      instance.script(["ok"]);
      await instance.submit({ requestId: "t-1", text: "hi" });
    });
    await idle(rig.stub);

    expect(Arr.filter(await entries(rig.stub), (each) => each.kind === KIND)).toHaveLength(1);
  });

  it("is dropped with a moved branch, and not carried by a Fork or a Clone", async () => {
    const rig = await withApp();
    const { stub } = rig;

    await rig.context("pending in the source");

    const target = `fork-${counter++}`;

    await runInDurableObject(stub, (instance: TestSession) =>
      instance.forkInto(target, { quiet: "none" }),
    );

    const copy = env.SESSIONS.getByName(target);

    // The record came with the Fork; the context did not.
    const copied = (
      await runInDurableObject(copy, (instance: TestSession) => instance.appCalls())
    ).at(-1);

    expect(copied).toMatchObject({ callId: rig.entry.callId });
    expect(copied?.context).toBeUndefined();

    await runInDurableObject(copy, async (instance: TestSession) => {
      instance.script(["ok"]);
      await instance.submit({ requestId: "copy-1", text: "hello" });
    });
    await idle(copy);
    expect(Arr.filter(await entries(copy), (each) => each.kind === KIND)).toEqual([]);

    // A new Session branch: moving the active branch off the conversation drops what was pending for it.
    const tree = await runInDurableObject(stub, (instance: TestSession) => instance.tree());
    const first = tree.nodes.find((node) => node.role === "user");

    if (first === undefined) throw new Error("No owner message");

    expect(
      await runInDurableObject(stub, (instance: TestSession) =>
        instance.navigate({ entryId: first.id, position: "before" }),
      ),
    ).toHaveProperty("navigated");
    expect((await callOf(rig))?.context).toBeUndefined();
  });
});

/** An owner's or a notice's entry as the transcript projects it. */
const projected = (
  kind: string,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- an entry's `data` as a test reads it back from the Session: the projection decodes it.
  data: unknown,
  content: string | ReadonlyArray<{ readonly type: "text"; readonly text: string }>,
) =>
  // SAFETY: a record of the shape `projectEntry` reads: a test's own, with the fields it does not read left out.
  projectEntry({
    id: 1,
    conversationId: 1,
    kind,
    data,
    model: [{ role: "user", content, timestamp: 0 }],
  } as never);

describe("an App View's context in /export", () => {
  it("is in the export beside the App's call, pending and then sent to the model", async () => {
    const rig = await withApp();
    const { stub } = rig;

    const exported = () =>
      runInDurableObject(stub, async (instance: TestSession) => {
        const answer = await instance.command("export", "");

        if (!("outcome" in answer)) throw new Error(answer.failure);

        return answer.outcome.file?.content ?? "";
      });

    expect(await exported()).not.toContain("Last App context");

    await rig.context("picked the red chart");
    expect(await exported()).toContain(
      "_App: docs/app (not rendered)_\n\nLast App context (pending, not yet sent):\n\n> picked the red chart",
    );

    await runInDurableObject(stub, async (instance: TestSession) => {
      instance.script(["Noted."]);
      await instance.submit({ requestId: "export-1", text: "next" });
    });
    await idle(stub);
    expect(await exported()).toContain(
      "Last App context (sent to the model):\n\n> picked the red chart",
    );
  });
});

describe("an App View kept across a move of the active branch", () => {
  const nodes = (stub: DurableObjectStub<TestSession>) =>
    runInDurableObject(stub, (instance: TestSession) => instance.tree());

  it("gives its context to the branch moved to, whose History holds the call, at the next input there", async () => {
    const rig = await withApp();
    const { stub } = rig;
    const answer = (await nodes(stub)).nodes.find((node) => node.role === "assistant");

    if (answer === undefined) throw new Error("No answer");

    const root = await runInDurableObject(stub, (instance: TestSession) => instance.activeBranch());

    // A new branch at the message that made the call: made in the conversation left, it is in this one's History.
    expect(
      await runInDurableObject(stub, (instance: TestSession) =>
        instance.navigate({ entryId: answer.id, position: "at" }),
      ),
    ).toHaveProperty("navigated");

    const branch = await runInDurableObject(stub, (instance: TestSession) =>
      instance.activeBranch(),
    );

    expect(branch).not.toBe(root);

    // Shown in the branch moved to, it is given to that one, not to the conversation the call was made in.
    expect(await rig.context("picked the blue chart", rig.entry.callId, branch)).toMatchObject({
      status: "held",
    });

    await runInDurableObject(stub, async (instance: TestSession) => {
      instance.script(["Noted."]);
      await instance.submit({ requestId: "moved-1", text: "and now?" });
    });
    await idle(stub);

    const notice = (await entries(stub, branch)).filter((each) => each.kind === KIND);

    expect(notice).toHaveLength(1);
    expect(notice[0]?.text).toContain('<app server="docs" tool="app">picked the blue chart</app>');
    expect((await callOf(rig))?.context).toMatchObject({
      text: "picked the blue chart",
      delivered: true,
    });
  });

  /** Move the active branch to a new one at `position` of the first assistant or owner message; its ID. */
  const moveTo = async (
    stub: DurableObjectStub<TestSession>,
    role: "assistant" | "user",
    position: "at" | "before",
    which = 0,
  ) => {
    const node = (await nodes(stub)).nodes.filter((each) => each.role === role)[which];

    if (node === undefined) throw new Error(`No ${role} message`);

    expect(
      await runInDurableObject(stub, (instance: TestSession) =>
        instance.navigate({ entryId: node.id, position }),
      ),
    ).toHaveProperty("navigated");

    return runInDurableObject(stub, (instance: TestSession) => instance.activeBranch());
  };

  const noticesOf = async (stub: DurableObjectStub<TestSession>, branch: ConversationId) =>
    Arr.filter(await entries(stub, branch), (each) => each.kind === KIND);

  it("refuses it, when the branch moved to does not hold the call and the conversation the call was made in was left", async () => {
    const rig = await withApp();
    const { stub } = rig;

    // A branch from before the call: its History does not hold it, and the conversation the call was made in is left.
    const branch = await moveTo(stub, "user", "before");

    expect(await rig.context("not for this branch", rig.entry.callId, branch)).toMatchObject({
      status: "refused",
    });
    // From an App Pane, which names no conversation: the same.
    expect(await rig.context("from a pane")).toMatchObject({ status: "refused" });
    expect((await callOf(rig))?.context).toBeUndefined();

    await runInDurableObject(stub, async (instance: TestSession) => {
      instance.script(["ok"]);
      await instance.submit({ requestId: "other-1", text: "hello" });
    });
    await idle(stub);

    expect(await noticesOf(stub, branch)).toEqual([]);
  });

  it("remembers that a branch made before the call does not hold it, for that branch only", async () => {
    const rig = await withApp();
    const { stub } = rig;
    const before = await moveTo(stub, "user", "before");

    expect(await rig.context("not yet", rig.entry.callId, before)).toMatchObject({
      status: "refused",
    });
    // A refusal again, now from what is remembered.
    expect(await rig.context("still not", rig.entry.callId, before)).toMatchObject({
      status: "refused",
    });

    // A branch made at the call holds it, though another branch was found not to.
    const at = await moveTo(stub, "assistant", "at");

    expect(at).not.toBe(before);
    expect(await rig.context("now", rig.entry.callId, at)).toMatchObject({ status: "held" });
  });

  it("does not take a branch's History for holding the call because it holds other calls", async () => {
    const rig = await withApp();
    const { stub } = rig;
    const branch = await moveTo(stub, "user", "before");

    // The branch makes a call of its own to the same tool: its History holds that one, not the first.
    await runInDurableObject(stub, async (instance: TestSession) => {
      instance.script([`call:mcp__docs__app:${JSON.stringify({ text: "again" })}`, "done"]);
      await instance.submit({ requestId: "again-1", text: "call it again" });
    });
    await idle(stub);

    const second = (
      await runInDurableObject(stub, (instance: TestSession) => instance.appCalls(branch))
    ).at(-1);

    expect(second).toBeDefined();
    expect(await rig.context("for the first call", rig.entry.callId, branch)).toMatchObject({
      status: "refused",
    });
    expect(await rig.context("for the second", second?.callId, branch)).toMatchObject({
      status: "held",
    });
  });

  it("gives it to the active branch when the page names no conversation and the call was made in one left, if that branch holds the call", async () => {
    const rig = await withApp();
    const { stub } = rig;
    const branch = await moveTo(stub, "assistant", "at");

    // An App Pane names no conversation; the call's own is the root, which was left.
    expect(await rig.context("from a pane")).toMatchObject({ status: "held" });

    await runInDurableObject(stub, async (instance: TestSession) => {
      instance.script(["Noted."]);
      await instance.submit({ requestId: "pane-1", text: "and now?" });
    });
    await idle(stub);

    expect(await noticesOf(stub, branch)).toHaveLength(1);
  });

  it("tells a busy branch moved to at once, writing the notice at its next boundary", async () => {
    const rig = await withApp();
    const { stub } = rig;
    const branch = await moveTo(stub, "assistant", "at");

    await runInDurableObject(stub, async (instance: TestSession) => {
      instance.script(["gate:Working on it."]);
      await instance.submit({ requestId: "busy-moved", text: "go" });
      await instance.gated.promise;
    });
    expect(await rig.context("while busy", rig.entry.callId, branch)).toMatchObject({
      status: "held",
    });
    await runInDurableObject(stub, (instance: TestSession) => instance.open());
    await idle(stub);

    // No other input was sent: the busy conversation was told as its run went on.
    expect(await noticesOf(stub, branch)).toHaveLength(1);
  });

  it("finds a call nested in a codemode script by the script's call, which is the one in the History", async () => {
    const rig = await withApp();
    const { stub } = rig;
    const branch = await moveTo(stub, "assistant", "at");

    await runInDurableObject(stub, (instance: TestSession) =>
      instance.appPut({
        callId: "nested-1",
        parentCall: rig.entry.callId,
        server: "docs",
        tool: "app",
        conversation: "1",
        arguments: {},
        htmlHash: "hash-nested",
        result: { content: [{ type: "text", text: "ok" }] },
      }),
    );
    expect(await rig.context("from a nested call", "nested-1", branch)).toMatchObject({
      status: "held",
    });

    await runInDurableObject(stub, async (instance: TestSession) => {
      instance.script(["Noted."]);
      await instance.submit({ requestId: "nested-1", text: "and now?" });
    });
    await idle(stub);

    expect((await noticesOf(stub, branch))[0]?.text).toContain("from a nested call");
  });

  it("is exported as held for another branch by a branch whose model never read it", async () => {
    const rig = await withApp();
    const { stub } = rig;
    const root = await runInDurableObject(stub, (instance: TestSession) => instance.activeBranch());

    await runInDurableObject(stub, async (instance: TestSession) => {
      instance.script(["Fine."]);
      await instance.submit({ requestId: "second-turn", text: "another turn" });
    });
    await idle(stub);

    // A branch from before the second turn: its History holds the call and its result.
    const branch = await moveTo(stub, "user", "before", 1);

    await rig.context("seen by the new branch", rig.entry.callId, branch);
    await runInDurableObject(stub, async (instance: TestSession) => {
      instance.script(["Noted."]);
      await instance.submit({ requestId: "export-moved", text: "next" });
    });
    await idle(stub);

    const exported = () =>
      runInDurableObject(stub, async (instance: TestSession) => {
        const answer = await instance.command("export", "");

        if (!("outcome" in answer)) throw new Error(answer.failure);

        return answer.outcome.file?.content ?? "";
      });

    expect(await exported()).toContain("Last App context (sent to the model)");

    // Back on the branch the call was made in: the model there never read it.
    const home = (await nodes(stub)).nodes.findLast(
      (node) => node.role === "assistant" && node.conversationId === root,
    );

    if (home === undefined) throw new Error("No answer on the first branch");

    await runInDurableObject(stub, (instance: TestSession) =>
      instance.navigate({ entryId: home.id, position: "at" }),
    );
    expect(await runInDurableObject(stub, (instance: TestSession) => instance.activeBranch())).toBe(
      root,
    );

    const content = await exported();

    expect(content).toContain("Last App context (held for another Session branch)");
    expect(content).not.toContain("sent to the model");
  });
});

describe("an App message in a Session", () => {
  it("goes with the owner's own send as a part of its own after what they typed, named by the call's server, and is kept for the transcript", async () => {
    const rig = await withApp();

    await runInDurableObject(rig.stub, (instance: TestSession) => instance.script(["Sure."]));

    expect(
      await rig.send({
        text: "Please look",
        app: [{ callId: rig.entry.callId, text: "Compare the two charts" }],
      }),
    ).toMatchObject({ type: "result" });
    await idle(rig.stub);

    expect(
      await runInDurableObject(rig.stub, (instance: TestSession) => instance.lastUserContent()),
    ).toEqual(["text:Please look", "text:Compare the two charts"]);

    const owner = (await entries(rig.stub)).findLast((each) => each.kind === "cloudpid.user");

    expect(owner?.data).toMatchObject({
      display: "Please look",
      app: [{ callId: rig.entry.callId, server: "docs", text: "Compare the two charts" }],
    });

    // The transcript shows the typed text and the App's block, not two texts of the owner's.
    expect(
      projected("cloudpid.user", owner?.data, [
        { type: "text", text: "Please look" },
        { type: "text", text: "Compare the two charts" },
      ]),
    ).toMatchObject({
      role: "user",
      parts: [{ type: "text", text: "Please look" }],
      app: [{ server: "docs", text: "Compare the two charts" }],
    });
  });

  it("is redacted of a held Secret, and is no notice and no context: it starts a Run only as the owner's send", async () => {
    const rig = await withApp();

    await runInDurableObject(rig.stub, (instance: TestSession) =>
      instance.hold({ TOKEN: "s3cr3t-value" }),
    );

    const asked = (await requests(rig.stub)).length;

    // Nothing of an App message is held or written until the owner sends it: the Session sees none of it.
    expect(await runInDurableObject(rig.stub, (instance: TestSession) => instance.idle())).toBe(
      true,
    );
    expect((await requests(rig.stub)).length).toBe(asked);

    await runInDurableObject(rig.stub, (instance: TestSession) => instance.script(["ok"]));
    await rig.send({ text: "", app: [{ callId: rig.entry.callId, text: "use s3cr3t-value now" }] });
    await idle(rig.stub);

    const content = await runInDurableObject(rig.stub, (instance: TestSession) =>
      instance.lastUserContent(),
    );

    expect(content).toEqual([`text:use ${secretReference("TOKEN")} now`]);
    expect(Arr.filter(await entries(rig.stub), (each) => each.kind === KIND)).toEqual([]);
  });

  it("is named with no server when its call's record is gone, and cannot go with a Review", async () => {
    const rig = await withApp();

    await runInDurableObject(rig.stub, (instance: TestSession) => instance.script(["ok"]));
    await rig.send({ text: "hi", app: [{ callId: "evicted-call", text: "an old offer" }] });
    await idle(rig.stub);

    const owner = (await entries(rig.stub)).findLast((each) => each.kind === "cloudpid.user");

    expect(owner?.data).toMatchObject({ app: [{ callId: "evicted-call", server: "" }] });

    const id = `review-${counter++}`;

    rig.client.send({
      type: "submit",
      id,
      input: "summary",
      annotations: ["draft-1"],
      app: [{ callId: rig.entry.callId, text: "x" }],
    });

    const messages = await rig.client.until((all) =>
      all.some((message) => message.type === "error" && message.id === id),
    );

    expect(messages).toContainEqual(
      expect.objectContaining({
        type: "error",
        id,
        message: expect.stringContaining("App messages cannot go with a Review"),
      }),
    );
  });
});
