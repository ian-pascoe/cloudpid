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

/** A new Session on Workspace `slug`. */
const sessionOn = (slug: string) => {
  const stub = env.WORKSPACE_SESSIONS.get(env.WORKSPACE_SESSIONS.newUniqueId());

  return {
    /** Run one Run whose scripted model calls each tool in turn, then answers; the text of that Run's tool results. */
    run: (calls: readonly string[]) =>
      runInDurableObject(stub, async (instance: TestWorkspaceSession) => {
        instance.bindWorkspace(slug);
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
      "notes.txt",
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
      "shared.txt",
    ]);
    // A Session created afterwards finds the files: they belong to the Workspace, not to a Session.
    expect(await sessionOn(slug).run([call("grep", { pattern: "second" })])).toEqual([
      "shared.txt:2: from second",
    ]);
  });

  it("keep Sessions on different Workspaces apart", async () => {
    const one = sessionOn(uniqueWorkspace());
    const other = sessionOn(uniqueWorkspace());

    await one.run([call("write", { path: "mine.txt", content: "x" })]);

    expect(await other.run([call("ls", {})])).toEqual(["(empty directory)"]);
  });
});
