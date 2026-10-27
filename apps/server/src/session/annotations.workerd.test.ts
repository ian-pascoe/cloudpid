// workerd's Durable Object, WebSocket, and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off preferEffectArray:off
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  type AnnotationDraft,
  type ClientMessage,
  HEARTBEAT,
  MAX_ANNOTATIONS,
  ServerMessageJson,
  type ServerMessage,
  UPLOADS_ROOT,
} from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import type { ChangesFixture, TestSession } from "./host.fixture.ts";
import { DRAFTS_CHANGED } from "./reviews.ts";

const decode = Schema.decodeUnknownEffect(ServerMessageJson);

type Annotations = Extract<ServerMessage, { type: "annotations" }>;

/** A client of a Session's socket that keeps every message the Session sent it. */
const connect = async (stub: DurableObjectStub<TestSession>) => {
  const response = await stub.fetch("http://session/socket", { headers: { Upgrade: "websocket" } });
  const socket = response.webSocket;

  if (socket === null) throw new Error(`No socket: ${response.status}`);
  socket.accept();

  const received: ServerMessage[] = [];

  socket.addEventListener("message", (event) => {
    if (event.data !== HEARTBEAT.response) received.push(Effect.runSync(decode(event.data)));
  });

  const until = async (done: (messages: readonly ServerMessage[]) => boolean, from = 0) => {
    // 10 s: a loaded runner answers slowly.
    for (let attempt = 0; attempt < 1_000; attempt++) {
      const messages = received.slice(from);

      if (done(messages)) return messages;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    throw new Error(`Never received the expected messages: ${JSON.stringify(received.slice(from))}`);
  };

  /** The drafts as the Session last said them, once it has said them `count` times. */
  const lists = (messages: readonly ServerMessage[]) =>
    messages.filter((message): message is Annotations => message.type === "annotations");

  return {
    received,
    send: (message: ClientMessage) => socket.send(JSON.stringify(message)),
    until,
    lists: () => lists(received),
    /** Wait for the `n`th `annotations` message and answer its drafts. */
    nth: async (n: number) => {
      const messages = await until((each) => lists(each).length >= n);

      return lists(messages)[n - 1]?.annotations ?? [];
    },
    answer: async (id: string) => {
      const answered = (message: ServerMessage) => "id" in message && message.id === id;
      const messages = await until((each) => each.some(answered));

      return messages.find(answered);
    },
  };
};

const fresh = () => env.SESSIONS.get(env.SESSIONS.newUniqueId());

const HEAD = "a".repeat(40);

/** The Changes of repo `app`: `src/a.ts` modified, with `text` as its working text. */
const changes = (text: string, more = 0): ChangesFixture => ({
  running: {
    repos: [
      {
        repo: "app",
        head: { commit: HEAD, branch: "main" },
        files: [{ path: "src/a.ts", status: "modified", additions: 1, deletions: 0 }],
        more,
        stale: false,
      },
    ],
  },
  files: { "app/src/a.ts": text },
});

const onChanges = (overrides: Partial<AnnotationDraft> = {}): AnnotationDraft => ({
  id: "on-changes",
  source: { kind: "changes", repo: "app", head: HEAD },
  path: "src/a.ts",
  side: "new",
  start: 2,
  end: 3,
  quote: ["const b = 2;", "const c = 3;"],
  more: 0,
  text: "Why two constants?",
  ...overrides,
});

const onCall = (overrides: Partial<AnnotationDraft> = {}): AnnotationDraft => ({
  id: "on-call",
  source: {
    kind: "call",
    // SAFETY: the root conversation of a fresh test Session is pi-durable's first.
    conversationId: 1 as never,
    callId: "call-1",
    tool: "edit",
  },
  path: "/workspace/app/src/b.ts",
  side: "new",
  start: 10,
  end: 10,
  quote: ["return x;"],
  more: 0,
  text: "Return early instead.",
  ...overrides,
});

const FILE = "const a = 1;\nconst b = 2;\nconst c = 3;\n";

describe("draft Annotations", () => {
  it("are sent after hello, then to every client on each save and delete", async () => {
    const stub = fresh();
    const first = await connect(stub);

    expect(await first.nth(1)).toEqual([]);
    expect(first.received[0]?.type).toBe("hello");

    const second = await connect(stub);

    await second.nth(1);
    first.send({ type: "annotation_save", id: "save", annotation: onChanges() });
    expect(await first.answer("save")).toEqual({ type: "result", id: "save", result: null });

    const [saved] = await second.nth(2);

    expect(saved).toMatchObject({ ...onChanges(), createdAt: expect.any(Number) });
    expect(saved?.updatedAt).toBe(saved?.createdAt);

    // An edit replaces it, keeping when it was made.
    second.send({
      type: "annotation_save",
      id: "edit",
      annotation: onChanges({ text: "Fold them into one." }),
    });
    await second.answer("edit");
    expect(await first.nth(3)).toEqual([
      expect.objectContaining({ text: "Fold them into one.", createdAt: saved?.createdAt }),
    ]);

    first.send({ type: "annotation_delete", id: "delete", annotationId: "on-changes" });
    await first.answer("delete");
    expect(await second.nth(4)).toEqual([]);

    // One that is gone is not an error, and changes nothing.
    first.send({ type: "annotation_delete", id: "again", annotationId: "on-changes" });
    expect(await first.answer("again")).toEqual({ type: "result", id: "again", result: null });

    // A client that connects later is sent them as they are.
    first.send({ type: "annotation_save", id: "call", annotation: onCall() });
    await first.answer("call");

    const third = await connect(stub);

    expect(await third.nth(1)).toEqual([expect.objectContaining({ id: "on-call" })]);
  });

  it("on a Call diff take an absolute path, a relative one resolved in the conversation's directory", async () => {
    const stub = fresh();
    const client = await connect(stub);

    await client.nth(1);
    client.send({
      type: "annotation_save",
      id: "relative",
      annotation: onCall({ path: "./src/../src/b.ts" }),
    });
    expect(await client.answer("relative")).toEqual({ type: "result", id: "relative", result: null });

    const [saved] = await client.nth(2);

    expect(saved?.path).toMatch(/^\/workspace(\/[^/]+)?\/src\/b\.ts$/u);
  });

  it("are refused past the limit, and their quotes cut to it", async () => {
    const stub = fresh();
    const client = await connect(stub);

    await runInDurableObject(stub, async (instance: TestSession) => {
      for (let index = 0; index < MAX_ANNOTATIONS; index++) {
        await instance.saveAnnotation(onCall({ id: `a${index}` }));
      }
    });

    client.send({ type: "annotation_save", id: "over", annotation: onCall({ id: "over" }) });
    expect(await client.answer("over")).toMatchObject({
      type: "error",
      message: expect.stringMatching(/at most 100 draft Annotations/u),
    });

    // Editing one already there is not adding one.
    client.send({
      type: "annotation_save",
      id: "edit",
      annotation: onCall({ id: "a0", quote: Array.from({ length: 80 }, () => "line") }),
    });
    await client.answer("edit");

    const [edited] = await runInDurableObject(stub, (instance: TestSession) => instance.annotations());

    expect(edited?.quote).toHaveLength(50);
    expect(edited?.more).toBe(30);
  });

  it("on the Changes move with their lines, are marked when the lines change, and when their file leaves", async () => {
    const stub = fresh();

    await runInDurableObject(stub, (instance: TestSession) => instance.setChanges(changes(FILE)));

    const client = await connect(stub);

    client.send({ type: "annotation_save", id: "save", annotation: onChanges() });
    client.send({ type: "annotation_save", id: "call", annotation: onCall() });
    await client.answer("call");
    client.send({ type: "watch_changes", id: "watch" });
    await client.answer("watch");

    // Two lines added above: it moves, silently.
    await runInDurableObject(stub, (instance: TestSession) =>
      instance.setChanges(changes(`// one\n// two\n${FILE}`)),
    );
    client.send({ type: "refresh_changes", id: "refresh" });
    await client.answer("refresh");

    const moved = (await client.until((messages) =>
      messages.some(
        (message) =>
          message.type === "annotations" && message.annotations.some((draft) => draft.start === 4),
      ),
    )).filter((message): message is Annotations => message.type === "annotations").at(-1);

    expect(moved?.annotations.find((draft) => draft.id === "on-changes")).toMatchObject({
      start: 4,
      end: 5,
    });
    expect(moved?.annotations.find((draft) => draft.id === "on-changes")?.status).toBeUndefined();

    // Its lines changed: marked, keeping its place and quote. The Call diff's draft is never checked.
    await runInDurableObject(stub, (instance: TestSession) =>
      instance.setChanges(changes("const a = 1;\nconst b = 20;\nconst c = 3;\n")),
    );
    client.send({ type: "refresh_changes", id: "refresh-2" });
    await client.answer("refresh-2");
    await client.until((messages) =>
      messages.some(
        (message) =>
          message.type === "annotations" &&
          message.annotations.some((draft) => draft.status === "outdated"),
      ),
    );

    const drafts = await runInDurableObject(stub, (instance: TestSession) => instance.annotations());

    expect(drafts.find((draft) => draft.id === "on-changes")).toMatchObject({
      status: "outdated",
      start: 4,
      quote: ["const b = 2;", "const c = 3;"],
    });
    expect(drafts.find((draft) => draft.id === "on-call")?.status).toBeUndefined();

    // Its file left the Changes (committed, say).
    await runInDurableObject(stub, (instance: TestSession) =>
      instance.setChanges({
        running: {
          repos: [{ repo: "app", head: { commit: HEAD, branch: "main" }, files: [], more: 0, stale: false }],
        },
      }),
    );
    client.send({ type: "refresh_changes", id: "refresh-3" });
    await client.answer("refresh-3");
    await client.until((messages) =>
      messages.some(
        (message) =>
          message.type === "annotations" &&
          message.annotations.some((draft) => draft.status === "gone"),
      ),
    );
  });

  it("addressed to a deleted subagent are dropped", async () => {
    const stub = fresh();
    const client = await connect(stub);

    // SAFETY: a subagent's conversation ID the Subagents document does not list.
    client.send({ type: "annotation_save", id: "save", annotation: onCall({ conversationId: 99 as never }) });
    await client.answer("save");
    client.send({ type: "annotation_save", id: "root", annotation: onChanges() });
    await client.answer("root");

    await runInDurableObject(stub, (instance: TestSession) => instance.pruneAnnotations());

    expect(
      (await runInDurableObject(stub, (instance: TestSession) => instance.annotations())).map(
        (draft) => draft.id,
      ),
    ).toEqual(["on-changes"]);
  });

  it("are not copied into a Fork or Clone", async () => {
    const stub = fresh();
    const target = "fork-of-a-session-with-drafts";

    await runInDurableObject(stub, async (instance: TestSession) => {
      await instance.saveAnnotation(onCall());
      await instance.forkInto(target, { quiet: "none" });
      expect(await instance.annotations()).toHaveLength(1);
    });

    await runInDurableObject(env.SESSIONS.getByName(target), async (copy: TestSession) => {
      expect(await copy.annotations()).toEqual([]);
    });
  });
});

describe("a Review", () => {
  it("sends the drafts with the summary as one message, and deletes them", async () => {
    const stub = fresh();

    await runInDurableObject(stub, (instance: TestSession) => {
      instance.setChanges(changes(FILE));
      instance.script(["Looked."]);
    });

    const client = await connect(stub);

    client.send({ type: "annotation_save", id: "a", annotation: onChanges() });
    client.send({ type: "annotation_save", id: "b", annotation: onCall() });
    await client.answer("b");
    client.send({
      type: "submit",
      id: "send",
      input: "Two things.",
      requestId: "review-1",
      annotations: ["on-changes", "on-call"],
    });
    expect(await client.answer("send")).toMatchObject({
      type: "result",
      result: { submissionId: expect.any(Number) },
    });
    await client.until((messages) =>
      messages.some((message) => message.type === "annotations" && message.annotations.length === 0),
    );

    for (let attempt = 0; attempt < 300; attempt++) {
      if (await runInDurableObject(stub, (instance: TestSession) => instance.idle())) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const entries = await runInDurableObject(stub, (instance: TestSession) => instance.rootEntries());
    const sent = entries.find((entry) => entry.kind === "cloudpid.user");

    expect(sent?.text).toMatch(/^Two things\.\n\n/u);
    expect(sent?.text).toContain("### Uncommitted Changes in `app`");
    expect(sent?.text).toContain("### Your `edit` call on `/workspace/app/src/b.ts`: lines as of that call");
    expect(sent?.text).toContain("Why two constants?");
    expect(sent?.data).toMatchObject({
      display: "Two things.",
      review: { annotations: [expect.objectContaining({ path: "src/a.ts" }), expect.anything()] },
    });

    // Going back to it with /tree puts only the summary in the composer.
    const tree = await runInDurableObject(stub, (instance: TestSession) => instance.tree());
    const review = tree.nodes.find((node) => node.role === "user");

    expect(review?.text).toBe("Two things.");

    const went = await runInDurableObject(stub, (instance: TestSession) =>
      instance.navigate({ entryId: review?.id ?? 0, position: "before" }),
    );

    expect(went).toMatchObject({ navigated: { text: "Two things." } });
  });

  it("with no summary but an Attachment puts its Markdown first, keeping the Attachment's path", async () => {
    const stub = fresh();

    await runInDurableObject(stub, (instance: TestSession) => instance.script(["Looked."]));

    const client = await connect(stub);
    const paths = `@${UPLOADS_ROOT}/s/notes.txt`;

    client.send({ type: "annotation_save", id: "a", annotation: onCall() });
    await client.answer("a");
    client.send({
      type: "submit",
      id: "send",
      input: [{ type: "text", text: paths }],
      annotations: ["on-call"],
    });
    await client.answer("send");

    for (let attempt = 0; attempt < 300; attempt++) {
      if (await runInDurableObject(stub, (instance: TestSession) => instance.idle())) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const entries = await runInDurableObject(stub, (instance: TestSession) => instance.rootEntries());
    const sent = entries.find((entry) => entry.kind === "cloudpid.user");

    expect(sent?.text).toMatch(/^## Review: 1 Annotation\n/u);
    expect(sent?.text).toContain(paths);
    expect(sent?.data).toMatchObject({ display: "" });
  });

  it("is refused when a draft it names is gone or goes elsewhere, and keeps the drafts", async () => {
    const stub = fresh();
    const client = await connect(stub);

    client.send({ type: "annotation_save", id: "a", annotation: onCall() });
    await client.answer("a");
    client.send({ type: "submit", id: "gone", input: "", annotations: ["on-call", "deleted"] });
    expect(await client.answer("gone")).toEqual({ type: "error", id: "gone", message: DRAFTS_CHANGED });

    // SAFETY: a subagent's conversation ID; the draft goes to the active branch.
    client.send({ type: "submit", id: "elsewhere", conversationId: 99 as never, input: "", annotations: ["on-call"] });
    expect(await client.answer("elsewhere")).toMatchObject({ type: "error" });
    expect(
      (await runInDurableObject(stub, (instance: TestSession) => instance.annotations())).map((draft) => draft.id),
    ).toEqual(["on-call"]);
  });

  it("withdrawn by Stop before it was placed brings its drafts back", async () => {
    const stub = fresh();

    await runInDurableObject(stub, (instance: TestSession) => instance.script(["hang"]));

    const client = await connect(stub);

    client.send({ type: "submit", id: "first", input: "start", requestId: "first" });
    await client.answer("first");
    await runInDurableObject(stub, (instance: TestSession) => instance.hanging.promise);
    client.send({ type: "annotation_save", id: "a", annotation: onCall() });
    await client.answer("a");
    client.send({
      type: "submit",
      id: "review",
      input: "Later.",
      requestId: "review",
      whenBusy: "followUp",
      annotations: ["on-call"],
    });
    await client.answer("review");
    expect(await runInDurableObject(stub, (instance: TestSession) => instance.annotations())).toEqual([]);

    client.send({ type: "abort", id: "abort" });
    await client.answer("abort");
    await client.until((messages) =>
      messages.some(
        (message) =>
          message.type === "annotations" &&
          message.annotations.some((draft) => draft.id === "on-call"),
      ),
    );
  });
});
