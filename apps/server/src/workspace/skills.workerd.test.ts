// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off cryptoRandomUUID:off
import type { JsonValue } from "@earendil-works/chord";
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
const uniqueWorkspace = () => `skills-${++workspaces}`;

/** A new Session on Workspace `slug`, working in its repo directory `repo` if it has one. */
const sessionOn = (slug: string, repo: string | null = null) => {
  const stub = env.WORKSPACE_SESSIONS.get(env.WORKSPACE_SESSIONS.newUniqueId());

  /** Run one Run whose scripted model calls each tool in turn, then answers. */
  const run = (calls: readonly string[]) =>
    runInDurableObject(stub, async (instance: TestWorkspaceSession) => {
      instance.bindWorkspace(slug, repo);
      instance.script([...calls, "done"]);

      const earlier = (await instance.toolResults()).length;

      const answer = await instance.prompt({ requestId: crypto.randomUUID(), text: "go" });

      expect(answer).toMatchObject({ status: "answered", text: "done" });

      return {
        results: (await instance.toolResults()).slice(earlier),
        sections: instance.sections(),
      };
    });

  return { run };
};

const call = (tool: string, args: JsonValue) => `call:${tool}:${JSON.stringify(args)}`;

const DEPLOY_SKILL =
  "---\nname: deploy\ndescription: Deploy this repo to staging.\n---\n\nRun `./deploy.sh`.\n";

describe("the bundled skills", () => {
  it("are listed in the system prompt with the skills of the repo the Session works in", async () => {
    const slug = uniqueWorkspace();

    await sessionOn(slug).run([
      call("bash", { command: "mkdir demo && cd demo && git init -b main", backend: "worker" }),
      call("write", { path: "demo/.agents/skills/deploy/SKILL.md", content: DEPLOY_SKILL }),
    ]);

    const { sections } = await sessionOn(slug, "demo").run([]);

    const skills = sections["skills"] ?? "";

    expect(skills).toContain("<name>deploy</name>");
    expect(skills).toContain("<description>Deploy this repo to staging.</description>");
    expect(skills).toContain("<location>/workspace/demo/.agents/skills/deploy/SKILL.md</location>");
    expect(skills).toContain("<name>tdd</name>");
    expect(skills).toContain("<description>Test-driven development.");
    expect(skills).toContain("<location>/workspace/.agents/skills/tdd/SKILL.md</location>");
    // A skill meant to be asked for by name is not listed.
    expect(skills).not.toContain("<name>implement</name>");
  });

  it("list no repo's skills to a Session that works at the Workspace root", async () => {
    const slug = uniqueWorkspace();

    await sessionOn(slug).run([
      call("write", { path: "demo/.agents/skills/deploy/SKILL.md", content: DEPLOY_SKILL }),
    ]);

    const { sections } = await sessionOn(slug).run([]);

    expect(sections["skills"]).toContain("<name>tdd</name>");
    expect(sections["skills"]).not.toContain("<name>deploy</name>");
  });

  it("let the agent read a skill's SKILL.md and the files it refers to by path", async () => {
    const { results } = await sessionOn(uniqueWorkspace()).run([
      call("read", { path: "/workspace/.agents/skills/tdd/SKILL.md" }),
      call("read", { path: "/workspace/.agents/skills/tdd/tests.md" }),
      call("ls", { path: "/workspace/.agents/skills/tdd" }),
      call("bash", {
        command: "head -n 1 /workspace/.agents/skills/tdd/mocking.md",
        backend: "worker",
      }),
    ]);

    expect(results[0]).toContain("# Test-Driven Development");
    expect(results[0]).toContain("[tests.md](tests.md)");
    expect(results[1]).toContain("# ");
    expect(results[2]).toBe("mocking.md\nSKILL.md\ntests.md");
    expect(results[3]).toMatch(/^# /);
  });

  it("reject writes under the mount, whichever tool tries", async () => {
    const slug = uniqueWorkspace();

    const { results } = await sessionOn(slug).run([
      call("write", { path: "/workspace/.agents/skills/tdd/NOTES.md", content: "mine\n" }),
      call("edit", {
        path: "/workspace/.agents/skills/tdd/SKILL.md",
        edits: [{ oldText: "# Test-Driven Development", newText: "# Mine" }],
      }),
      call("write", { path: "/workspace/.agents/skills/mine/SKILL.md", content: DEPLOY_SKILL }),
      call("bash", { command: "rm /workspace/.agents/skills/tdd/SKILL.md", backend: "worker" }),
    ]);

    expect(results).toEqual([
      expect.stringContaining("read-only mount at /workspace/.agents/skills"),
      expect.stringContaining("Error code: permission_denied"),
      expect.stringContaining("read-only mount at /workspace/.agents/skills"),
      expect.stringContaining("read-only mount at /workspace/.agents/skills"),
    ]);

    const after = await sessionOn(slug).run([
      call("read", { path: "/workspace/.agents/skills/tdd/SKILL.md" }),
      call("find", { pattern: "NOTES.md", path: "/workspace/.agents/skills" }),
      call("find", { pattern: "mine", path: "/workspace/.agents/skills" }),
    ]);

    expect(after.results[0]).toContain("# Test-Driven Development");
    expect(after.results.slice(1)).toEqual([
      "No files found matching pattern",
      "No files found matching pattern",
    ]);
  });
});
