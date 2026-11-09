// Visuals in a Session end to end (`docs/architecture/visuals.md` → Testing): a model's `visual_show` call keeps its page in the
// Session's storage, outside History, which `visual_page` answers with the Session's origin, after the object restarts too; the
// sockets say `hello.visuals`, and send a watched conversation's Visuals (`visuals`) after its view and as they change; past its
// bounds the least recently mounted Visual becomes a stub its card can still show; an earlier Visual of the same file is the
// one a show supersedes; the call's `pi.tool.visual_show` span carries counts and fixed values, never the page's words; and a
// Fork or Clone shows the Visuals of the calls it copies, across builds too, where what a build cannot use is "no longer kept".
// workerd's Durable Object, WebSocket and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off preferEffectArray:off
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  type ClientMessage,
  MAX_VISUAL_BYTES,
  ServerMessageJson,
  type ServerMessage,
  isRecordCopy,
  type VisualCopy,
  type VisualDraft,
  type VisualEntry,
  type VisualRecord,
} from "@cloudpid/protocol";
import type { VisualCheckInput, VisualCheckResult } from "@cloudpid/extensions/browser/contract";
import type { JsonValue } from "@earendil-works/pi-ai";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vitest";
import { viewOrigin } from "../view-host.ts";
import { visualViewHash } from "../view-hash.ts";
import { poll } from "../poll.fixture.ts";
import type { ExportPage, ForkSourceRequest } from "./fork.ts";
import type { TestSession } from "./host.fixture.ts";
import { visualFileAnswer } from "./visual-file.ts";

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

/** The model calls `visual_check` with `args`, and the call is done. */
const check = async (
  stub: DurableObjectStub<TestSession>,
  args: Record<string, string | number>,
) => {
  await runInDurableObject(stub, async (instance: TestSession) => {
    instance.script([`call:visual_check:${JSON.stringify(args)}`, "done"]);
    await instance.submit({ requestId: `turn-${counter++}`, text: "check it" });
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

  describe("checked with visual_check", () => {
    const FOUND: VisualCheckResult = {
      coldStart: true,
      contentHeight: 5_200,
      screenshot: { data: "AAAA", mimeType: "image/jpeg", top: 0, height: 3_000, quality: 80 },
      clipped: true,
      growth: { grows: false, heights: [5_200, 5_200] },
      console: [{ type: "error", text: "secret console words" }],
      violations: ["connect-src blocked https://secret.example/api"],
      failedLoads: [{ url: "https://secret.example/x.png", reason: "csp" }],
      warnings: [],
    };

    /** Script what the browser host answers a check: its result, or the failure of the call. */
    const script = (
      stub: DurableObjectStub<TestSession>,
      kvKey: "visual-check-result" | "visual-check-failure",
      value: VisualCheckResult | { message: string; unavailable?: boolean; busy?: boolean },
    ) =>
      runInDurableObject(stub, (_instance: TestSession, state) => {
        state.storage.kv.put(kvKey, value);
      });

    /** The pages the browser host was asked to check, oldest first; none when it was never asked. */
    const asked = (stub: DurableObjectStub<TestSession>) =>
      runInDurableObject(stub, (_instance: TestSession, state) =>
        // SAFETY: the test host (`testBrowserHost`) keeps each `VisualCheckInput` it is given under this key.
        state.storage.kv.get<VisualCheckInput[]>("visual-checks"),
      );

    it("asks the browser host to render the prepared page at the width, theme and top, and tells the model what it found", async () => {
      const { stub } = fresh();

      await script(stub, "visual-check-result", FOUND);
      await check(stub, { html: PAGE, width: 360, theme: "dark", top: 100 });

      const pages = await asked(stub);

      expect(pages).toHaveLength(1);
      expect(pages?.[0]).toMatchObject({ width: 360, theme: "dark", top: 100 });
      expect(pages?.[0]?.html).toContain("<h1>Sales</h1>");

      const [text] = await runInDurableObject(stub, (instance: TestSession) =>
        instance.toolResults(),
      );

      expect(text).toContain("Checked at 360 px wide in the dark theme");
      expect(text).toContain("5200 px tall");
      expect(text).toContain("check again with top 3000");
      expect(text).toContain('[error] "secret console words"');
      expect(text).toContain('"connect-src blocked https://secret.example/api"');
      expect(text).toContain('"https://secret.example/x.png" (csp)');
    });

    it("renders at the thread's width in the light theme from the top unless told otherwise, and keeps nothing", async () => {
      const { stub } = fresh();

      await check(stub, { html: PAGE });

      expect(await asked(stub)).toMatchObject([{ width: 736, theme: "light", top: 0 }]);

      const client = await connect(stub);
      const { root } = await client.root();

      client.send({ type: "watch", conversationId: root });
      expect(await client.visuals(root)).toEqual([]);
      client.close();
    });

    it("fails as not checked when the browser is unavailable", async () => {
      const { stub } = fresh();

      await script(stub, "visual-check-failure", {
        message: "checkVisual: Error: Browser Run is down",
      });
      await check(stub, { html: PAGE });

      const [text] = await runInDurableObject(stub, (instance: TestSession) =>
        instance.toolResults(),
      );

      expect(text).toContain("Not checked");
      expect(text).toContain("Browser Run is down");
    });

    it("fails as busy, not as the browser's fault, when the host holds as many checks as it takes", async () => {
      const { stub } = fresh();

      await script(stub, "visual-check-failure", {
        message: "checkVisual: the Session's browser is busy with other checks",
        busy: true,
      });
      await check(stub, { html: PAGE });

      const [text] = await runInDurableObject(stub, (instance: TestSession) =>
        instance.toolResults(),
      );

      expect(text).toContain("visual_check is busy");
      expect(text).not.toContain("Not checked");
      expect(text).not.toContain("the browser could not render");
    });

    it("puts counts and fixed values on the call's span, never the page's words, the console's or a host", async () => {
      const { stub } = fresh();

      await script(stub, "visual-check-result", FOUND);
      await check(stub, { html: "<p>secret page words</p>", width: 360 });

      const spans = await runInDurableObject(stub, (instance: TestSession) =>
        Arr.filter(instance.spans(), (span) => span.name === "pi.tool.visual_check"),
      );

      expect(spans).toHaveLength(1);
      expect(spans[0]?.attributes).toMatchObject({
        "tool.is_error": false,
        "visual.width": 360,
        "visual.theme": "light",
        "visual.cold_start": true,
        "visual.outcome": "checked",
        "visual.console": 1,
        "visual.violations": 1,
        "visual.failed_loads": 1,
        "visual.content_height": 5_200,
        "visual.screenshot_bytes": 3,
        "visual.clipped": true,
      });

      const recorded = JSON.stringify(spans);

      for (const words of ["secret page words", "secret console words", "secret.example"]) {
        expect(recorded).not.toContain(words);
      }
    });
  });
});

type Answered = Awaited<ReturnType<Awaited<ReturnType<typeof connect>>["answer"]>>;

/** A copy another build might send: an RPC's value is never decoded, so any shape arrives. */
// SAFETY: that is the point of the test; `adopt` reads a copy by its shape and skips what it cannot use.
// oxlint-disable-next-line anti-slop/no-chained-type-assertions
const copyOf = (value: JsonValue): VisualCopy => value as VisualCopy;

describe("the Visuals a Fork or Clone carries", () => {
  /** Copy `source` into a new Session of the Visuals' name, `transit` changing what its pages carry on the way. */
  const copyInto = async (
    source: DurableObjectStub<TestSession>,
    request: ForkSourceRequest,
    transit?: (page: ExportPage) => ExportPage,
  ) => {
    const name = `visuals-copy-${counter++}`;

    await runInDurableObject(source, (instance: TestSession) =>
      instance.forkInto(name, request, transit),
    );

    return { name, stub: env.SESSIONS.getByName(name) };
  };

  /** A Clone of `source`: a copy with no point, of its latest entry. */
  const cloneOf = (
    source: DurableObjectStub<TestSession>,
    transit?: (page: ExportPage) => ExportPage,
  ) => copyInto(source, { quiet: "none" }, transit);

  /** A Fork of `source` just before its `n`th owner's message (from 1). */
  const forkBefore = async (source: DurableObjectStub<TestSession>, n: number) => {
    const tree = await runInDurableObject(source, (instance: TestSession) => instance.tree());
    const message = tree.nodes.filter((node) => node.role === "user")[n - 1];

    if (message === undefined) throw new Error(`No owner message ${n}`);

    return copyInto(source, { point: { entryId: message.id, position: "before" }, quiet: "none" });
  };

  /** What a Session's clients are told of its root conversation's Visuals, and its answer to `visual_page` for each of `callIds`. */
  const seen = async (
    stub: DurableObjectStub<TestSession>,
    callIds: ReadonlyArray<string> = [],
  ) => {
    const client = await connect(stub);
    const { root } = await client.root();

    client.send({ type: "watch", conversationId: root });

    const visuals = await client.visuals(root);
    const pages: Record<string, Answered> = {};

    for (const callId of callIds) {
      client.send({ type: "visual_page", id: `page-${callId}`, callId });
      pages[callId] = await client.answer(`page-${callId}`);
    }

    client.close();

    return { root, visuals, pages };
  };

  /** A Session that showed two Visuals, in two owner messages, and the two calls' IDs. */
  const showedTwo = async () => {
    const { stub } = fresh();

    await show(stub, { html: PAGE, title: "First", summary: "The first, as bars" });
    await show(stub, {
      html: `${PAGE}<p>2</p>`,
      title: "Second",
      summary: "The second, as a table",
    });

    const { visuals } = await seen(stub);
    const [first, second] = Arr.map(visuals, (each) => each.callId);

    if (first === undefined || second === undefined)
      throw new Error("The Session has no two Visuals");

    return { stub, first, second };
  };

  it("shows the source's Visuals in a Clone, each page at the Clone's own origin", async () => {
    const { stub, first, second } = await showedTwo();
    const clone = await cloneOf(stub);
    const { root, visuals, pages } = await seen(clone.stub, [first]);

    expect(Arr.map(visuals, (each) => [each.callId, each.title, each.state])).toEqual([
      [first, "First", "kept"],
      [second, "Second", "kept"],
    ]);
    expect(pages[first]).toMatchObject({
      status: "page",
      origin: viewOrigin({ hash: visualViewHash(clone.name), label: undefined, local: false }),
      record: { callId: first, html: PAGE, title: "First", conversation: String(root) },
    });

    // The source keeps its own.
    expect((await seen(stub)).visuals).toHaveLength(2);
  });

  it("shows the Visuals of the calls before a Fork's point only", async () => {
    const { stub, first } = await showedTwo();
    const fork = await forkBefore(stub, 2);

    expect(Arr.map((await seen(fork.stub)).visuals, (each) => each.callId)).toEqual([first]);
  });

  it("keeps a Visual the source had evicted as the stub it was, through a Clone of a Clone", async () => {
    const { stub, first, second } = await showedTwo();

    // Sixteen pages of nearly 2 MiB fill the 32 MiB with the two small ones; mounting the second and one more page past the
    // bound evicts the least recently mounted: the first, and a page of the filler.
    const big = `<!doctype html><p>${"x".repeat(MAX_VISUAL_BYTES - 64)}</p>`;

    await runInDurableObject(stub, async (instance: TestSession) => {
      for (let n = 0; n < 16; n++) await instance.visualPut(draft(`filler-${n}`, big));
    });

    const client = await connect(stub);

    await client.root();
    client.send({ type: "visual_page", id: "m", callId: second });
    expect(await client.answer("m")).toMatchObject({ status: "page" });
    client.close();

    await runInDurableObject(stub, (instance: TestSession) =>
      instance.visualPut(draft("filler-16", big)),
    );
    expect((await seen(stub, [first])).pages[first]).toMatchObject({ status: "evicted" });

    // The filler belongs to no call of the History, so a Clone carries the two calls' Visuals only.
    const clone = await cloneOf(stub);
    const again = await cloneOf(clone.stub);
    const copied = await seen(again.stub, [first]);

    expect(Arr.map(copied.visuals, (each) => [each.callId, each.state])).toEqual([
      [first, "evicted"],
      [second, "kept"],
    ]);
    expect(copied.pages[first]).toMatchObject({
      status: "evicted",
      stub: { callId: first, title: "First", summary: "The first, as bars" },
    });
  });

  it("is made without them when the storage refuses to keep them, with the History copied", async () => {
    const { stub } = await showedTwo();
    const name = `visuals-copy-${counter++}`;
    const target = env.SESSIONS.getByName(name);

    await runInDurableObject(target, (instance: TestSession) => instance.refuseVisuals());
    await runInDurableObject(stub, (instance: TestSession) =>
      instance.forkInto(name, { quiet: "none" }),
    );

    expect(await runInDurableObject(target, (instance: TestSession) => instance.copying())).toBe(
      false,
    );
    expect((await seen(target)).visuals).toEqual([]);

    const nodes = (session: DurableObjectStub<TestSession>) =>
      runInDurableObject(
        session,
        async (instance: TestSession) => (await instance.tree()).nodes.length,
      );

    expect(await nodes(target)).toBe(await nodes(stub));
  });

  describe("across builds", () => {
    /** A Clone of a Session of two Visuals, `change` given the copies of a page (the first Visual's among them) and the first's. */
    const skewed = async (
      change: (
        visuals: ReadonlyArray<VisualCopy>,
        first: VisualCopy,
      ) => ReadonlyArray<VisualCopy> | undefined,
    ) => {
      const { stub, first, second } = await showedTwo();

      const clone = await cloneOf(stub, (page) => {
        const { visuals, ...rest } = page;
        const head = visuals?.[0];

        if (visuals === undefined || head === undefined) return page;

        const changed = change(visuals, head);

        return changed === undefined ? rest : { ...rest, visuals: changed };
      });

      // The Clone was made: its Session takes messages and shows its History.
      expect(
        await runInDurableObject(clone.stub, (instance: TestSession) => instance.copying()),
      ).toBe(false);

      return { ...(await seen(clone.stub, [first])), first, second };
    };

    /** `copy` as a record of another build changed it, or as it is when it is not a record. */
    const recordChanged = (copy: VisualCopy, change: (record: VisualRecord) => JsonValue) =>
      isRecordCopy(copy) ? copyOf({ kind: "record", record: change(copy.record) }) : copy;

    it("from a source before Visuals shows none, and the Clone is made", async () => {
      const { visuals } = await skewed(() => undefined);

      expect(visuals).toEqual([]);
    });

    it("skips a kind of copy it does not know, or that is not the shape of its kind, and keeps the others", async () => {
      const { visuals, first, second } = await skewed((all) => [
        copyOf({ kind: "future", payload: { html: PAGE } }),
        copyOf({ kind: "record" }),
        copyOf({ kind: "record", record: "not a record" }),
        copyOf({ kind: "stub", stub: null }),
        copyOf({ kind: "stub", stub: { callId: 7 } }),
        ...all,
      ]);

      expect(Arr.map(visuals, (each) => each.callId)).toEqual([first, second]);
    });

    it("keeps a record it cannot read as the stub its card shows: no longer kept", async () => {
      const { visuals, pages, first, second } = await skewed((all, head) => [
        recordChanged(head, (record) => ({ ...record, html: 42 })),
        ...all.slice(1),
      ]);

      expect(Arr.map(visuals, (each) => [each.callId, each.state])).toEqual([
        [first, "evicted"],
        [second, "kept"],
      ]);
      expect(pages[first]).toMatchObject({
        status: "evicted",
        stub: { callId: first, title: "First", summary: "The first, as bars" },
      });
    });

    it("keeps a page past this build's bound as a stub, whatever its record says it weighs", async () => {
      const { visuals, first, second } = await skewed((all, head) => [
        recordChanged(head, (record) => ({
          ...record,
          html: "x".repeat(MAX_VISUAL_BYTES + 1),
          bytes: 10,
        })),
        ...all.slice(1),
      ]);

      expect(
        Arr.map(visuals, (each) => [each.callId, each.state, each.bytes > MAX_VISUAL_BYTES]),
      ).toEqual([
        [first, "evicted", true],
        [second, "kept", false],
      ]);
    });
  });
});
