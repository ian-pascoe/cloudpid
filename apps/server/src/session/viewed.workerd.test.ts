// Viewed boxes and the drafts on a pull request, on a Session host in workerd: the boxes are kept in the Session and synced
// to every client like the drafts (`viewed`, `viewed_set`); a refresh of the pull request to a file's new blob unticks it;
// a Fork or Clone has none; the drafts on a pull request move to a new head and head its Review.
// workerd's Durable Object, WebSocket, and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off preferEffectArray:off
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  type AnnotationDraft,
  type ClientMessage,
  type CompareResult,
  type Comparison,
  HEARTBEAT,
  ServerMessageJson,
  type ServerMessage,
  type ViewedFile,
} from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import type { TestSession } from "./host.fixture.ts";

const decode = Schema.decodeUnknownEffect(ServerMessageJson);

type ViewedMessage = Extract<ServerMessage, { type: "viewed" }>;

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

  const until = async (done: (messages: readonly ServerMessage[]) => boolean) => {
    // 10 s: a loaded runner answers slowly.
    for (let attempt = 0; attempt < 1_000; attempt++) {
      if (done(received)) return received;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    throw new Error(`Never received the expected messages: ${JSON.stringify(received)}`);
  };

  const lists = () =>
    received.filter((message): message is ViewedMessage => message.type === "viewed");

  return {
    received,
    send: (message: ClientMessage) => socket.send(JSON.stringify(message)),
    until,
    /** Wait for the `n`th `viewed` message and answer its boxes. */
    nth: async (n: number): Promise<readonly ViewedFile[]> => {
      await until(() => lists().length >= n);

      return lists()[n - 1]?.viewed ?? [];
    },
    answer: async (id: string) => {
      const answered = (message: ServerMessage) => "id" in message && message.id === id;

      await until((each) => each.some(answered));

      return received.find(answered);
    },
  };
};

const fresh = () => env.SESSIONS.get(env.SESSIONS.newUniqueId());

const MERGE_BASE = "b".repeat(40);

/** Pull request 7 of repo `app` at `head`, with `files` (path and head blob). */
const pullComparison = (
  head: string,
  files: ReadonlyArray<readonly [string, string]>,
  overrides: Partial<Comparison> = {},
): Comparison => ({
  repo: "app",
  base: "main",
  branch: "topic",
  pull: { number: 7, title: "Fix the thing", author: "dev", draft: false, state: "open" },
  mergeBase: MERGE_BASE,
  head,
  commits: 1,
  files: files.map(([path, blob]) => ({
    path,
    status: "modified",
    additions: 1,
    deletions: 0,
    blob,
  })),
  more: 0,
  ...overrides,
});

const answered = (comparison: Comparison): CompareResult => ({ status: "ok", comparison });

const HEAD_1 = "1".repeat(40);
const HEAD_2 = "2".repeat(40);

const asked = (id: string): ClientMessage => ({
  type: "compare",
  id,
  repo: "app",
  source: "pull",
  pull: 7,
});

const tick = (path: string, blob: string | null, id = `tick-${path}`): ClientMessage => ({
  type: "viewed_set",
  id,
  repo: "app",
  pull: 7,
  path,
  blob,
});

describe("Viewed boxes", () => {
  it("are sent after hello (an empty list too), then to every client on each tick and untick", async () => {
    const stub = fresh();
    const first = await connect(stub);

    expect(await first.nth(1)).toEqual([]);
    expect(first.received[0]?.type).toBe("hello");

    const second = await connect(stub);

    await second.nth(1);
    first.send(tick("src/a.ts", "blob-a"));
    expect(await first.answer("tick-src/a.ts")).toEqual({
      type: "result",
      id: "tick-src/a.ts",
      result: null,
    });
    expect(await second.nth(2)).toEqual([
      { repo: "app", pull: 7, path: "src/a.ts", blob: "blob-a" },
    ]);

    second.send(tick("src/b.ts", "blob-b"));
    await second.answer("tick-src/b.ts");
    expect((await first.nth(3)).map((box) => box.path)).toEqual(["src/a.ts", "src/b.ts"]);

    first.send(tick("src/a.ts", null, "untick"));
    await first.answer("untick");
    expect((await second.nth(4)).map((box) => box.path)).toEqual(["src/b.ts"]);

    // A client that connects later is sent them as they are.
    const third = await connect(stub);

    expect((await third.nth(1)).map((box) => box.path)).toEqual(["src/b.ts"]);
  });

  it("untick when a refresh brings a new blob for the file, or the file leaves, and not otherwise", async () => {
    const stub = fresh();

    await runInDurableObject(stub, (instance: TestSession) => {
      instance.setComparison({
        results: {
          "app#7": answered(
            pullComparison(HEAD_1, [
              ["a.ts", "blob-a"],
              ["b.ts", "blob-b"],
              ["c.ts", "blob-c"],
            ]),
          ),
        },
      });
    });

    const client = await connect(stub);

    client.send(asked("first"));
    await client.answer("first");
    client.send(tick("a.ts", "blob-a"));
    client.send(tick("b.ts", "blob-b"));
    client.send(tick("c.ts", "blob-c"));
    await client.answer("tick-c.ts");

    // A push changes b.ts and removes c.ts; a.ts stays as it was.
    await runInDurableObject(stub, (instance: TestSession) => {
      instance.setComparison({
        results: {
          "app#7": answered(
            pullComparison(HEAD_2, [
              ["a.ts", "blob-a"],
              ["b.ts", "blob-b2"],
            ]),
          ),
        },
      });
    });
    client.send(asked("refresh"));
    await client.answer("refresh");
    await client.until(() =>
      client.received.some(
        (message) =>
          message.type === "viewed" &&
          message.viewed.length === 1 &&
          message.viewed[0]?.path === "a.ts",
      ),
    );

    expect(await runInDurableObject(stub, (instance: TestSession) => instance.viewed())).toEqual([
      { repo: "app", pull: 7, path: "a.ts", blob: "blob-a" },
    ]);

    // The pull request's last result marked behind, or merged, is not its head: it unticks nothing.
    await runInDurableObject(stub, async (instance: TestSession) => {
      await instance.comparedPull(pullComparison(HEAD_1, [["a.ts", "other"]], { behind: HEAD_2 }));
      await instance.comparedPull(
        pullComparison(HEAD_1, [["a.ts", "other"]], {
          pull: { number: 7, title: "T", author: "dev", draft: false, state: "merged" },
        }),
      );
    });
    expect(
      await runInDurableObject(stub, (instance: TestSession) => instance.viewed()),
    ).toHaveLength(1);
  });

  it("are not copied into a Fork or Clone", async () => {
    const stub = fresh();
    const target = "fork-of-a-session-with-viewed-boxes";
    const client = await connect(stub);

    client.send(tick("a.ts", "blob-a"));
    await client.answer("tick-a.ts");

    await runInDurableObject(stub, async (instance: TestSession) => {
      await instance.forkInto(target, { quiet: "none" });
      expect(await instance.viewed()).toHaveLength(1);
    });

    await runInDurableObject(env.SESSIONS.getByName(target), async (copy: TestSession) => {
      expect(await copy.viewed()).toEqual([]);
    });
  });

  it("belong to pull requests: a pull request Comparison asked for without a number is an error", async () => {
    const stub = fresh();
    const client = await connect(stub);

    client.send({ type: "compare", id: "bad", repo: "app", source: "pull" });
    expect(await client.answer("bad")).toMatchObject({ type: "error", id: "bad" });
  });
});

describe("drafts on a pull request", () => {
  const FILE = "const a = 1;\nconst b = 2;\nconst c = 3;\n";

  const onPull = (): AnnotationDraft => ({
    id: "on-pull",
    source: {
      kind: "pull",
      repo: "app",
      number: 7,
      title: "Fix the thing",
      mergeBase: MERGE_BASE,
      head: HEAD_1,
    },
    path: "src/a.ts",
    side: "new",
    start: 2,
    end: 3,
    quote: ["const b = 2;", "const c = 3;"],
    more: 0,
    text: "Why two?",
  });

  it("move with their lines to a new head when the pull request is refreshed, and take its title", async () => {
    const stub = fresh();

    await runInDurableObject(stub, (instance: TestSession) => {
      instance.setComparison({
        results: { "app#7": answered(pullComparison(HEAD_1, [["src/a.ts", "x"]])) },
        files: { "app/src/a.ts": FILE },
      });
    });

    const client = await connect(stub);

    client.send({ type: "annotation_save", id: "save", annotation: onPull() });
    await client.answer("save");

    await runInDurableObject(stub, (instance: TestSession) => {
      instance.setComparison({
        results: {
          "app#7": answered(
            pullComparison(HEAD_2, [["src/a.ts", "y"]], {
              pull: {
                number: 7,
                title: "Fix the other thing",
                author: "dev",
                draft: false,
                state: "open",
              },
            }),
          ),
        },
        files: { "app/src/a.ts": `// one\n// two\n${FILE}` },
      });
    });
    client.send(asked("refresh"));
    await client.answer("refresh");
    await client.until((messages) =>
      messages.some(
        (message) =>
          message.type === "annotations" && message.annotations.some((draft) => draft.start === 4),
      ),
    );

    const [moved] = await runInDurableObject(stub, (instance: TestSession) =>
      instance.annotations(),
    );

    expect(moved).toMatchObject({
      start: 4,
      end: 5,
      source: { kind: "pull", number: 7, title: "Fix the other thing", head: HEAD_2 },
    });
    expect(moved?.status).toBeUndefined();

    // The lines change in the next head: marked, and still on the pair it was written against.
    const third = "3".repeat(40);

    await runInDurableObject(stub, (instance: TestSession) => {
      instance.setComparison({
        results: { "app#7": answered(pullComparison(third, [["src/a.ts", "z"]])) },
        files: { "app/src/a.ts": "// one\n// two\nconst a = 1;\nconst b = 20;\nconst c = 3;\n" },
      });
    });
    client.send(asked("refresh-2"));
    await client.answer("refresh-2");
    await client.until((messages) =>
      messages.some(
        (message) =>
          message.type === "annotations" &&
          message.annotations.some((draft) => draft.status === "outdated"),
      ),
    );

    // A closed pull request's last result, and a list marked behind, change nothing.
    await runInDurableObject(stub, async (instance: TestSession) => {
      await instance.compared(pullComparison("4".repeat(40), [], { behind: third }));
      await instance.compared(
        pullComparison("4".repeat(40), [], {
          pull: { number: 7, title: "T", author: "dev", draft: false, state: "closed" },
        }),
      );
    });
    expect(
      (await runInDurableObject(stub, (instance: TestSession) => instance.annotations()))[0]
        ?.status,
    ).toBe("outdated");
  });

  it("head the Review: Pull request #7 'title' at the head's first seven characters", async () => {
    const stub = fresh();

    await runInDurableObject(stub, (instance: TestSession) => {
      instance.script(["Looked."]);
    });

    const client = await connect(stub);

    client.send({ type: "annotation_save", id: "save", annotation: onPull() });
    await client.answer("save");
    client.send({
      type: "submit",
      id: "send",
      input: "Check this.",
      requestId: "review-pull",
      annotations: ["on-pull"],
    });
    await client.answer("send");

    for (let attempt = 0; attempt < 300; attempt++) {
      if (await runInDurableObject(stub, (instance: TestSession) => instance.idle())) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const entries = await runInDurableObject(stub, (instance: TestSession) =>
      instance.rootEntries(),
    );

    const sent = entries.find((entry) => entry.kind === "cloudpid.user");

    expect(sent?.text).toContain("### Pull request #7 'Fix the thing' at `1111111`");
    expect(sent?.text).toContain("`/workspace/app/src/a.ts`, lines 2–3");
  });
});
