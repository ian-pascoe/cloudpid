// The `environment` extension's tools for an Environment's own Skills, and those kept for every Environment (docs/spec.md
// → The Environment's own Skills, → Approval): `environment_skill_save` reads a Skill's folder from the Workspace and
// saves it, `environment_skill_remove` removes one, over fake Skills that keep them as the Registry does. With `id: "*"`
// each waits for the owner's Approval.
// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off
import { DEFAULT_CONTAINER_SETTINGS } from "@cloudpid/config";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
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
import type * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vitest";
import { type ApprovalAsk, Approvals, type ApprovalsService, makeApprovals } from "./approvals.ts";
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
    every: Effect.sync(() => ({ variables: {}, secrets: [], skills: skills.listed("*") })),
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

  return { tool, logged, call, answeredEarlier, notified, approvals, ...skills };
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
  it("runs alone, is rerun after an eviction (a change to every Environment waits for the same request), and is the root conversation's only", async () => {
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
        everySkills: [],
      },
      true,
    );

    expect(shown).toContain(
      "Skills (its own, served read-only at /workspace/.agents/skills/<name>",
    );
    expect(shown).toContain("\n  release (saved 1970-01-01T00:00:00.000Z): Cut a release.");
  });
});

const EVERY_ARGS = {
  id: "*",
  path: "/workspace/.cloudpid/tmp/release",
  reason: "Every project cuts releases the same way",
};

const OTHER_MD =
  "---\nname: release\ndescription: Cut a different release.\n---\nPush, then tag.\n";

describe("environment_skill_save for every Environment", () => {
  it("asks the owner on a card showing the Skill, notifies them once, and saves it only on Approve", async () => {
    const { call, saves, logged, notified, kept } = await setUp();

    const { result, text, shown } = await call("environment_skill_save", EVERY_ARGS, {
      approve: true,
      meanwhile: () => {
        // The request waits: nothing is saved yet.
        expect(saves).toEqual([]);
      },
    });

    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({
      tool: "environment_skill_save",
      target: "every Environment",
      change: 'Save the Skill "release"',
      before: "Not kept for every Environment",
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
    expect(text).toContain(
      "The user approved: Saved the new Skill release for every Environment (2 files).",
    );
    expect(text).toContain("served now at /workspace/.agents/skills/release (read-only)");
    expect(text).toContain(
      "Every Environment's Workspaces and spares get it at their next readying",
    );
    expect(text).toContain("This Session's Workspace has the change now");
    expect(result.details).toMatchObject({
      approval: { approved: true },
      agentChange: {
        environment: { id: "*", name: "every Environment" },
        field: "skills.release",
        before: null,
      },
    });
    expect(logged).toEqual([
      {
        tool: "environment_skill_save",
        environmentName: "every Environment",
        field: "skills.release",
      },
    ]);
  });

  it("tells the agent in its description that the user must approve it", async () => {
    const { tool } = await setUp();

    expect(tool("environment_skill_save").description).toContain(
      "the user must approve the change",
    );
    expect(tool("environment_skill_remove").description).toContain("which the user must approve");
  });

  it("saves nothing on Decline, and gives the owner's reason", async () => {
    const { call, saves, kept, logged } = await setUp();

    const { result, text } = await call("environment_skill_save", EVERY_ARGS, {
      approve: false,
      reason: "Not now",
    });

    expect(text).toContain("The user declined: saving the Skill release for every Environment");
    expect(text).toContain("Their reason: Not now");
    expect(result.details).toMatchObject({ approval: { approved: false, reason: "Not now" } });
    expect(saves).toEqual([]);
    expect(kept.size).toBe(0);
    expect(logged).toEqual([]);
  });

  it("shows the Skill kept now when it replaces one, and applies only against it", async () => {
    const { call, keep, saves } = await setUp();

    keep("*", "release", { "SKILL.md": OTHER_MD, "old.md": "Old.\n" });

    const { shown } = await call("environment_skill_save", EVERY_ARGS);

    expect(shown[0]?.before).toBe(
      "Kept for every Environment: Cut a different release. (files: SKILL.md, old.md)",
    );
    expect(saves[0]?.expected?.savedAt).toEqual(expect.any(Number));
  });

  it("applies nothing when the Skill was saved again between the request and the answer", async () => {
    const { call, keep, kept, logged } = await setUp();

    const { result, text } = await call("environment_skill_save", EVERY_ARGS, {
      approve: true,
      meanwhile: () => {
        keep("*", "release", { "SKILL.md": OTHER_MD });
      },
    });

    expect(result.isError).toBe(true);
    expect(text).toContain("was saved again since they were asked: nothing was saved");
    expect(kept.get("*:release")).toEqual({ "SKILL.md": OTHER_MD });
    expect(logged).toEqual([]);
  });

  it("refuses without asking what the Registry refuses, and what holds a Secret or is not a folder", async () => {
    const { call, refuse, notified } = await setUp({ API_KEY: "sk-live-abcdefghijkl" });

    expect(
      (
        await call(
          "environment_skill_save",
          EVERY_ARGS,
          { approve: true },
          scratch({ "/workspace/.cloudpid/tmp/release/notes.md": "Use sk-live-abcdefghijkl." }),
        )
      ).text,
    ).toContain("the file notes.md holds the value of a Secret");

    refuse("SKILL.md's name: too long");

    const { text, result, shown } = await call("environment_skill_save", EVERY_ARGS);

    expect(result.isError).toBe(true);
    expect(text).toContain("Nothing was saved:");
    expect(text).toContain("too long");
    expect(shown).toEqual([]);
    expect(notified).toEqual([]);
  });

  it("asks nothing for the files kept for every Environment already", async () => {
    const { call, keep, notified, saves, logged } = await setUp();

    keep("*", "release", {
      "SKILL.md": SKILL_MD,
      "references/steps.md": "1. Tag.\n",
    });

    const { text } = await call("environment_skill_save", EVERY_ARGS);

    expect(text).toContain("keeps the Skill release with these files already: nothing was asked");
    expect(notified).toEqual([]);
    expect(saves).toEqual([]);
    expect(logged).toEqual([]);
  });

  it("takes the answer given meanwhile on a rerun, and applies it only to the folder the owner was shown", async () => {
    const { call, answeredEarlier, kept, logged } = await setUp();

    // The owner approved a request for other files; the rerun reads this folder, which differs.
    await answeredEarlier(7, { savedAt: null, digest: "not-this-folder" });

    const { result, text } = await call("environment_skill_save", EVERY_ARGS, {
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
    const probe = await call("environment_skill_save", EVERY_ARGS, { approve: false });
    // SAFETY: the tool asks with `{ savedAt, digest }`, which this test reads back.
    const asked = probe.shown[0]?.expected as { digest: string };

    keep("*", "release", { "SKILL.md": SKILL_MD, "references/steps.md": "1. Tag.\n" });
    await answeredEarlier(9, { savedAt: null, digest: asked.digest });

    const { text } = await call("environment_skill_save", EVERY_ARGS, { approve: true, task: 9 });

    expect(text).toContain("The user approved, and every Environment keeps the Skill release");
    expect(logged).toEqual([]);
  });

  it("says this Session's Workspace keeps its own Skill of the name, which hides it, and the Environments that do", async () => {
    const { call, keep } = await setUp();

    keep("default", "release", { "SKILL.md": OTHER_MD });
    keep("0000abcd", "release", { "SKILL.md": OTHER_MD });

    const { text, result } = await call("environment_skill_save", EVERY_ARGS);

    expect(text).toContain(
      "This Session's Environment keeps its own Skill of that name, which hides it there",
    );
    expect(text).toContain(
      'does not reach the Environments whose own Skill of that name hides it: Environment "Other" (0000abcd)',
    );
    expect(result.details).toMatchObject({ own: false });
  });
});

describe("environment_skill_save over an Environment's own Skill of a name kept for every Environment", () => {
  it("saves at once, with no Approval, and says it hides the one kept for every Environment", async () => {
    const { call, keep, notified, saves } = await setUp();

    keep("*", "release", { "SKILL.md": OTHER_MD });

    const { text, shown } = await call("environment_skill_save", {
      path: "/workspace/.cloudpid/tmp/release",
      reason: "Ours differs",
    });

    expect(shown).toEqual([]);
    expect(notified).toEqual([]);
    expect(saves).toHaveLength(1);
    expect(text).toContain(
      "It hides the Skill of that name kept for every Environment, in this Environment.",
    );
  });
});

describe("environment_skill_remove for every Environment", () => {
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
      target: "every Environment",
      change: 'Remove the Skill "release"',
      before: "release: Cut a release.",
    });
    await vi.waitFor(() => expect(notified).toHaveLength(1));
    expect(removals).toEqual([{ environment: "*", name: "release" }]);
    expect(kept.has("*:release")).toBe(false);
    expect(text).toContain("The user approved: removed the Skill release from every Environment.");
    expect(text).toContain('Environment "Other" (0000abcd)');
    expect(result.details).toMatchObject({
      approval: { approved: true },
      agentChange: { environment: { id: "*" }, field: "skills.release", after: null },
    });
    expect(logged).toEqual([
      {
        tool: "environment_skill_remove",
        environmentName: "every Environment",
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

    expect(text).toContain("The user declined: removing the Skill release from every Environment");
    expect(text).toContain("Their reason: Keep it");
    expect(removals).toEqual([]);
    expect(kept.has("*:release")).toBe(true);
  });

  it("refuses without asking a Skill that is not kept for every Environment, pointing to environment_get", async () => {
    const { call, keep, notified } = await setUp();

    // An Environment's own Skill of the name is not the one kept for every Environment.
    keep("default", "release", { "SKILL.md": SKILL_MD });

    const { result, text, shown } = await call("environment_skill_remove", {
      id: "*",
      name: "release",
      reason: "r",
    });

    expect(result.isError).toBe(true);
    expect(text).toContain('no Skill named "release" is kept for every Environment');
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
    expect(text).toContain("was saved again since they were asked: nothing was removed");
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
  it("says the Skill kept for every Environment is served instead, and asks nothing", async () => {
    const { call, keep, notified } = await setUp();

    keep("default", "release", { "SKILL.md": SKILL_MD });
    keep("*", "release", { "SKILL.md": OTHER_MD });

    const { text, shown } = await call("environment_skill_remove", {
      name: "release",
      reason: "Back to the shared one",
    });

    expect(shown).toEqual([]);
    expect(notified).toEqual([]);
    expect(text).toContain(
      "The Skill of that name kept for every Environment is served at /workspace/.agents/skills/release instead.",
    );
  });
});

describe("environment_get for every Environment's Skills", () => {
  it("lists the Skills kept for every Environment, and for an Environment those it overrides", () => {
    const base = {
      id: "default",
      name: "Default",
      repos: [],
      build: { status: "none" as const },
      settings: DEFAULT_CONTAINER_SETTINGS,
      secrets: [],
      everyVariables: {},
      skills: [{ name: "release", description: "Ours.", savedAt: 0 }],
      everySkills: [
        { name: "release", description: "Shared release.", savedAt: 0 },
        { name: "review", description: "Review code.", savedAt: 0 },
      ],
    };

    const shown = describeEnvironment(base, true);

    expect(shown).toContain(
      'Skills for every Environment (id "*"; the Environment\'s own of the same name win): \n  review (saved 1970-01-01T00:00:00.000Z): Review code.\n  overridden here: release',
    );
    // What it keeps of its own is listed apart.
    expect(shown).toContain("\n  release (saved 1970-01-01T00:00:00.000Z): Ours.");
    expect(shown).not.toContain("Shared release.");
  });

  it("says none when nothing is kept for every Environment", () => {
    const shown = describeEnvironment(
      {
        id: "default",
        name: "Default",
        repos: [],
        build: { status: "none" },
        settings: DEFAULT_CONTAINER_SETTINGS,
        secrets: [],
        everyVariables: {},
        skills: [],
        everySkills: [],
      },
      false,
    );

    expect(shown).toContain(
      'Skills for every Environment (id "*"; the Environment\'s own of the same name win): none',
    );
  });
});
