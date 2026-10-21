// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off cryptoRandomUUID:off
import { ComputerExecutionEnv } from "@cloudpid/computer-env";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { TestWorkspaceSession } from "./session.fixture.ts";
import type { TestWorkspace } from "./workerd.fixture.ts";

declare global {
  namespace Cloudflare {
    /** The bindings `vitest.config.ts` gives the Workspace test Worker. */
    interface Env {
      readonly WORKSPACES: DurableObjectNamespace<TestWorkspace>;
      readonly WORKSPACE_SESSIONS: DurableObjectNamespace<TestWorkspaceSession>;
    }
  }
}

let workspaces = 0;

/** A Workspace slug no other test uses. */
const uniqueWorkspace = () => `session-${++workspaces}`;

/** A new Session on Workspace `slug`, working in its repo directory `repo` if it has one. */
const sessionOn = (slug: string, repo: string | null = null) => {
  const stub = env.WORKSPACE_SESSIONS.get(env.WORKSPACE_SESSIONS.newUniqueId());

  return {
    /** Run one Run whose scripted model calls each tool in turn, then answers; the text of that Run's tool results. */
    run: (calls: readonly string[]) =>
      runInDurableObject(stub, async (instance: TestWorkspaceSession) => {
        instance.bindWorkspace(slug, repo);
        instance.script([...calls, "done"]);

        const earlier = (await instance.toolResults()).length;

        const answer = await instance.prompt({ requestId: crypto.randomUUID(), text: "go" });

        expect(answer).toMatchObject({ status: "answered", text: "done" });

        return (await instance.toolResults()).slice(earlier);
      }),
  };
};

const call = (tool: string, args: JsonValue) => `call:${tool}:${JSON.stringify(args)}`;

describe("a Session's coding tools", () => {
  it("create, read, edit, search, and run commands on files in its Workspace", async () => {
    const slug = uniqueWorkspace();

    const results = await sessionOn(slug).run([
      call("write", { path: "notes.txt", content: "alpha\nbeta\n" }),
      call("edit", { path: "notes.txt", edits: [{ oldText: "beta", newText: "gamma" }] }),
      call("read", { path: "notes.txt" }),
      call("grep", { pattern: "gamma" }),
      call("find", { pattern: "*.txt" }),
      call("ls", {}),
      call("bash", { command: "cat notes.txt" }),
    ]);

    expect(results).toEqual([
      "Successfully wrote to notes.txt",
      expect.stringContaining("Successfully replaced"),
      "alpha\ngamma\n",
      "notes.txt:2: gamma",
      "notes.txt",
      // Every Workspace holds the bundled skills, in `.agents/skills`.
      ".agents/\nnotes.txt",
      "alpha\ngamma\n",
    ]);

    // The file is in the Workspace, which no Session holds.
    const workspace = new ComputerExecutionEnv({
      workspace: env.WORKSPACES.getByName(slug),
      id: `computer:${slug}`,
      cwd: "/workspace",
    });

    expect(getOrThrow(await workspace.readTextFile("notes.txt", BACKGROUND_CONTEXT))).toBe(
      "alpha\ngamma\n",
    );
  });

  it("show two Sessions on one Workspace each other's changes, and a later Session the files", async () => {
    const slug = uniqueWorkspace();
    const first = sessionOn(slug);
    const second = sessionOn(slug);

    await first.run([call("write", { path: "shared.txt", content: "from first\n" })]);

    expect(await second.run([call("read", { path: "shared.txt" })])).toEqual(["from first\n"]);

    await second.run([call("bash", { command: "echo from second >> shared.txt" })]);

    expect(await first.run([call("read", { path: "shared.txt" }), call("ls", {})])).toEqual([
      "from first\nfrom second\n",
      ".agents/\nshared.txt",
    ]);
    // A Session created afterwards finds the files: they belong to the Workspace, not to a Session.
    expect(await sessionOn(slug).run([call("grep", { pattern: "second" })])).toEqual([
      "shared.txt:2: from second",
    ]);
  });

  it("work in the repo directory they are bound to: files, search, commands and git", async () => {
    const slug = uniqueWorkspace();

    // A repo the Workspace holds, made on the Worker Shell (git init runs on the Container otherwise, which these tests lack).
    await sessionOn(slug).run([
      call("bash", { command: "mkdir demo && cd demo && git init -b main", backend: "worker" }),
      call("write", { path: "other/keep.txt", content: "outside\n" }),
    ]);

    const results = await sessionOn(slug, "demo").run([
      call("bash", { command: "pwd" }),
      call("write", { path: "notes.txt", content: "alpha\n" }),
      call("ls", {}),
      call("grep", { pattern: "alpha" }),
      call("bash", { command: "git status" }),
    ]);

    expect(results[0]).toBe("/workspace/demo\n");
    expect(results[1]).toBe("Successfully wrote to notes.txt");
    expect(results[2]).toBe(".git/\nnotes.txt");
    expect(results[3]).toBe("notes.txt:1: alpha");
    // The Worker Shell's git finds the repository from the Session's directory, and sees the file the Session wrote.
    expect(results[4]).toContain("notes.txt");

    // The file is in the repo's directory, not at the root, where the Workspace's other files are.
    expect(
      await sessionOn(slug).run([call("read", { path: "demo/notes.txt" }), call("ls", {})]),
    ).toEqual(["alpha\n", expect.stringContaining("demo")]);
  });

  it("keep Sessions on different Workspaces apart", async () => {
    const one = sessionOn(uniqueWorkspace());
    const other = sessionOn(uniqueWorkspace());

    await one.run([call("write", { path: "mine.txt", content: "x" })]);

    expect(await other.run([call("ls", {})])).toEqual([".agents/"]);
  });
});
