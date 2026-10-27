// pi-durable's Harness and the faux provider are Promise-based, so these tests are too.
// @effect-diagnostics asyncFunction:off missingPipeableSignature:off preferEffectArray:off preferEffectRecord:off
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness as ServiceHarness, openHarness } from "@cloudpid/effect-durable";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type AssistantMessage,
  type Message,
  type ToolCall,
} from "@earendil-works/pi-ai";
import { createRegistry, defineTool, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import {
  err,
  FileError,
  ok,
  type ExecutionEnv,
  type FileListEntry,
} from "@earendil-works/pi-durable/env";
import { Type } from "@earendil-works/pi-ai";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import { describe, expect, it } from "vitest";
import { ContextManagement } from "./context.ts";
import {
  BUNDLED_SKILLS_DIRECTORY,
  discoverSkills,
  parseSkill,
  Skills,
  skillDirectories,
  type Skill,
} from "./skills.ts";

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
const reads: string[] = [];

const envOf = (
  cwd: string,
  files: Readonly<Record<string, string>>,
  links: Readonly<Record<string, Readonly<Record<string, string>>>> = {},
): ExecutionEnv => {
  const fake: Pick<ExecutionEnv, "cwd" | "listFiles" | "readTextFile"> = {
    cwd,
    listFiles: (root, options) => {
      const target = links[root];

      if (target !== undefined) {
        const entries = entriesOf(
          Object.keys(target).map((path) => `${root}/${path}`),
          `${root}/`,
        );

        const max = options?.maxEntries ?? Number.MAX_SAFE_INTEGER;

        return Promise.resolve(
          ok({ entries: entries.slice(0, max), truncated: entries.length > max }),
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
      reads.push(path);

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

/** `env` that also discovers skills itself, and fails any read or listing: a request must not need them. */
const withOwn = (env: ExecutionEnv, own: () => Promise<ReadonlyArray<Skill>>): ExecutionEnv =>
  Object.assign(env, {
    discoverSkills: own,
    listFiles: () => Promise.reject(new Error("listFiles must not be called")),
    readTextFile: () => Promise.reject(new Error("readTextFile must not be called")),
  });

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
  own?: () => Promise<ReadonlyArray<Skill>>,
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
    {
      models,
      registry,
      env: () =>
        own === undefined ? envOf(cwd, files, links) : withOwn(envOf(cwd, files, links), own),
    },
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

  it("reads at most 100 SKILL.md files, of a large directory or a link to one", async () => {
    const big = Object.fromEntries(
      Array.from({ length: 500 }, (_, index) => [
        `s${String(index).padStart(3, "0")}/SKILL.md`,
        skillFile(`s${String(index).padStart(3, "0")}`, "Large."),
      ]),
    );

    reads.length = 0;

    const section = await skillsSection("/workspace/repo", {}, true, {
      "/workspace/repo/.agents/skills/big": big,
    });

    expect(section?.match(/<skill>/g)?.length ?? 0).toBeLessThanOrEqual(100);
    expect(reads.length).toBeLessThanOrEqual(100);

    reads.length = 0;

    await skillsSection(
      "/workspace/repo",
      Object.fromEntries(
        Object.entries(big).map(([path, text]) => [`/workspace/repo/.agents/skills/${path}`, text]),
      ),
    );

    expect(reads.length).toBeLessThanOrEqual(100);
  });

  it("adds nothing to the prompt when no skill is found", async () => {
    // The section is there but empty: it records that the context read the Skills and found none.
    expect(
      await skillsSection("/workspace/repo", { "/workspace/repo/README.md": "# repo\n" }),
    ).toBe("");
  });

  it("takes the skills of an environment that discovers its own, without a read or a listing", async () => {
    let asked = 0;

    const section = await skillsSection("/workspace/repo", {}, true, {}, () => {
      asked++;

      return Promise.resolve([
        {
          name: "deploy",
          description: "Ship it.",
          filePath: "/workspace/repo/.agents/skills/deploy/SKILL.md",
          disableModelInvocation: false,
        },
        {
          name: "tdd",
          description: "Test-driven development.",
          filePath: "/workspace/.agents/skills/tdd/SKILL.md",
          disableModelInvocation: false,
        },
      ]);
    });

    expect(asked).toBe(1);
    expect(section).toContain("<name>deploy</name>");
    expect(section).toContain("<name>tdd</name>");
    expect(section).toContain("are bundled with the agent and read-only");
  });
});

describe("discoverSkills with a directory's skills already known", () => {
  const tdd: Skill = {
    name: "tdd",
    description: "Bundled.",
    filePath: "/workspace/.agents/skills/tdd/SKILL.md",
    disableModelInvocation: false,
  };

  it("walks the other directories, never the known one, and lists the known skills last", async () => {
    const listed: string[] = [];

    const env = envOf("/workspace/repo", {
      "/workspace/repo/.agents/skills/deploy/SKILL.md": skillFile("deploy", "Ship."),
      // Not the bundle's: a walk of the root would find it, and the known skills stand in for the walk.
      "/workspace/.agents/skills/stray/SKILL.md": skillFile("stray", "Stray."),
    });

    const listFiles = env.listFiles!.bind(env);

    env.listFiles = (path, options, context) => {
      listed.push(path);

      return listFiles(path, options, context);
    };

    const found = await Effect.runPromise(
      discoverSkills(env, new Map([[BUNDLED_SKILLS_DIRECTORY, [tdd]]])),
    );

    expect(found.map((skill) => skill.name)).toEqual(["deploy", "tdd"]);
    expect(listed).toEqual(["/workspace/repo/.agents/skills"]);
  });

  it("lets a nearer skill shadow a known one of the same name", async () => {
    const found = await Effect.runPromise(
      discoverSkills(
        envOf("/workspace/repo", {
          "/workspace/repo/.agents/skills/tdd/SKILL.md": skillFile("tdd", "Repo's own."),
        }),
        new Map([[BUNDLED_SKILLS_DIRECTORY, [tdd]]]),
      ),
    );

    expect(found.map((skill) => skill.description)).toEqual(["Repo's own."]);
  });
});

describe("the skills section over a conversation's Context Windows", () => {
  const SKILLS = "/workspace/repo/.agents/skills";

  /** What a step is given: the files to change before it answers, and `call` to answer with a tool call. */
  type Turn = {
    readonly files: Record<string, string>;
    readonly call: (name: string, args: ToolCall["arguments"]) => AssistantMessage;
  };

  type Options = {
    /** The environment's own discovery, in place of a walk of `files`; it may fail. */
    readonly own?: () => Promise<ReadonlyArray<Skill>>;
    /** The conversation has no environment. */
    readonly noEnv?: boolean;
  };

  /**
   * Run a conversation over `files` whose model gets `steps` in order, then "Done.", with a request after each.
   * Returns the `skills` section each request carried, in order (undefined where it carried none).
   */
  const sectionsOfEachRequest = async (
    files: Record<string, string>,
    steps: ReadonlyArray<(turn: Turn) => AssistantMessage>,
    options: Options = {},
  ) => {
    const faux = fauxProvider({ models: [{ id: "faux-1", contextWindow: 1_000_000 }] });
    const models = createModels();
    const sections: Array<string | undefined> = [];
    let calls = 0;

    const turn: Turn = {
      files,
      call: (name, args) =>
        fauxAssistantMessage([fauxToolCall(name, args, { id: `call-${name}-${calls++}` })], {
          stopReason: "toolUse",
        }),
    };

    models.setProvider(faux.provider);
    faux.setResponses(
      Array.from({ length: 20 }, () => (request: { readonly messages: readonly Message[] }) => {
        let section: string | undefined;

        for (const message of request.messages) {
          if (message.role === "system" && message.sections !== undefined) {
            if ("skills" in message.sections) section = message.sections["skills"] ?? undefined;
          }
        }

        const step = steps[sections.length];

        sections.push(section);

        return step === undefined ? fauxAssistantMessage("Done.") : step(turn);
      }),
    );

    const service = await Effect.runPromise(
      openHarness(new MemoryStorage(), {
        models,
        env: () => {
          if (options.noEnv === true) return undefined;

          const env = envOf("/workspace/repo", files);

          return options.own === undefined ? env : withOwn(env, options.own);
        },
      }),
    );

    const extensions = await Effect.runPromise(
      Effect.all([Skills, ContextManagement]).pipe(
        Effect.provide(Context.make(ServiceHarness, service)),
      ),
    );

    for (const extension of [{ name: "tools", tools: [noop] }, ...extensions]) {
      await Effect.runPromise(service.install(extension));
    }

    const conversation = await service.harness.root(BACKGROUND_CONTEXT, {
      agent: { model: { provider: "faux", modelId: "faux-1" } },
    });

    await (
      await conversation.submit({ type: "input", content: "Go" }, BACKGROUND_CONTEXT)
    ).wait(BACKGROUND_CONTEXT);
    await service.harness.waitForIdle(BACKGROUND_CONTEXT);

    return sections;
  };

  it("shows the Skills as they were at the first request for as long as the context lasts", async () => {
    const sections = await sectionsOfEachRequest(
      { [`${SKILLS}/deploy/SKILL.md`]: skillFile("deploy", "Ship it.") },
      [
        ({ files, call }) => {
          files[`${SKILLS}/lint/SKILL.md`] = skillFile("lint", "Lint it.");

          return call("read", {});
        },
        ({ files, call }) => {
          files[`${SKILLS}/deploy/SKILL.md`] = skillFile("deploy", "Changed description.");

          return call("read", {});
        },
      ],
    );

    // The system prompt is the head of every request: a Skill saved meanwhile may not rewrite it.
    expect(sections).toHaveLength(3);
    expect(sections[0]).toContain("<name>deploy</name>");
    expect(sections[0]).not.toContain("<name>lint</name>");
    expect(sections).toEqual(sections.map(() => sections[0]));
  });

  it("lists the Skills as they are then after a Handoff", async () => {
    const sections = await sectionsOfEachRequest(
      { [`${SKILLS}/deploy/SKILL.md`]: skillFile("deploy", "Ship it.") },
      [
        ({ files, call }) => {
          files[`${SKILLS}/lint/SKILL.md`] = skillFile("lint", "Lint it.");

          return call("read", {});
        },
        ({ call }) => call("context_rollover", { handoff: "Keep going." }),
      ],
    );

    expect(sections[0]).not.toContain("<name>lint</name>");
    expect(sections[1]).toBe(sections[0]);
    expect(sections.at(-1)).toContain("<name>deploy</name>");
    expect(sections.at(-1)).toContain("<name>lint</name>");
  });

  it("stays without a list when the first read found no Skills, though one is added later", async () => {
    const sections = await sectionsOfEachRequest({}, [
      ({ files, call }) => {
        files[`${SKILLS}/lint/SKILL.md`] = skillFile("lint", "Lint it.");

        return call("read", {});
      },
      ({ call }) => call("read", {}),
    ]);

    expect(sections).toHaveLength(3);
    // Nothing of the system prompt changed after the first request: no section was added meanwhile.
    expect(sections).toEqual(sections.map(() => sections[0]));
    expect(sections.join("")).not.toContain("<name>lint</name>");
  });

  it("lists the Skills of a later Context Window though the first one had none", async () => {
    const sections = await sectionsOfEachRequest({}, [
      ({ files, call }) => {
        files[`${SKILLS}/lint/SKILL.md`] = skillFile("lint", "Lint it.");

        return call("context_rollover", { handoff: "Keep going." });
      },
    ]);

    // The first context froze "nothing to list", and kept it until the Handoff.
    expect(sections[0]).toBe("");
    expect(sections.at(-1)).toContain("<name>lint</name>");
  });

  it("freezes nothing when the first read fails, so the next request reads again", async () => {
    const lint: Skill = {
      name: "lint",
      description: "Lint it.",
      filePath: `${SKILLS}/lint/SKILL.md`,
      disableModelInvocation: false,
    };

    let reads = 0;

    const sections = await sectionsOfEachRequest(
      {},
      [({ call }) => call("read", {}), ({ call }) => call("read", {})],
      {
        own: () =>
          reads++ === 0 ? Promise.reject(new Error("unreachable")) : Promise.resolve([lint]),
      },
    );

    expect(sections[0]).toBeUndefined();
    expect(sections[1]).toContain("<name>lint</name>");
    // Read now, the list is frozen as any other.
    expect(sections[2]).toBe(sections[1]);
    expect(reads).toBe(2);
  });

  it("freezes nothing without an environment", async () => {
    const sections = await sectionsOfEachRequest({}, [({ call }) => call("read", {})], {
      noEnv: true,
    });

    expect(sections).toEqual([undefined, undefined]);
  });
});
