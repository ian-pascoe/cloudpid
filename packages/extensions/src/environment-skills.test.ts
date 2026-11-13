// The `environment` extension's tools for an Environment's own Skills, and those kept Global (docs/architecture/workspace.md
// → The Environment's own Skills, → Approval): `environment_skill_save` reads a Skill's folder from the Workspace and
// saves it, `environment_skill_remove` removes one, over fake Skills that keep them as the Registry does. With `id: "*"`
// each waits for the owner's Approval.
// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off schemaSync:off preferEffectArray:off
import { DEFAULT_CONTAINER_SETTINGS } from "@cloudpid/config";
import { type AgentChange, type PreviewedSkill, skillField } from "@cloudpid/protocol";
import type { GlobalSkillToolName } from "@cloudpid/protocol/harness-tools";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  type JsonObject,
  ROOT_CONVERSATION_ID,
  type TaskId,
  type ToolExecutionApi,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vite-plus/test";
import { type ApprovalAsk, Approvals, type ApprovalsService, makeApprovals } from "./approvals.ts";
import {
  AgentChangeLog,
  DeployCredentials,
  describeEnvironment,
  type EnvironmentsError,
  Environments,
  type EnvironmentsService,
  EnvironmentTools,
  type RunChange,
} from "./environment.ts";
import { unusedLifecycle } from "./environment-lifecycle.fixture.ts";
import {
  SkillInstallOutput,
  SkillRemoveOutput,
  SkillSaveOutput,
  SkillUpdateOutput,
} from "./environment-lifecycle-outputs.ts";
import { HARNESS_TOOLS } from "@cloudpid/protocol/harness-tools";
import { expectEndpointWords } from "./endpoint-words.fixture.ts";
import { endpointTextCheck } from "./environment-changes.ts";
import { SKILL_REPLAYED, skillCores } from "./environment-skill-changes.ts";
import { type GlobalSkillCores, globalSkillCores } from "./environment-skill-approvals.ts";
import type { SkillRemoved } from "./environment-skill-results.ts";
import type { HarnessAnswer } from "./harness.ts";
import { answerRequests, runProgram, runSized } from "./program.fixture.ts";
import { unusedSecretMarks } from "./environment-secret-marks.fixture.ts";
import { fakeFolderEnv, fakeSkills } from "./environment-skills.fixture.ts";
import { Redactions } from "./secrets/redaction.ts";
import { Secrets, type SecretsService } from "./secrets/store.ts";
import { DEFAULT_TOOLSETS } from "./subagents.ts";
import { MAX_FILE_BYTES } from "./skill-checks.ts";
import { resolveTools } from "./subagents/toolsets.ts";

const GITHUB_TOKEN = "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB";

const SKILL_MD = "---\nname: release\ndescription: Cut a release.\n---\nTag, then push.\n";

const setUp = async (held: Readonly<Record<string, string>> = {}) => {
  const skills = fakeSkills();
  const logged: RunChange[] = [];
  const redactions = new Redactions();
  const map = new Map<string, unknown>();
  /** The requests the owner was notified of. */
  const notified: ApprovalAsk[] = [];

  const approvals: ApprovalsService = await Effect.runPromise(
    makeApprovals({
      storage: {
        // SAFETY: the store reads back only what it wrote under each key.
        get: <T>(key: string) => map.get(key) as T | undefined,
        put: (key, value) => {
          map.set(key, structuredClone(value));
        },
        delete: (key) => map.delete(key),
      },
      announce: () => Effect.void,
      asked: (request) =>
        Effect.sync(() => {
          notified.push(request);
        }),
    }),
  );

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
    global: Effect.sync(() => ({
      settings: DEFAULT_CONTAINER_SETTINGS,
      overriddenIn: {},
      secrets: [],
      skills: skills.listed("*"),
    })),
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
      Effect.provideService(Approvals, approvals),
    ),
  );

  const tool = (name: string): ToolRegistration =>
    Option.getOrThrowWith(
      Arr.findFirst(extension.tools ?? [], (each) => each.name === name),
      () => new Error(`no tool ${name}`),
    );

  /** How the owner answers a call's request; `meanwhile` runs first, as what happens while the card waits. */
  type Answer = {
    readonly approve: boolean;
    readonly reason?: string;
    readonly meanwhile?: () => void;
    /** The task of a rerun: a call an eviction cut off, which asked already. */
    readonly task?: number;
  };

  let task = 0;

  /**
   * Call `name` with `args` in a Workspace of `env`'s files; `answer` answers the call's request once it waits, unless
   * the call ends without one.
   */
  const call = async (
    name: string,
    args: Readonly<Record<string, unknown>>,
    answer: Answer = { approve: true },
    env: Pick<
      ExecutionEnv,
      "absolutePath" | "fileInfo" | "listFiles" | "readBinaryFile"
    > = scratch(),
  ) => {
    const id = answer.task ?? ++task;

    // SAFETY: a task's id is a number pi-durable brands; each call here is a task of its own.
    const asking = { taskId: id as TaskId, conversationId: ROOT_CONVERSATION_ID, env };
    // SAFETY: the tools read only these of the invocation's API; the arguments are the tool's JSON parameters.

    const running = tool(name).execute(
      args as never,
      asking as ToolExecutionApi,
      BACKGROUND_CONTEXT,
    );

    let settled = false;

    void running.finally(() => {
      settled = true;
    });

    const shown: ApprovalAsk[] = [];

    for (;;) {
      const [request] = await Effect.runPromise(approvals.pending);

      if (request !== undefined) {
        shown.push(request);
        answer.meanwhile?.();

        await Effect.runPromise(
          approvals.answer(request.id, { approve: answer.approve, reason: answer.reason }),
        );

        break;
      }

      if (settled) break;

      await new Promise((resolve) => setTimeout(resolve, 2));
    }

    const result = await running;

    return {
      result,
      text: text(result),
      shown,
      pending: await Effect.runPromise(approvals.pending),
    };
  };

  /**
   * A call of task `id` that asked with `expected` and was answered, then cut off by an eviction before it ended: the
   * answer is kept for its rerun.
   */
  const answeredEarlier = async (id: number, expected: Schema.Json, approve = true) => {
    task = Math.max(task, id);

    const asking = Effect.runPromise(
      approvals.ask({
        id: String(id),
        conversationId: ROOT_CONVERSATION_ID,
        tool: "earlier",
        target: "earlier",
        change: "earlier",
        before: "earlier",
        after: "earlier",
        reason: "earlier",
        expected,
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 2));
    await Effect.runPromise(approvals.answer(String(id), { approve }));
    await asking;
  };

  return { tool, extension, logged, call, answeredEarlier, notified, approvals, ...skills };
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
  it("runs alone, is rerun after an eviction (a change to Global waits for the same request), and is the root conversation's only", async () => {
    const { tool } = await setUp();

    for (const name of ["environment_skill_save", "environment_skill_remove"]) {
      expect(tool(name).replay).toBe("safe");
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
      {
        id: "default",
        path: ".cloudpid/tmp/release",
        reason: "The release steps are the same every time",
      },
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
    const args = { id: "default", path: "/workspace/.cloudpid/tmp/release", reason: "r" };

    await run(tool("environment_skill_save"), args, scratch());
    const again = await run(tool("environment_skill_save"), args, scratch());

    expect(text(again)).toContain("with these files already: nothing was changed or recorded now");
    expect(text(again)).toContain("it is done");
    expect(logged).toHaveLength(1);
  });

  it("passes on the Registry's refusal, saying why", async () => {
    const { tool, refuse, logged } = await setUp();

    refuse('SKILL.md\'s name: "Release" may hold only lowercase letters, digits and hyphens');

    const message = await failure(
      run(
        tool("environment_skill_save"),
        { id: "default", path: "/workspace/.cloudpid/tmp/release", reason: "r" },
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
      "a file over the limit",
      { "/workspace/.cloudpid/tmp/release/big.md": "x".repeat(MAX_FILE_BYTES + 1) },
      `big.md: ${MAX_FILE_BYTES + 1} bytes`,
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
          { id: "default", path: "/workspace/.cloudpid/tmp/release", reason: "r" },
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
        { id: "default", path: "/workspace/.cloudpid/tmp/release", reason: "r" },
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
        run(
          tool("environment_skill_save"),
          { id: "default", path: "/tmp/release", reason: "r" },
          scratch(),
        ),
      ),
    ).toContain("is not in the Workspace's files");
    expect(
      await failure(
        run(
          tool("environment_skill_save"),
          { id: "default", path: "/workspace/nothing", reason: "r" },
          scratch(),
        ),
      ),
    ).toContain("/workspace/nothing does not exist");
    expect(
      await failure(
        run(
          tool("environment_skill_save"),
          { id: "default", path: "/workspace/.cloudpid/tmp/release", reason: "r" },
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
          { id: "default", path: "/workspace/app/dist/release", reason: "r" },
          fakeFolderEnv(files, [], onContainer),
        ),
      ),
    ).toContain("/workspace/app/dist/release is a Container-only path");
    expect(
      await failure(
        run(
          tool("environment_skill_save"),
          { id: "default", path: "/workspace/.cloudpid/tmp/release", reason: "r" },
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
        { id: "default", path: "/workspace/.cloudpid/tmp/release", reason: "r" },
        fakeFolderEnv({ "/workspace/.cloudpid/tmp/release/SKILL.md": SKILL_MD }, [], "fails"),
      ),
    );

    expect(message).toContain(
      "Nothing was saved: could not check whether the folder is a Workspace path",
    );
    expect(message).toContain("The Workspace did not answer");
    expect(saves).toEqual([]);
  });
});

describe("environment_skill_remove", () => {
  it("removes a Skill the Environment keeps, saying what is served in its place", async () => {
    const { tool, logged, kept } = await setUp();

    await run(
      tool("environment_skill_save"),
      { id: "default", path: "/workspace/.cloudpid/tmp/release", reason: "r" },
      scratch(),
    );

    const result = await run(tool("environment_skill_remove"), {
      id: "default",
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
      run(tool("environment_skill_remove"), { id: "default", name: "pr", reason: "r" }),
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
  it("runs alone, is rerun after an eviction (an install at Global waits for the same request), and is the root conversation's only", async () => {
    const { tool } = await setUp();

    expect(tool("environment_skill_install").replay).toBe("safe");
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
        },
      ],
      handed: true,
    });

    const result = await run(tool("environment_skill_install"), {
      id: "default",
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
        },
        { name: "b", path: "skills/b", outcome: "unchanged" },
        { name: "c", path: "skills/c", outcome: "rejected", message: "notes.md: a binary file" },
      ],
      handed: false,
    });

    const said = text(
      await run(tool("environment_skill_install"), {
        id: "default",
        source: "o/skills",
        skills: ["*"],
        reason: "r",
      }),
    );

    expect(said).toContain("Installed a for Environment");
    expect(said).not.toContain("bundle");
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
      id: "default",
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
      await failure(
        run(tool("environment_skill_install"), { id: "default", source: "o/gone", reason: "r" }),
      ),
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
      run(tool("environment_skill_install"), { id: "default", source: "o/r", reason: "r" }),
    );

    expect(message).toContain("Nothing was installed from o/r; each Skill was refused:");
    expect(message).toContain("- x (x): no SKILL.md");
    expect(logged).toEqual([]);
  });

  it("refuses an Environment that is not there, and a Secret in the reason or the source", async () => {
    const { tool, installs, answerInstall } = await setUp({ API_KEY: "s3cr3t-value-123456" });

    answerInstall({ status: "missing" });

    expect(
      await failure(
        run(tool("environment_skill_install"), { id: "0000dead", source: "o/r", reason: "r" }),
      ),
    ).toContain("0000dead");

    expect(
      await failure(
        run(tool("environment_skill_install"), {
          id: "default",
          source: "o/r",
          reason: "using s3cr3t-value-123456",
        }),
      ),
    ).toContain("holds the value of a Secret");

    expect(
      await failure(
        run(tool("environment_skill_install"), {
          id: "default",
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
        overrides: {},
        global: DEFAULT_CONTAINER_SETTINGS,
        skills: [{ name: "release", description: "Cut a release.", savedAt: 0 }],
        globalSkills: [],
      },
      true,
    );

    expect(shown).toContain(
      "Skills (its own, served read-only at /workspace/.agents/skills/<name>",
    );
    expect(shown).toContain("\n  release (saved 1970-01-01T00:00:00.000Z): Cut a release.");
    expect(shown).toContain("over those kept Global of the same name; environment_skill_save");
    expect(shown).not.toContain("bundle");
  });

  it("says where an installed Skill came from", () => {
    const shown = describeEnvironment(
      {
        id: "default",
        name: "Default",
        repos: [],
        build: { status: "none" },
        settings: DEFAULT_CONTAINER_SETTINGS,
        overrides: {},
        global: DEFAULT_CONTAINER_SETTINGS,
        secrets: [],
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
        globalSkills: [],
      },
      true,
    );

    expect(shown).toContain(
      "\n  grill-me (saved 1970-01-01T00:00:00.000Z, installed from mattpocock/skills/skills/grill-me at c0ffee0): Interview me.",
    );
  });
});

const GLOBAL_ARGS = {
  id: "*",
  path: "/workspace/.cloudpid/tmp/release",
  reason: "Every project cuts releases the same way",
};

const OTHER_MD =
  "---\nname: release\ndescription: Cut a different release.\n---\nPush, then tag.\n";

describe("environment_skill_save at Global", () => {
  it("asks the owner on a card showing the Skill, notifies them once, and saves it only on Approve", async () => {
    const { call, saves, logged, notified, kept, recorded } = await setUp();

    const { result, text, shown } = await call("environment_skill_save", GLOBAL_ARGS, {
      approve: true,
      meanwhile: () => {
        // The request waits: nothing is saved yet.
        expect(saves).toEqual([]);
      },
    });

    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({
      tool: "environment_skill_save",
      target: "Global",
      change: 'Save the Skill "release"',
      before: "Not kept Global",
      reason: "Every project cuts releases the same way",
    });
    // The card shows what steers every Session: the description, and each file's text.
    expect(shown[0]?.after).toContain("Cut a release.");
    expect(shown[0]?.after).toContain("── SKILL.md (");
    expect(shown[0]?.after).toContain("Tag, then push.");
    expect(shown[0]?.after).toContain("── references/steps.md (");
    // The notification goes out in the background.
    await vi.waitFor(() => expect(notified).toHaveLength(1));

    expect(saves).toEqual([
      expect.objectContaining({
        environment: "*",
        folder: "release",
        expected: { savedAt: null },
      }),
    ]);
    expect(kept.has("*:release")).toBe(true);
    expect(text).toContain("The user approved: Saved the new Skill release for Global (2 files).");
    expect(text).toContain("served now at /workspace/.agents/skills/release (read-only)");
    expect(text).toContain(
      "Each Environment's Workspaces and spares get it at their next readying",
    );
    expect(text).toContain("This Session's Workspace has the change now");
    expect(result.details).toMatchObject({
      approval: { approved: true },
      agentChange: {
        environment: { id: "*", name: "Global" },
        field: "skills.release",
        before: null,
      },
    });
    expect(logged).toEqual([
      {
        tool: "environment_skill_save",
        environmentName: "Global",
        field: "skills.release",
      },
    ]);
    // The change is recorded for the scope * as the owner approved it.
    expect(recorded).toEqual([
      expect.objectContaining({ scope: "*", field: "skills.release", approved: true }),
    ]);
  });

  it("saves nothing on Decline, and gives the owner's reason", async () => {
    const { call, saves, kept, logged } = await setUp();

    const { result, text } = await call("environment_skill_save", GLOBAL_ARGS, {
      approve: false,
      reason: "Not now",
    });

    expect(text).toContain("The user declined: saving the Skill release at Global");
    expect(text).toContain("Their reason: Not now");
    expect(result.details).toMatchObject({ approval: { approved: false, reason: "Not now" } });
    expect(saves).toEqual([]);
    expect(kept.size).toBe(0);
    expect(logged).toEqual([]);
  });

  it("shows the Skill kept now when it replaces one, and applies only against it", async () => {
    const { call, keep, saves } = await setUp();

    keep("*", "release", { "SKILL.md": OTHER_MD, "old.md": "Old.\n" });

    const { shown } = await call("environment_skill_save", GLOBAL_ARGS);

    expect(shown[0]?.before).toBe(
      "Kept at Global: Cut a different release. (files: SKILL.md, old.md)",
    );
    expect(saves[0]?.expected?.savedAt).toEqual(expect.any(Number));
  });

  it("applies nothing when the Skill was saved again between the request and the answer", async () => {
    const { call, keep, kept, logged } = await setUp();

    const { result, text } = await call("environment_skill_save", GLOBAL_ARGS, {
      approve: true,
      meanwhile: () => {
        keep("*", "release", { "SKILL.md": OTHER_MD });
      },
    });

    expect(result.isError).toBe(true);
    expect(text).toContain("was saved again since the user was asked: nothing was saved");
    expect(kept.get("*:release")).toEqual({ "SKILL.md": OTHER_MD });
    expect(logged).toEqual([]);
  });

  it("refuses without asking what the Registry refuses, and what holds a Secret or is not a folder", async () => {
    const { call, refuse, notified } = await setUp({ API_KEY: "sk-live-abcdefghijkl" });

    expect(
      (
        await call(
          "environment_skill_save",
          GLOBAL_ARGS,
          { approve: true },
          scratch({ "/workspace/.cloudpid/tmp/release/notes.md": "Use sk-live-abcdefghijkl." }),
        )
      ).text,
    ).toContain("the file notes.md holds the value of a Secret");

    refuse("SKILL.md's name: too long");

    const { text, result, shown } = await call("environment_skill_save", GLOBAL_ARGS);

    expect(result.isError).toBe(true);
    expect(text).toContain("Nothing was saved:");
    expect(text).toContain("too long");
    expect(shown).toEqual([]);
    expect(notified).toEqual([]);
  });

  it("asks nothing for the files kept Global already", async () => {
    const { call, keep, notified, saves, logged } = await setUp();

    keep("*", "release", {
      "SKILL.md": SKILL_MD,
      "references/steps.md": "1. Tag.\n",
    });

    const { text } = await call("environment_skill_save", GLOBAL_ARGS);

    expect(text).toContain("keeps the Skill release with these files already: nothing was asked");
    expect(notified).toEqual([]);
    expect(saves).toEqual([]);
    expect(logged).toEqual([]);
  });

  it("takes the answer given meanwhile on a rerun, and applies it only to the folder the owner was shown", async () => {
    const { call, answeredEarlier, kept, logged } = await setUp();

    // The owner approved a request for other files; the rerun reads this folder, which differs.
    await answeredEarlier(7, { savedAt: null, digest: "not-this-folder" });

    const { result, text } = await call("environment_skill_save", GLOBAL_ARGS, {
      approve: true,
      task: 7,
    });

    expect(result.isError).toBe(true);
    expect(text).toContain("no longer holds the Skill they were shown");
    expect(kept.size).toBe(0);
    expect(logged).toEqual([]);
  });

  it("reports an approved save a rerun finds made, as approved, with nothing more changed", async () => {
    const { call, answeredEarlier, keep, logged } = await setUp();

    // The folder's digest is the one a first call computed for it.
    const probe = await call("environment_skill_save", GLOBAL_ARGS, { approve: false });
    // SAFETY: the tool asks with `{ savedAt, digest }`, which this test reads back.
    const asked = probe.shown[0]?.expected as { digest: string };

    keep("*", "release", { "SKILL.md": SKILL_MD, "references/steps.md": "1. Tag.\n" });
    await answeredEarlier(9, { savedAt: null, digest: asked.digest });

    const { text } = await call("environment_skill_save", GLOBAL_ARGS, { approve: true, task: 9 });

    expect(text).toContain("The user approved, and Global keeps the Skill release");
    expect(logged).toEqual([]);
  });

  it("says this Session's Workspace keeps its own Skill of the name, which hides it, and the Environments that do", async () => {
    const { call, keep } = await setUp();

    keep("default", "release", { "SKILL.md": OTHER_MD });
    keep("0000abcd", "release", { "SKILL.md": OTHER_MD });

    const { text, result } = await call("environment_skill_save", GLOBAL_ARGS);

    expect(text).toContain(
      "This Session's Environment keeps its own Skill of that name, which hides it there",
    );
    expect(text).toContain(
      'does not reach the Environments whose own Skill of that name hides it: Environment "Other" (0000abcd)',
    );
    expect(result.details).toMatchObject({ own: false });
  });
});

describe("environment_skill_save over an Environment's own Skill of a name kept Global", () => {
  it("saves at once, with no Approval, and says it hides the one kept Global", async () => {
    const { call, keep, notified, saves } = await setUp();

    keep("*", "release", { "SKILL.md": OTHER_MD });

    const { text, shown } = await call("environment_skill_save", {
      id: "default",
      path: "/workspace/.cloudpid/tmp/release",
      reason: "Ours differs",
    });

    expect(shown).toEqual([]);
    expect(notified).toEqual([]);
    expect(saves).toHaveLength(1);
    expect(text).toContain("It hides the Skill of that name kept Global, in this Environment.");
  });
});

describe("environment_skill_remove at Global", () => {
  it("asks the owner on a card naming the Skill, and removes it only on Approve", async () => {
    const { call, keep, kept, removals, logged, notified } = await setUp();

    keep("*", "release", { "SKILL.md": SKILL_MD });
    keep("0000abcd", "release", { "SKILL.md": OTHER_MD });

    const { result, text, shown } = await call("environment_skill_remove", {
      id: "*",
      name: "release",
      reason: "Nobody releases that way any more",
    });

    expect(shown[0]).toMatchObject({
      tool: "environment_skill_remove",
      target: "Global",
      change: 'Remove the Skill "release"',
      before: "release: Cut a release.",
    });
    await vi.waitFor(() => expect(notified).toHaveLength(1));
    expect(removals).toEqual([{ environment: "*", name: "release" }]);
    expect(kept.has("*:release")).toBe(false);
    expect(text).toContain("The user approved: removed the Skill release from Global.");
    expect(text).toContain('Environment "Other" (0000abcd)');
    expect(result.details).toMatchObject({
      approval: { approved: true },
      agentChange: { environment: { id: "*" }, field: "skills.release", after: null },
    });
    expect(logged).toEqual([
      {
        tool: "environment_skill_remove",
        environmentName: "Global",
        field: "skills.release",
      },
    ]);
  });

  it("removes nothing on Decline", async () => {
    const { call, keep, kept, removals } = await setUp();

    keep("*", "release", { "SKILL.md": SKILL_MD });

    const { text } = await call(
      "environment_skill_remove",
      { id: "*", name: "release", reason: "r" },
      { approve: false, reason: "Keep it" },
    );

    expect(text).toContain("The user declined: removing the Skill release from Global");
    expect(text).toContain("Their reason: Keep it");
    expect(removals).toEqual([]);
    expect(kept.has("*:release")).toBe(true);
  });

  it("refuses without asking a Skill that is not kept Global, pointing to environment_get", async () => {
    const { call, keep, notified } = await setUp();

    // An Environment's own Skill of the name is not the one kept Global.
    keep("default", "release", { "SKILL.md": SKILL_MD });

    const { result, text, shown } = await call("environment_skill_remove", {
      id: "*",
      name: "release",
      reason: "r",
    });

    expect(result.isError).toBe(true);
    expect(text).toContain('no Skill named "release" is kept Global');
    expect(text).toContain('environment_get with id "*"');
    expect(shown).toEqual([]);
    expect(notified).toEqual([]);
  });

  it("removes nothing when the Skill was saved again between the request and the answer", async () => {
    const { call, keep, kept, logged } = await setUp();

    keep("*", "release", { "SKILL.md": SKILL_MD });

    const { result, text } = await call(
      "environment_skill_remove",
      { id: "*", name: "release", reason: "r" },
      {
        approve: true,
        meanwhile: () => {
          keep("*", "release", { "SKILL.md": OTHER_MD });
        },
      },
    );

    expect(result.isError).toBe(true);
    expect(text).toContain("was saved again since the user was asked: nothing was removed");
    expect(kept.has("*:release")).toBe(true);
    expect(logged).toEqual([]);
  });

  it("refuses a reason that holds a Secret, asking nothing", async () => {
    const { call, notified } = await setUp({ API_KEY: "sk-live-abcdefghijkl" });

    const { result, text } = await call("environment_skill_remove", {
      id: "*",
      name: "release",
      reason: "sk-live-abcdefghijkl is leaked",
    });

    expect(result.isError).toBe(true);
    expect(text).toContain("the reason holds the value of a Secret");
    expect(notified).toEqual([]);
  });
});

describe("environment_skill_remove for an Environment's own Skill", () => {
  it("says the Skill kept Global is served instead, and asks nothing", async () => {
    const { call, keep, notified } = await setUp();

    keep("default", "release", { "SKILL.md": SKILL_MD });
    keep("*", "release", { "SKILL.md": OTHER_MD });

    const { text, shown } = await call("environment_skill_remove", {
      id: "default",
      name: "release",
      reason: "Back to the shared one",
    });

    expect(shown).toEqual([]);
    expect(notified).toEqual([]);
    expect(text).toContain(
      "The Skill of that name kept Global is served at /workspace/.agents/skills/release instead.",
    );
  });
});

describe("environment_get for each Environment's Skills", () => {
  it("lists the Skills kept Global, and for an Environment those it overrides", () => {
    const base = {
      id: "default",
      name: "Default",
      repos: [],
      build: { status: "none" as const },
      settings: DEFAULT_CONTAINER_SETTINGS,
      secrets: [],
      overrides: {},
      global: DEFAULT_CONTAINER_SETTINGS,
      skills: [{ name: "release", description: "Ours.", savedAt: 0 }],
      globalSkills: [
        { name: "release", description: "Shared release.", savedAt: 0 },
        { name: "review", description: "Review code.", savedAt: 0 },
      ],
    };

    const shown = describeEnvironment(base, true);

    expect(shown).toContain(
      'Skills at Global (id "*"; the Environment\'s own of the same name win): \n  review (saved 1970-01-01T00:00:00.000Z): Review code.\n  overridden here: release',
    );
    // What it keeps of its own is listed apart.
    expect(shown).toContain("\n  release (saved 1970-01-01T00:00:00.000Z): Ours.");
    expect(shown).not.toContain("Shared release.");
    expect(shown).not.toContain("bundle");
  });

  it("says none when nothing is kept Global", () => {
    const shown = describeEnvironment(
      {
        id: "default",
        name: "Default",
        repos: [],
        build: { status: "none" },
        settings: DEFAULT_CONTAINER_SETTINGS,
        secrets: [],
        overrides: {},
        global: DEFAULT_CONTAINER_SETTINGS,
        skills: [],
        globalSkills: [],
      },
      false,
    );

    expect(shown).toContain(
      'Skills at Global (id "*"; the Environment\'s own of the same name win): none',
    );
  });
});

describe("the Approval card of a Skill kept Global", () => {
  const long = (size: number) => "Step.\n".repeat(Math.ceil(size / 6)).slice(0, size);

  it("shows a Skill that fits in full, with no warning", async () => {
    const { call } = await setUp();

    const { shown, text } = await call("environment_skill_save", GLOBAL_ARGS);

    expect(shown[0]?.after).not.toContain("NOT FULLY SHOWN");
    expect(text).not.toContain("not reviewed");
  });

  it("says plainly what it could not show, above the files and below them, and tells the agent after Approve", async () => {
    const { call } = await setUp();

    const env = fakeFolderEnv({
      "/workspace/.cloudpid/tmp/release/SKILL.md": SKILL_MD,
      // 40,000 characters: the card shows 16,000 in all, so this one is cut, and the next is left out.
      "/workspace/.cloudpid/tmp/release/references/long.md": long(40_000),
      "/workspace/.cloudpid/tmp/release/references/more.md": long(1_000),
    });

    const { shown, text } = await call(
      "environment_skill_save",
      GLOBAL_ARGS,
      { approve: true },
      env,
    );

    const after = shown[0]?.after ?? "";

    // 41,000 characters and the SKILL.md's own, of which the card showed 16,000.
    const total = SKILL_MD.length + 40_000 + 1_000;

    expect(after.startsWith("⚠ NOT FULLY SHOWN: ")).toBe(true);
    expect(after.endsWith("unless you trust the part you cannot see.")).toBe(true);
    expect(after).toContain(`${total - 16_000} of ${total} characters (2 of 3 files)`);
    expect(after).toContain("it was not reviewed");
    expect(after).toContain("── references/long.md (40000 bytes), CUT ──");
    expect(after).toContain("── references/more.md (1000 bytes), NOT SHOWN ──");
    // The agent is told to keep such a Skill small enough to review.
    expect(text).toContain("that part was not reviewed");
    expect(text).toContain("small enough to review in full");
  });
});

describe("environment_skill_remove that would serve a Skill that does not fit", () => {
  it("passes on the refusal, saying why, and records nothing, for an own Skill and Global", async () => {
    const { call, tool, keep, refuseRemoval, logged, recorded } = await setUp();

    keep("default", "release", { "SKILL.md": SKILL_MD });
    keep("*", "release", { "SKILL.md": OTHER_MD });
    refuseRemoval(
      'Environment "Default" (default)\'s Skill set would be 9000000 bytes, more than the 8388608 a set may once the Skill of the name in the layer below, which release hides, is served instead: remove another Skill first',
    );

    const own = await failure(
      run(tool("environment_skill_remove"), { id: "default", name: "release", reason: "r" }),
    );

    const atGlobal = await call("environment_skill_remove", {
      id: "*",
      name: "release",
      reason: "r",
    });

    expect(own).toContain("Nothing was removed:");
    expect(own).toContain("more than the 8388608 a set may");
    expect(atGlobal.result.isError).toBe(true);
    expect(atGlobal.text).toContain("The user approved, but nothing was removed:");
    expect(atGlobal.text).toContain("remove another Skill first");
    expect(logged).toEqual([]);
    expect(recorded).toEqual([]);
  });
});

describe("a rerun after an eviction of a change that went through", () => {
  it("says an own save, and an own removal, may be done already", async () => {
    const { tool, keep } = await setUp();

    keep("default", "release", {
      "SKILL.md": SKILL_MD,
      "references/steps.md": "1. Tag.\n",
    });

    const saved = await run(
      tool("environment_skill_save"),
      { id: "default", path: "/workspace/.cloudpid/tmp/release", reason: "r" },
      scratch(),
    );

    const removed = await failure(
      run(tool("environment_skill_remove"), { id: "default", name: "gone", reason: "r" }),
    );

    expect(text(saved)).toContain(
      "if an earlier run of this call saved it before the Session restarted, it is done",
    );
    expect(removed).toContain(
      "if an earlier run of this call removed it before the Session restarted, it is done",
    );
  });
});

const GLOBAL_SCOPE = { id: "*", name: "Global" };

const INSTALL_ARGS = {
  id: "*",
  source: "mattpocock/skills",
  skills: ["grill-me"],
  reason: "Every project should grill the plan",
};

const GRILL_FILES = {
  "SKILL.md": "---\nname: grill-me\ndescription: Interview me.\n---\nAsk one question at a time.\n",
  "references/questions.md": "- Why?\n",
};

/** A Skill the Registry would keep, as its preview shows it. */
const previewedSkill = (
  name: string,
  files: Readonly<Record<string, string>> = GRILL_FILES,
): PreviewedSkill => ({
  name,
  path: `skills/${name}`,
  description: "Interview me.",
  files,
  digest: `digest-of-${name}`,
  unchanged: false,
  current: null,
});

const previewOf = (
  skills: ReadonlyArray<ReturnType<typeof previewedSkill>>,
  rejected: ReadonlyArray<{ name: string; path: string; message: string }> = [],
) => ({
  status: "previewed" as const,
  environment: GLOBAL_SCOPE,
  repo: "mattpocock/skills",
  ref: null,
  commit: GRILL_COMMIT,
  skills,
  rejected,
});

/** What the Registry answers an approved install with. */
const installedAtGlobal = (names: ReadonlyArray<string>) => ({
  status: "installed" as const,
  environment: GLOBAL_SCOPE,
  repo: "mattpocock/skills",
  ref: null,
  commit: GRILL_COMMIT,
  results: Arr.map(names, (name, at) => ({
    name,
    path: `skills/${name}`,
    outcome: "installed" as const,
    change: { ...installChange(20 + at, name), scope: "*", approved: true as const },
    overriddenIn: [],
  })),
  handed: true,
});

describe("environment_skill_install at Global", () => {
  it("asks the owner on a card showing each Skill, and installs with the commit and Skills it showed only on Approve", async () => {
    const { call, answerPreview, answerInstall, installs, previews, logged, notified } =
      await setUp();

    answerPreview(previewOf([previewedSkill("grill-me")]));
    answerInstall(installedAtGlobal(["grill-me"]));

    const { result, text, shown } = await call("environment_skill_install", INSTALL_ARGS, {
      approve: true,
      meanwhile: () => {
        // The request waits: nothing is installed yet.
        expect(installs).toEqual([]);
      },
    });

    expect(previews).toEqual([
      { environment: "*", source: "mattpocock/skills", skills: ["grill-me"] },
    ]);
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({
      tool: "environment_skill_install",
      target: "Global",
      change: 'Install the Skill "grill-me" from mattpocock/skills at c0ffee0',
      before: "grill-me: not kept Global",
      reason: "Every project should grill the plan",
    });
    // The card shows what steers every Session: the description and each file's text.
    expect(shown[0]?.after).toContain("grill-me (skills/grill-me)");
    expect(shown[0]?.after).toContain("Interview me.");
    expect(shown[0]?.after).toContain("── SKILL.md (");
    expect(shown[0]?.after).toContain("Ask one question at a time.");
    expect(shown[0]?.after).toContain("── references/questions.md (");
    expect(shown[0]?.after).not.toContain("NOT FULLY SHOWN");
    await vi.waitFor(() => expect(notified).toHaveLength(1));

    // The commit the owner was shown is the commit read, and the Skill is kept only against what was shown.
    expect(installs).toEqual([
      {
        environment: "*",
        source: "mattpocock/skills",
        skills: undefined,
        reason: "Every project should grill the plan",
        approved: true,
        pin: {
          commit: GRILL_COMMIT,
          skills: [
            {
              name: "grill-me",
              path: "skills/grill-me",
              digest: "digest-of-grill-me",
              savedAt: null,
            },
          ],
        },
      },
    ]);
    expect(text).toContain(
      "The user approved: installed grill-me for Global from mattpocock/skills at c0ffee0.",
    );
    expect(text).toContain(
      "Each Environment's Workspaces and spares get them at their next readying",
    );
    expect(text).toContain("This Session's Workspace has the change now");
    expect(text).toContain("recorded as approved");
    expect(result.details).toMatchObject({
      approval: { approved: true },
      agentChanges: [{ environment: GLOBAL_SCOPE, field: "skills.grill-me" }],
    });
    expect(logged).toEqual([
      {
        tool: "environment_skill_install",
        environmentName: "Global",
        field: "skills.grill-me",
      },
    ]);
  });

  it("shows the Skill kept now that one replaces, and asks the Registry to apply it only against that", async () => {
    const { call, answerPreview, answerInstall, installs } = await setUp();

    answerPreview(
      previewOf([
        {
          ...previewedSkill("grill-me"),
          current: { description: "Old.", savedAt: 1_234, files: ["SKILL.md", "old.md"] },
        },
      ]),
    );
    answerInstall(installedAtGlobal(["grill-me"]));

    const { shown } = await call("environment_skill_install", INSTALL_ARGS);

    expect(shown[0]?.before).toBe("grill-me: kept Global: Old. (files: SKILL.md, old.md)");
    expect(installs[0]?.pin).toEqual({
      commit: GRILL_COMMIT,
      skills: [
        { name: "grill-me", path: "skills/grill-me", digest: "digest-of-grill-me", savedAt: 1_234 },
      ],
    });
  });

  it("installs nothing on Decline, and gives the owner's reason", async () => {
    const { call, answerPreview, installs, logged } = await setUp();

    answerPreview(previewOf([previewedSkill("grill-me")]));

    const { result, text } = await call("environment_skill_install", INSTALL_ARGS, {
      approve: false,
      reason: "Too chatty",
    });

    expect(installs).toEqual([]);
    expect(logged).toEqual([]);
    expect(text).toContain("The user declined: installing grill-me");
    expect(text).toContain("Their reason: Too chatty");
    expect(result.isError).toBeUndefined();
    expect(result.details).toMatchObject({ approval: { approved: false, reason: "Too chatty" } });
  });

  it("shows several Skills on one card, each with its own files", async () => {
    const { call, answerPreview, answerInstall, installs } = await setUp();

    answerPreview(
      previewOf([
        previewedSkill("grill-me"),
        previewedSkill("tdd", {
          "SKILL.md": "---\nname: tdd\ndescription: Test first.\n---\nRed, green.\n",
        }),
      ]),
    );
    answerInstall(installedAtGlobal(["grill-me", "tdd"]));

    const { shown, text } = await call("environment_skill_install", {
      ...INSTALL_ARGS,
      skills: ["*"],
    });

    expect(shown[0]?.change).toBe(
      'Install the Skills "grill-me", "tdd" from mattpocock/skills at c0ffee0',
    );
    expect(shown[0]?.after).toContain("grill-me (skills/grill-me)");
    expect(shown[0]?.after).toContain("tdd (skills/tdd)");
    expect(shown[0]?.after).toContain("Red, green.");
    // Which Skills are read is the pin's: nothing is chosen again by name.
    expect(installs[0]?.skills).toBeUndefined();
    expect(Arr.map(installs[0]?.pin?.skills ?? [], ({ name }) => name)).toEqual([
      "grill-me",
      "tdd",
    ]);
    expect(text).toContain("installed grill-me, tdd for Global");
  });

  it("says plainly what the card could not show of each Skill, and tells the agent after Approve", async () => {
    const { call, answerPreview, answerInstall } = await setUp();
    const long = "Step.\n".repeat(7_000);

    answerPreview(
      previewOf([
        previewedSkill("grill-me", { ...GRILL_FILES, "references/long.md": long }),
        previewedSkill("tdd", {
          "SKILL.md": "---\nname: tdd\ndescription: Test first.\n---\nRed.\n",
        }),
      ]),
    );
    answerInstall(installedAtGlobal(["grill-me", "tdd"]));

    const { shown, text } = await call("environment_skill_install", {
      ...INSTALL_ARGS,
      skills: ["*"],
    });

    const after = shown[0]?.after ?? "";

    // The long Skill's card warns above and below its files; the short one's does not.
    expect(after).toContain("⚠ NOT FULLY SHOWN: ");
    expect(after).toContain("references/long.md (42000 bytes), CUT");
    expect(after.match(/⚠ NOT FULLY SHOWN/g)).toHaveLength(2);
    expect(text).toContain("that part was not reviewed");
    expect(text).toContain("small enough to review in full");
  });

  it("asks nothing when every Skill is kept already or refused, and says so", async () => {
    const { call, answerPreview, installs, previews } = await setUp();

    answerPreview(
      previewOf(
        [{ ...previewedSkill("grill-me"), unchanged: true }],
        [{ name: "tdd", path: "skills/tdd", message: "SKILL.md: looks like a credential" }],
      ),
    );

    const { result, text, shown } = await call("environment_skill_install", {
      ...INSTALL_ARGS,
      skills: ["*"],
    });

    expect(shown).toEqual([]);
    expect(previews).toHaveLength(1);
    expect(installs).toEqual([]);
    expect(result.isError).toBeUndefined();
    expect(text).toContain("grill-me was installed from mattpocock/skills at c0ffee0 already");
    expect(text).toContain("tdd (skills/tdd): SKILL.md: looks like a credential");
  });

  it("refuses without asking when each Skill is refused, a source holds several, or GitHub gave no answer", async () => {
    const { call, answerPreview, installs } = await setUp();

    answerPreview(
      previewOf([], [{ name: "tdd", path: "skills/tdd", message: "SKILL.md: too large" }]),
    );

    const allRefused = await call("environment_skill_install", INSTALL_ARGS);

    expect(allRefused.result.isError).toBe(true);
    expect(allRefused.text).toContain("each Skill was refused");
    expect(allRefused.text).toContain("SKILL.md: too large");

    answerPreview({
      status: "listed",
      environment: GLOBAL_SCOPE,
      repo: "mattpocock/skills",
      ref: null,
      commit: GRILL_COMMIT,
      available: [
        { name: "grill-me", description: "Interview me.", path: "skills/grill-me" },
        { name: "tdd", description: "Test first.", path: "skills/tdd" },
      ],
    });

    const { skills: _named, ...unnamed } = INSTALL_ARGS;
    const listed = await call("environment_skill_install", unnamed);

    expect(listed.shown).toEqual([]);
    expect(listed.text).toContain("holds 2 Skills and none was named");

    answerPreview({ status: "refused", message: "GitHub has no repo o/r (or it is private)" });

    const refused = await call("environment_skill_install", INSTALL_ARGS);

    expect(refused.result.isError).toBe(true);
    expect(refused.text).toContain("Nothing was installed: GitHub has no repo");
    expect(installs).toEqual([]);
  });

  it("asks about at most ten Skills at once", async () => {
    const { call, answerPreview, installs } = await setUp();

    answerPreview(previewOf(Arr.makeBy(11, (at) => previewedSkill(`skill-${at}`))));

    const { result, text, shown } = await call("environment_skill_install", {
      ...INSTALL_ARGS,
      skills: ["*"],
    });

    expect(shown).toEqual([]);
    expect(result.isError).toBe(true);
    expect(text).toContain("11 Skills");
    expect(text).toContain("at most 10");
    expect(installs).toEqual([]);
  });

  it("tells the owner nothing was installed for a Skill saved again between the request and the answer", async () => {
    const { call, answerPreview, answerInstall } = await setUp();

    answerPreview(previewOf([previewedSkill("grill-me")]));
    answerInstall({
      ...installedAtGlobal([]),
      results: [
        {
          name: "grill-me",
          path: "skills/grill-me",
          outcome: "rejected",
          message:
            "the Skill of the name was saved again since the user was asked: nothing was installed. Ask again",
        },
      ],
    });

    const { result, text } = await call("environment_skill_install", INSTALL_ARGS);

    expect(result.isError).toBe(true);
    expect(text).toContain("The user approved, but nothing was installed");
    expect(text).toContain("saved again since the user was asked");
  });

  it("takes the answer given meanwhile on a rerun, reading nothing first, and installs the commit and Skills the owner was shown", async () => {
    const { call, answeredEarlier, answerInstall, installs, previews } = await setUp();

    const shownEarlier = {
      commit: "feed0000000000000000000000000000000000f1",
      skills: [{ name: "grill-me", path: "skills/grill-me", digest: "d1", savedAt: 5 }],
      unseen: { files: 0, characters: 0 },
      notKept: [],
    };

    // The preview would fail now (GitHub is unreachable): the rerun does not ask it.
    answerInstall(installedAtGlobal(["grill-me"]));
    await answeredEarlier(7, shownEarlier);

    const { text } = await call("environment_skill_install", INSTALL_ARGS, {
      approve: true,
      task: 7,
    });

    expect(previews).toEqual([]);
    expect(installs).toEqual([
      expect.objectContaining({
        approved: true,
        skills: undefined,
        pin: { commit: shownEarlier.commit, skills: shownEarlier.skills },
      }),
    ]);
    expect(text).toContain("The user approved: installed grill-me");
  });

  it("reports an approved install a rerun finds made, as approved, with nothing more changed", async () => {
    const { call, answeredEarlier, answerInstall } = await setUp();

    await answeredEarlier(9, {
      commit: GRILL_COMMIT,
      skills: [{ name: "grill-me", path: "skills/grill-me", digest: "d1", savedAt: null }],
      unseen: { files: 0, characters: 0 },
      // What the first call's preview left out: a refusal, which the rerun reports as well.
      notKept: [
        { name: "tdd", path: "skills/tdd", outcome: "rejected", message: "SKILL.md: too large" },
      ],
    });
    answerInstall({
      ...installedAtGlobal([]),
      results: [{ name: "grill-me", path: "skills/grill-me", outcome: "unchanged" }],
    });

    const { text, result } = await call("environment_skill_install", INSTALL_ARGS, {
      approve: true,
      task: 9,
    });

    expect(text).toContain("The user approved, and Global keeps grill-me from");
    expect(text).toContain("Refused: tdd (skills/tdd): SKILL.md: too large");
    expect(result.details).toMatchObject({ approval: { approved: true } });
  });

  it("says which Environments' own Skills hide each Skill installed, and whether this Session's Workspace has them", async () => {
    const { call, answerPreview, answerInstall } = await setUp();

    answerPreview(previewOf([previewedSkill("grill-me"), previewedSkill("tdd")]));
    answerInstall({
      ...installedAtGlobal(["grill-me", "tdd"]),
      results: [
        ...installedAtGlobal(["grill-me"]).results,
        {
          ...installedAtGlobal(["tdd"]).results[0]!,
          overriddenIn: [{ id: "0000abcd", name: "Other" }],
        },
      ],
    });

    const { text } = await call("environment_skill_install", { ...INSTALL_ARGS, skills: ["*"] });

    expect(text).toContain("This Session's Workspace has the change now.");
    expect(text).toContain(
      'tdd does not reach Environment "Other" (0000abcd), whose own Skill of that name hides it.',
    );
    expect(text).not.toContain("grill-me does not reach");
  });

  it("refuses a Secret in the reason or the source, asking nothing", async () => {
    const { call, previews } = await setUp({ API_KEY: "s3cr3t-value-123456" });

    const withSecret = await call("environment_skill_install", {
      ...INSTALL_ARGS,
      reason: "using s3cr3t-value-123456",
    });

    expect(withSecret.result.isError).toBe(true);
    expect(withSecret.text).toContain("holds the value of a Secret");
    expect(previews).toEqual([]);
  });
});

describe("environment_skill_update", () => {
  const NEW_COMMIT = "dec0de0000000000000000000000000000000002";

  const from = {
    repo: "mattpocock/skills",
    path: "skills/grill-me",
    ref: null,
    commit: GRILL_COMMIT,
  };

  const to = { ...from, commit: NEW_COMMIT };

  const updatedGrill = (overwrote = false) => ({
    name: "grill-me",
    outcome: "updated" as const,
    from,
    to,
    overwrote,
    change: installChange(9, "grill-me"),
  });

  it("runs alone, is rerun safely, requires a reason, and is the root conversation's only", async () => {
    const { tool } = await setUp();

    // No tool of the Skills says anything of a bundle: cloudpid ships no Skills.
    for (const name of [
      "environment_skill_save",
      "environment_skill_install",
      "environment_skill_update",
      "environment_skill_remove",
    ]) {
      expect(tool(name).description, name).not.toMatch(/bundle/i);
      expect(JSON.stringify(tool(name).parameters), name).not.toMatch(/bundle/i);
    }

    // A rerun finds the Skills at the new commit already: unchanged, nothing recorded again.
    expect(tool("environment_skill_update").replay).toBe("safe");
    expect(tool("environment_skill_update").executionMode).toBe("sequential");

    expect(
      resolveTools(undefined, ["bash", "environment_skill_update"], DEFAULT_TOOLSETS),
    ).toMatchObject({ success: { tools: ["bash"] } });

    // A reason is required, as for every changing tool.
    expect(JSON.stringify(tool("environment_skill_update").parameters)).toMatch(
      /"required":\[[^\]]*"reason"/,
    );
  });

  it("updates the named Skills, saying from where to where, and records an Agent change for each", async () => {
    const { tool, logged, updates, answerUpdate } = await setUp();

    answerUpdate({
      status: "done",
      environment: DEFAULT,
      results: [updatedGrill()],
      handed: true,
    });

    const result = await run(tool("environment_skill_update"), {
      id: "default",
      names: ["grill-me"],
      reason: "The user asked for the latest grill-me",
    });

    expect(updates).toEqual([
      {
        environment: "default",
        names: ["grill-me"],
        overwrite: false,
        pins: undefined,
        reason: "The user asked for the latest grill-me",
        approved: false,
      },
    ]);

    const said = text(result);

    expect(said).toContain(
      'Updated grill-me (mattpocock/skills/skills/grill-me at c0ffee0 → dec0de0) for Environment "Default" (default).',
    );
    expect(said).toContain("served now at /workspace/.agents/skills/<name> (read-only)");
    expect(said).toContain("the user can revert it on the Skills page");
    expect(result.isError).not.toBe(true);
    expect(result.details).toMatchObject({ agentChanges: [{ id: 9, field: "skills.grill-me" }] });

    expect(logged).toEqual([
      { tool: "environment_skill_update", environmentName: "Default", field: "skills.grill-me" },
    ]);
  });

  it("updates every Skill marked update available when no names are given, and says when none is", async () => {
    const { tool, updates, answerUpdate } = await setUp();

    answerUpdate({ status: "nothing", environment: DEFAULT });

    const result = await run(tool("environment_skill_update"), {
      id: "default",
      reason: "Keep Skills current",
    });

    expect(updates[0]).toMatchObject({ names: undefined });
    expect(text(result)).toContain(
      'No Skill kept for Environment "Default" (default) is marked update available',
    );
    expect(result.isError).not.toBe(true);
    expect(result.details).toMatchObject({ updated: [] });
  });

  it("names the Skills refused for being modified, and the ones left unchanged, while updating the rest", async () => {
    const { tool, updates, answerUpdate } = await setUp();

    answerUpdate({
      status: "done",
      environment: DEFAULT,
      results: [
        updatedGrill(),
        {
          name: "tdd",
          outcome: "modified",
          message: "tdd was edited since it was installed; set overwrite to replace the edits.",
        },
        { name: "pr", outcome: "unchanged", message: "pr is the same." },
      ],
      handed: true,
    });

    const said = text(
      await run(tool("environment_skill_update"), {
        id: "default",
        reason: "Keep Skills current",
      }),
    );

    expect(updates[0]).toMatchObject({ overwrite: false });
    expect(said).toContain("Updated grill-me");
    expect(said).toContain(
      "pr was the same at the ref's latest commit: nothing changed, and nothing was recorded for it.",
    );
    expect(said).toContain("- tdd (modified): tdd was edited since it was installed");
    expect(said).toContain(
      "tdd was refused because the Skill was edited since it was installed: call again with overwrite set",
    );
  });

  it("fails naming the refused Skills when nothing was moved, and says what overwrite replaces", async () => {
    const { tool, answerUpdate } = await setUp();

    answerUpdate({
      status: "done",
      environment: DEFAULT,
      results: [
        { name: "tdd", outcome: "modified", message: "tdd was edited." },
        { name: "mine", outcome: "rejected", message: "mine has no Skill source." },
      ],
      handed: false,
    });

    const said = await failure(
      run(tool("environment_skill_update"), {
        id: "default",
        names: ["tdd", "mine"],
        reason: "Update both",
      }),
    );

    expect(said).toContain("Nothing was updated:");
    expect(said).toContain("- tdd (modified): tdd was edited.");
    expect(said).toContain("- mine (rejected): mine has no Skill source.");
    expect(said).toContain("tdd was edited since installed: call again with overwrite set");
  });

  it("passes overwrite on, and says the replaced edits come back with a revert", async () => {
    const { tool, updates, answerUpdate } = await setUp();

    answerUpdate({
      status: "done",
      environment: DEFAULT,
      results: [updatedGrill(true)],
      handed: true,
    });

    const said = text(
      await run(tool("environment_skill_update"), {
        id: "default",
        names: ["grill-me"],
        overwrite: true,
        reason: "The user wants the upstream version",
      }),
    );

    expect(updates[0]).toMatchObject({ overwrite: true });
    expect(said).toContain(
      "The edits made to grill-me were replaced; reverting the update brings them back.",
    );
  });

  it("refuses an Environment that is not there, and a Secret in the reason", async () => {
    const { tool, updates } = await setUp({ API_KEY: "sk-live-0123456789abcdef" });

    expect(
      await failure(
        run(tool("environment_skill_update"), { id: "ghost0000", reason: "Keep Skills current" }),
      ),
    ).toContain("ghost0000");

    expect(
      await failure(
        run(tool("environment_skill_update"), {
          id: "default",
          reason: "Use sk-live-0123456789abcdef to fetch",
        }),
      ),
    ).toContain("Secret");

    expect(updates).toHaveLength(1);
  });
});

describe("environment_skill_update at Global", () => {
  const NEW_COMMIT = "dec0de0000000000000000000000000000000002";
  const GLOBAL_TARGET = { id: "*", name: "Global" };

  const from = {
    repo: "mattpocock/skills",
    path: "skills/grill-me",
    ref: null,
    commit: GRILL_COMMIT,
  };

  const to = { ...from, commit: NEW_COMMIT };

  const ready = (files: Record<string, string>, overwrites = false) => ({
    name: "grill-me",
    outcome: "ready" as const,
    from,
    to,
    description: "Interview me.",
    files,
    folderHash: "folder-hash-1",
    savedAt: 1_234,
    overwrites,
    current: { description: "Interview me.", files: ["SKILL.md"] },
  });

  const args = { id: "*", names: ["grill-me"], reason: "The user wants the latest grill-me" };

  it("asks the owner on a card showing the files each Skill would take, and updates only on Approve at the shown commit", async () => {
    const { call, updates, updatePreviews, notified, logged, answerUpdatePreview, answerUpdate } =
      await setUp();

    answerUpdatePreview({
      status: "done",
      environment: GLOBAL_TARGET,
      results: [
        ready({ "SKILL.md": "---\nname: grill-me\ndescription: Interview me.\n---\nNew steps.\n" }),
      ],
    });

    answerUpdate({
      status: "done",
      environment: GLOBAL_TARGET,
      results: [
        {
          name: "grill-me",
          outcome: "updated" as const,
          from,
          to,
          overwrote: false,
          change: installChange(3, "grill-me"),
        },
      ],
      handed: false,
    });

    const {
      shown,
      text: said,
      result,
    } = await call("environment_skill_update", args, {
      approve: true,
      meanwhile: () => expect(updates).toEqual([]),
    });

    expect(updatePreviews).toEqual([{ environment: "*", names: ["grill-me"], overwrite: false }]);
    expect(shown[0]).toMatchObject({
      tool: "environment_skill_update",
      target: "Global",
      change: expect.stringContaining('"grill-me"'),
      reason: args.reason,
    });
    expect(shown[0]?.before).toContain(
      "grill-me: kept Global: mattpocock/skills/skills/grill-me at c0ffee0",
    );
    expect(shown[0]?.after).toContain("New steps.");
    expect(shown[0]?.after).toContain("━━ grill-me (skills/grill-me) at");
    expect(shown[0]?.after).toContain("── SKILL.md (");
    expect(shown[0]?.after).not.toContain("NOT FULLY SHOWN");
    await vi.waitFor(() => expect(notified).toHaveLength(1));

    expect(updates).toEqual([
      expect.objectContaining({
        environment: "*",
        names: ["grill-me"],
        overwrite: false,
        approved: true,
        pins: [
          { name: "grill-me", savedAt: 1_234, commit: NEW_COMMIT, folderHash: "folder-hash-1" },
        ],
      }),
    ]);

    expect(said).toContain("The user approved: updated grill-me");
    expect(said).toContain(
      "Each Environment's Workspaces and spares get it at their next readying",
    );
    expect(result.details).toMatchObject({ approval: { approved: true } });
    expect(logged).toEqual([
      {
        tool: "environment_skill_update",
        environmentName: "Global",
        field: "skills.grill-me",
      },
    ]);
  });

  it("says plainly on the card what it could not show, and tells the agent after Approve", async () => {
    const { call, answerUpdatePreview, answerUpdate } = await setUp();
    const long = "Step.\n".repeat(7_000);

    answerUpdatePreview({
      status: "done",
      environment: GLOBAL_TARGET,
      results: [
        ready({
          "SKILL.md": "---\nname: grill-me\ndescription: d\n---\n",
          "references/long.md": long,
        }),
      ],
    });
    answerUpdate({
      status: "done",
      environment: GLOBAL_TARGET,
      results: [{ name: "grill-me", outcome: "updated", from, to, overwrote: false }],
      handed: false,
    });

    const { shown, text: said } = await call("environment_skill_update", args);

    expect(shown[0]?.after).toContain("NOT FULLY SHOWN");
    expect(shown[0]?.after).toContain("CUT");
    expect(said).toContain("that part was not reviewed");
  });

  it("marks on the card a Skill whose edits the update would replace, and asks again with the same overwrite", async () => {
    const { call, updates, answerUpdatePreview, answerUpdate } = await setUp();

    answerUpdatePreview({
      status: "done",
      environment: GLOBAL_TARGET,
      results: [ready({ "SKILL.md": "---\nname: grill-me\ndescription: d\n---\nNew.\n" }, true)],
    });
    answerUpdate({
      status: "done",
      environment: GLOBAL_TARGET,
      results: [{ name: "grill-me", outcome: "updated", from, to, overwrote: true }],
      handed: false,
    });

    const { shown } = await call("environment_skill_update", { ...args, overwrite: true });

    expect(shown[0]?.after).toContain("EDITED since it was installed");
    expect(shown[0]?.before).toContain("edited since installed");
    expect(updates[0]).toMatchObject({ overwrite: true });
  });

  it("updates nothing on Decline, and gives the owner's reason", async () => {
    const { call, updates, answerUpdatePreview } = await setUp();

    answerUpdatePreview({
      status: "done",
      environment: GLOBAL_TARGET,
      results: [ready({ "SKILL.md": "---\nname: grill-me\ndescription: d\n---\n" })],
    });

    const { text: said } = await call("environment_skill_update", args, {
      approve: false,
      reason: "Too big a change",
    });

    expect(updates).toEqual([]);
    expect(said).toContain("Too big a change");
  });

  it("asks nothing when no Skill is ready, passing on why", async () => {
    const {
      call,
      shown: _unused,
      updates,
      answerUpdatePreview,
    } = await setUp().then((s) => ({ ...s, shown: [] }));

    answerUpdatePreview({
      status: "done",
      environment: GLOBAL_TARGET,
      results: [{ name: "grill-me", outcome: "modified", message: "grill-me was edited." }],
    });

    const { result, text: said, shown } = await call("environment_skill_update", args);

    expect(shown).toEqual([]);
    expect(result.isError).toBe(true);
    expect(said).toContain("- grill-me (modified): grill-me was edited.");
    expect(updates).toEqual([]);
  });

  const pin = { name: "grill-me", savedAt: 1_234, commit: NEW_COMMIT, folderHash: "folder-hash-1" };
  const asked = { overwrite: false, pins: [pin], unseen: { files: 0, characters: 0 }, notKept: [] };

  it("applies on a rerun what the owner approved, though GitHub shows nothing to ask about now", async () => {
    const { call, answeredEarlier, updates, updatePreviews, answerUpdate } = await setUp();

    // The owner approved the update before the eviction; the rerun reads nothing, so GitHub's answer now cannot matter.
    await answeredEarlier(7, asked);

    answerUpdate({
      status: "done",
      environment: GLOBAL_TARGET,
      results: [
        {
          name: "grill-me",
          outcome: "updated",
          from,
          to,
          overwrote: false,
          change: installChange(4, "grill-me"),
        },
      ],
      handed: false,
    });

    const { text: said, pending } = await call("environment_skill_update", args, {
      approve: true,
      task: 7,
    });

    expect(updates).toEqual([expect.objectContaining({ pins: [pin], approved: true })]);
    expect(updatePreviews).toEqual([]);
    expect(said).toContain("The user approved: updated grill-me");
    expect(pending).toEqual([]);
  });

  it("reports on a rerun the Skills the card left out, and what it could not show", async () => {
    const { call, answeredEarlier, answerUpdate } = await setUp();

    await answeredEarlier(8, {
      ...asked,
      unseen: { files: 2, characters: 900 },
      notKept: [{ name: "tdd", outcome: "modified", message: "it was edited" }],
    });

    answerUpdate({
      status: "done",
      environment: GLOBAL_TARGET,
      results: [{ name: "grill-me", outcome: "updated", from, to, overwrote: false }],
      handed: false,
    });

    const { text: said } = await call("environment_skill_update", args, { approve: true, task: 8 });

    expect(said).toContain("- tdd (modified): it was edited");
    expect(said).toContain("900 characters in 2 files were cut or left out");
  });

  it("reports an approved update a rerun finds made, as approved, with nothing more changed", async () => {
    const { call, answeredEarlier, logged, updatePreviews, answerUpdate } = await setUp();

    await answeredEarlier(9, asked);

    answerUpdate({
      status: "done",
      environment: GLOBAL_TARGET,
      results: [
        {
          name: "grill-me",
          outcome: "unchanged",
          message: "it already has these files from that commit",
        },
      ],
      handed: false,
    });

    const { text: said } = await call("environment_skill_update", args, { approve: true, task: 9 });

    expect(said).toContain("The user approved, and the Skills grill-me were updated already");
    expect(logged).toEqual([]);
    expect(updatePreviews).toEqual([]);
  });

  it("asks nothing and says why when the Registry refuses a preview of too many Skills", async () => {
    const { call, answerUpdatePreview, updates } = await setUp();

    answerUpdatePreview({
      status: "refused",
      message:
        "11 Skills would be updated, and one request for the user's Approval shows at most 10",
    });

    const {
      result,
      text: said,
      shown,
    } = await call("environment_skill_update", { id: "*", reason: "Keep current" });

    expect(shown).toEqual([]);
    expect(result.isError).toBe(true);
    expect(said).toContain("shows at most 10");
    expect(updates).toEqual([]);
  });

  it("asks nothing when none is marked update available", async () => {
    const { call, answerUpdatePreview } = await setUp();

    answerUpdatePreview({ status: "nothing", environment: GLOBAL_TARGET });

    const { shown, text: said } = await call("environment_skill_update", {
      id: "*",
      reason: "Keep current",
    });

    expect(shown).toEqual([]);
    expect(said).toContain("is marked update available");
  });
});

describe("environment_get marks", () => {
  it("says a Skill is modified since it was installed, and that an update is available", () => {
    const shown = describeEnvironment(
      {
        id: "default",
        name: "Default",
        repos: [],
        build: { status: "none" },
        settings: DEFAULT_CONTAINER_SETTINGS,
        overrides: {},
        global: DEFAULT_CONTAINER_SETTINGS,
        secrets: [],
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
            modified: true,
            updateAvailable: true,
          },
          {
            name: "tdd",
            description: "Tests first.",
            savedAt: 0,
            source: {
              repo: "mattpocock/skills",
              path: "skills/tdd",
              ref: null,
              commit: GRILL_COMMIT,
            },
            modified: false,
            updateAvailable: false,
          },
        ],
        globalSkills: [],
      },
      true,
    );

    expect(shown).toContain(
      "at c0ffee0, modified since installed, update available): Interview me.",
    );
    expect(shown).toContain("skills/tdd at c0ffee0): Tests first.");
    expect(shown).toContain("environment_skill_update");
  });
});

describe("the Skill tools from a program", () => {
  const decodeSave = Schema.decodeUnknownSync(SkillSaveOutput);
  const decodeRemove = Schema.decodeUnknownSync(SkillRemoveOutput);
  const decodeInstall = Schema.decodeUnknownSync(SkillInstallOutput);
  const decodeUpdate = Schema.decodeUnknownSync(SkillUpdateOutput);

  const reason = "To check";
  const FOLDER = "/workspace/.cloudpid/tmp/release";
  const OTHER = "/workspace/.cloudpid/tmp/other";

  const files = () =>
    fakeFolderEnv({
      [`${FOLDER}/SKILL.md`]: SKILL_MD,
      [`${FOLDER}/references/steps.md`]: "1. Tag.\n",
      [`${OTHER}/SKILL.md`]: "---\nname: other\ndescription: Another.\n---\nDo it.\n",
    });

  const FROM = {
    repo: "mattpocock/skills",
    path: "skills/grill-me",
    ref: null,
    commit: GRILL_COMMIT,
  };

  const TO = { ...FROM, commit: "dec0de0000000000000000000000000000000002" };

  it("gets the outcome of an install: the Skills installed, refused and kept, or the Skills listed when none was named", async () => {
    const { extension, answerInstall } = await setUp();

    answerInstall({
      status: "installed",
      environment: DEFAULT,
      repo: "mattpocock/skills",
      ref: "main",
      commit: GRILL_COMMIT,
      results: [
        {
          name: "grill-me",
          path: "skills/grill-me",
          outcome: "installed",
          change: installChange(7, "grill-me"),
        },
        { name: "tdd", path: "skills/tdd", outcome: "unchanged" },
        { name: "bad", path: "skills/bad", outcome: "rejected", message: "SKILL.md is missing" },
      ],
      handed: true,
    });

    const [installed] = await runProgram(
      [extension],
      [
        [
          "environment_skill_install",
          { id: "default", source: "mattpocock/skills", skills: ["*"], reason },
        ],
      ],
    );

    expect(installed?.isError).toBe(false);
    expect(installed?.diagnostics).toEqual([]);

    expect(decodeInstall(installed?.structuredOutput)).toMatchObject({
      scope: DEFAULT,
      changes: [{ id: 7, field: "skills.grill-me" }],
      unchanged: ["skills.tdd"],
      approval: null,
      changed: true,
      source: { repo: "mattpocock/skills", ref: "main", commit: GRILL_COMMIT },
      installed: [{ name: "grill-me", path: "skills/grill-me" }],
      refused: [{ name: "bad", path: "skills/bad", message: "SKILL.md is missing" }],
      listed: [],
      handed: true,
    });

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

    const [listed] = await runProgram(
      [extension],
      [["environment_skill_install", { id: "default", source: "mattpocock/skills", reason }]],
    );

    expect(decodeInstall(listed?.structuredOutput)).toMatchObject({
      changes: [],
      changed: false,
      installed: [],
      listed: [
        { name: "grill-me", description: "Interview me", path: "skills/grill-me" },
        { name: "tdd", description: "Test first", path: "skills/tdd" },
      ],
      listed_truncated: false,
      handed: false,
    });
  });

  it("gets the owner's Approval of a change kept Global: approved, or declined with the reason", async () => {
    const {
      extension,
      approvals,
      answerPreview,
      answerInstall,
      answerUpdate,
      answerUpdatePreview,
    } = await setUp();

    const pending = () => Effect.runPromise(approvals.pending);

    const answer = (id: string, given: { approve: boolean; reason?: string }) =>
      Effect.runPromise(approvals.answer(id, given));

    // A save and a removal at Global, each approved and declined.
    const saves: ReadonlyArray<readonly [string, JsonObject]> = [
      ["environment_skill_save", { id: "*", path: FOLDER, reason }],
      ["environment_skill_save", { id: "*", path: OTHER, reason }],
      ["environment_skill_remove", { id: "*", name: "release", reason }],
      ["environment_skill_remove", { id: "*", name: "release", reason }],
    ];

    const called = await runProgram([extension], saves, {
      env: files(),
      meanwhile: () =>
        answerRequests(pending, answer, [
          { approve: true },
          { approve: false, reason: "Too broad" },
          { approve: false },
          { approve: true },
        ]),
    });

    expect(called.map((each) => each.isError)).toEqual([false, false, false, false]);
    expect(called.map((each) => each.diagnostics)).toEqual(saves.map(() => []));

    const [saved, declinedSave, declinedRemove, removed] = called.map(
      (each) => each.structuredOutput,
    );

    expect(decodeSave(saved)).toMatchObject({
      scope: GLOBAL_SCOPE,
      changes: [{ field: "skills.release" }],
      changed: true,
      approval: { approved: true, reason: null },
      handed: true,
    });

    expect(decodeSave(declinedSave)).toMatchObject({
      scope: GLOBAL_SCOPE,
      changes: [],
      unchanged: [],
      changed: false,
      skill: "other",
      approval: { approved: false, reason: "Too broad" },
      served_at: null,
    });

    expect(decodeRemove(declinedRemove)).toMatchObject({
      changes: [],
      changed: false,
      approval: { approved: false, reason: null },
    });

    expect(decodeRemove(removed)).toMatchObject({
      scope: GLOBAL_SCOPE,
      changes: [{ field: "skills.release", after: null }],
      changed: true,
      approval: { approved: true, reason: null },
    });

    // An install at Global, approved and declined.
    answerPreview(previewOf([previewedSkill("grill-me")]));
    answerInstall(installedAtGlobal(["grill-me"]));

    const installs = await runProgram(
      [extension],
      [
        ["environment_skill_install", INSTALL_ARGS],
        ["environment_skill_install", INSTALL_ARGS],
      ],
      {
        meanwhile: () =>
          answerRequests(pending, answer, [{ approve: true }, { approve: false, reason: "No" }]),
      },
    );

    expect(installs.map((each) => each.isError)).toEqual([false, false]);

    expect(decodeInstall(installs[0]?.structuredOutput)).toMatchObject({
      scope: GLOBAL_SCOPE,
      changes: [{ field: "skills.grill-me" }],
      changed: true,
      approval: { approved: true, reason: null },
      installed: [{ name: "grill-me", path: "skills/grill-me" }],
    });

    expect(decodeInstall(installs[1]?.structuredOutput)).toMatchObject({
      scope: GLOBAL_SCOPE,
      changes: [],
      changed: false,
      approval: { approved: false, reason: "No" },
      installed: [],
    });

    // An update at Global, approved and declined.
    answerUpdatePreview({
      status: "done",
      environment: GLOBAL_SCOPE,
      results: [
        {
          name: "grill-me",
          outcome: "ready",
          from: FROM,
          to: TO,
          description: "Interview me.",
          files: GRILL_FILES,
          folderHash: "folder-hash-1",
          savedAt: 1_234,
          overwrites: false,
          current: { description: "Interview me.", files: ["SKILL.md"] },
        },
      ],
    });

    answerUpdate({
      status: "done",
      environment: GLOBAL_SCOPE,
      results: [
        {
          name: "grill-me",
          outcome: "updated",
          from: FROM,
          to: TO,
          overwrote: false,
          change: installChange(3, "grill-me"),
        },
      ],
      handed: false,
    });

    const updates = await runProgram(
      [extension],
      [
        ["environment_skill_update", { id: "*", names: ["grill-me"], reason }],
        ["environment_skill_update", { id: "*", names: ["grill-me"], reason }],
      ],
      {
        meanwhile: () =>
          answerRequests(pending, answer, [{ approve: true }, { approve: false, reason: "Later" }]),
      },
    );

    expect(updates.map((each) => each.isError)).toEqual([false, false]);

    expect(decodeUpdate(updates[0]?.structuredOutput)).toMatchObject({
      scope: GLOBAL_SCOPE,
      changed: true,
      approval: { approved: true, reason: null },
      updated: [{ name: "grill-me", to: TO }],
    });

    expect(decodeUpdate(updates[1]?.structuredOutput)).toMatchObject({
      changes: [],
      changed: false,
      approval: { approved: false, reason: "Later" },
      updated: [],
    });
  });

  it("cuts what does not fit: the Skills listed, installed and updated, and a change's large value, saying so, without failing", async () => {
    const { extension, answerInstall, answerUpdate } = await setUp();
    const many = Arr.makeBy(2_000, (at) => `skill-${at}`);

    answerInstall({
      status: "listed",
      environment: DEFAULT,
      repo: "mattpocock/skills",
      ref: null,
      commit: GRILL_COMMIT,
      available: Arr.map(many, (name) => ({
        name,
        description: "d".repeat(200),
        path: `skills/${name}`,
      })),
    });

    const [listed] = await runSized(
      [extension],
      [["environment_skill_install", { id: "default", source: "mattpocock/skills", reason }]],
    );

    expect(listed?.isError).toBe(false);
    expect(listed?.truncated["listed_truncated"]).toBe(true);
    expect(listed?.lengths["listed"]).toBeGreaterThan(0);
    expect(listed?.lengths["listed"]).toBeLessThan(2_000);
    expect(listed?.bytes).toBeLessThan(1.5 * 1024 * 1024);

    answerInstall({
      status: "installed",
      environment: DEFAULT,
      repo: "mattpocock/skills",
      ref: null,
      commit: GRILL_COMMIT,
      results: Arr.map(many, (name, at) => ({
        name,
        path: `skills/${name}`,
        outcome: "installed" as const,
        change: installChange(100 + at, name),
        overriddenIn: Arr.makeBy(2, (index) => ({
          id: `env-${index}`,
          name: `Environment ${index}`,
        })),
      })),
      handed: true,
    });

    const [installed] = await runSized(
      [extension],
      [
        [
          "environment_skill_install",
          { id: "default", source: "mattpocock/skills", skills: ["*"], reason },
        ],
      ],
    );

    expect(installed?.isError).toBe(false);
    expect(installed?.truncated["changes_truncated"]).toBe(true);
    expect(installed?.lengths["changes"]).toBeLessThan(2_000);
    expect(installed?.lengths["installed"]).toBe(2_000);
    expect(installed?.truncated["installed_truncated"]).toBe(false);
    expect(installed?.lengths["overridden_in"]).toBe(2);
    expect(installed?.bytes).toBeLessThan(1.5 * 1024 * 1024);

    answerUpdate({
      status: "done",
      environment: DEFAULT,
      results: Arr.map(many, (name, at) => ({
        name,
        outcome: "updated" as const,
        from: FROM,
        to: TO,
        overwrote: false,
        change: installChange(5_000 + at, name),
      })),
      handed: true,
    });

    const [updated] = await runSized(
      [extension],
      [["environment_skill_update", { id: "default", reason }]],
    );

    expect(updated?.isError).toBe(false);
    expect(updated?.truncated["changes_truncated"]).toBe(true);
    expect(updated?.bytes).toBeLessThan(1.5 * 1024 * 1024);

    // A Skill of files so large that the change recording them cannot be shown whole: its value is left out.
    const big = fakeFolderEnv({
      [`${FOLDER}/SKILL.md`]: SKILL_MD,
      [`${FOLDER}/references/big.md`]: "x".repeat(200 * 1024),
    });

    const [saved] = await runProgram(
      [extension],
      [["environment_skill_save", { id: "default", path: FOLDER, reason }]],
      { env: big },
    );

    expect(saved?.isError).toBe(false);

    expect(decodeSave(saved?.structuredOutput)).toMatchObject({
      changed: true,
      changes: [{ before: null, before_truncated: false, after: null, after_truncated: true }],
      changes_truncated: false,
    });
  });
});

describe("the Skill cores on the endpoint", () => {
  /** The cores over fake Skills as the endpoint runs them: no Session, and a check that knows no Session's Secrets. */
  const endpointCores = async () => {
    const skills = fakeSkills();

    const holdsSecret = await Effect.runPromise(
      endpointTextCheck.pipe(Effect.provideService(DeployCredentials, { values: [GITHUB_TOKEN] })),
    );

    return {
      cores: skillCores({
        environments: { ...skills.service, current: Effect.succeed(null) },
        holdsSecret,
      }),
      ...skills,
    };
  };

  const source = {
    repo: "mattpocock/skills",
    path: "skills/grill-me",
    ref: null,
    commit: GRILL_COMMIT,
  };

  const moved = {
    name: "grill-me",
    outcome: "updated" as const,
    from: source,
    to: { ...source, commit: "d".repeat(40) },
    overwrote: false,
    change: installChange(9, "grill-me"),
  };

  const decodeInstall = Schema.decodeUnknownSync(
    HARNESS_TOOLS.environment_skill_install.endpoint.output,
  );

  it("reads each Skill of an install, so one whose Skills were all refused is an answer that kept nothing", async () => {
    const { cores, answerInstall } = await endpointCores();

    answerInstall({
      status: "installed",
      environment: DEFAULT,
      repo: "o/skills",
      ref: null,
      commit: GRILL_COMMIT,
      results: [{ name: "c", path: "skills/c", outcome: "rejected", message: "a binary file" }],
      handed: false,
    });

    const answer = await Effect.runPromise(
      cores.environment_skill_install(
        { id: "default", source: "o/skills", skills: ["c"], reason: "r" },
        "endpoint",
      ),
    );

    expect(decodeInstall(answer.structured)).toMatchObject({
      changed: false,
      changes: [],
      installed: [],
      refused: [{ name: "c", message: "a binary file" }],
    });
    expect(answer.text).toContain("Installed nothing");
    expect(answer.logged).toBeUndefined();
  });

  it("answers an install's Skills one by one: installed, unchanged and refused, with the ones the repo lists", async () => {
    const { cores, answerInstall } = await endpointCores();

    answerInstall({
      status: "installed",
      environment: DEFAULT,
      repo: "mattpocock/skills",
      ref: "v2",
      commit: GRILL_COMMIT,
      results: [
        { name: "a", path: "skills/a", outcome: "installed", change: installChange(1, "a") },
        { name: "b", path: "skills/b", outcome: "unchanged" },
        { name: "c", path: "skills/c", outcome: "rejected", message: "a binary file" },
      ],
      handed: true,
    });

    const answer = await Effect.runPromise(
      cores.environment_skill_install(
        { id: "default", source: "mattpocock/skills", skills: ["*"], reason: "r" },
        "endpoint",
      ),
    );

    const output = decodeInstall(answer.structured);

    expect(output).toMatchObject({
      changed: true,
      source: { repo: "mattpocock/skills", ref: "v2", commit: GRILL_COMMIT },
      installed: [{ name: "a", path: "skills/a" }],
      unchanged: ["skills.b"],
      refused: [{ name: "c" }],
    });
    // Nothing is a Session's: no Workspace was handed the change, and no Approval was asked.
    expect(output).not.toHaveProperty("handed");
    expect(output).not.toHaveProperty("approval");
    expect(answer.logged).toMatchObject({ tool: "environment_skill_install", field: "skills.a" });
    expectEndpointWords(answer.text);
  });

  it("answers an update with what moved and what was refused", async () => {
    const { cores, answerUpdate } = await endpointCores();

    answerUpdate({
      status: "done",
      environment: DEFAULT,
      results: [moved, { name: "tdd", outcome: "modified", message: "edited since installed" }],
      handed: true,
    });

    const updated = await Effect.runPromise(
      cores.environment_skill_update({ id: "default", reason: "r" }, "endpoint"),
    );

    expect(
      Schema.decodeUnknownSync(HARNESS_TOOLS.environment_skill_update.endpoint.output)(
        updated.structured,
      ),
    ).toMatchObject({
      changed: true,
      updated: [{ name: "grill-me", to: { commit: "d".repeat(40) }, overwrote: false }],
      refused: [{ name: "tdd", outcome: "modified" }],
    });
    expectEndpointWords(updated.text);
  });

  it("answers a removal with the Skill's name", async () => {
    const { cores, keep } = await endpointCores();

    keep("default", "pr", { "SKILL.md": "x" });

    const removed = await Effect.runPromise(
      cores.environment_skill_remove({ id: "default", name: "pr", reason: "r" }, "endpoint"),
    );

    expect(
      Schema.decodeUnknownSync(HARNESS_TOOLS.environment_skill_remove.endpoint.output)(
        removed.structured,
      ),
    ).toMatchObject({ changed: true, skill: "pr", global_served: false });
  });

  it.each([
    [
      "a Skill that is not kept",
      "environment_skill_remove",
      { id: "default", name: "pr", reason: "r" },
      "not_found",
    ],
    [
      "an Environment that is not there",
      "environment_skill_remove",
      { id: "0000beef", name: "pr", reason: "r" },
      "not_found",
    ],
    [
      "a source holding a GitHub token",
      "environment_skill_install",
      { id: "default", source: GITHUB_TOKEN, reason: "r" },
      "invalid_argument",
    ],
    ["a Global id", "environment_skill_update", { id: "*", reason: "r" }, "invalid_argument"],
    [
      "a source the Registry refuses",
      "environment_skill_install",
      { id: "default", source: "o/skills", reason: "r" },
      "invalid_argument",
    ],
  ] as const)("refuses %s as %s", async (_, name, args, code) => {
    const { cores } = await endpointCores();

    // SAFETY: each row's arguments are its tool's.
    const refused = await Effect.runPromise(
      cores[name](args as never, "endpoint").pipe(Effect.flip),
    );

    expect(refused.code).toBe(code);
    expectEndpointWords(refused.message);
  });

  describe("replayed", () => {
    const installed = (name: string, at: number) => ({
      id: at,
      scope: "default",
      scopeName: "Default",
      field: skillField(name),
      before: null,
      after: { files: { "SKILL.md": "h" }, source: { ...source, path: `skills/${name}` } },
    });

    it("gives one result per change of an install, from the Skill source each holds", () => {
      const answer = SKILL_REPLAYED.environment_skill_install(
        [installed("a", 1), installed("b", 2)],
        "default",
      );

      expect(decodeInstall(answer.structured)).toMatchObject({
        source: { repo: "mattpocock/skills", commit: GRILL_COMMIT },
        installed: [
          { name: "a", path: "skills/a" },
          { name: "b", path: "skills/b" },
        ],
        changes: [{ id: 1 }, { id: 2 }],
        replayed: true,
      });
    });

    it("gives one result per Skill an update moved, and the removed Skill's name", () => {
      const update = SKILL_REPLAYED.environment_skill_update(
        [
          {
            ...installed("a", 3),
            before: { files: {}, source },
            after: { files: {}, source: { ...source, commit: "d".repeat(40) } },
          },
        ],
        "default",
      );

      expect(
        Schema.decodeUnknownSync(HARNESS_TOOLS.environment_skill_update.endpoint.output)(
          update.structured,
        ),
      ).toMatchObject({ updated: [{ name: "a", to: { commit: "d".repeat(40) } }], replayed: true });

      const removed = SKILL_REPLAYED.environment_skill_remove(
        [{ ...installed("a", 4), before: { files: {} }, after: null }],
        "default",
      );

      expect(
        Schema.decodeUnknownSync(HARNESS_TOOLS.environment_skill_remove.endpoint.output)(
          removed.structured,
        ),
      ).toMatchObject({ skill: "a", changed: true, replayed: true });
    });
  });
});

// #693 S3b-3: a change to the Skills kept Global over the endpoint waits for the owner's Approval, which the Registry keeps.
// These are the cores' parts the ask and the approved apply run (`apps/server/src/harness/approval-tools.ts`).
describe("the Skill cores at Global, on the endpoint", () => {
  const NEW_COMMIT = "dec0de0000000000000000000000000000000002";
  /** What `prepare` knows of Global, as a core reads it back. */
  const GLOBAL_KNOWN = { id: "*", name: "Global" } as const;

  const author = {
    tool: "environment_skill_install",
    reason: "Every project should grill the plan",
  };

  /** The cores over fake Skills as the endpoint runs them: no Session, and a check that knows no Session's Secrets. */
  const globalCores = async () => {
    const skills = fakeSkills();

    const holdsSecret = await Effect.runPromise(
      endpointTextCheck.pipe(Effect.provideService(DeployCredentials, { values: [GITHUB_TOKEN] })),
    );

    return {
      cores: globalSkillCores({
        environments: {
          ...skills.service,
          global: Effect.sync(() => ({
            settings: DEFAULT_CONTAINER_SETTINGS,
            overriddenIn: {},
            secrets: [],
            skills: skills.listed("*"),
          })),
        },
        holdsSecret,
      }),
      ...skills,
    };
  };

  const decodeInstall = Schema.decodeUnknownSync(
    HARNESS_TOOLS.environment_skill_install.endpoint.output,
  );

  const decodeUpdate = Schema.decodeUnknownSync(
    HARNESS_TOOLS.environment_skill_update.endpoint.output,
  );

  const ARGS = {
    id: "*",
    source: "mattpocock/skills",
    skills: ["grill-me", "tdd"],
    reason: author.reason,
  };

  /** The pin of an install of `names` as the preview showed them. */
  const pinOf = (names: ReadonlyArray<string>) => ({
    commit: GRILL_COMMIT,
    skills: Arr.map(names, (name) => ({
      name,
      path: `skills/${name}`,
      digest: `digest-of-${name}`,
      savedAt: null,
    })),
  });

  /** A change an earlier run of the same approved request recorded under its claim, for Skill `name`. */
  const earlierChange = (id: number, name: string): AgentChange => ({
    ...installChange(id, name),
    scope: "*",
    session: null,
    conversation: null,
  });

  describe("an install", () => {
    it("asks with each Skill's files on the card and keeps only the pin as expected, telling the caller what it left out", async () => {
      const { cores, answerPreview, previews } = await globalCores();

      answerPreview(
        previewOf(
          [previewedSkill("grill-me"), { ...previewedSkill("tdd"), unchanged: true }],
          [{ name: "pr", path: "skills/pr", message: "the user's key is in it" }],
        ),
      );

      const prepared = await Effect.runPromise(cores.environment_skill_install.prepare(ARGS));

      expect(previews).toEqual([
        { environment: "*", source: "mattpocock/skills", skills: ["grill-me", "tdd"] },
      ]);
      expect(prepared.card).toMatchObject({
        tool: "environment_skill_install",
        target: "Global",
        change: 'Install the Skill "grill-me" from mattpocock/skills at c0ffee0',
        before: "grill-me: not kept Global",
        reason: author.reason,
      });
      expect(prepared.card.after).toContain("Ask one question at a time.");
      // The pin only: never a file's text (#685 L6).
      expect(prepared.expected).toEqual(pinOf(["grill-me"]));
      expect(JSON.stringify(prepared.expected)).not.toContain("Ask one question");
      expect(prepared.unchanged).toBeUndefined();
      // The note names each Skill the request leaves out; the Registry's reason is told in the owner's words (the contract:
      // the owner, never the user).
      expect(prepared.note).toContain("tdd");
      expect(prepared.note).toContain("- pr (skills/pr): the owner's key is in it");
      expectEndpointWords(prepared.note ?? "");
    });

    it.each([
      [
        "more Skills than one request shows",
        {
          status: "refused" as const,
          message: "o/skills holds 11 Skills, more than the 10 one request may take",
        },
      ],
      [
        "more files than one request holds",
        {
          status: "refused" as const,
          message:
            "These Skills are 9000000 bytes together, more than the 8388608 a Skill set may hold",
        },
      ],
      [
        "Skills the checks all refuse",
        previewOf([], [{ name: "pr", path: "skills/pr", message: "a binary file" }]),
      ],
    ])("refuses %s, asking nothing", async (_, preview) => {
      const { cores, answerPreview } = await globalCores();

      answerPreview(preview);

      const refused = await Effect.runPromise(
        cores.environment_skill_install.prepare(ARGS).pipe(Effect.flip),
      );

      expect(refused.code).toBe("invalid_argument");
      expectEndpointWords(refused.message);
    });

    it("refuses a repo that holds several Skills, none named, listing each with its description as the repo writes it", async () => {
      const { cores, answerPreview } = await globalCores();
      // A repo's text: quoted as it is, never reworded as cloudpid's own sentences are.
      const description = "Helps the user write the test first.";

      answerPreview({
        status: "listed",
        environment: GLOBAL_SCOPE,
        repo: "mattpocock/skills",
        ref: null,
        commit: GRILL_COMMIT,
        available: [{ name: "tdd", description, path: "skills/tdd" }],
      });

      const refused = await Effect.runPromise(
        cores.environment_skill_install.prepare(ARGS).pipe(Effect.flip),
      );

      expect(refused.code).toBe("invalid_argument");
      expect(refused.message).toContain(description);
    });

    const WITH_TOKEN = `use ${GITHUB_TOKEN}`;

    it.each<[string, (cores: GlobalSkillCores) => Effect.Effect<object, EnvironmentsError>]>([
      [
        "environment_skill_install",
        (cores) => cores.environment_skill_install.prepare({ ...ARGS, reason: WITH_TOKEN }),
      ],
      [
        "environment_skill_update",
        (cores) =>
          cores.environment_skill_update.prepare({
            id: "*",
            names: ["grill-me"],
            reason: WITH_TOKEN,
          }),
      ],
      [
        "environment_skill_remove",
        (cores) =>
          cores.environment_skill_remove.prepare({ id: "*", name: "grill-me", reason: WITH_TOKEN }),
      ],
    ])("refuses %s with a credential in the reason, reading nothing", async (_, prepare) => {
      const { cores, previews, updatePreviews, keep } = await globalCores();

      keep("*", "grill-me", GRILL_FILES);

      const refused = await Effect.runPromise(prepare(cores).pipe(Effect.flip));

      expect(refused.code).toBe("invalid_argument");
      expect(previews).toEqual([]);
      expect(updatePreviews).toEqual([]);
    });

    it("answers unchanged, asking nothing, when Global keeps every Skill so already", async () => {
      const { cores, answerPreview } = await globalCores();

      answerPreview(previewOf([{ ...previewedSkill("grill-me"), unchanged: true }]));

      const prepared = await Effect.runPromise(cores.environment_skill_install.prepare(ARGS));

      expect(prepared.expected).toBeNull();
      expect(decodeInstall(prepared.unchanged?.structured)).toMatchObject({
        scope: GLOBAL_SCOPE,
        unchanged: ["skills.grill-me"],
        changed: false,
      });
    });

    it("installs on Approve against the pin, as approved, keeping each Skill only while its pin holds and naming each it skipped", async () => {
      const { cores, answerInstall, installs } = await globalCores();
      const core = cores.environment_skill_install;
      const installed = installedAtGlobal(["grill-me"]);

      answerInstall({
        ...installed,
        results: [
          ...installed.results,
          {
            name: "tdd",
            path: "skills/tdd",
            outcome: "rejected",
            message:
              "the Skill of the name was saved again since the user was asked: nothing was installed. Ask again",
          },
        ],
      });

      const applied = await Effect.runPromise(core.apply(ARGS, pinOf(["grill-me", "tdd"]), author));

      expect(installs).toEqual([
        {
          environment: "*",
          source: "mattpocock/skills",
          skills: ["grill-me", "tdd"],
          reason: author.reason,
          approved: true,
          pin: pinOf(["grill-me", "tdd"]),
        },
      ]);
      expect(core.outcome(applied.result, [])).toBe("wrote");

      const answer = await Effect.runPromise(core.render(ARGS, null, applied, { earlier: [] }));

      // The Registry's reason a Skill was skipped is told in the owner's words (the contract: the owner, never the user).
      expect(answer.text).toContain(
        "- tdd (skills/tdd): the Skill of the name was saved again since the owner was asked",
      );
      expectEndpointWords(answer.text);
      expect(decodeInstall(answer.structured)).toMatchObject({
        scope: GLOBAL_SCOPE,
        changed: true,
        installed: [{ name: "grill-me" }],
        refused: [{ name: "tdd" }],
        changes: [{ field: "skills.grill-me" }],
      });
    });

    it("ends changed_since, naming each Skill, when none is still as the owner was shown it", async () => {
      const { cores, answerInstall } = await globalCores();
      const core = cores.environment_skill_install;

      answerInstall({
        ...installedAtGlobal([]),
        results: [
          {
            name: "grill-me",
            path: "skills/grill-me",
            outcome: "rejected",
            message: "its files are not the ones the user was shown",
          },
        ],
      });

      const applied = await Effect.runPromise(core.apply(ARGS, pinOf(["grill-me"]), author));

      expect(core.outcome(applied.result, [])).toBe("changed_since");

      const refused = await Effect.runPromise(
        core.render(ARGS, null, applied, { earlier: [] }).pipe(Effect.flip),
      );

      expect(refused.code).toBe("invalid_argument");
      expect(refused.message).toContain("grill-me");
      expectEndpointWords(refused.message);
    });

    it("ends changed_since when the repo lists Skills to choose from at the pinned commit, so it holds none it showed", async () => {
      const { cores, answerInstall } = await globalCores();
      const core = cores.environment_skill_install;

      answerInstall({
        status: "listed",
        environment: GLOBAL_SCOPE,
        repo: "mattpocock/skills",
        ref: null,
        commit: GRILL_COMMIT,
        available: [{ name: "tdd", description: "Test first.", path: "skills/tdd" }],
      });

      const applied = await Effect.runPromise(core.apply(ARGS, pinOf(["grill-me"]), author));

      expect(core.outcome(applied.result, [])).toBe("changed_since");

      const refused = await Effect.runPromise(
        core.render(ARGS, null, applied, { earlier: [] }).pipe(Effect.flip),
      );

      expect(refused.code).toBe("invalid_argument");
      expectEndpointWords(refused.message);
    });

    it("refuses a request kept with no pin, installing nothing", async () => {
      const { cores, installs } = await globalCores();

      const refused = await Effect.runPromise(
        cores.environment_skill_install.apply(ARGS, null, author).pipe(Effect.flip),
      );

      expect(refused.code).toBe("invalid_argument");
      expect(installs).toEqual([]);
    });

    // #685 L18: an approved install cut after some Skills committed is applied again under the same attempt.
    it("tells the Skills an earlier run of the request kept as installed, with their changes, when the rerun finds them kept", async () => {
      const { cores, answerInstall } = await globalCores();
      const core = cores.environment_skill_install;
      const installed = installedAtGlobal(["tdd"]);

      answerInstall({
        ...installed,
        results: [
          { name: "grill-me", path: "skills/grill-me", outcome: "unchanged" },
          ...installed.results,
        ],
      });

      const applied = await Effect.runPromise(core.apply(ARGS, pinOf(["grill-me", "tdd"]), author));
      const earlier = [earlierChange(7, "grill-me")];

      expect(core.outcome(applied.result, earlier)).toBe("wrote");

      const answer = await Effect.runPromise(core.render(ARGS, null, applied, { earlier }));

      expect(decodeInstall(answer.structured)).toMatchObject({
        installed: [{ name: "grill-me" }, { name: "tdd" }],
        unchanged: [],
        changes: [{ id: 7 }, { id: 20 }],
      });

      // A rerun that finds every Skill kept, all by the earlier run, still settles the claim with them.
      answerInstall({
        ...installedAtGlobal([]),
        results: [{ name: "grill-me", path: "skills/grill-me", outcome: "unchanged" }],
      });

      const again = await Effect.runPromise(core.apply(ARGS, pinOf(["grill-me"]), author));

      expect(core.outcome(again.result, earlier)).toBe("wrote");
      expect(core.outcome(again.result, [])).toBe("found");
    });
  });

  describe("an update", () => {
    const from = {
      repo: "mattpocock/skills",
      path: "skills/grill-me",
      ref: null,
      commit: GRILL_COMMIT,
    };

    const to = { ...from, commit: NEW_COMMIT };

    const UPDATE = {
      id: "*",
      names: ["grill-me", "tdd"],
      reason: "The owner wants the latest grill-me",
    };

    const PIN = {
      name: "grill-me",
      savedAt: 1_234,
      commit: NEW_COMMIT,
      folderHash: "folder-hash-1",
    };

    const ready = {
      name: "grill-me",
      outcome: "ready" as const,
      from,
      to,
      description: "Interview me.",
      files: GRILL_FILES,
      folderHash: "folder-hash-1",
      savedAt: 1_234,
      overwrites: false,
      current: { description: "Interview me.", files: ["SKILL.md"] },
    };

    it("asks with the files each Skill would take and keeps only the pins as expected, naming the Skills left out", async () => {
      const { cores, answerUpdatePreview, updatePreviews } = await globalCores();

      answerUpdatePreview({
        status: "done",
        environment: GLOBAL_SCOPE,
        results: [
          ready,
          { name: "tdd", outcome: "modified", message: "it was edited since it was installed" },
        ],
      });

      const prepared = await Effect.runPromise(cores.environment_skill_update.prepare(UPDATE));

      expect(updatePreviews).toEqual([
        { environment: "*", names: ["grill-me", "tdd"], overwrite: false },
      ]);
      expect(prepared.card.change).toBe(
        'Update the Skill "grill-me" to their refs\' latest commits',
      );
      expect(prepared.card.after).toContain("Not part of this update:\n- tdd (modified)");
      expect(prepared.card.after).toContain("Ask one question at a time.");
      expect(prepared.expected).toEqual({ pins: [PIN] });
      expect(prepared.note).toContain("tdd");
      expectEndpointWords(prepared.note ?? "");
    });

    it("marks on the card a Skill whose edits the update replaces, and keeps overwrite for the apply", async () => {
      const { cores, answerUpdatePreview, updatePreviews } = await globalCores();

      answerUpdatePreview({
        status: "done",
        environment: GLOBAL_SCOPE,
        results: [{ ...ready, overwrites: true }],
      });

      const prepared = await Effect.runPromise(
        cores.environment_skill_update.prepare({ ...UPDATE, overwrite: true }),
      );

      expect(updatePreviews).toEqual([
        { environment: "*", names: ["grill-me", "tdd"], overwrite: true },
      ]);
      // The card's warning is what the owner approves the edits away by.
      expect(prepared.card.before).toContain("(edited since installed)");
      expect(prepared.card.after).toContain("EDITED since it was installed");
    });

    it("refuses a preview of more Skills than one request shows, and answers unchanged when nothing would move", async () => {
      const { cores, answerUpdatePreview } = await globalCores();

      answerUpdatePreview({
        status: "refused",
        message:
          "11 Skills would be updated, and one request for the user's Approval shows at most 10",
      });

      const refused = await Effect.runPromise(
        cores.environment_skill_update.prepare(UPDATE).pipe(Effect.flip),
      );

      expect(refused.code).toBe("invalid_argument");
      expectEndpointWords(refused.message);

      answerUpdatePreview({
        status: "done",
        environment: GLOBAL_SCOPE,
        results: [{ name: "grill-me", outcome: "unchanged", message: "its folder is the same" }],
      });

      const prepared = await Effect.runPromise(cores.environment_skill_update.prepare(UPDATE));

      expect(decodeUpdate(prepared.unchanged?.structured)).toMatchObject({
        unchanged: ["skills.grill-me"],
        changed: false,
      });
    });

    it("updates on Approve at the pinned commits, telling a Skill an earlier run moved as updated, and names each skipped", async () => {
      const { cores, answerUpdate, updates } = await globalCores();
      const core = cores.environment_skill_update;

      answerUpdate({
        status: "done",
        environment: GLOBAL_SCOPE,
        results: [
          {
            name: "grill-me",
            outcome: "unchanged",
            message: "it is at the commit and files the user approved already",
          },
          {
            name: "tdd",
            outcome: "changed-since",
            message: "it was saved again since the user was asked",
          },
        ],
        handed: false,
      });

      const applied = await Effect.runPromise(
        core.apply(
          UPDATE,
          { pins: [PIN] },
          { tool: "environment_skill_update", reason: UPDATE.reason },
        ),
      );

      expect(updates).toEqual([
        {
          environment: "*",
          names: ["grill-me"],
          overwrite: false,
          pins: [PIN],
          reason: UPDATE.reason,
          approved: true,
        },
      ]);

      const earlier: ReadonlyArray<AgentChange> = [
        {
          ...earlierChange(8, "grill-me"),
          before: { files: { "SKILL.md": "h1" }, source: from },
          after: { files: { "SKILL.md": "h2" }, source: to },
        },
      ];

      expect(core.outcome(applied.result, earlier)).toBe("wrote");
      expect(core.outcome(applied.result, [])).toBe("found");

      const answer = await Effect.runPromise(core.render(UPDATE, null, applied, { earlier }));

      expectEndpointWords(answer.text);
      expect(decodeUpdate(answer.structured)).toMatchObject({
        changed: true,
        updated: [{ name: "grill-me", to: { commit: NEW_COMMIT } }],
        refused: [{ name: "tdd", outcome: "changed-since" }],
        changes: [{ id: 8 }],
      });
    });

    it("refuses an apply the Registry finds nothing to update for, the request's Skills gone", async () => {
      const { cores } = await globalCores();
      const core = cores.environment_skill_update;

      const applied = {
        known: GLOBAL_KNOWN,
        result: { status: "nothing" as const, environment: GLOBAL_KNOWN },
      };

      expect(core.outcome(applied.result, [])).toBe("refused");

      const refused = await Effect.runPromise(
        core.render(UPDATE, null, applied, { earlier: [] }).pipe(Effect.flip),
      );

      expect(refused.code).toBe("invalid_argument");
      expectEndpointWords(refused.message);
    });
  });

  describe("a removal", () => {
    const REMOVE = { id: "*", name: "grill-me", reason: "Nobody grills any more" };

    it("asks against when the Skill was last saved, and refuses one not kept Global, asking nothing", async () => {
      const { cores, keep } = await globalCores();

      const absent = await Effect.runPromise(
        cores.environment_skill_remove.prepare(REMOVE).pipe(Effect.flip),
      );

      expect(absent.code).toBe("not_found");
      expectEndpointWords(absent.message);

      keep("*", "grill-me", GRILL_FILES);

      const prepared = await Effect.runPromise(cores.environment_skill_remove.prepare(REMOVE));

      expect(prepared.card).toMatchObject({
        change: 'Remove the Skill "grill-me"',
        before: "grill-me: Interview me.",
        target: "Global",
      });
      expect(prepared.expected).toEqual({ savedAt: expect.any(Number) });
    });

    it("removes on Approve only while the Skill was last saved as the owner saw it", async () => {
      const { cores, keep, kept } = await globalCores();
      const core = cores.environment_skill_remove;
      const removing = { tool: "environment_skill_remove", reason: REMOVE.reason };

      keep("*", "grill-me", GRILL_FILES);

      const { expected } = await Effect.runPromise(core.prepare(REMOVE));

      // Saved again since the ask: nothing is removed.
      const stale = await Effect.runPromise(core.apply(REMOVE, { savedAt: 1 }, removing));

      expect(core.outcome(stale.result, [])).toBe("changed_since");
      expect(kept.has("*:grill-me")).toBe(true);

      const applied = await Effect.runPromise(core.apply(REMOVE, expected, removing));

      expect(core.outcome(applied.result, [])).toBe("wrote");
      expect(kept.has("*:grill-me")).toBe(false);

      const answer = await Effect.runPromise(
        core.render(REMOVE, expected, applied, { earlier: [] }),
      );

      expectEndpointWords(answer.text);
      expect(
        Schema.decodeUnknownSync(HARNESS_TOOLS.environment_skill_remove.endpoint.output)(
          answer.structured,
        ),
      ).toMatchObject({ scope: GLOBAL_SCOPE, changed: true, skill: "grill-me" });
    });

    const decodeRemove = Schema.decodeUnknownSync(
      HARNESS_TOOLS.environment_skill_remove.endpoint.output,
    );

    it("answers a Skill found gone already as approved, with nothing removed", async () => {
      const { cores } = await globalCores();
      const core = cores.environment_skill_remove;

      const applied = {
        known: GLOBAL_KNOWN,
        result: { status: "absent" as const, environment: GLOBAL_KNOWN },
      };

      expect(core.outcome(applied.result, [])).toBe("found");

      const answer = await Effect.runPromise(core.render(REMOVE, null, applied, { earlier: [] }));

      expectEndpointWords(answer.text);
      expect(decodeRemove(answer.structured)).toMatchObject({
        changed: false,
        unchanged: ["skills.grill-me"],
        skill: "grill-me",
      });
    });

    it.each<[string, SkillRemoved]>([
      [
        "refused",
        { status: "rejected", message: "Removing it would serve a Skill the user cannot fit." },
      ],
      ["changed_since", { status: "changed-since", environment: GLOBAL_KNOWN }],
    ])(
      "ends %s, removing nothing, for a removal the Registry did not make",
      async (end, result) => {
        const { cores } = await globalCores();
        const core = cores.environment_skill_remove;
        const applied = { known: GLOBAL_KNOWN, result };

        expect(core.outcome(result, [])).toBe(end);

        const refused = await Effect.runPromise(
          core.render(REMOVE, null, applied, { earlier: [] }).pipe(Effect.flip),
        );

        expect(refused.code).toBe("invalid_argument");
        expectEndpointWords(refused.message);
      },
    );
  });

  // A Session's request is the one declined to a caller; the endpoint's caller reads the Registry's request. Each core still
  // says what a Decline means, with the owner's reason, in its tool's output.
  const DECLINED = { approved: false, reason: "Not this one", expected: null } as const;

  it.each<[GlobalSkillToolName, (cores: GlobalSkillCores) => HarnessAnswer]>([
    [
      "environment_skill_install",
      (cores) => cores.environment_skill_install.declined(ARGS, GLOBAL_KNOWN, DECLINED),
    ],
    [
      "environment_skill_update",
      (cores) =>
        cores.environment_skill_update.declined(
          { id: "*", names: ["grill-me"], reason: "Latest" },
          GLOBAL_KNOWN,
          DECLINED,
        ),
    ],
    [
      "environment_skill_remove",
      (cores) =>
        cores.environment_skill_remove.declined(
          { id: "*", name: "grill-me", reason: "Unused" },
          GLOBAL_KNOWN,
          DECLINED,
        ),
    ],
  ])("has %s's declined change nothing, giving the owner's reason", async (tool, declined) => {
    const { cores } = await globalCores();
    const answer = declined(cores);

    expect(answer.text).toContain(DECLINED.reason);
    expectEndpointWords(answer.text);
    expect(
      Schema.decodeUnknownSync(HARNESS_TOOLS[tool].endpoint.output)(answer.structured),
    ).toMatchObject({ changed: false, changes: [] });
  });
});
