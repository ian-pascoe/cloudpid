// @effect-diagnostics preferEffectArray:off -- tests of plain functions over native arrays.

import type { RepoBranches } from "@cloudpid/protocol";
import { describe, expect, it } from "vitest";
import {
  baseChoices,
  baseWarning,
  draftBaseProblem,
  draftBranchProblem,
  draftPlace,
  draftSendable,
  effectiveWorkspace,
  type DraftInput,
} from "./draft.ts";

const draft = (changes: Partial<DraftInput> = {}): DraftInput => ({
  text: "Fix the build",
  environment: "default",
  workspace: "new",
  branch: "",
  base: "",
  ...changes,
});

describe("the Workspace a draft uses", () => {
  const workspaces = [{ id: "0a1b2c3d" }, { id: "deadbeef" }];

  it("is the one picked when the Environment has it", () => {
    expect(effectiveWorkspace("deadbeef", workspaces)).toBe("deadbeef");
  });

  it("is a new one when none is picked, or the one picked is gone", () => {
    expect(effectiveWorkspace("new", workspaces)).toBe("new");
    expect(effectiveWorkspace("ffffffff", workspaces)).toBe("new");
    expect(effectiveWorkspace("0a1b2c3d", [])).toBe("new");
  });
});

describe("what a draft is told to create", () => {
  it("is the Environment and a new Workspace, with no branch or base left empty", () => {
    expect(draftPlace(draft())).toEqual({ environment: "default", workspace: "new" });
  });

  it("carries the base and branch of a new Workspace, trimmed", () => {
    expect(draftPlace(draft({ environment: "work", branch: " fix/build ", base: "main" }))).toEqual(
      { environment: "work", workspace: "new", branch: "fix/build", base: "main" },
    );
  });

  it("names an existing Workspace and carries no branch or base", () => {
    expect(draftPlace(draft({ workspace: "0a1b2c3d", branch: "x", base: "y" }))).toEqual({
      environment: "default",
      workspace: "0a1b2c3d",
    });
  });
});

describe("whether a draft can be sent", () => {
  it("needs a message", () => {
    expect(draftSendable(draft())).toBe(true);
    expect(draftSendable(draft({ text: "  \n" }))).toBe(false);
  });

  it("checks the branch and base of a new Workspace as they are typed", () => {
    expect(draftBranchProblem(draft({ branch: "a..b" }))).not.toBeNull();
    expect(draftBaseProblem(draft({ base: "has space" }))).not.toBeNull();
    expect(draftSendable(draft({ branch: "a..b" }))).toBe(false);
    expect(draftSendable(draft({ base: "has space" }))).toBe(false);
    expect(draftBranchProblem(draft({ branch: "feature/x" }))).toBeNull();
  });

  it("refuses the spare Workspace's placeholder as the branch, not as the base", () => {
    expect(draftBranchProblem(draft({ branch: "cloudpid/spare" }))).not.toBeNull();
    expect(draftBaseProblem(draft({ base: "cloudpid/spare" }))).toBeNull();
  });

  it("ignores the branch and base fields of an existing Workspace", () => {
    expect(draftSendable(draft({ workspace: "0a1b2c3d", branch: "a..b" }))).toBe(true);
  });
});

describe("the Start from menu", () => {
  const app: RepoBranches = {
    repo: "app",
    status: "ok",
    defaultBranch: "main",
    branches: [
      { name: "feat/login", committedAt: 3_000 },
      { name: "main", committedAt: 2_000 },
      { name: "old", committedAt: null },
    ],
  };

  const api: RepoBranches = {
    repo: "api",
    status: "ok",
    defaultBranch: "trunk",
    branches: [
      { name: "main", committedAt: 4_000 },
      { name: "trunk", committedAt: 1_000 },
    ],
  };

  it("lists one Repo's branches, most recent first, and marks its default branch", () => {
    expect(baseChoices([app], "")).toEqual({
      choices: [
        { name: "feat/login", note: undefined, missingFrom: [] },
        { name: "main", note: "default", missingFrom: [] },
        { name: "old", note: undefined, missingFrom: [] },
      ],
      unlisted: [],
    });
  });

  it("lists each branch of several Repos once, those all have first, naming the Repos without one", () => {
    expect(baseChoices([app, api], "").choices).toEqual([
      { name: "main", note: "default in app", missingFrom: [] },
      { name: "feat/login", note: undefined, missingFrom: ["api"] },
      { name: "trunk", note: "default in api", missingFrom: ["app"] },
      { name: "old", note: undefined, missingFrom: ["api"] },
    ]);
  });

  it("calls a branch every Repo starts from the default", () => {
    const lib: RepoBranches = { ...api, repo: "lib", defaultBranch: "main" };

    expect(baseChoices([app, lib], "main").choices).toEqual([
      { name: "main", note: "default", missingFrom: [] },
    ]);
  });

  it("keeps the branches whose name holds what is typed, in any case", () => {
    expect(baseChoices([app, api], " LOG ").choices).toEqual([
      { name: "feat/login", note: undefined, missingFrom: ["api"] },
    ]);
  });

  it("warns of a base some listed Repos have no branch of, since their clones would fail", () => {
    const lib: RepoBranches = { ...api, repo: "lib" };

    expect(baseWarning([app, api], "feat/login ")).toBe(
      "api has no branch feat/login: its clone cannot start from it.",
    );
    expect(baseWarning([app, api, lib], "feat/login")).toBe(
      "api, lib have no branch feat/login: their clones cannot start from it.",
    );
    // Every Repo has it, the field is empty, or no list has it (pushed a moment ago): nothing to say.
    expect(baseWarning([app, api], "main")).toBeNull();
    expect(baseWarning([app, api], "")).toBeNull();
    expect(baseWarning([app, api], "feat/new")).toBeNull();
  });

  it("says which Repos it could not list, and lists the others as if alone", () => {
    expect(
      baseChoices(
        [app, { repo: "lib", status: "error", kind: "no_github", message: "Not on GitHub" }],
        "",
      ),
    ).toEqual({
      choices: [
        { name: "feat/login", note: undefined, missingFrom: [] },
        { name: "main", note: "default", missingFrom: [] },
        { name: "old", note: undefined, missingFrom: [] },
      ],
      unlisted: [{ repo: "lib", message: "Not on GitHub" }],
    });
  });
});
