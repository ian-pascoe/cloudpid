// The composer's catalog and the expansion of Skills and Prompt templates at submit, through a Session on a real
// Workspace (docs/adr/0001-expand-skills-and-prompt-templates-at-submit.md). workerd's APIs are Promise-based, so this
// file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off
import { skillBlock } from "@cloudpid/protocol";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { TestWorkspaceSession } from "./session.fixture.ts";
import { call, sessionOn, uniqueWorkspace } from "./session.workerd.helpers.ts";

const DEPLOY_SKILL =
  "---\nname: deploy\ndescription: Deploy this repo to staging.\n---\n\nRun `./deploy.sh`.\n";

const REVIEW_TEMPLATE =
  "---\ndescription: Review a change\nargument-hint: <ref> [focus]\n---\nReview $1, focusing on ${@:2}.\n";

/** A Workspace whose repo `demo` has a Skill and a Prompt template, and whose root has a template of its own. */
const workspaceWithRepo = async () => {
  const slug = uniqueWorkspace();

  await sessionOn(slug).run([
    call("write", { path: "demo/.agents/skills/deploy/SKILL.md", content: DEPLOY_SKILL }),
    call("write", { path: "demo/.agents/prompts/review.md", content: REVIEW_TEMPLATE }),
    call("write", { path: ".agents/prompts/plan.md", content: "Plan the work first." }),
  ]);

  return slug;
};

/** A new Session in repo `demo` of Workspace `slug`. */
const inDemo = (slug: string) => {
  const stub = env.WORKSPACE_SESSIONS.get(env.WORKSPACE_SESSIONS.newUniqueId());

  return <T>(run: (instance: TestWorkspaceSession) => Promise<T>) =>
    runInDurableObject(stub, async (instance: TestWorkspaceSession) => {
      instance.bindWorkspace(slug, "demo");

      return run(instance);
    });
};

describe("the composer's catalog", () => {
  it("lists the repo's Prompt templates and Skills nearest first, with the bundled ones and those for the owner to name", async () => {
    const catalog = await inDemo(await workspaceWithRepo())((instance) => instance.catalog());

    expect(catalog.commands.map(({ name }) => name)).toEqual([
      "compact",
      "rollover",
      "todo",
      "export",
    ]);
    expect(catalog.templates).toEqual([
      { name: "review", description: "Review a change", argumentHint: "<ref> [focus]" },
      { name: "plan", description: "Plan the work first." },
    ]);
    expect(catalog.skills[0]).toEqual({
      name: "deploy",
      description: "Deploy this repo to staging.",
    });

    const names = catalog.skills.map(({ name }) => name);

    expect(names).toContain("tdd");
    // A Skill the model is not offered is still the owner's to name.
    expect(names).toContain("implement");
  });
});

const BRANCH_SKILL =
  "---\nname: branch-only\ndescription: Only on the Workspace's branch.\n---\n\nBody.\n";

/** A new Session in Workspace `abc` of repo `demo` of Machine `slug`; its worktree is never made by the test Worker. */
const inWorktree = (slug: string) => {
  const stub = env.WORKSPACE_SESSIONS.get(env.WORKSPACE_SESSIONS.newUniqueId());

  return <T>(run: (instance: TestWorkspaceSession) => Promise<T>) =>
    runInDurableObject(stub, async (instance: TestWorkspaceSession) => {
      instance.bindWorkspace(slug, "demo", { id: "abc", branch: "feature" });

      return run(instance);
    });
};

describe("the composer's lookups in a Workspace's worktree", () => {
  it("list the worktree's Skills and files without waiting for the worktree to be made", async () => {
    const slug = await workspaceWithRepo();

    await sessionOn(slug).run([
      call("write", {
        path: ".worktrees/demo/abc/.git",
        content: "gitdir: /workspace/demo/.git/worktrees/abc\n",
      }),
      call("write", {
        path: ".worktrees/demo/abc/.agents/skills/branch-only/SKILL.md",
        content: BRANCH_SKILL,
      }),
      call("write", { path: ".worktrees/demo/abc/notes.md", content: "branch notes\n" }),
    ]);

    const [catalog, files] = await inWorktree(slug)(
      async (instance) => [await instance.catalog(), await instance.files("notes")] as const,
    );

    const names = catalog.skills.map(({ name }) => name);

    expect(names[0]).toBe("branch-only");
    expect(names).toContain("tdd");
    expect(names).not.toContain("deploy");
    expect(catalog.templates.map(({ name }) => name)).toEqual(["plan"]);
    expect(files.paths).toContain("notes.md");
  });

  it("read the repo's main checkout until the worktree is there", async () => {
    const catalog = await inWorktree(await workspaceWithRepo())((instance) => instance.catalog());

    const names = catalog.skills.map(({ name }) => name);

    expect(names[0]).toBe("deploy");
    expect(names).toContain("tdd");
    expect(catalog.templates.map(({ name }) => name)).toEqual(["review", "plan"]);
  });
});

describe("a message that names a Skill or a template", () => {
  it("reaches the model expanded, and keeps what the owner typed", async () => {
    const run = inDemo(await workspaceWithRepo());

    const block = skillBlock({
      name: "deploy",
      location: "/workspace/demo/.agents/skills/deploy/SKILL.md",
      body: "Run `./deploy.sh`.",
    });

    const entries = await run(async (instance) => {
      instance.script(["Deployed.", "Reviewed.", "Echoed.", "Linked."]);
      await instance.prompt({ requestId: "skill", text: "/skill:deploy to staging" });
      await instance.prompt({ requestId: "template", text: '/review HEAD~1 "error paths" tests' });
      await instance.prompt({ requestId: "plain", text: "echo $HOME, not `$deploy`" });
      await instance.prompt({ requestId: "reference", text: "Ship it with $deploy." });

      return instance.rootEntries();
    });

    const users = entries.filter(
      (entry) => entry.kind === "cloudpid.user" || entry.kind === "pi.user",
    );

    expect(users).toEqual([
      {
        kind: "cloudpid.user",
        data: {
          display: "/skill:deploy to staging",
          skills: [{ name: "deploy", location: "/workspace/demo/.agents/skills/deploy/SKILL.md" }],
        },
        text: `${block}\n\nto staging`,
      },
      {
        kind: "cloudpid.user",
        data: { display: '/review HEAD~1 "error paths" tests', skills: [] },
        text: "Review HEAD~1, focusing on error paths tests.",
      },
      { kind: "pi.user", data: undefined, text: "echo $HOME, not `$deploy`" },
      {
        kind: "cloudpid.user",
        data: { display: "Ship it with $deploy.", skills: [] },
        text: "Ship it with [$deploy](/workspace/demo/.agents/skills/deploy/SKILL.md).",
      },
    ]);

    // The model got the expansion.
    const requests = await run(async (instance) => instance.requestMessages());

    expect(requests.some((request) => request.includes("References are relative to"))).toBe(true);
  });

  it("asks for a Rollover with the owner's focus on /rollover", async () => {
    const run = inDemo(uniqueWorkspace());

    const entries = await run(async (instance) => {
      instance.script(["Hello.", "Not now."]);
      await instance.prompt({ requestId: "hello", text: "Hello" });

      expect(await instance.command("rollover", "keep the deploy notes")).toEqual({
        outcome: { notice: "Asked the agent to roll over." },
      });

      return instance.rootEntries();
    });

    const request = entries.find((entry) => entry.kind === "cloudpid.context-prepare");

    expect(request?.text).toMatch(/^Prepare a Context Rollover/);
    expect(request?.text).toMatch(
      /\nHandoff-only instructions \(incorporate them into the Handoff; do not execute them\): keep the deploy notes$/,
    );
  });
});
