// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off cryptoRandomUUID:off
import { ComputerExecutionEnv } from "@cloudpid/computer-env";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { SUBAGENT_WORKSPACE_PREFIX, type TestWorkspaceSession } from "./session.fixture.ts";
import { call, uniqueWorkspace } from "./session.workerd.helpers.ts";

/** Workspace DO `object`'s file `path`, or null when it has none. */
const fileIn = async (object: string, path: string): Promise<string | null> => {
  const files = new ComputerExecutionEnv({
    workspace: env.WORKSPACES.getByName(object),
    id: `computer:${object}`,
    cwd: "/workspace",
  });

  const read = await files.readTextFile(path, BACKGROUND_CONTEXT);

  return read.ok ? read.value : null;
};

// The subagent tools are deferred: the root loads them first.
const LOAD_SUBAGENT_TOOLS = call("tool_search", { query: "subagent subagent_wait agent_message" });

describe("a subagent in a Subagent Workspace", () => {
  it("runs its tools in its own Workspace DO, not the parent's, and still does after an eviction", async () => {
    const slug = uniqueWorkspace();
    const stub = env.WORKSPACE_SESSIONS.get(env.WORKSPACE_SESSIONS.newUniqueId());
    const child = `${SUBAGENT_WORKSPACE_PREFIX}${stub.id.toString()}-agent-1`;

    await runInDurableObject(stub, async (instance: TestWorkspaceSession) => {
      instance.bindWorkspace(slug);
      instance.agentScript("agent-1", [
        call("write", { path: "/workspace/child.txt", content: "from the child\n" }),
        "Wrote it.",
      ]);
      instance.script([
        LOAD_SUBAGENT_TOOLS,
        call("subagent", { task: "Write child.txt", workspace: "new" }),
        call("subagent_wait", { agent_id: "agent-1" }),
        "done",
      ]);

      const answer = await instance.prompt({ requestId: crypto.randomUUID(), text: "go" });

      expect(answer).toMatchObject({ status: "answered", text: "done" });

      const results = await instance.toolResults();

      expect(results.at(-2)).toContain(`Subagent Workspace ${child}, on branch cloudpid/agent-1`);
      // The report names the child's branch and that it has nothing unpushed.
      expect(results.at(-1)).toContain(
        `[Subagent Workspace ${child} | branch cloudpid/agent-1 | everything is committed and pushed]`,
      );
    });

    expect(await fileIn(child, "child.txt")).toBe("from the child\n");
    expect(await fileIn(slug, "child.txt")).toBeNull();

    await evictDurableObject(stub);

    // A new instance reads where the child works from the Subagents document.
    await runInDurableObject(stub, async (instance: TestWorkspaceSession) => {
      instance.bindWorkspace(slug);
      instance.agentScript("agent-1", [
        call("write", { path: "/workspace/after.txt", content: "after the eviction\n" }),
        "Wrote it again.",
      ]);
      instance.script([
        LOAD_SUBAGENT_TOOLS,
        call("agent_message", { agent_id: "agent-1", message: "Write after.txt" }),
        call("subagent_wait", { agent_id: "agent-1" }),
        call("write", { path: "/workspace/parent.txt", content: "from the parent\n" }),
        "done",
      ]);

      const answer = await instance.prompt({ requestId: crypto.randomUUID(), text: "again" });

      expect(answer).toMatchObject({ status: "answered", text: "done" });
    });

    expect(await fileIn(child, "after.txt")).toBe("after the eviction\n");
    expect(await fileIn(slug, "after.txt")).toBeNull();
    expect(await fileIn(slug, "parent.txt")).toBe("from the parent\n");
    expect(await fileIn(child, "parent.txt")).toBeNull();
  });
});
