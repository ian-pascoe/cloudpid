// pi-durable's Harness and the faux provider are Promise-based, so these tests are too.
// @effect-diagnostics asyncFunction:off missingPipeableSignature:off preferEffectArray:off preferEffectRecord:off
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry, defineTool, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import {
  err,
  FileError,
  ok,
  type ExecutionEnv,
  type FileListEntry,
} from "@earendil-works/pi-durable/env";
import { Type } from "@earendil-works/pi-ai";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import { describe, expect, it } from "vitest";
import { parseSkill, Skills, skillDirectories } from "./skills.ts";

/** A skill's `SKILL.md`. */
const skillFile = (name: string, description: string, extra = "") =>
  `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ${name}\n`;

/** The entries below `prefix` among `paths`: its directories, and its files as `kind`. */
const entriesOf = (
  paths: ReadonlyArray<string>,
  prefix: string,
  kind: FileListEntry["kind"] = "file",
): FileListEntry[] => {
  const directories = new Set(
    paths.flatMap((path) => {
      const segments = path.slice(prefix.length).split("/").slice(0, -1);

      return segments.map((_, index) => segments.slice(0, index + 1).join("/"));
    }),
  );

  return [
    ...[...directories].map((path) => ({ path, kind: "directory" as const })),
    ...paths.map((path) => ({ path: path.slice(prefix.length), kind })),
  ];
};

/**
 * An environment holding `files` (absolute path to text) with `cwd`, that answers what skill discovery asks of one.
 * `links` are symbolic links to directories: the absolute path of each, with the files below its target. A listing
 * shows a link as a link, and does not follow it.
 */
const envOf = (
  cwd: string,
  files: Readonly<Record<string, string>>,
  links: Readonly<Record<string, Readonly<Record<string, string>>>> = {},
): ExecutionEnv => {
  const fake: Pick<ExecutionEnv, "cwd" | "listFiles" | "readTextFile"> = {
    cwd,
    listFiles: (root) => {
      const target = links[root];

      if (target !== undefined) {
        return Promise.resolve(
          ok({
            entries: entriesOf(
              Object.keys(target).map((path) => `${root}/${path}`),
              `${root}/`,
            ),
            truncated: false,
          }),
        );
      }

      const prefix = `${root}/`;
      const below = Object.keys(files).filter((path) => path.startsWith(prefix));
      const linked = Object.keys(links).filter((path) => path.startsWith(prefix));

      if (below.length + linked.length === 0) {
        return Promise.resolve(err(new FileError("not_found", "No such directory", root)));
      }

      return Promise.resolve(
        ok({
          entries: [
            ...entriesOf(below, prefix),
            ...entriesOf(linked, prefix, "symlink").filter((entry) => entry.kind === "symlink"),
          ],
          truncated: false,
        }),
      );
    },
    readTextFile: (path) => {
      const link = Object.keys(links).find((candidate) => path.startsWith(`${candidate}/`));
      const text = link === undefined ? files[path] : links[link]?.[path.slice(link.length + 1)];

      return Promise.resolve(
        text === undefined ? err(new FileError("not_found", "No such file", path)) : ok(text),
      );
    },
  };

  // SAFETY: skill discovery uses only `cwd`, `listFiles` and `readTextFile`, which the fake answers.
  return fake as ExecutionEnv;
};

const noop = defineTool({
  name: "read",
  description: "Read a file",
  parameters: Type.Object({}),
  execute: async () => ({ output: [{ type: "text", text: "" }] }),
});

/** The `skills` section of the system prompt a request in `cwd` over `files` declared; undefined when it has none. */
const skillsSection = async (
  cwd: string,
  files: Readonly<Record<string, string>>,
  tools = true,
  links: Readonly<Record<string, Readonly<Record<string, string>>>> = {},
): Promise<string | undefined> => {
  const faux = fauxProvider();
  const models = createModels();
  const registry = createRegistry();
  const sections: Array<string | null | undefined> = [];

  models.setProvider(faux.provider);
  faux.setResponses([
    (request) => {
      for (const message of request.messages) {
        if (message.role === "system") sections.push(message.sections?.["skills"]);
      }

      return fauxAssistantMessage("ok");
    },
  ]);

  registry.install(await Effect.runPromise(Skills));

  if (tools) registry.install({ name: "tools", tools: [noop] });

  const harness = await Harness.open(
    new MemoryStorage(),
    { models, registry, env: () => envOf(cwd, files, links) },
    BACKGROUND_CONTEXT,
  );

  const root = await harness.root(BACKGROUND_CONTEXT, {
    agent: { model: { provider: "faux", modelId: "faux-1" } },
  });

  await (
    await root.submit({ type: "input", content: "hi" }, BACKGROUND_CONTEXT)
  ).wait(BACKGROUND_CONTEXT);

  return sections.find((section) => Predicate.isString(section)) ?? undefined;
};

describe("parseSkill", () => {
  it("reads the name and description from the frontmatter", () => {
    expect(parseSkill("/s/tdd/SKILL.md", skillFile("tdd", "Test-driven development."))).toEqual({
      name: "tdd",
      description: "Test-driven development.",
      filePath: "/s/tdd/SKILL.md",
      disableModelInvocation: false,
    });
  });

  it("takes the directory's name for a skill with none, and reads quoted and folded descriptions", () => {
    expect(
      parseSkill("/s/pr/SKILL.md", '---\ndescription: "Use when: writing a PR body."\n---\nbody'),
    ).toMatchObject({ name: "pr", description: "Use when: writing a PR body." });
    expect(
      parseSkill("/s/a/SKILL.md", "---\nname: a\ndescription: >\n  folded\n  text\n---\n"),
    ).toMatchObject({
      description: "folded text\n",
    });
  });

  it("loads no skill without a description, without frontmatter, or with frontmatter that is not YAML", () => {
    expect(parseSkill("/s/a/SKILL.md", "---\nname: a\n---\n")).toBeUndefined();
    expect(parseSkill("/s/a/SKILL.md", '---\nname: a\ndescription: "  "\n---\n')).toBeUndefined();
    expect(parseSkill("/s/a/SKILL.md", "# a\n")).toBeUndefined();
    expect(parseSkill("/s/a/SKILL.md", "---\n: [unclosed\n---\n")).toBeUndefined();
  });
});

describe("skillDirectories", () => {
  it("lists the directory and each one above it up to the Workspace root", () => {
    expect(skillDirectories("/workspace/repo/packages/app")).toEqual([
      "/workspace/repo/packages/app",
      "/workspace/repo/packages",
      "/workspace/repo",
      "/workspace",
    ]);
    expect(skillDirectories("/workspace")).toEqual(["/workspace"]);
    expect(skillDirectories("/elsewhere/project")).toEqual(["/elsewhere/project"]);
  });
});

describe("the skills section", () => {
  it("lists bundled and repo-local skills with their descriptions, as pi does", async () => {
    const section = await skillsSection("/workspace/repo", {
      "/workspace/.agents/skills/tdd/SKILL.md": skillFile("tdd", "Test-driven development."),
      "/workspace/.agents/skills/tdd/tests.md": "# tests\n",
      "/workspace/repo/.agents/skills/deploy/SKILL.md": skillFile(
        "deploy",
        'Ship <it> & "verify".',
      ),
    });

    expect(section).toBe(
      [
        "<skills>",
        "The following skills provide specialized instructions for specific tasks.",
        "Use the read tool to load a skill's file when the task matches its description.",
        "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
        "The skills in /workspace/.agents/skills are bundled with the agent and read-only: do not write there.",
        "",
        "<available_skills>",
        "  <skill>",
        "    <name>deploy</name>",
        "    <description>Ship &lt;it&gt; &amp; &quot;verify&quot;.</description>",
        "    <location>/workspace/repo/.agents/skills/deploy/SKILL.md</location>",
        "  </skill>",
        "  <skill>",
        "    <name>tdd</name>",
        "    <description>Test-driven development.</description>",
        "    <location>/workspace/.agents/skills/tdd/SKILL.md</location>",
        "  </skill>",
        "</available_skills>",
        "</skills>",
      ].join("\n"),
    );
  });

  it("finds a repo's skills from a directory below it, and none of another repo's", async () => {
    const section = await skillsSection("/workspace/repo/packages/app", {
      "/workspace/repo/.agents/skills/mine/SKILL.md": skillFile("mine", "Mine."),
      "/workspace/other/.agents/skills/theirs/SKILL.md": skillFile("theirs", "Theirs."),
    });

    expect(section).toContain("<name>mine</name>");
    expect(section).not.toContain("theirs");
  });

  it("keeps the nearest skill when two have a name, and ignores files inside a skill and dot directories", async () => {
    const section = await skillsSection("/workspace/repo", {
      "/workspace/.agents/skills/lint/SKILL.md": skillFile("lint", "Bundled lint."),
      "/workspace/repo/.agents/skills/lint/SKILL.md": skillFile("lint", "Repo lint."),
      "/workspace/repo/.agents/skills/lint/examples/inner/SKILL.md": skillFile("inner", "Inside."),
      "/workspace/repo/.agents/skills/.hidden/SKILL.md": skillFile("hidden", "Hidden."),
      "/workspace/repo/.agents/skills/nested/group/SKILL.md": skillFile(
        "group",
        "Found below a plain directory.",
      ),
    });

    expect(section).toContain("Repo lint.");
    expect(section).not.toContain("Bundled lint.");
    expect(section).not.toContain("Inside.");
    expect(section).not.toContain("Hidden.");
    expect(section).toContain(
      "<location>/workspace/repo/.agents/skills/nested/group/SKILL.md</location>",
    );
  });

  it("leaves out skills that are for the user to name, and says where to find them", async () => {
    const section = await skillsSection("/workspace", {
      "/workspace/.agents/skills/implement/SKILL.md": skillFile(
        "implement",
        "Implement a spec.",
        "disable-model-invocation: true\n",
      ),
      "/workspace/.agents/skills/tdd/SKILL.md": skillFile("tdd", "Test-driven development."),
    });

    expect(section).toContain("<name>tdd</name>");
    expect(section).not.toContain("<name>implement</name>");
    expect(section).toContain(
      "Skills that are not listed are for when the user asks for one by name",
    );
  });

  it("names no tool for loading a skill when the agent has neither read nor bash", async () => {
    const section = await skillsSection(
      "/workspace",
      { "/workspace/.agents/skills/tdd/SKILL.md": skillFile("tdd", "Test-driven development.") },
      false,
    );

    expect(section).toContain("Load a skill's file when the task matches its description.");
  });

  it("lists no read-only note when no listed skill is bundled", async () => {
    const section = await skillsSection("/workspace/repo", {
      "/workspace/repo/.agents/skills/mine/SKILL.md": skillFile("mine", "Mine."),
    });

    expect(section).not.toContain("read-only");
  });

  it("cuts a description to the Agent Skills limit of 1024 characters", async () => {
    const section = await skillsSection("/workspace/repo", {
      "/workspace/repo/.agents/skills/wordy/SKILL.md": skillFile("wordy", "x".repeat(5000)),
    });

    expect(section).toContain(`<description>${"x".repeat(1024)}</description>`);
  });

  it("lists at most 100 skills, the nearest first", async () => {
    const many = Object.fromEntries(
      Array.from({ length: 120 }, (_, index) => [
        `/workspace/repo/.agents/skills/s${String(index).padStart(3, "0")}/SKILL.md`,
        skillFile(`s${String(index).padStart(3, "0")}`, "A skill."),
      ]),
    );

    const section = await skillsSection("/workspace/repo", {
      ...many,
      "/workspace/.agents/skills/tdd/SKILL.md": skillFile("tdd", "Test-driven development."),
    });

    expect(section?.match(/<skill>/g)).toHaveLength(100);
    expect(section).toContain("<name>s000</name>");
    expect(section).not.toContain("<name>tdd</name>");
  });

  it("follows a symbolic link to a skill directory, as pi does, one level deep", async () => {
    const section = await skillsSection("/workspace/repo", {}, true, {
      "/workspace/repo/.agents/skills/installed": {
        "SKILL.md": skillFile("installed", "Installed by a skill installer."),
        "notes.md": "# notes\n",
      },
    });

    expect(section).toContain("<name>installed</name>");
    expect(section).toContain(
      "<location>/workspace/repo/.agents/skills/installed/SKILL.md</location>",
    );
  });

  it("is absent when no skill is found", async () => {
    expect(
      await skillsSection("/workspace/repo", { "/workspace/repo/README.md": "# repo\n" }),
    ).toBeUndefined();
  });
});
