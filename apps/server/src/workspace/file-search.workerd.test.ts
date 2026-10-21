// The composer's `@` menu end to end: a `files` request on a Session's socket, answered from a real Workspace's
// gitignore-aware listing of the Session's repo directory. workerd's WebSocket and `cloudflare:test` APIs are
// Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off preferEffectArray:off preferEffectRecord:off
import { type ClientMessage, type ServerMessage, ServerMessageJson } from "@cloudpid/protocol";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import type { TestWorkspaceSession } from "./session.fixture.ts";
import { call, sessionOn, uniqueWorkspace } from "./session.workerd.helpers.ts";

const decode = Schema.decodeUnknownEffect(ServerMessageJson);

/** A client of a Session's socket: send a command, and wait for the message that answers it. */
const connect = async (stub: DurableObjectStub<TestWorkspaceSession>) => {
  const response = await stub.fetch("http://session/socket", { headers: { Upgrade: "websocket" } });
  const socket = response.webSocket;

  if (socket === null) throw new Error(`No socket: ${response.status}`);
  socket.accept();

  const received: ServerMessage[] = [];

  socket.addEventListener("message", (event) => {
    received.push(Effect.runSync(decode(event.data)));
  });

  return {
    send: (message: ClientMessage) => socket.send(JSON.stringify(message)),
    answer: async (id: string) => {
      for (let attempt = 0; attempt < 1000; attempt++) {
        const found = received.find((message) => "id" in message && message.id === id);

        if (found !== undefined) return found;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      throw new Error(`No answer to ${id}: ${JSON.stringify(received)}`);
    },
    close: () => socket.close(),
  };
};

/** A Workspace whose repo `demo` is a git work tree with a `.gitignore`, built ignored files and a `node_modules`. */
const workspaceWithRepo = async () => {
  const slug = uniqueWorkspace();

  const files = {
    "demo/.git/HEAD": "ref: refs/heads/main\n",
    "demo/.gitignore": "dist/\n*.log\n",
    "demo/README.md": "# Demo\n",
    "demo/src/app.ts": "export {};\n",
    "demo/src/chat/menu.ts": "export {};\n",
    "demo/src/chat/composer.tsx": "export {};\n",
    "demo/dist/app.js": "built\n",
    "demo/debug.log": "noise\n",
    "demo/node_modules/left-pad/index.js": "module.exports = 1;\n",
    "outside.ts": "export {};\n",
  };

  const writes = Object.entries(files).map(([path, content]) => call("write", { path, content }));

  // A scripted Session answers a few calls at most.
  for (let from = 0; from < writes.length; from += 5) {
    await sessionOn(slug).run(writes.slice(from, from + 5));
  }

  return slug;
};

describe("a files request", () => {
  it("answers the repo directory's files and folders that match, without what git ignores", async () => {
    const slug = await workspaceWithRepo();
    const stub = env.WORKSPACE_SESSIONS.get(env.WORKSPACE_SESSIONS.newUniqueId());

    await runInDurableObject(stub, (instance: TestWorkspaceSession) => {
      instance.bindWorkspace(slug, "demo");
    });

    const client = await connect(stub);

    const ask = async (id: string, query: string) => {
      client.send({ type: "files", id, query });

      return client.answer(id);
    };

    const all = await ask("all", "");

    expect(all).toMatchObject({ type: "result", id: "all" });

    // SAFETY: a `files` request is answered with `FileMatches`, checked by the expectations below.
    const paths = all.type === "result" ? (all.result as { paths: string[] }).paths : [];

    expect(paths).toEqual(
      expect.arrayContaining([
        ".gitignore",
        "README.md",
        "src/",
        "src/app.ts",
        "src/chat/",
        "src/chat/menu.ts",
        "src/chat/composer.tsx",
      ]),
    );
    // The top level first.
    expect(paths.indexOf("src/")).toBeLessThan(paths.indexOf("src/app.ts"));

    for (const absent of ["dist/", "dist/app.js", "debug.log", "outside.ts"]) {
      expect(paths).not.toContain(absent);
    }

    expect(paths.some((path) => path.startsWith(".git/") || path === ".git")).toBe(false);
    expect(paths.some((path) => path.includes("node_modules"))).toBe(false);

    expect(await ask("menu", "menu")).toEqual({
      type: "result",
      id: "menu",
      result: { paths: ["src/chat/menu.ts"] },
    });
    expect(await ask("folder", "src/chat/")).toEqual({
      type: "result",
      id: "folder",
      // Siblings in the listing's byte order.
      result: { paths: ["src/chat/", "src/chat/composer.tsx", "src/chat/menu.ts"] },
    });

    client.close();
  });
});
