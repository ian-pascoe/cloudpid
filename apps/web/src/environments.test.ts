// @effect-diagnostics preferEffectArray:off -- tests of plain functions over native arrays.

import {
  DEFAULT_CONTAINER_SETTINGS,
  INSTANCE_TYPES,
  MAX_IGNORE_PATTERNS,
  MAX_SCRIPT_BYTES,
  MAX_VARIABLES,
} from "@cloudpid/config";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import type { SessionRecord } from "@cloudpid/protocol";
import { describe, expect, it } from "vitest";
import {
  deleteConfirmed,
  environmentNameProblem,
  groupByEnvironment,
  idleMinutesProblem,
  ignorePatternsFrom,
  ignoreProblem,
  instanceLabel,
  optionalBranchProblem,
  parseVariables,
  scriptFieldProblem,
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

describe("instanceLabel", () => {
  it("names the size and what it offers, and marks the default one", () => {
    expect(instanceLabel("custom-2")).toBe("custom-2: 2 vCPU, 6 GiB memory, 12 GB disk (default)");
    expect(instanceLabel("standard-2")).toBe("standard-2: 1 vCPU, 6 GiB memory, 12 GB disk");
  });

  it("marks exactly one of the offered sizes", () => {
    expect(INSTANCE_TYPES.filter((type) => instanceLabel(type).endsWith("(default)"))).toEqual([
      DEFAULT_CONTAINER_SETTINGS.instance,
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

  const problem = (text: string) => {
    const result = parseVariables(text);

    return Result.isFailure(result) ? result.failure : null;
  };

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

  it("gives back the variables it was made from", () => {
    const variables = { NODE_ENV: "test", QUERY: "a=b" };

    expect(variablesText(variables)).toBe("NODE_ENV=test\nQUERY=a=b");
    expect(parsed(variablesText(variables))).toEqual(variables);
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
