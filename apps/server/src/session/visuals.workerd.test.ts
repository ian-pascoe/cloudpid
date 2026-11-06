// Visuals in a Session end to end (`docs/architecture/visuals.md` → Testing): a model's `visual_show` call keeps its page in the
// Session's storage, outside History, which `visual_page` answers with the Session's origin, after the object restarts too; the
// sockets say `hello.visuals`, and send a watched conversation's Visuals (`visuals`) after its view and as they change; past its
// bounds the least recently mounted Visual becomes a stub its card can still show; an earlier Visual of the same file is the
// one a show supersedes; and the call's `pi.tool.visual_show` span carries counts and fixed values, never the page's words.
// workerd's Durable Object, WebSocket and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off preferEffectArray:off
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  type ClientMessage,
  MAX_VISUAL_BYTES,
  ServerMessageJson,
  type ServerMessage,
  type VisualDraft,
  type VisualEntry,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vitest";
import { viewOrigin } from "../view-host.ts";
import { visualViewHash } from "../view-hash.ts";
import { poll } from "../poll.fixture.ts";
import type { TestSession } from "./host.fixture.ts";
import { visualFileAnswer } from "./visuals-store.ts";

declare global {
  namespace Cloudflare {
    /** The bindings `vitest.config.ts` gives the test Worker. */
    interface Env {
      readonly SESSIONS: DurableObjectNamespace<TestSession>;
    }
  }
}

const settles = <A>(check: () => Promise<A>) =>
  vi.waitFor(check, { timeout: 10_000, interval: 50 });

let counter = 0;

/** A Session with `visual_show`, under a name of its own (a Session's name is its ID, which its Visuals' origin is of). */
const fresh = () => {
  const name = `visuals-${counter++}`;

  return { name, stub: env.SESSIONS.getByName(name) };
};

const idle = (stub: DurableObjectStub<TestSession>) =>
  settles(async () =>
    expect(await runInDurableObject(stub, (instance: TestSession) => instance.idle())).toBe(true),
  );

const PAGE = "<!doctype html><html><head></head><body><h1>Sales</h1></body></html>";

/** The model calls `visual_show` with `args`, and the call is done. */
const show = async (stub: DurableObjectStub<TestSession>, args: Record<string, string>) => {
  await runInDurableObject(stub, async (instance: TestSession) => {
    instance.script([`call:visual_show:${JSON.stringify(args)}`, "done"]);
    await instance.submit({ requestId: `turn-${counter++}`, text: "show it" });
  });
  await idle(stub);
};

const decode = Schema.decodeUnknownEffect(ServerMessageJson);

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

  return {
    received,
    send,
    until,
    /** The `result` of command `id`. */
    answer: async (id: string) => {
      const answered = (message: ServerMessage) => message.type === "result" && message.id === id;
      const messages = await until(Arr.some(answered));
      const found = Arr.findFirst(messages, answered).pipe(Option.getOrUndefined);

      return found?.type === "result" ? found.result : undefined;
    },
    /** The newest `visuals` list of `conversationId` once `done` holds of it. */
    visuals: async (
      conversationId: number,
      done: (visuals: ReadonlyArray<VisualEntry>) => boolean = () => true,
    ) => {
      const latest = (messages: readonly ServerMessage[]) =>
        Arr.findLast(
          messages,
          (message) => message.type === "visuals" && message.conversationId === conversationId,
        ).pipe(
          Option.flatMap((message) =>
            message.type === "visuals" ? Option.some(message.visuals) : Option.none(),
          ),
        );

      const messages = await until((all) =>
        Option.match(latest(all), { onNone: () => false, onSome: done }),
      );

      return Option.getOrElse(latest(messages), () => []);
    },
    root: async () => {
      const [hello] = await until((messages) => messages[0]?.type === "hello");

      if (hello?.type !== "hello") throw new Error("No hello");

      return hello;
    },
    close: () => {
      socket.close();
    },
  };
};

/** A draft of a Visual in conversation 1 (a test's root), of `html`, from `path` when given. */
const draft = (callId: string, html: string, path?: string): VisualDraft => ({
  callId,
  conversation: "1",
  title: `Visual ${callId}`,
  summary: `What ${callId} shows`,
  source: path === undefined ? { kind: "inline" } : { kind: "path", path },
  html,
  bytes: new TextEncoder().encode(html).length,
  warnings: [],
});

describe("a Visual shown in a Session", () => {
  it("says in hello that the Session keeps Visuals", async () => {
    const { stub } = fresh();
    const client = await connect(stub);

    expect(await client.root()).toMatchObject({ type: "hello", visuals: true });
    client.close();
  });

  it("keeps the page of a call outside History, and answers it with the Session's origin, after a restart too", async () => {
    const { name, stub } = fresh();
    const client = await connect(stub);
    const { root } = await client.root();

    client.send({ type: "watch", conversationId: root });
    await client.visuals(root);

    await show(stub, { html: PAGE, title: "Sales", summary: "Sales by month, as bars" });

    const [entry] = await client.visuals(root, (visuals) => visuals.length === 1);

    expect(entry).toMatchObject({
      title: "Sales",
      summary: "Sales by month, as bars",
      source: { kind: "inline" },
      state: "kept",
      bytes: new TextEncoder().encode(PAGE).length,
    });

    const callId = entry?.callId ?? "";

    expect(
      await runInDurableObject(stub, (instance: TestSession) => instance.toolResults()),
    ).toEqual(['Shown "Sales". Don\'t restate it.']);
    expect(
      await runInDurableObject(stub, (instance: TestSession) => instance.toolResultDetails()),
    ).toEqual([
      {
        visual: {
          id: callId,
          title: "Sales",
          summary: "Sales by month, as bars",
          bytes: new TextEncoder().encode(PAGE).length,
          source_path: null,
          supersedes: null,
          warnings: [],
        },
      },
    ]);

    const origin = viewOrigin({ hash: visualViewHash(name), label: undefined, local: false });

    client.send({ type: "visual_page", id: "p1", callId });
    expect(await client.answer("p1")).toMatchObject({
      status: "page",
      origin,
      record: { callId, html: PAGE, title: "Sales", conversation: String(root) },
    });

    client.send({ type: "visual_page", id: "p2", callId: "no-such-call" });
    expect(await client.answer("p2")).toEqual({ status: "none" });
    client.close();

    await evictDurableObject(stub);

    const again = await connect(stub);

    again.send({ type: "visual_page", id: "p3", callId });
    expect(await again.answer("p3")).toMatchObject({ status: "page", record: { html: PAGE } });
    again.close();
  });

  it("fails a call that gives both sources, and keeps nothing", async () => {
    const { stub } = fresh();

    await show(stub, { html: PAGE, path: "/workspace/a.html", title: "t", summary: "s" });

    expect(
      await runInDurableObject(stub, (instance: TestSession) => instance.toolResults()),
    ).toEqual(["Give exactly one of path or html, not both"]);

    const client = await connect(stub);
    const { root } = await client.root();

    client.send({ type: "watch", conversationId: root });
    expect(await client.visuals(root)).toEqual([]);
    client.close();
  });

  it("names the earlier Visual of the same file in the conversation as the one a show supersedes", async () => {
    const { stub } = fresh();

    const kept = await runInDurableObject(stub, async (instance: TestSession) => [
      await instance.visualPut(draft("a", PAGE, "/workspace/v.html")),
      await instance.visualPut(draft("b", PAGE, "/workspace/other.html")),
      await instance.visualPut(draft("c", PAGE, "/workspace/v.html")),
      await instance.visualPut(draft("d", PAGE)),
    ]);

    expect(Arr.map(kept, (each) => each.supersedes)).toEqual([
      undefined,
      undefined,
      "a",
      undefined,
    ]);
  });

  it("answers Open file with the file the record names, never one the client does, and nothing for an inline page", async () => {
    const { stub } = fresh();

    await runInDurableObject(stub, async (instance: TestSession) => {
      await instance.visualPut(draft("file", PAGE, "/workspace/v.html"));
      await instance.visualPut(draft("inline", PAGE));
    });

    const client = await connect(stub);

    await client.root();
    client.send({ type: "visual_file", id: "f1", callId: "inline" });
    expect(await client.answer("f1")).toEqual({ status: "none" });
    client.send({ type: "visual_file", id: "f2", callId: "no-such-call" });
    expect(await client.answer("f2")).toEqual({ status: "none" });
    // The test's Session has no Workspace to read it from.
    client.send({ type: "visual_file", id: "f3", callId: "file" });
    expect(await client.answer("f3")).toEqual({ status: "missing", path: "/workspace/v.html" });
    client.close();
  });

  it("reads a file for Open file as its UTF-8 text, or says why not", () => {
    const path = "/workspace/v.html";

    expect(visualFileAnswer(path, { kind: "base64", base64: btoa("<p>hi</p>") })).toEqual({
      status: "text",
      path,
      text: "<p>hi</p>",
    });
    expect(visualFileAnswer(path, { kind: "base64", base64: btoa("\u00ff\u00fe") })).toEqual({
      status: "not_text",
      path,
    });
    expect(visualFileAnswer(path, { kind: "too_large" })).toEqual({ status: "too_large", path });
    expect(visualFileAnswer(path, { kind: "missing" })).toEqual({ status: "missing", path });
  });

  it("evicts the least recently mounted Visual to a stub its card still shows, never the one just kept", async () => {
    const { stub } = fresh();
    const client = await connect(stub);
    const { root } = await client.root();

    client.send({ type: "watch", conversationId: root });
    await client.visuals(root);

    // Sixteen pages of nearly 2 MiB fill the 32 MiB; mounting the first makes the second the least recently mounted.
    const big = `<!doctype html><p>${"x".repeat(MAX_VISUAL_BYTES - 64)}</p>`;

    await runInDurableObject(stub, async (instance: TestSession) => {
      for (let n = 0; n < 16; n++) await instance.visualPut(draft(`v${n}`, big));
    });

    client.send({ type: "visual_page", id: "m0", callId: "v0" });
    expect(await client.answer("m0")).toMatchObject({ status: "page" });

    const kept = await runInDurableObject(stub, (instance: TestSession) =>
      instance.visualPut(draft("v16", big)),
    );

    expect(kept.evicted).toBe(1);

    const visuals = await client.visuals(root, (list) => list.length === 17);

    expect(
      Arr.map(
        Arr.filter(visuals, (each) => each.state === "evicted"),
        (each) => each.callId,
      ),
    ).toEqual(["v1"]);

    client.send({ type: "visual_page", id: "m1", callId: "v1" });
    expect(await client.answer("m1")).toEqual({
      status: "evicted",
      stub: {
        callId: "v1",
        conversation: "1",
        title: "Visual v1",
        summary: "What v1 shows",
        source: { kind: "inline" },
        bytes: new TextEncoder().encode(big).length,
        at: expect.any(Number),
      },
    });
    client.close();
  });

  it("puts counts and fixed values on the call's span, never its title, summary or page", async () => {
    const { stub } = fresh();

    await show(stub, {
      html: '<p>fragment <img src="https://example.com/x.png"></p>',
      title: "Secret title",
      summary: "Secret summary",
    });
    await show(stub, { title: "t", summary: "s" });

    const spans = await runInDurableObject(stub, (instance: TestSession) =>
      Arr.filter(instance.spans(), (span) => span.name === "pi.tool.visual_show"),
    );

    expect(spans).toHaveLength(2);
    expect(spans[0]?.attributes).toMatchObject({
      "tool.is_error": false,
      "visual.source": "inline",
      "visual.warnings": 2,
      "visual.warning.wrapped": 1,
      "visual.warning.host_not_listed": 1,
      "visual.evicted": 0,
      "visual.inlined.images": 0,
    });
    expect(spans[1]?.attributes).toMatchObject({
      "tool.is_error": true,
      "visual.failure": "no_source",
    });

    const recorded = JSON.stringify(spans);

    for (const words of ["Secret title", "Secret summary", "fragment", "example.com"]) {
      expect(recorded).not.toContain(words);
    }
  });

  it("tells the model when to show a Visual in a section of its own, which the tool's grant shows", async () => {
    const { stub } = fresh();

    await show(stub, { html: PAGE, title: "t", summary: "s" });

    const sections = await runInDurableObject(stub, (instance: TestSession) =>
      instance.requestSection("visuals"),
    );

    expect(sections[0]).toContain("visual_show");
    // Frozen: every request of the Context Window shows the same text.
    expect(new Set(sections).size).toBe(1);
  });
});
