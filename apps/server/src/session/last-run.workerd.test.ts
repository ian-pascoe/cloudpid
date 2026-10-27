// Last run on the Session (docs/spec.md → Diffs and review → Run diff), over a fake Workspace that answers the copies
// (`host.fixture.ts` `setRun`, `runCalls`): when a Run opens and ends, what the clients are told, and how the drafts on
// the Last run are checked. The Workspace's own part is `workspace/runs.test.ts` and `runs.workerd.test.ts`.
// workerd's Durable Object, WebSocket, and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off globalDate:off newPromise:off globalTimers:off preferEffectArray:off
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  type ClientMessage,
  type DiffAnnotationDraft,
  isDiffAnnotation,
  HEARTBEAT,
  type RunDiff,
  ServerMessageJson,
  type ServerMessage,
} from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import type { TestSession } from "./host.fixture.ts";

const decode = Schema.decodeUnknownEffect(ServerMessageJson);

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

  return {
    received,
    send: (message: ClientMessage) => socket.send(JSON.stringify(message)),
    until,
    answer: async (id: string) => {
      const answered = (message: ServerMessage) => "id" in message && message.id === id;
      const messages = await until((each) => each.some(answered));

      return messages.find(answered);
    },
    lastRuns: () =>
      received.flatMap((message) => (message.type === "last_run" ? [message.lastRun] : [])),
  };
};

let made = 0;

/** A Session whose host has a writing tool (`write`) and a fake Workspace that copies. */
const fresh = () => env.SESSIONS.getByName(`runs-${Date.now()}-${made++}`);

const idle = async (stub: DurableObjectStub<TestSession>) => {
  for (let attempt = 0; attempt < 1_000; attempt++) {
    if (await runInDurableObject(stub, (instance: TestSession) => instance.idle())) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error("The Session never went idle");
};

const WRITE = 'call:write:{"path":"a.txt"}';

const submit = (client: Awaited<ReturnType<typeof connect>>, id: string, input: string) =>
  client.send({ type: "submit", id, input, requestId: id });

const FILE = "const a = 1;\nconst b = 2;\nconst c = 3;\n";

const diff = (run: string, live: boolean): RunDiff => ({
  run,
  live,
  repos: [
    {
      repo: "app",
      head: { commit: "a".repeat(40), branch: "main" },
      files: [{ path: "src/a.ts", status: "modified", additions: 1, deletions: 0 }],
      more: 0,
      stale: false,
    },
  ],
});

const onRun = (run: string, overrides: Partial<DiffAnnotationDraft> = {}): DiffAnnotationDraft => ({
  id: "on-run",
  source: {
    kind: "run",
    // SAFETY: the root conversation of a fresh test Session is pi-durable's first.
    conversationId: 1 as never,
    run,
    repo: "app",
    start: "a".repeat(40),
    end: null,
  },
  path: "src/a.ts",
  side: "new",
  start: 2,
  end: 3,
  quote: ["const b = 2;", "const c = 3;"],
  more: 0,
  text: "Why two constants?",
  ...overrides,
});

describe("the Last run on the Session", () => {
  it("is null after hello when no Run has written, and opens at the first writing call, ending when the Session goes idle", async () => {
    const stub = fresh();

    await runInDurableObject(stub, (instance: TestSession) => {
      instance.setRun({ diff: diff("run0", true) });
      // A call of a tool that writes nothing opens no Run.
      instance.script(['call:echo:{"text":"hi"}', "Only looked.", WRITE, "Wrote it."]);
    });

    const client = await connect(stub);

    await client.until((messages) => messages.some((message) => message.type === "last_run"));
    expect(client.lastRuns()).toEqual([null]);

    submit(client, "look", "Look at it");
    await client.answer("look");
    await idle(stub);
    expect(await runInDurableObject(stub, (instance: TestSession) => instance.runCalls())).toEqual(
      [],
    );
    expect(client.lastRuns()).toEqual([null]);

    submit(client, "write", "Write it");
    await client.answer("write");
    await idle(stub);

    // Opened before the write, with the call that made it; ended with the newest entry once the Session was idle.
    const calls = await runInDurableObject(stub, (instance: TestSession) => instance.runCalls());

    expect(calls).toEqual([
      {
        start: expect.objectContaining({
          run: "run0",
          conversationId: 1,
          firstCall: expect.any(String),
          keep: [],
        }),
      },
      { end: expect.objectContaining({ run: "run0", until: expect.any(Number), keep: [] }) },
    ]);

    const runs = client.lastRuns();

    expect(runs.at(-2)).toMatchObject({ run: "run0", endedAt: null, until: null });
    expect(runs.at(-1)).toMatchObject({
      run: "run0",
      endedAt: expect.any(Number),
      until: expect.any(Number),
    });
    expect(runs.at(-1)).not.toMatchObject({ until: 0 });

    // A client that connects later is told where it stands.
    const late = await connect(stub);

    await late.until((messages) => messages.some((message) => message.type === "last_run"));
    expect(late.lastRuns().at(-1)).toMatchObject({ run: "run0", endedAt: expect.any(Number) });
  });

  it("answers run_diff and run_file from the Workspace", async () => {
    const stub = fresh();

    await runInDurableObject(stub, (instance: TestSession) =>
      instance.setRun({
        diff: diff("run0", false),
        files: {
          "app/src/a.ts": { old: null, new: { kind: "text", text: FILE } },
        },
      }),
    );

    const client = await connect(stub);

    client.send({ type: "run_diff", id: "diff" });
    expect(await client.answer("diff")).toMatchObject({
      type: "result",
      result: { run: "run0", repos: [{ repo: "app" }] },
    });

    client.send({ type: "run_file", id: "file", repo: "app", path: "src/a.ts" });
    expect(await client.answer("file")).toMatchObject({
      type: "result",
      result: { new: { kind: "text", text: FILE } },
    });

    client.send({ type: "run_file", id: "missing", repo: "app", path: "nope.ts" });
    expect(await client.answer("missing")).toMatchObject({ type: "error" });
  });

  it("checks the drafts on the Last run when the Run ends, and freezes them with the end copy's commit", async () => {
    const stub = fresh();

    await runInDurableObject(stub, (instance: TestSession) => {
      instance.setRun({
        diff: diff("run0", true),
        files: { "app/src/a.ts": { old: null, new: { kind: "text", text: FILE } } },
      });
      instance.script([WRITE, "gate:Wrote it."]);
    });

    const client = await connect(stub);

    submit(client, "write", "Write it");
    await client.answer("write");
    await runInDurableObject(stub, (instance: TestSession) => instance.gated.promise);

    // The Run is live: a draft is saved against it, its quote still in place.
    client.send({ type: "annotation_save", id: "save", annotation: onRun("run0") });
    await client.answer("save");
    await runInDurableObject(stub, (instance: TestSession) => instance.open());
    await idle(stub);

    // Ended: one more check freezes the draft at the end copy.
    for (let attempt = 0; attempt < 500; attempt++) {
      const drafts = await runInDurableObject(stub, (instance: TestSession) =>
        instance.annotations(),
      );

      if (drafts[0]?.source.kind === "run" && drafts[0].source.end !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const [draft] = (
      await runInDurableObject(stub, (instance: TestSession) => instance.annotations())
    ).filter(isDiffAnnotation);

    expect(draft?.source).toMatchObject({ kind: "run", run: "run0", end: "b".repeat(40) });
    expect(draft?.status).toBeUndefined();
  });

  it("tells the clients an end that came after the Session stopped waiting for it", async () => {
    const stub = fresh();

    await runInDurableObject(stub, (instance: TestSession) => {
      // Slower than the 200 ms the test Session waits for an end.
      instance.delayRunEnd(600);
      instance.script([WRITE, "Wrote it."]);
    });

    const client = await connect(stub);

    submit(client, "write", "Write it");
    await client.answer("write");
    await idle(stub);

    await client.until((messages) =>
      messages.some(
        (message) =>
          message.type === "last_run" &&
          message.lastRun?.run === "run0" &&
          message.lastRun.endedAt !== null,
      ),
    );
    expect(client.lastRuns().at(-1)).toMatchObject({ run: "run0", until: expect.any(Number) });
  });

  it("does not hold a write for a Workspace that never answers: it goes on, asks for no second copy, and ends the Run as missed", async () => {
    const stub = fresh();

    await runInDurableObject(stub, (instance: TestSession) => {
      instance.hangRunStart(true);
      instance.script([WRITE, WRITE, "Done."]);
    });

    const client = await connect(stub);

    submit(client, "write", "Write it twice");
    await client.answer("write");
    await idle(stub);

    // Both writes ran (the Session went idle) with one start asked for, and the Run was ended as missed.
    for (let attempt = 0; attempt < 500; attempt++) {
      const calls = await runInDurableObject(stub, (instance: TestSession) => instance.runCalls());

      if (calls.some((call) => "end" in call)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const calls = await runInDurableObject(stub, (instance: TestSession) => instance.runCalls());

    expect(calls.filter((call) => "start" in call)).toHaveLength(1);
    expect(calls.filter((call) => "end" in call)).toMatchObject([
      { end: { run: "run0", missed: true } },
    ]);
  });

  it("never marks a draft on an ended Run outdated: its lines are as of the end of that run, whatever the files do after", async () => {
    const stub = fresh();

    await runInDurableObject(stub, (instance: TestSession) => {
      instance.setRun({
        diff: diff("run0", true),
        files: { "app/src/a.ts": { old: null, new: { kind: "text", text: FILE } } },
      });
      instance.script([WRITE, "gate:Wrote it.", "Looked."]);
    });

    const client = await connect(stub);

    submit(client, "write", "Write it");
    await client.answer("write");
    await runInDurableObject(stub, (instance: TestSession) => instance.gated.promise);
    client.send({ type: "annotation_save", id: "save", annotation: onRun("run0") });
    await client.answer("save");
    await runInDurableObject(stub, (instance: TestSession) => instance.open());
    await idle(stub);

    for (let attempt = 0; attempt < 500; attempt++) {
      const drafts = await runInDurableObject(stub, (instance: TestSession) =>
        instance.annotations(),
      );

      if (drafts[0]?.source.kind === "run" && drafts[0].source.end !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // The files change after the Run: the quoted lines are gone from them.
    await runInDurableObject(stub, (instance: TestSession) => {
      instance.setRun({
        diff: diff("run0", false),
        files: {
          "app/src/a.ts": { old: null, new: { kind: "text", text: "nothing like it\n" } },
        },
      });
    });

    // A Review checks every draft again before it is sent.
    client.send({ type: "submit", id: "send", input: "", annotations: ["on-run"] });
    await client.answer("send");
    await idle(stub);

    const entries = await runInDurableObject(stub, (instance: TestSession) =>
      instance.rootEntries(),
    );

    const sent = entries.find(
      (entry) => entry.kind === "cloudpid.user" && entry.text?.startsWith("## Review") === true,
    );

    expect(sent?.text).toContain(
      "Your changes in your last run to `/workspace/app/src/a.ts`: lines as of the end of that run",
    );
    expect(sent?.text).not.toContain("have changed since");
    expect(sent?.text).not.toContain("no longer in the diff");
  });

  it("marks a draft on the live Run outdated when its lines change, and keeps the Run named for the Workspace", async () => {
    const stub = fresh();

    await runInDurableObject(stub, (instance: TestSession) => {
      instance.setRun({
        diff: diff("run0", true),
        files: {
          "app/src/a.ts": {
            old: null,
            new: { kind: "text", text: "const a = 1;\nconst b = 20;\n" },
          },
        },
      });
      instance.script([WRITE, "gate:Wrote it."]);
    });

    const client = await connect(stub);

    submit(client, "write", "Write it");
    await client.answer("write");
    await runInDurableObject(stub, (instance: TestSession) => instance.gated.promise);
    client.send({ type: "annotation_save", id: "save", annotation: onRun("run0") });
    await client.answer("save");
    await runInDurableObject(stub, (instance: TestSession) => instance.open());
    await idle(stub);

    // The quote is gone from the file: outdated, not moved.
    for (let attempt = 0; attempt < 500; attempt++) {
      const drafts = (
        await runInDurableObject(stub, (instance: TestSession) => instance.annotations())
      ).filter(isDiffAnnotation);

      if (drafts[0]?.status === "outdated") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const [draft] = (
      await runInDurableObject(stub, (instance: TestSession) => instance.annotations())
    ).filter(isDiffAnnotation);

    expect(draft?.status).toBe("outdated");
  });
});
