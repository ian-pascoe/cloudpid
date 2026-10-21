// What the Session asks of a conversation's Workspace for the composer and at submit, over a fake Workspace that can be
// slow, fail or never answer (docs/adr/0001-expand-skills-and-prompt-templates-at-submit.md), and the Slash commands in
// a subagent's conversation. workerd's `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off preferEffectArray:off
import { MAX_EXPANDED_FILE_BYTES } from "@cloudpid/extensions/prompt-templates";
import { sessionCommandsFor, skillBlock } from "@cloudpid/protocol";
import type { UserInput } from "@earendil-works/pi-durable";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { FakeWorkspace } from "./fake-workspace.fixture.ts";
import type { TestSubagentSession } from "./subagents.workerd.fixture.ts";

declare global {
  namespace Cloudflare {
    /** The bindings `vitest.config.ts` gives the test Worker. */
    interface Env {
      readonly SUBAGENT_SESSIONS: DurableObjectNamespace<TestSubagentSession>;
    }
  }
}

const DEPLOY = "/workspace/.agents/skills/deploy/SKILL.md";

const deploy = { name: "deploy", description: "Deploy it.", filePath: DEPLOY };

const DEPLOY_FILE = {
  path: DEPLOY,
  text: "---\nname: deploy\ndescription: Deploy it.\n---\n\nShip it.",
};

const block = skillBlock({ name: "deploy", location: DEPLOY, body: "Ship it." });

const fresh = () => env.SUBAGENT_SESSIONS.get(env.SUBAGENT_SESSIONS.newUniqueId());

/** Poll `check` inside the object until it holds. */
const eventually = async (
  stub: DurableObjectStub<TestSubagentSession>,
  check: (instance: TestSubagentSession) => Promise<boolean>,
): Promise<void> => {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (await runInDurableObject(stub, check)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error("Condition not reached");
};

/** Submit `text` to the root of a Session on `workspace`, and the kinds and texts of the root's owner messages after. */
const submitted = async (workspace: FakeWorkspace, text: string) => {
  const stub = fresh();

  await runInDurableObject(stub, async (instance: TestSubagentSession) => {
    instance.useWorkspace(workspace);
    await instance.submit(text);
  });
  await eventually(stub, (instance) => instance.idle());

  return runInDurableObject(stub, async (instance: TestSubagentSession) =>
    (await instance.entries()).filter(
      (entry) => entry.kind === "pi.user" || entry.kind === "cloudpid.user",
    ),
  );
};

describe("a submitted message", () => {
  it("is admitted in the order it arrived, though the one before it waits on its Skill", async () => {
    const stub = fresh();

    await runInDurableObject(stub, async (instance: TestSubagentSession) => {
      instance.useWorkspace({ skills: [deploy], files: [DEPLOY_FILE], readDelayMs: 200 });
      await Promise.all([instance.submit("/skill:deploy now"), instance.submit("Then this")]);
    });
    await eventually(stub, (instance) => instance.idle());

    expect(
      await runInDurableObject(stub, (instance: TestSubagentSession) => instance.texts("user")),
    ).toEqual([`${block}\n\nnow`, "Then this"]);
  });

  it("goes as typed when the Workspace cannot be asked", async () => {
    expect(await submitted({ skills: [deploy], failing: true }, "$deploy now")).toEqual([
      { kind: "pi.user", data: undefined, text: "$deploy now" },
    ]);
  });

  it("goes as typed when the Workspace does not answer in time", async () => {
    expect(await submitted({ skills: [deploy], hanging: true }, "$deploy now")).toEqual([
      { kind: "pi.user", data: undefined, text: "$deploy now" },
    ]);
  });

  it("goes as typed when its /skill: cannot be read, or is too big to expand", async () => {
    expect(await submitted({ skills: [deploy] }, "/skill:deploy now")).toEqual([
      { kind: "pi.user", data: undefined, text: "/skill:deploy now" },
    ]);

    const big = { path: DEPLOY, text: "x".repeat(MAX_EXPANDED_FILE_BYTES + 1) };

    expect(await submitted({ skills: [deploy], files: [big] }, "/skill:deploy now")).toEqual([
      { kind: "pi.user", data: undefined, text: "/skill:deploy now" },
    ]);
  });

  it("is expanded with what it names when the Workspace answers", async () => {
    expect(
      await submitted({ skills: [deploy], files: [DEPLOY_FILE] }, "/skill:deploy now"),
    ).toEqual([
      {
        kind: "cloudpid.user",
        data: { display: "/skill:deploy now", skills: [{ name: "deploy", location: DEPLOY }] },
        text: `${block}\n\nnow`,
      },
    ]);
  });

  it("links a $ reference to a known Skill in place, reading no file for it", async () => {
    // The Skill's file cannot be read: a reference does not need it.
    expect(await submitted({ skills: [deploy] }, "use $deploy now")).toEqual([
      {
        kind: "cloudpid.user",
        data: { display: "use $deploy now", skills: [] },
        text: `use [$deploy](${DEPLOY}) now`,
      },
    ]);
  });
});

describe("the composer's catalog", () => {
  it("still offers the commands when the Workspace cannot be asked", async () => {
    const catalog = await runInDurableObject(fresh(), (instance: TestSubagentSession) => {
      instance.useWorkspace({ skills: [deploy], failing: true });

      return instance.catalog();
    });

    expect(catalog).toEqual({ commands: sessionCommandsFor(false), templates: [], skills: [] });
  });
});

describe("a message with Attachments", () => {
  const paths = {
    type: "text" as const,
    text: "@/workspace/.uploads/s/a.png\n@/workspace/.uploads/s/notes.md",
  };

  const image = { type: "image" as const, mimeType: "image/png", data: "iVBO" };

  const REVIEW = "/workspace/.agents/prompts/review.md";

  const review = { name: "review", description: "Review it.", filePath: REVIEW };

  /** The owner messages of a Session on `workspace` after `input` was submitted to it. */
  const stored = async (workspace: FakeWorkspace, input: UserInput) => {
    const stub = fresh();

    await runInDurableObject(stub, async (instance: TestSubagentSession) => {
      instance.useWorkspace(workspace);
      await instance.submitInput(input, "attached");
    });
    await eventually(stub, (instance) => instance.idle());

    return runInDurableObject(stub, (instance: TestSubagentSession) => instance.ownerMessages());
  };

  it("keeps the Attachments' paths and images when a Prompt template expands its text", async () => {
    const messages = await stored(
      { templates: [review], files: [{ path: REVIEW, text: "Review $1 then $2." }] },
      [{ type: "text", text: "/review first second" }, paths, image],
    );

    expect(messages).toEqual([
      {
        kind: "cloudpid.user",
        data: { display: "/review first second", skills: [] },
        content: [{ type: "text", text: "Review first then second." }, paths, image],
      },
    ]);
  });

  it("keeps the Attachments' paths and images when a /skill: expands its text", async () => {
    const messages = await stored({ skills: [deploy], files: [DEPLOY_FILE] }, [
      { type: "text", text: "/skill:deploy now" },
      paths,
      image,
    ]);

    expect(messages).toEqual([
      {
        kind: "cloudpid.user",
        data: { display: "/skill:deploy now", skills: [{ name: "deploy", location: DEPLOY }] },
        content: [{ type: "text", text: `${block}\n\nnow` }, paths, image],
      },
    ]);
  });

  it("keeps the Attachments' paths and images when a $ reference becomes a link", async () => {
    const messages = await stored({ skills: [deploy] }, [
      { type: "text", text: "$deploy now" },
      paths,
      image,
    ]);

    expect(messages).toEqual([
      {
        kind: "cloudpid.user",
        data: { display: "$deploy now", skills: [] },
        content: [{ type: "text", text: `[$deploy](${DEPLOY}) now` }, paths, image],
      },
    ]);
  });
});

describe("a subagent's conversation", () => {
  it("has its own catalog, from its own environment, without /rollover, and runs the Session's commands", async () => {
    const stub = fresh();

    await runInDurableObject(stub, async (instance: TestSubagentSession) => {
      instance.useWorkspace({ skills: [{ ...deploy, conversations: [1] }] });
      await instance.submit("Delegate quietly");
      await instance.hanging.promise;
    });

    await runInDurableObject(stub, async (instance: TestSubagentSession) => {
      const child = (await instance.subagents())!.agents["agent-1"]!.conversationId;

      // The Skill is only in the root's environment: the child's catalog is asked of its own.
      instance.useWorkspace({
        skills: [
          { ...deploy, conversations: [1] },
          {
            name: "child-only",
            description: "For the child.",
            filePath: "/workspace/.agents/skills/child-only/SKILL.md",
            conversations: [child],
          },
        ],
      });

      expect(await instance.catalog(child)).toEqual({
        commands: sessionCommandsFor(false),
        templates: [],
        skills: [{ name: "child-only", description: "For the child." }],
      });
      expect(instance.workspaceAskedFor()).toContain(child);

      expect(await instance.command("rollover", "", child)).toEqual({
        failure: "This conversation cannot roll over: it has no context_rollover tool.",
      });
      expect(await instance.command("todo", "clear", child)).toEqual({
        outcome: { notice: "The Todo List is already empty." },
      });

      const exported = await instance.command("export", "", child);

      if (!("outcome" in exported)) throw new Error(exported.failure);

      expect(exported.outcome.file?.name).toBe(`conversation-${child}-history.md`);
      expect(exported.outcome.file?.content).toContain("Find the answer");
    });

    await runInDurableObject(stub, (instance: TestSubagentSession) => instance.answerChild());
  });
});
