// The Skill set a Workspace holds (empty until one is handed over) and its repo's skills, through Sessions and the
// environment (docs/architecture/workspace.md → Filesystem and tools).
// They live in their own file so no file of the `workerd-session` project grows large (#64).
// @effect-diagnostics asyncFunction:off preferEffectArray:off preferEffectRecord:off
import { ComputerExecutionEnv } from "@cloudpid/computer-env";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { call, sessionOn, uniqueWorkspace } from "./session.workerd.helpers.ts";
import { EMPTY_SKILL_SET } from "./skill-set-schema.ts";
import { skillFile } from "./skills.fixtures.ts";
import { UNWRITABLE_SKILL_SET } from "./workerd.fixture.ts";

const DEPLOY_SKILL = skillFile("deploy", "Deploy this repo to staging.", "Run `./deploy.sh`.");

/** A Skill set an Environment might hand its Workspaces: `tdd`, with two files it refers to. */
const TDD_SET = {
  hash: "sha256:tdd",
  files: {
    "tdd/SKILL.md": skillFile(
      "tdd",
      "Test-driven development.",
      "# Test-Driven Development\n\nSee [tests.md](tests.md).",
    ),
    "tdd/tests.md": "# Good and bad tests\n",
    "tdd/mocking.md": "# Mocking\n",
  },
};

/** The Workspace `slug`, handed `TDD_SET` as its Environment's Skill set. */
const withTdd = async (slug: string) => {
  expect(await env.WORKSPACES.getByName(slug).updateSkills(TDD_SET)).toEqual({ ok: true });
};

describe("a Workspace that was handed no Skill set", () => {
  it("holds the empty set: an empty read-only mount, and no Skill in its system prompt", async () => {
    const slug = uniqueWorkspace();

    const { results, sections } = await sessionOn(slug).runFull([
      call("bash", {
        command: "cd /workspace/.agents/skills && find . -type f",
        backend: "worker",
      }),
      call("write", { path: "/workspace/.agents/skills/mine/SKILL.md", content: DEPLOY_SKILL }),
    ]);

    expect((results[0] ?? "").trim()).toBe("");
    expect(results[1]).toContain("read-only mount at /workspace/.agents/skills");
    expect(sections["skills"] ?? "").not.toContain("<name>");
    expect(sections["skills"] ?? "").not.toContain("environment_skill_save");
    expect(await env.WORKSPACES.getByName(slug).skillSetHash()).toBe(EMPTY_SKILL_SET.hash);
    expect(await env.WORKSPACES.getByName(slug).skills("/workspace")).toEqual([]);
  });

  it("lists only its repo's Skills", async () => {
    const slug = uniqueWorkspace();

    await sessionOn(slug).runFull([
      call("bash", { command: "mkdir demo && cd demo && git init -b main", backend: "worker" }),
      call("write", { path: "demo/.agents/skills/deploy/SKILL.md", content: DEPLOY_SKILL }),
    ]);

    const { sections } = await sessionOn(slug, "demo").runFull([]);

    expect(sections["skills"]).toContain("<name>deploy</name>");
    expect(sections["skills"]).not.toContain("environment_skill_save");
    expect(sections["skills"]).not.toContain("<location>/workspace/.agents/skills/");
  });

  it("is cleared at its next index when its mount was copied from another set before, with nothing kept", async () => {
    const slug = uniqueWorkspace();
    const workspace = env.WORKSPACES.getByName(slug);

    // A mount copied from a set the Workspace no longer holds (none kept in its storage), as computer recorded it.
    await withTdd(slug);
    expect(
      (await sessionOn(slug).runFull([call("ls", { path: "/workspace/.agents/skills" })])).results,
    ).toEqual(["tdd/"]);

    await runInDurableObject(workspace, async (_instance, state) => {
      for (const [key] of state.storage.kv.list({ prefix: "cloudpid:skills:" })) {
        state.storage.kv.delete(key);
      }
    });
    await evictDurableObject(workspace);

    expect(await workspace.skillSetHash()).toBe(EMPTY_SKILL_SET.hash);

    const { results, sections } = await sessionOn(slug).runFull([
      call("ls", { path: "/workspace/.agents/skills" }),
    ]);

    expect(results[0]).toContain("empty directory");
    expect(sections["skills"] ?? "").not.toContain("<name>tdd</name>");
  });
});

describe("the Skill set mounted in a Workspace", () => {
  it("is listed in the system prompt with the skills of the repo the Session works in", async () => {
    const slug = uniqueWorkspace();

    await withTdd(slug);
    await sessionOn(slug).runFull([
      call("bash", { command: "mkdir demo && cd demo && git init -b main", backend: "worker" }),
      call("write", { path: "demo/.agents/skills/deploy/SKILL.md", content: DEPLOY_SKILL }),
    ]);

    const { sections } = await sessionOn(slug, "demo").runFull([]);

    const skills = sections["skills"] ?? "";

    expect(skills).toContain("<name>deploy</name>");
    expect(skills).toContain("<description>Deploy this repo to staging.</description>");
    expect(skills).toContain("<location>/workspace/demo/.agents/skills/deploy/SKILL.md</location>");
    expect(skills).toContain("<name>tdd</name>");
    expect(skills).toContain("<description>Test-driven development.");
    expect(skills).toContain("<location>/workspace/.agents/skills/tdd/SKILL.md</location>");
    expect(skills).toContain(
      "The skills in /workspace/.agents/skills are the Environment's (its own, and those kept for every Environment) and read-only: change them with environment_skill_save and the other environment_skill_* tools",
    );
  });

  it("list no repo's skills to a Session that works at the Workspace root", async () => {
    const slug = uniqueWorkspace();

    await withTdd(slug);
    await sessionOn(slug).runFull([
      call("write", { path: "demo/.agents/skills/deploy/SKILL.md", content: DEPLOY_SKILL }),
    ]);

    const { sections } = await sessionOn(slug).runFull([]);

    expect(sections["skills"]).toContain("<name>tdd</name>");
    expect(sections["skills"]).not.toContain("<name>deploy</name>");
  });

  it("let the agent read a skill's SKILL.md and the files it refers to by path", async () => {
    const slug = uniqueWorkspace();

    await withTdd(slug);

    const { results } = await sessionOn(slug).runFull([
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
    expect(results[1]).toContain("# Good and bad tests");
    expect(results[2]).toBe("mocking.md\nSKILL.md\ntests.md");
    expect(results[3]).toMatch(/^# /);
  });

  it("reject writes under the mount, whichever tool tries", async () => {
    const slug = uniqueWorkspace();

    await withTdd(slug);

    const { results } = await sessionOn(slug).runFull([
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

    const after = await sessionOn(slug).runFull([
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

  it("are skipped by a search from above the mount, and found by one of the mount", async () => {
    const slug = uniqueWorkspace();

    await withTdd(slug);

    const { results } = await sessionOn(slug).runFull([
      call("write", { path: "notes.txt", content: "Test-Driven Development\n" }),
      call("find", { pattern: "SKILL.md" }),
      call("grep", { pattern: "Test-Driven Development" }),
      call("find", { pattern: "SKILL.md", path: "/workspace/.agents/skills" }),
      call("grep", { pattern: "# Test-Driven Development", path: "/workspace/.agents/skills/tdd" }),
    ]);

    expect(results[1]).toBe("No files found matching pattern");
    expect(results[2]).toBe("notes.txt:1: Test-Driven Development");
    expect(results[3]).toContain("tdd/SKILL.md");
    expect(results[4]).toBe("SKILL.md:6: # Test-Driven Development");
  });
});

describe("the Skill set a Workspace holds", () => {
  /** What the Worker Shell lists under the mount, one path per line, and the Skills the `skills` section lists. */
  const seen = async (slug: string) => {
    const { results, sections } = await sessionOn(slug).runFull([
      call("bash", {
        command: "cd /workspace/.agents/skills && find . -type f",
        backend: "worker",
      }),
    ]);

    return {
      files: (results[0] ?? "")
        .split("\n")
        .filter((path) => path !== "")
        .sort(),
      section: sections["skills"] ?? "",
    };
  };

  it("replaces the mount's files when a set is handed over, in the files, the Worker Shell and the skills section", async () => {
    const slug = uniqueWorkspace();
    const workspace = env.WORKSPACES.getByName(slug);

    // Another set is mounted first, as in a Workspace a Session already used.
    await withTdd(slug);
    expect((await seen(slug)).section).toContain("<name>tdd</name>");

    expect(
      await workspace.updateSkills({
        hash: "sha256:one",
        files: {
          "deploy/SKILL.md": skillFile("deploy", "Deploy to staging."),
          "deploy/steps.md": "1. build\n",
          "review/SKILL.md": skillFile("review", "Review a change."),
        },
      }),
    ).toEqual({ ok: true });

    const first = await seen(slug);

    expect(first.files).toEqual(["./deploy/SKILL.md", "./deploy/steps.md", "./review/SKILL.md"]);
    expect(first.section).toContain("<name>deploy</name>");
    expect(first.section).toContain(
      "<location>/workspace/.agents/skills/review/SKILL.md</location>",
    );
    expect(first.section).not.toContain("<name>tdd</name>");
    expect(await workspace.skillSetHash()).toBe("sha256:one");

    // A file changed, one added, and a file and a whole Skill removed.
    expect(
      await workspace.updateSkills({
        hash: "sha256:two",
        files: {
          "deploy/SKILL.md": skillFile("deploy", "Deploy to production."),
          "lint/SKILL.md": skillFile("lint", "Lint the repo."),
        },
      }),
    ).toEqual({ ok: true });

    const second = await seen(slug);

    const { results } = await sessionOn(slug).runFull([
      call("read", { path: "/workspace/.agents/skills/deploy/SKILL.md" }),
      call("ls", { path: "/workspace/.agents/skills" }),
    ]);

    expect(second.files).toEqual(["./deploy/SKILL.md", "./lint/SKILL.md"]);
    expect(second.section).toContain("<description>Deploy to production.</description>");
    expect(second.section).toContain("<name>lint</name>");
    expect(second.section).not.toContain("<name>review</name>");
    expect(results[0]).toContain("description: Deploy to production.");
    expect(results[1]).toBe("deploy/\nlint/");
  });

  it("is emptied by the empty set, which is kept as nothing, after an eviction too", async () => {
    const slug = uniqueWorkspace();
    const workspace = env.WORKSPACES.getByName(slug);

    await withTdd(slug);
    expect((await seen(slug)).files).toHaveLength(3);

    expect(await workspace.updateSkills(EMPTY_SKILL_SET)).toEqual({ ok: true });

    const emptied = await seen(slug);

    expect(emptied.files).toEqual([]);
    expect(emptied.section).not.toContain("<name>tdd</name>");
    expect(await workspace.skillSetHash()).toBe(EMPTY_SKILL_SET.hash);

    await evictDurableObject(workspace);

    expect(await workspace.skillSetHash()).toBe(EMPTY_SKILL_SET.hash);
    expect((await seen(slug)).files).toEqual([]);
  });

  it("is left as it is by a set with the hash it already has", async () => {
    const slug = uniqueWorkspace();
    const workspace = env.WORKSPACES.getByName(slug);

    await workspace.updateSkills({
      hash: "sha256:same",
      files: { "deploy/SKILL.md": skillFile("deploy", "Deploy to staging.") },
    });
    expect(
      await workspace.updateSkills({
        hash: "sha256:same",
        files: { "other/SKILL.md": skillFile("other", "Something else.") },
      }),
    ).toEqual({ ok: true });

    const { files, section } = await seen(slug);

    expect(files).toEqual(["./deploy/SKILL.md"]);
    expect(section).not.toContain("<name>other</name>");
  });

  it("stays read-only after a hand-over, whichever tool writes", async () => {
    const slug = uniqueWorkspace();

    await seen(slug);
    await env.WORKSPACES.getByName(slug).updateSkills({
      hash: "sha256:ro",
      files: { "deploy/SKILL.md": skillFile("deploy", "Deploy to staging.") },
    });

    const { results } = await sessionOn(slug).runFull([
      call("write", { path: "/workspace/.agents/skills/deploy/NOTES.md", content: "mine\n" }),
      call("write", { path: "/workspace/.agents/skills/mine/SKILL.md", content: DEPLOY_SKILL }),
      call("bash", { command: "rm /workspace/.agents/skills/deploy/SKILL.md", backend: "worker" }),
      call("bash", {
        command: "echo x > /workspace/.agents/skills/deploy/SKILL.md",
        backend: "worker",
      }),
    ]);

    for (const result of results) {
      expect(result).toContain("read-only mount at /workspace/.agents/skills");
    }

    expect((await seen(slug)).files).toEqual(["./deploy/SKILL.md"]);
  });

  it("refuses a set whose paths are not the mount's as a walk lists them, and keeps the one it holds", async () => {
    const slug = uniqueWorkspace();
    const workspace = env.WORKSPACES.getByName(slug);

    for (const path of [
      "../escape/SKILL.md",
      "./deploy/SKILL.md",
      "deploy//SKILL.md",
      "/deploy/SKILL.md",
      "deploy/SKILL.md/",
      "deploy\\SKILL.md",
    ]) {
      const answer = await workspace.updateSkills({
        hash: "sha256:bad",
        files: { [path]: skillFile("deploy") },
      });

      expect(answer).toMatchObject({ ok: false, message: expect.stringContaining(path) });
    }

    // A path that is both a file and a directory.
    expect(
      await workspace.updateSkills({
        hash: "sha256:bad",
        files: { "deploy/SKILL.md": skillFile("deploy"), deploy: "x" },
      }),
    ).toMatchObject({ ok: false });

    expect(await workspace.skillSetHash()).toBe(EMPTY_SKILL_SET.hash);
    expect((await seen(slug)).files).toEqual([]);
  });

  it("keeps the set it holds, mounted and read-only, when a new one cannot be written", async () => {
    const slug = uniqueWorkspace();
    const workspace = env.WORKSPACES.getByName(slug);

    await workspace.updateSkills({
      hash: "sha256:held",
      files: { "deploy/SKILL.md": skillFile("deploy", "Deploy to staging.") },
    });

    const answer = await workspace.updateSkills({
      hash: `${UNWRITABLE_SKILL_SET}:new`,
      files: { "lint/SKILL.md": skillFile("lint"), "review/SKILL.md": skillFile("review") },
    });

    expect(answer).toEqual({
      ok: false,
      message:
        "The Skill set could not be mounted, and the Workspace keeps the one it held: the Skill set's files could not be written",
    });
    expect(await workspace.skillSetHash()).toBe("sha256:held");

    const { files, section } = await seen(slug);

    expect(files).toEqual(["./deploy/SKILL.md"]);
    expect(section).toContain("<name>deploy</name>");
    expect(section).not.toContain("<name>lint</name>");

    const { results } = await sessionOn(slug).runFull([
      call("write", { path: "/workspace/.agents/skills/mine/SKILL.md", content: DEPLOY_SKILL }),
      call("bash", {
        command: "echo x > /workspace/.agents/skills/deploy/SKILL.md",
        backend: "worker",
      }),
    ]);

    for (const result of results) {
      expect(result).toContain("read-only mount at /workspace/.agents/skills");
    }

    // And after an eviction, the set kept is the one held.
    await evictDurableObject(workspace);

    expect(await workspace.skillSetHash()).toBe("sha256:held");
    expect((await seen(slug)).files).toEqual(["./deploy/SKILL.md"]);
  });
});

describe("a Workspace with the read-only mount", () => {
  const envOn = (slug: string) =>
    new ComputerExecutionEnv({
      workspace: env.WORKSPACES.getByName(slug),
      id: `computer:${slug}`,
      cwd: "/workspace",
    });

  it("still makes a directory that exists, above the mount, and files in it", async () => {
    const workspace = envOn(uniqueWorkspace());

    getOrThrow(await workspace.createDir("/workspace", { recursive: true }, BACKGROUND_CONTEXT));
    getOrThrow(await workspace.writeFile("top.txt", "x", BACKGROUND_CONTEXT));
    getOrThrow(
      await workspace.createDir("/workspace/new/deep", { recursive: true }, BACKGROUND_CONTEXT),
    );
    getOrThrow(await workspace.writeFile("/workspace/new/deep/a.txt", "y", BACKGROUND_CONTEXT));

    expect(
      getOrThrow(await workspace.readTextFile("/workspace/new/deep/a.txt", BACKGROUND_CONTEXT)),
    ).toBe("y");
  });

  it("refuses to make or write below the mount", async () => {
    const workspace = envOn(uniqueWorkspace());

    for (const result of [
      await workspace.createDir(
        "/workspace/.agents/skills/mine",
        { recursive: true },
        BACKGROUND_CONTEXT,
      ),
      await workspace.writeFile("/workspace/.agents/skills/mine/SKILL.md", "x", BACKGROUND_CONTEXT),
    ]) {
      expect(result).toMatchObject({ ok: false, error: { code: "permission_denied" } });
    }
  });

  it("lets the Worker Shell make a directory that exists, above the mount", async () => {
    const { results } = await sessionOn(uniqueWorkspace()).runFull([
      call("bash", {
        command:
          "mkdir -p /workspace && echo a=$? && mkdir -p . && echo b=$? && touch /workspace && echo c=$? && mkdir -p /workspace/new/deep && echo d=$?",
        backend: "worker",
      }),
      call("bash", { command: "mkdir -p /workspace/.agents/skills/mine", backend: "worker" }),
    ]);

    expect(results[0]).toBe("a=0\nb=0\nc=0\nd=0\n");
    expect(results[1]).toContain("read-only mount at /workspace/.agents/skills");
  });
});
