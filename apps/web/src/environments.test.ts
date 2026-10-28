// @effect-diagnostics preferEffectArray:off -- tests of plain functions over native arrays.

import {
  DEFAULT_CONTAINER_SETTINGS,
  INSTANCE_TYPES,
  MAX_IGNORE_PATTERNS,
  MAX_SCRIPT_BYTES,
  MAX_TOOLCHAINS_BYTES,
  MAX_VARIABLES,
} from "@cloudpid/config";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import {
  type AgentChange,
  DELETED_FIELD,
  type EnvironmentSecretRecord,
  type SessionRecord,
} from "@cloudpid/protocol";
import { describe, expect, it } from "vitest";
import {
  EMPTY_SECRET_DRAFT,
  GLOBAL,
  inheritedSecrets,
  inheritedVariables,
  secretDraftProblems,
  secretDraftReady,
  secretScopeOf,
  secretsIn,
  secretVariable,
  secretWrite,
  buildLine,
  changeByline,
  changeFieldText,
  changeTitleText,
  changeValueText,
  fieldValueText,
  revertible,
  deleteConfirmed,
  environmentNameProblem,
  groupByEnvironment,
  idleMinutesProblem,
  ignorePatternsFrom,
  ignoreProblem,
  instanceLabel,
  sizeLimitLabel,
  optionalBranchProblem,
  parseVariables,
  repoNameProblem,
  scriptFieldProblem,
  toolchainsFieldProblem,
  sourceProblem,
  splitArchived,
  variablesText,
} from "./environments.ts";

const session = (id: string, environment: string, workspace = "0a1b2c3d"): SessionRecord => ({
  id,
  title: null,
  titleSource: null,
  environment,
  workspace,
  status: "idle",
  createdAt: 1,
  updatedAt: 1,
  archivedAt: null,
});

describe("groupByEnvironment", () => {
  it("groups Sessions by Environment, the newest Session's Environment first", () => {
    const groups = groupByEnvironment([
      session("c", "pi"),
      session("b", "cloudpid", "deadbeef"),
      session("a", "pi", "cafebabe"),
    ]);

    expect(groups.map((group) => [group.environment, group.sessions.map((s) => s.id)])).toEqual([
      ["pi", ["c", "a"]],
      ["cloudpid", ["b"]],
    ]);
  });

  it("says whether any of a group's Sessions is running", () => {
    const groups = groupByEnvironment([
      { ...session("c", "pi"), status: "running" },
      session("b", "cloudpid"),
      session("a", "pi"),
    ]);

    expect(groups.map((group) => [group.environment, group.running])).toEqual([
      ["pi", true],
      ["cloudpid", false],
    ]);
  });

  it("is empty without Sessions", () => {
    expect(groupByEnvironment([])).toEqual([]);
  });

  it("labels each group with its Environment's name, and with the id for one it does not know", () => {
    const groups = groupByEnvironment([session("a", "pi"), session("b", "gone")], {
      pi: "Pi on Cloudflare",
    });

    expect(groups.map((group) => [group.environment, group.name])).toEqual([
      ["pi", "Pi on Cloudflare"],
      ["gone", "gone"],
    ]);
  });
});

describe("splitArchived", () => {
  it("separates archived Sessions from the rest, keeping their order", () => {
    const archived = { ...session("b", "pi"), archivedAt: 5 };

    const { active, archived: put } = splitArchived([
      session("a", "pi"),
      archived,
      session("c", "x"),
    ]);

    expect(active.map((s) => s.id)).toEqual(["a", "c"]);
    expect(put.map((s) => s.id)).toEqual(["b"]);
  });
});

describe("environmentNameProblem", () => {
  it("accepts a name another Environment does not have, in any case, and says what is wrong otherwise", () => {
    const others = ["Pi on Cloudflare"];

    expect(environmentNameProblem("  Docs ", others)).toBeNull();
    expect(environmentNameProblem("   ", others)).toBe("Give the environment a name");
    expect(environmentNameProblem("a".repeat(81), others)).toBe("Use at most 80 characters");
    expect(environmentNameProblem("pi on cloudflare", others)).toBe(
      "Another environment is already named that",
    );
  });
});

describe("deleteConfirmed", () => {
  it("holds only when the name is typed exactly", () => {
    expect(deleteConfirmed("cloudpid", "cloudpid")).toBe(true);
    expect(deleteConfirmed("cloudpid", " cloudpid ")).toBe(true);
    expect(deleteConfirmed("cloudpid", "CloudPid")).toBe(false);
    expect(deleteConfirmed("cloudpid", "")).toBe(false);
    expect(deleteConfirmed("cloudpid/1a2b3c4d", "cloudpid/1a2b3c4d")).toBe(true);
  });
});

describe("optionalBranchProblem", () => {
  it("accepts nothing, which means the default, and a branch the server accepts", () => {
    expect(optionalBranchProblem("")).toBeNull();
    expect(optionalBranchProblem("  ")).toBeNull();
    expect(optionalBranchProblem("feature/login")).toBeNull();
  });

  it("says what is wrong with anything else", () => {
    expect(optionalBranchProblem("a..b")).not.toBeNull();
    expect(optionalBranchProblem("-x")).not.toBeNull();
    expect(optionalBranchProblem("has space")).not.toBeNull();
    expect(optionalBranchProblem("HEAD")).not.toBeNull();
  });
});

describe("sourceProblem", () => {
  it("accepts owner/repo and https URLs, and says what is wrong with anything else", () => {
    expect(sourceProblem("octocat/Hello-World")).toBeNull();
    expect(sourceProblem("https://github.com/octocat/Hello-World.git")).toBeNull();
    expect(sourceProblem("file:///etc/passwd")).toContain("https");
    expect(sourceProblem("")).not.toBeNull();
  });
});

describe("repoNameProblem", () => {
  it("accepts nothing (the repo's own name) and a plain directory name, and says what is wrong with anything else", () => {
    expect(repoNameProblem("")).toBeNull();
    expect(repoNameProblem("  ")).toBeNull();
    expect(repoNameProblem(" other-web ")).toBeNull();
    expect(repoNameProblem("web.v2_old")).toBeNull();
    expect(repoNameProblem(".hidden")).toBe(
      "Use letters, digits, dots, underscores and dashes, starting with a letter or digit",
    );
    expect(repoNameProblem("a/b")).not.toBeNull();
    expect(repoNameProblem("-rf")).not.toBeNull();
    expect(repoNameProblem("a".repeat(101))).toBe("Use at most 100 characters");
  });
});

describe("instanceLabel", () => {
  it("names the size and what it offers, and marks the default one", () => {
    expect(instanceLabel("cpu-1")).toBe("cpu-1: 1 vCPU, 3 GiB memory, 12 GB disk (default)");
    expect(instanceLabel("cpu-2")).toBe("cpu-2: 2 vCPU, 6 GiB memory, 12 GB disk");
    expect(instanceLabel("standard-2")).toBe("standard-2: 1 vCPU, 6 GiB memory, 12 GB disk");
    expect(instanceLabel("cpu-3")).toBe("cpu-3: 3 vCPU, 9 GiB memory, 12 GB disk");
    expect(instanceLabel("mem-4")).toBe("mem-4: 1 vCPU, 4 GiB memory, 12 GB disk");
    expect(instanceLabel("mem-12")).toBe("mem-12: 2 vCPU, 12 GiB memory, 12 GB disk");
  });

  it("offers cpu-3 and mem-12 between standard-3 and standard-4, in the size and the size limit pickers", () => {
    expect(INSTANCE_TYPES.slice(INSTANCE_TYPES.indexOf("standard-3"))).toEqual([
      "standard-3",
      "cpu-3",
      "mem-12",
      "standard-4",
    ]);
    expect(sizeLimitLabel("cpu-3")).toBe("cpu-3: 3 vCPU, 9 GiB memory, 12 GB disk");
  });

  it("marks exactly one of the offered sizes", () => {
    expect(INSTANCE_TYPES.filter((type) => instanceLabel(type).endsWith("(default)"))).toEqual([
      DEFAULT_CONTAINER_SETTINGS.instance,
    ]);
  });
});

describe("sizeLimitLabel", () => {
  it("marks cpu-2, the default size limit", () => {
    expect(sizeLimitLabel("cpu-2")).toBe("cpu-2: 2 vCPU, 6 GiB memory, 12 GB disk (default)");
    expect(INSTANCE_TYPES.filter((type) => sizeLimitLabel(type).endsWith("(default)"))).toEqual([
      "cpu-2",
    ]);
  });
});

describe("idleMinutesProblem", () => {
  it("accepts a whole number of minutes from 1 to a day and says what is wrong with anything else", () => {
    expect(idleMinutesProblem("15")).toBeNull();
    expect(idleMinutesProblem("1")).toBeNull();
    expect(idleMinutesProblem("1440")).toBeNull();
    expect(idleMinutesProblem("")).not.toBeNull();
    expect(idleMinutesProblem("0")).not.toBeNull();
    expect(idleMinutesProblem("1441")).not.toBeNull();
    expect(idleMinutesProblem("2.5")).not.toBeNull();
    expect(idleMinutesProblem("soon")).not.toBeNull();
  });
});

describe("ignorePatternsFrom", () => {
  it("takes one pattern per line, without the spaces around it or the blank lines", () => {
    expect(ignorePatternsFrom("  /data \n\n**/.gradle-cache\n")).toEqual([
      "/data",
      "**/.gradle-cache",
    ]);
    expect(ignorePatternsFrom("")).toEqual([]);
  });
});

describe("ignoreProblem", () => {
  it("accepts computer's ignore patterns, one per line, and names the line of one it would refuse", () => {
    expect(ignoreProblem("")).toBeNull();
    expect(ignoreProblem("/data\n**/.gradle-cache\n!/repo/node_modules")).toBeNull();
    expect(ignoreProblem("/data\ndata")).toContain("data");
    expect(ignoreProblem("/a/{b,c}")).not.toBeNull();
  });

  it("refuses more patterns than an Environment may have", () => {
    const many = Array.from({ length: MAX_IGNORE_PATTERNS + 1 }, (_, i) => `/data-${i}`);

    expect(ignoreProblem(many.join("\n"))).toContain(String(MAX_IGNORE_PATTERNS));
  });
});

describe("parseVariables", () => {
  const parsed = (text: string) => Result.getOrThrow(parseVariables(text));

  const problemWith = (text: string, inherited: Readonly<Record<string, string>>) => {
    const result = parseVariables(text, inherited);

    return Result.isFailure(result) ? result.failure : null;
  };

  const problem = (text: string) => problemWith(text, {});

  it("reads a NAME=value line each, the value everything after the first =, as typed", () => {
    expect(parsed("NODE_ENV=test\nQUERY=a=b&c=d\nEMPTY=\nSPACED= two words ")).toEqual({
      NODE_ENV: "test",
      QUERY: "a=b&c=d",
      EMPTY: "",
      SPACED: " two words ",
    });
  });

  it("leaves out blank lines and # comments, and spaces around a name", () => {
    expect(parsed("\n  # the database\n  DB_URL =postgres://x\n\n")).toEqual({
      DB_URL: "postgres://x",
    });
    expect(parsed("")).toEqual({});
  });

  it("takes any name a shell can export, __proto__ too", () => {
    expect(Record.keys(parsed("__proto__=1"))).toEqual(["__proto__"]);
  });

  it("says which line has no =", () => {
    expect(problem("A=1\nB")).toBe("Line 2: write NAME=value");
  });

  it("says why a name cannot be a variable's, with the server's rules", () => {
    expect(problem("1A=x")).toContain("1A must be letters");
    expect(problem("PATH=/bin")).toBe("PATH is reserved: the Container sets it itself");
    expect(problem("CLOUDPID_X=1")).toContain("CLOUDPID_X is reserved");
  });

  it("refuses a name set twice", () => {
    expect(problem("A=1\nA=2")).toBe("A is set twice");
  });

  it(`refuses more than ${MAX_VARIABLES} variables, and a value over 4096 characters`, () => {
    const many = Array.from({ length: MAX_VARIABLES + 1 }, (_, i) => `V${i}=x`).join("\n");

    expect(problem(many)).toBe(`Use at most ${MAX_VARIABLES} variables`);
    expect(problem(`A=${"a".repeat(4097)}`)).toBe("A's value is longer than 4096 characters");
  });

  it("counts the variables kept Global in the limit, an overridden name once", () => {
    const globalVars = Record.fromEntries(
      Array.from({ length: 10 }, (_, i) => [`E${i}`, "x"] as const),
    );

    const own = (count: number, names: readonly string[] = []) =>
      [
        ...Array.from({ length: count }, (_, i) => `V${i}=x`),
        ...names.map((name) => `${name}=y`),
      ].join("\n");

    expect(Result.isSuccess(parseVariables(own(MAX_VARIABLES - 10), globalVars))).toBe(true);
    expect(problemWith(own(MAX_VARIABLES - 10 + 1), globalVars)).toBe(
      "With the 10 variables at Global it does not override, use at most 50 variables in all",
    );
    // Ten of its own override those ten: 50 in all.
    expect(
      Result.isSuccess(
        parseVariables(own(MAX_VARIABLES - 10, Record.keys(globalVars)), globalVars),
      ),
    ).toBe(true);
    expect(problem(own(MAX_VARIABLES + 1))).toBe(`Use at most ${MAX_VARIABLES} variables`);
  });

  it("gives back the variables it was made from", () => {
    const variables = { NODE_ENV: "test", QUERY: "a=b" };

    expect(variablesText(variables)).toBe("NODE_ENV=test\nQUERY=a=b");
    expect(parsed(variablesText(variables))).toEqual(variables);
  });
});

describe("inheritedVariables", () => {
  it("names the variables at Global an Environment gets, and those of its own that override one", () => {
    expect(inheritedVariables({ B: "1", C: "2" }, { A: "x", B: "y", D: "z" })).toEqual({
      inherited: ["A", "D"],
      overridden: ["B"],
    });
    expect(inheritedVariables({ A: "1" }, {})).toEqual({ inherited: [], overridden: [] });
  });
});

describe("scriptFieldProblem", () => {
  it("takes a script up to 64 KiB, and refuses a longer one", () => {
    expect(scriptFieldProblem("pnpm install\n")).toBeNull();
    expect(scriptFieldProblem("a".repeat(MAX_SCRIPT_BYTES))).toBeNull();
    expect(scriptFieldProblem("a".repeat(MAX_SCRIPT_BYTES + 1))).toBe(
      "The script is longer than 64 KiB",
    );
  });
});

describe("toolchainsFieldProblem", () => {
  it("takes a mise.toml up to 16 KiB, and refuses a longer one", () => {
    expect(toolchainsFieldProblem('[tools]\nnode = "22.20.0"\n')).toBeNull();
    expect(toolchainsFieldProblem("a".repeat(MAX_TOOLCHAINS_BYTES))).toBeNull();
    expect(toolchainsFieldProblem("a".repeat(MAX_TOOLCHAINS_BYTES + 1))).toBe(
      "The mise.toml is longer than 16 KiB",
    );
  });
});

describe("buildLine", () => {
  const NOW = 1_000_000_000_000;
  const HOUR = 3_600_000;

  it("says new Workspaces start from the image while there is no Build", () => {
    expect(buildLine({ status: "none" }, NOW)).toBe(
      "No build: new workspaces start from the image",
    );
  });

  it("says when the Build they start from was made", () => {
    expect(buildLine({ status: "ready", at: NOW - 2 * HOUR }, NOW)).toBe("Built 2 hours ago");
  });

  it("says what new Workspaces start from while a Build is under way", () => {
    expect(buildLine({ status: "building", since: NOW - 5 * 60_000, lastGoodAt: null }, NOW)).toBe(
      "Building since 5 minutes ago; new workspaces start from the image",
    );
    expect(buildLine({ status: "building", since: NOW, lastGoodAt: NOW - 48 * HOUR }, NOW)).toBe(
      "Building since just now; new workspaces start from the build of 2 days ago",
    );
  });

  it("says why a Build failed, and what new Workspaces start from meanwhile", () => {
    expect(
      buildLine(
        {
          status: "failed",
          reason: "exit 1: npm ERR!",
          at: NOW - HOUR,
          lastGoodAt: NOW - 24 * HOUR,
        },
        NOW,
      ),
    ).toBe(
      "Build failed 1 hour ago: exit 1: npm ERR!. Meanwhile new workspaces start from the build of yesterday",
    );
  });
});

describe("an Agent change", () => {
  const NOW = 1_000_000_000_000;

  const change: AgentChange = {
    id: 3,
    scope: "work",
    at: NOW - 5 * 60_000,
    actor: "agent",
    session: "s-1",
    conversation: 1,
    tool: "environment_variable_set",
    reason: "The tests read it",
    field: "variables.API_URL",
    before: null,
    after: "https://api.test",
    reverts: null,
    revertedBy: null,
  };

  it("shows its values in full, a variable's as written and none as not set", () => {
    expect(changeValueText(null)).toBe("not set");
    expect(
      changeValueText({
        files: { "SKILL.md": "h1", "references/a.md": "h2" },
        source: { repo: "o/r", path: "skills/x", ref: "v2", commit: "c0ffee0000000000" },
      }),
    ).toBe("SKILL.md\nreferences/a.md\nfrom o/r/skills/x at v2, c0ffee0");
    // An edit over an installed Skill keeps its source and marks it.
    expect(
      changeValueText({
        files: { "SKILL.md": "h1" },
        source: { repo: "o/r", path: "skills/x", ref: null, commit: "c0ffee0000000000" },
        modified: true,
      }),
    ).toBe("SKILL.md\nfrom o/r/skills/x at c0ffee0 (modified since installed)");
    expect(changeValueText({ files: { "SKILL.md": "h1" } })).toBe("SKILL.md");
    expect(changeValueText("a\nb")).toBe("a\nb");
    expect(changeValueText(30)).toBe("30");
    expect(changeValueText("")).toBe("empty");
    expect(changeValueText([])).toBe("none");
    expect(changeValueText(["/data", "**/.big"])).toBe("/data\n**/.big");
    expect(changeValueText({ a: 1 })).toBe('{"a":1}');
    expect(changeFieldText("variables.API_URL")).toBe("Variable API_URL");
    expect(changeFieldText("idleMinutes")).toBe("idleMinutes");
    expect(changeFieldText("name")).toBe("Name");
    expect(changeFieldText("secrets.API_KEY")).toBe("Secret API_KEY");
    expect(changeFieldText("secrets.API_KEY.build")).toBe("Secret API_KEY, for the Build");
    expect(changeFieldText("repos.api")).toBe("Repo api");
    expect(changeFieldText("environment")).toBe("Creation");
    expect(changeFieldText("build")).toBe("Build");
  });

  it("shows a Skill's change as the Skill, its values as its files' paths", () => {
    expect(changeFieldText("skills.release")).toBe("Skill release");
    expect(changeValueText({ files: { "references/a.md": "h2", "SKILL.md": "h1" } })).toBe(
      "SKILL.md\nreferences/a.md",
    );
    expect(changeValueText({ files: {} })).toBe("no files");
  });

  it("titles a call's change by setting and place, and an approved Environment delete as deleted", () => {
    expect(changeTitleText("variables.API_URL", "Default")).toBe("Variable API_URL in Default");
    expect(changeTitleText("spendLimit.perSession", "the Settings")).toBe(
      "spendLimit.perSession in the Settings",
    );
    expect(changeTitleText(DELETED_FIELD, "qa-b-del")).toBe("Environment qa-b-del deleted");
    // What the delete took before it, and that it is deleted after; any other none stays not set.
    expect(fieldValueText(DELETED_FIELD, "1 Workspace with 1 Session")).toBe(
      "1 Workspace with 1 Session",
    );
    expect(fieldValueText(DELETED_FIELD, null)).toBe("deleted");
    expect(fieldValueText("variables.API_URL", null)).toBe("not set");
  });

  it("cannot revert the making of an Environment or a Build asked for", () => {
    expect(revertible({ ...change, field: "environment" })).toBe(false);
    expect(revertible({ ...change, field: "build" })).toBe(false);
    expect(revertible({ ...change, field: "name" })).toBe(true);
    expect(revertible({ ...change, field: "repos.api" })).toBe(true);
  });

  it("can revert a Secret's Build mark, but not a Secret kept, which holds no value to bring back", () => {
    expect(revertible({ ...change, field: "secrets.API_KEY.build" })).toBe(true);
    expect(revertible({ ...change, field: "secrets.API_KEY" })).toBe(false);
  });

  it("says who made it and when, and can be reverted while it is the agent's and not reverted yet", () => {
    expect(changeByline(change, NOW)).toBe(
      "The agent, 5 minutes ago, with environment_variable_set",
    );
    expect(
      changeByline({ ...change, actor: "owner", tool: null, session: null, reverts: 2 }, NOW),
    ).toBe("You reverted change 2, 5 minutes ago");
    // A change the owner approved first says so.
    expect(
      changeByline(
        { ...change, tool: "environment_container_size_limit_set", approved: true },
        NOW,
      ),
    ).toBe("The agent, 5 minutes ago, with environment_container_size_limit_set, approved by you");
    expect(revertible(change)).toBe(true);
    expect(revertible({ ...change, revertedBy: 4 })).toBe(false);
    expect(revertible({ ...change, actor: "owner", reverts: 2 })).toBe(false);
  });
});

describe("an Environment's Secrets", () => {
  const kept = (
    environment: string | null,
    name: string,
    build = false,
  ): EnvironmentSecretRecord => ({ environment, name, build, updatedAt: 1 });

  const records = [
    kept("work", "NPM_KEY", true),
    kept(null, "SHARED", false),
    kept("work", "API_KEY"),
    kept(null, "API_KEY", true),
    kept("other", "DB_URL"),
  ];

  it("are listed by section, by name, those at Global under their own key", () => {
    expect(secretsIn(records, "work").map((record) => record.name)).toEqual(["API_KEY", "NPM_KEY"]);
    expect(secretsIn(records, GLOBAL).map((record) => record.name)).toEqual(["API_KEY", "SHARED"]);
    expect(secretScopeOf(GLOBAL)).toBeNull();
    expect(secretScopeOf("work")).toBe("work");
  });

  it("include those kept Global, but where the Environment keeps its own of the name", () => {
    expect(inheritedSecrets(records, "work").map((record) => record.name)).toEqual(["SHARED"]);
    expect(inheritedSecrets(records, "other").map((record) => record.name)).toEqual([
      "API_KEY",
      "SHARED",
    ]);
  });

  it("are typed with the server's rules, shown only once something is typed, never quoting the value", () => {
    expect(secretDraftProblems(EMPTY_SECRET_DRAFT)).toEqual({ name: null, value: null });
    expect(secretDraftReady(EMPTY_SECRET_DRAFT)).toBe(false);

    const bad = secretDraftProblems({ name: "api-key", value: "a\0b", build: false });

    expect(bad.name).toMatch(/uppercase/);
    expect(bad.value).toMatch(/NUL/);
    expect(bad.value).not.toContain("a\0b");
    expect(secretDraftReady({ name: "API_KEY", value: "sk-live", build: false })).toBe(true);
    expect(
      secretDraftProblems({ name: "API_KEY", value: "x".repeat(33 * 1024), build: false }).value,
    ).toMatch(/KiB/);
  });

  it("are added with the form's build flag, and replaced keeping theirs", () => {
    const draft = { name: "NPM_KEY", value: "npm_new", build: false };

    expect(secretWrite(draft, secretsIn(records, "work"))).toEqual({
      name: "NPM_KEY",
      value: "npm_new",
    });
    expect(secretWrite({ ...draft, build: true }, secretsIn(records, "other"))).toEqual({
      name: "NPM_KEY",
      value: "npm_new",
      build: true,
    });
  });

  it("reach a Build's scripts as the variable a Session's commands get them as", () => {
    expect(secretVariable("NPM_KEY")).toBe("PI_SECRET" + "_NPM_KEY");
  });
});
