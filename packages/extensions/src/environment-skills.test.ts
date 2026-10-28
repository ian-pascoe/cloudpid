// The `environment` extension's tools for an Environment's own Skills (docs/spec.md → The Environment's own Skills):
// `environment_skill_save` reads a Skill's folder from the Workspace and saves it, `environment_skill_remove` removes
// one, over fake Skills that keep them as the Registry does.
// @effect-diagnostics asyncFunction:off
import { DEFAULT_CONTAINER_SETTINGS } from "@cloudpid/config";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  ROOT_CONVERSATION_ID,
  type ToolExecutionApi,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import { describe, expect, it } from "vitest";
import { type AgentChange, skillField } from "@cloudpid/protocol";
import {
  AgentChangeLog,
  DeployCredentials,
  describeEnvironment,
  Environments,
  type EnvironmentsService,
  EnvironmentTools,
  type RunChange,
} from "./environment.ts";
import { unusedLifecycle } from "./environment-lifecycle.fixture.ts";
import { unusedSecretMarks } from "./environment-secret-marks.fixture.ts";
import { fakeFolderEnv, fakeSkills } from "./environment-skills.fixture.ts";
import { Redactions } from "./secrets/redaction.ts";
import { Secrets, type SecretsService } from "./secrets/store.ts";
import { DEFAULT_TOOLSETS } from "./subagents.ts";
import { resolveTools } from "./subagents/toolsets.ts";

const GITHUB_TOKEN = "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB";

const SKILL_MD = "---\nname: release\ndescription: Cut a release.\n---\nTag, then push.\n";

const setUp = async (held: Readonly<Record<string, string>> = {}) => {
  const skills = fakeSkills();
  const logged: RunChange[] = [];
  const redactions = new Redactions();

  for (const [name, value] of Record.toEntries(held)) redactions.hold(name, value);

  // SAFETY: the tools use only `refresh` and `redact` of the Secrets.
  const secrets = {
    refresh: Effect.void,
    redact: (value: string) => redactions.redact(value),
  } as SecretsService;

  const environments: EnvironmentsService = {
    ...unusedLifecycle,
    ...unusedSecretMarks,
    ...skills.service,
    current: Effect.succeed("default"),
    list: Effect.succeed([]),
    get: () => Effect.succeed(null),
    every: Effect.succeed({ variables: {}, secrets: [] }),
    change: () => Effect.die("not used here"),
  };

  const extension = await Effect.runPromise(
    EnvironmentTools.pipe(
      Effect.provideService(Environments, environments),
      Effect.provideService(AgentChangeLog, {
        record: (change) =>
          Effect.sync(() => {
            logged.push(change);
          }),
      }),
      Effect.provideService(DeployCredentials, { values: [GITHUB_TOKEN] }),
      Effect.provideService(Secrets, secrets),
    ),
  );

  const tool = (name: string): ToolRegistration =>
    Option.getOrThrowWith(
      Arr.findFirst(extension.tools ?? [], (each) => each.name === name),
      () => new Error(`no tool ${name}`),
    );

  return { tool, logged, ...skills };
};

type Result = Awaited<ReturnType<ToolRegistration["execute"]>>;

/** Run `tool` with `args`, in a Workspace whose files are `env`'s. */
const run = (
  tool: ToolRegistration,
  args: Readonly<Record<string, unknown>>,
  env: Pick<
    ExecutionEnv,
    "absolutePath" | "fileInfo" | "listFiles" | "readBinaryFile"
  > = fakeFolderEnv({}),
): Promise<Result> =>
  // SAFETY: the arguments are the tool's JSON parameters, and the save reads only these of the environment.
  tool.execute(
    args as never,
    { conversationId: ROOT_CONVERSATION_ID, env } as ToolExecutionApi,
    BACKGROUND_CONTEXT,
  );

const text = (result: Result): string =>
  Arr.join(
    Arr.map(result.output ?? [], (part) => (part.type === "text" ? part.text : "")),
    "",
  );

const failure = async (call: Promise<Result>) => {
  const result = await call;

  expect(result.isError).toBe(true);

  return text(result);
};

/** A scratch folder holding the `release` Skill, with `more` files beside. */
const scratch = (more: Readonly<Record<string, string | Uint8Array>> = {}) =>
  fakeFolderEnv({
    "/workspace/.cloudpid/tmp/release/SKILL.md": SKILL_MD,
    "/workspace/.cloudpid/tmp/release/references/steps.md": "1. Tag.\n",
    ...more,
  });

describe("environment_skill_save", () => {
  it("runs alone, is kept from a rerun after an eviction, and is the root conversation's only", async () => {
    const { tool } = await setUp();

    for (const name of ["environment_skill_save", "environment_skill_remove"]) {
      expect(tool(name).replay).toBe("unsafe");
      expect(tool(name).executionMode).toBe("sequential");
    }

    expect(
      resolveTools(undefined, ["bash", "environment_skill_save"], DEFAULT_TOOLSETS),
    ).toMatchObject({ success: { tools: ["bash"] } });
  });

  it("saves a Skill's folder from the Workspace, saying where it is served and when the list changes", async () => {
    const { tool, logged, saves } = await setUp();

    const result = await run(
      tool("environment_skill_save"),
      { path: ".cloudpid/tmp/release", reason: "The release steps are the same every time" },
      scratch(),
    );

    expect(saves).toEqual([
      {
        environment: "default",
        folder: "release",
        files: { "SKILL.md": SKILL_MD, "references/steps.md": "1. Tag.\n" },
      },
    ]);
    expect(text(result)).toContain(
      'Saved the new Skill release for Environment "Default" (default) (2 files)',
    );
    expect(text(result)).toContain("served now at /workspace/.agents/skills/release (read-only)");
    expect(text(result)).toContain("next Context Window");
    expect(result.details).toMatchObject({
      agentChange: {
        environment: { id: "default", name: "Default" },
        field: "skills.release",
        before: null,
      },
      path: "/workspace/.agents/skills/release",
    });
    expect(logged).toEqual([
      { tool: "environment_skill_save", environmentName: "Default", field: "skills.release" },
    ]);
  });

  it("says another Environment's Workspaces get it at their next readying, and this one not", async () => {
    const { tool } = await setUp();

    const result = await run(
      tool("environment_skill_save"),
      { id: "0000abcd", path: "/workspace/.cloudpid/tmp/release", reason: "r" },
      scratch(),
    );

    expect(text(result)).toContain(
      "next readying; this Session's Workspace, of another Environment, does not",
    );
  });

  it("records nothing for the files the Environment keeps already", async () => {
    const { tool, logged } = await setUp();
    const args = { path: "/workspace/.cloudpid/tmp/release", reason: "r" };

    await run(tool("environment_skill_save"), args, scratch());
    const again = await run(tool("environment_skill_save"), args, scratch());

    expect(text(again)).toContain("with these files already: nothing changed");
    expect(logged).toHaveLength(1);
  });

  it("passes on the Registry's refusal, saying why", async () => {
    const { tool, refuse, logged } = await setUp();

    refuse('SKILL.md\'s name: "Release" may hold only lowercase letters, digits and hyphens');

    const message = await failure(
      run(
        tool("environment_skill_save"),
        { path: "/workspace/.cloudpid/tmp/release", reason: "r" },
        scratch(),
      ),
    );

    expect(message).toContain("Nothing was saved:");
    expect(message).toContain("lowercase letters, digits and hyphens");
    expect(logged).toEqual([]);
  });

  it.each([
    [
      "a binary file",
      { "/workspace/.cloudpid/tmp/release/logo.png": new Uint8Array([137, 80, 0, 1]) },
      "logo.png: a binary file",
    ],
    [
      "a file over 128 KB",
      { "/workspace/.cloudpid/tmp/release/big.md": "x".repeat(128 * 1024 + 1) },
      "big.md: 131073 bytes",
    ],
    [
      "a credential",
      { "/workspace/.cloudpid/tmp/release/env.md": `export TOKEN=${GITHUB_TOKEN}` },
      "env.md: matches",
    ],
  ])("refuses a folder with %s before asking the Registry", async (_, more, message) => {
    const { tool, saves } = await setUp();

    expect(
      await failure(
        run(
          tool("environment_skill_save"),
          { path: "/workspace/.cloudpid/tmp/release", reason: "r" },
          scratch(more),
        ),
      ),
    ).toContain(message);
    expect(saves).toEqual([]);
  });

  it("refuses a file that holds a Secret this Session holds", async () => {
    const { tool, saves } = await setUp({ API_KEY: "sk-live-abcdefghijkl" });

    const message = await failure(
      run(
        tool("environment_skill_save"),
        { path: "/workspace/.cloudpid/tmp/release", reason: "r" },
        scratch({ "/workspace/.cloudpid/tmp/release/notes.md": "Use sk-live-abcdefghijkl." }),
      ),
    );

    expect(message).toContain("the file notes.md holds the value of a Secret");
    expect(saves).toEqual([]);
  });

  it("refuses a folder outside the Workspace's files, one that is missing, and one with a symbolic link", async () => {
    const { tool, saves } = await setUp();

    expect(
      await failure(
        run(tool("environment_skill_save"), { path: "/tmp/release", reason: "r" }, scratch()),
      ),
    ).toContain("is not in the Workspace's files");
    expect(
      await failure(
        run(tool("environment_skill_save"), { path: "/workspace/nothing", reason: "r" }, scratch()),
      ),
    ).toContain("/workspace/nothing does not exist");
    expect(
      await failure(
        run(
          tool("environment_skill_save"),
          { path: "/workspace/.cloudpid/tmp/release", reason: "r" },
          fakeFolderEnv({ "/workspace/.cloudpid/tmp/release/SKILL.md": SKILL_MD }, [
            "/workspace/.cloudpid/tmp/release/linked",
          ]),
        ),
      ),
    ).toContain("symbolic links (linked)");
    expect(saves).toEqual([]);
  });

  it("refuses a folder that is, or holds, a Container-only path, which the Workspace does not hold", async () => {
    const { tool, saves } = await setUp();

    const files = {
      "/workspace/app/dist/release/SKILL.md": SKILL_MD,
      "/workspace/.cloudpid/tmp/release/SKILL.md": SKILL_MD,
      "/workspace/.cloudpid/tmp/release/build/out.md": "x",
    };

    const onContainer = (path: string) => path.includes("/dist") || path.includes("/build/");

    expect(
      await failure(
        run(
          tool("environment_skill_save"),
          { path: "/workspace/app/dist/release", reason: "r" },
          fakeFolderEnv(files, [], onContainer),
        ),
      ),
    ).toContain("/workspace/app/dist/release is a Container-only path");
    expect(
      await failure(
        run(
          tool("environment_skill_save"),
          { path: "/workspace/.cloudpid/tmp/release", reason: "r" },
          fakeFolderEnv(files, [], onContainer),
        ),
      ),
    ).toContain("/workspace/.cloudpid/tmp/release/build/out.md is a Container-only path");
    expect(saves).toEqual([]);
  });

  it("refuses a folder whose place the environment cannot check, failing closed", async () => {
    const { tool, saves } = await setUp();

    const message = await failure(
      run(
        tool("environment_skill_save"),
        { path: "/workspace/.cloudpid/tmp/release", reason: "r" },
        fakeFolderEnv({ "/workspace/.cloudpid/tmp/release/SKILL.md": SKILL_MD }, [], "fails"),
      ),
    );

    expect(message).toContain(
      "Nothing was saved: could not check whether the folder is a Workspace path",
    );
    expect(message).toContain("The Workspace did not answer");
    expect(saves).toEqual([]);
  });

  it("refuses the id *, which names what is kept for every Environment", async () => {
    const { tool } = await setUp();

    expect(
      await failure(
        run(
          tool("environment_skill_save"),
          { id: "*", path: "/workspace/.cloudpid/tmp/release", reason: "r" },
          scratch(),
        ),
      ),
    ).toContain('The id "*"');
  });
});

describe("environment_skill_remove", () => {
  it("removes a Skill the Environment keeps, saying what is served in its place", async () => {
    const { tool, logged, kept } = await setUp();

    await run(
      tool("environment_skill_save"),
      { path: "/workspace/.cloudpid/tmp/release", reason: "r" },
      scratch(),
    );

    const result = await run(tool("environment_skill_remove"), {
      name: "release",
      reason: "Not used",
    });

    expect(text(result)).toContain(
      'Removed the Skill release from Environment "Default" (default)',
    );
    expect(text(result)).toContain(
      "Nothing is served at /workspace/.agents/skills/release any more",
    );
    expect(result.details).toMatchObject({ agentChange: { field: "skills.release", after: null } });
    expect(kept.size).toBe(0);
    expect(logged.at(-1)).toEqual({
      tool: "environment_skill_remove",
      environmentName: "Default",
      field: "skills.release",
    });
  });

  it("refuses a Skill the Environment does not keep, pointing to environment_get", async () => {
    const { tool, logged } = await setUp();

    const message = await failure(
      run(tool("environment_skill_remove"), { name: "pr", reason: "r" }),
    );

    expect(message).toContain('keeps no Skill named "pr"');
    expect(message).toContain("environment_get");
    expect(logged).toEqual([]);
  });
});

const GRILL_COMMIT = "c0ffee0000000000000000000000000000000001";

/** The Agent change an install of `name` recorded. */
const installChange = (id: number, name: string): AgentChange => ({
  id,
  scope: "default",
  at: 1_000,
  actor: "agent",
  session: "s-1",
  conversation: 0,
  tool: "environment_skill_install",
  reason: "The user asked for it",
  field: skillField(name),
  before: null,
  after: {
    files: { "SKILL.md": "hash" },
    source: { repo: "mattpocock/skills", path: `skills/${name}`, ref: null, commit: GRILL_COMMIT },
  },
  reverts: null,
  revertedBy: null,
});

const DEFAULT = { id: "default", name: "Default" };

describe("environment_skill_install", () => {
  it("runs alone, is kept from a rerun, and is the root conversation's only", async () => {
    const { tool } = await setUp();

    expect(tool("environment_skill_install").replay).toBe("unsafe");
    expect(tool("environment_skill_install").executionMode).toBe("sequential");

    expect(
      resolveTools(undefined, ["bash", "environment_skill_install"], DEFAULT_TOOLSETS),
    ).toMatchObject({ success: { tools: ["bash"] } });
  });

  it("installs the Skill a source names, saying where it came from and where it is served", async () => {
    const { tool, logged, installs, answerInstall } = await setUp();

    answerInstall({
      status: "installed",
      environment: DEFAULT,
      repo: "mattpocock/skills",
      ref: null,
      commit: GRILL_COMMIT,
      results: [
        {
          name: "grill-me",
          path: "skills/grill-me",
          outcome: "installed",
          change: installChange(7, "grill-me"),
          shadows: false,
        },
      ],
      handed: true,
    });

    const result = await run(tool("environment_skill_install"), {
      source: "mattpocock/skills@grill-me",
      reason: "The user asked for grill-me",
    });

    expect(installs).toEqual([
      {
        environment: "default",
        source: "mattpocock/skills@grill-me",
        skills: undefined,
        reason: "The user asked for grill-me",
      },
    ]);

    const said = text(result);

    expect(said).toContain(
      'Installed grill-me for Environment "Default" (default) from mattpocock/skills at c0ffee0.',
    );
    expect(said).toContain("served now at /workspace/.agents/skills/<name> (read-only)");
    expect(said).toContain("read /workspace/.agents/skills/grill-me/SKILL.md to use one");
    expect(said).toContain("next Context Window");
    expect(result.isError).not.toBe(true);

    expect(result.details).toMatchObject({
      agentChanges: [
        {
          id: 7,
          environment: DEFAULT,
          field: "skills.grill-me",
          after: { source: { repo: "mattpocock/skills", commit: GRILL_COMMIT } },
        },
      ],
    });

    expect(logged).toEqual([
      { tool: "environment_skill_install", environmentName: "Default", field: "skills.grill-me" },
    ]);
  });

  it("names the ref and the Skills it left unchanged or refused, installing the rest", async () => {
    const { tool, answerInstall } = await setUp();

    answerInstall({
      status: "installed",
      environment: DEFAULT,
      repo: "o/skills",
      ref: "v2",
      commit: GRILL_COMMIT,
      results: [
        {
          name: "a",
          path: "skills/a",
          outcome: "installed",
          change: installChange(1, "a"),
          shadows: true,
        },
        { name: "b", path: "skills/b", outcome: "unchanged" },
        { name: "c", path: "skills/c", outcome: "rejected", message: "notes.md: a binary file" },
      ],
      handed: false,
    });

    const said = text(
      await run(tool("environment_skill_install"), {
        source: "o/skills",
        skills: ["*"],
        reason: "r",
      }),
    );

    expect(said).toContain("Installed a (over the bundle's Skill of that name)");
    expect(said).toContain("from o/skills at v2, c0ffee0");
    expect(said).toContain("b was installed from o/skills at v2, c0ffee0 already: nothing changed");
    expect(said).toContain(
      "Refused (the others were installed): - c (skills/c): notes.md: a binary file",
    );
    expect(said).toContain("gets it at its next readying");
  });

  it("installs nothing and lists the Skills when the repo holds several and none was named", async () => {
    const { tool, logged, answerInstall } = await setUp();

    answerInstall({
      status: "listed",
      environment: DEFAULT,
      repo: "mattpocock/skills",
      ref: null,
      commit: GRILL_COMMIT,
      available: [
        { name: "grill-me", description: "Interview me", path: "skills/grill-me" },
        { name: "tdd", description: "Test first", path: "skills/tdd" },
      ],
    });

    const result = await run(tool("environment_skill_install"), {
      source: "mattpocock/skills",
      reason: "r",
    });

    expect(result.isError).not.toBe(true);
    expect(text(result)).toContain(
      "Installed nothing: mattpocock/skills (at c0ffee0) holds 2 Skills",
    );
    expect(text(result)).toContain("- grill-me (skills/grill-me): Interview me");
    expect(text(result)).toContain("- tdd (skills/tdd): Test first");
    expect(text(result)).toContain('skills set to their names (["*"] for all of them)');
    expect(logged).toEqual([]);
  });

  it("passes on why nothing was installed: a refused source, GitHub's failure, every Skill refused", async () => {
    const { tool, logged, answerInstall } = await setUp();

    answerInstall({ status: "refused", message: "GitHub has no repo o/gone" });

    expect(
      await failure(run(tool("environment_skill_install"), { source: "o/gone", reason: "r" })),
    ).toBe("Nothing was installed: GitHub has no repo o/gone");

    answerInstall({
      status: "installed",
      environment: DEFAULT,
      repo: "o/r",
      ref: null,
      commit: GRILL_COMMIT,
      results: [{ name: "x", path: "x", outcome: "rejected", message: "no SKILL.md" }],
      handed: false,
    });

    const message = await failure(
      run(tool("environment_skill_install"), { source: "o/r", reason: "r" }),
    );

    expect(message).toContain("Nothing was installed from o/r; each Skill was refused:");
    expect(message).toContain("- x (x): no SKILL.md");
    expect(logged).toEqual([]);
  });

  it("refuses the id *, an Environment that is not there, and a Secret in the reason or the source", async () => {
    const { tool, installs, answerInstall } = await setUp({ API_KEY: "s3cr3t-value-123456" });

    expect(
      await failure(
        run(tool("environment_skill_install"), { id: "*", source: "o/r", reason: "r" }),
      ),
    ).toContain('The id "*"');

    answerInstall({ status: "missing" });

    expect(
      await failure(
        run(tool("environment_skill_install"), { id: "0000dead", source: "o/r", reason: "r" }),
      ),
    ).toContain("0000dead");

    expect(
      await failure(
        run(tool("environment_skill_install"), {
          source: "o/r",
          reason: "using s3cr3t-value-123456",
        }),
      ),
    ).toContain("holds the value of a Secret");

    expect(
      await failure(
        run(tool("environment_skill_install"), {
          source: `https://${GITHUB_TOKEN}@github.com/o/r`,
          reason: "r",
        }),
      ),
    ).toContain("the source holds");

    // Only the Environment that is not there reached the Registry.
    expect(installs).toHaveLength(1);
  });
});

describe("environment_get", () => {
  it("lists the Environment's own Skills with when each was saved", () => {
    const shown = describeEnvironment(
      {
        id: "default",
        name: "Default",
        repos: [],
        build: { status: "none" },
        settings: DEFAULT_CONTAINER_SETTINGS,
        secrets: [],
        everyVariables: {},
        skills: [{ name: "release", description: "Cut a release.", savedAt: 0 }],
      },
      true,
    );

    expect(shown).toContain(
      "Skills (its own, served read-only at /workspace/.agents/skills/<name>",
    );
    expect(shown).toContain("\n  release (saved 1970-01-01T00:00:00.000Z): Cut a release.");
  });

  it("says where an installed Skill came from", () => {
    const shown = describeEnvironment(
      {
        id: "default",
        name: "Default",
        repos: [],
        build: { status: "none" },
        settings: DEFAULT_CONTAINER_SETTINGS,
        secrets: [],
        everyVariables: {},
        skills: [
          {
            name: "grill-me",
            description: "Interview me.",
            savedAt: 0,
            source: {
              repo: "mattpocock/skills",
              path: "skills/grill-me",
              ref: null,
              commit: GRILL_COMMIT,
            },
          },
        ],
      },
      true,
    );

    expect(shown).toContain(
      "\n  grill-me (saved 1970-01-01T00:00:00.000Z, installed from mattpocock/skills/skills/grill-me at c0ffee0): Interview me.",
    );
  });
});
