// The composer's `@` menu (`files`) over a fake Workspace: the root's directory and a subagent's, the listing held
// between requests, and a Workspace that cannot list. workerd's `cloudflare:test` APIs are Promise-based, so this file is
// too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off
import type { ConversationId } from "@earendil-works/pi-durable";
import type { FileListEntry } from "@earendil-works/pi-durable/env";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { TestSubagentSession } from "./subagents.workerd.fixture.ts";

declare global {
  namespace Cloudflare {
    /** The bindings `vitest.config.ts` gives the test Worker. */
    interface Env {
      readonly SUBAGENT_SESSIONS: DurableObjectNamespace<TestSubagentSession>;
    }
  }
}

const fresh = () => env.SUBAGENT_SESSIONS.get(env.SUBAGENT_SESSIONS.newUniqueId());

const file = (path: string): FileListEntry => ({ path, kind: "file" });

const dir = (path: string): FileListEntry => ({ path, kind: "directory" });

const ROOT_TREE = [dir("src"), file("src/app.ts"), file("src/menu.ts"), file("README.md")];

const SUB_TREE = [dir("lib"), file("lib/sub-only.ts")];

describe("the files the @ menu offers", () => {
  it("are the root directory's, ranked, and listed once for requests close together", async () => {
    const answers = await runInDurableObject(fresh(), async (instance: TestSubagentSession) => {
      instance.useWorkspace({ trees: { "/workspace": ROOT_TREE } });

      return {
        all: await instance.files(""),
        app: await instance.files("app"),
        none: await instance.files("zzz"),
        listed: instance.listedDirectories(),
      };
    });

    expect(answers.all).toEqual({ paths: ["src/", "README.md", "src/app.ts", "src/menu.ts"] });
    expect(answers.app).toEqual({ paths: ["src/app.ts"] });
    expect(answers.none).toEqual({ paths: [] });
    expect(answers.listed).toEqual(["/workspace"]);
  });

  it("fail with why when the Workspace cannot list", async () => {
    const answer = await runInDurableObject(fresh(), (instance: TestSubagentSession) => {
      instance.useWorkspace({ failing: true });

      return instance.files("app");
    });

    expect(answer).toEqual({ failure: expect.stringContaining("The Workspace is unreachable") });
  });

  it("are none without a Workspace, and refused for a conversation that is not the Session's", async () => {
    const answers = await runInDurableObject(fresh(), async (instance: TestSubagentSession) => ({
      none: await instance.files(""),
      // SAFETY: any positive integer is a conversation ID; this one names no conversation of the Session.
      stranger: await instance.files("", 999 as ConversationId),
    }));

    expect(answers.none).toEqual({ paths: [] });
    expect(answers.stranger).toEqual({
      failure: "Conversation 999 is not the root or a subagent of this Session",
    });
  });

  it("are a subagent's own directory's in its composer", async () => {
    const stub = fresh();

    await runInDurableObject(stub, async (instance: TestSubagentSession) => {
      instance.useWorkspace({});
      await instance.submit("Delegate quietly");
      await instance.hanging.promise;
    });

    await runInDurableObject(stub, async (instance: TestSubagentSession) => {
      const child = (await instance.subagents())!.agents["agent-1"]!.conversationId;

      instance.useWorkspace({
        cwds: { [child]: "/workspace/sub" },
        trees: { "/workspace": ROOT_TREE, "/workspace/sub": SUB_TREE },
      });

      expect(await instance.files("only", child)).toEqual({ paths: ["lib/sub-only.ts"] });
      expect(await instance.files("app")).toEqual({ paths: ["src/app.ts"] });
      expect(instance.listedDirectories()).toEqual(["/workspace/sub", "/workspace"]);
    });

    await runInDurableObject(stub, (instance: TestSubagentSession) => instance.answerChild());
  });
});
