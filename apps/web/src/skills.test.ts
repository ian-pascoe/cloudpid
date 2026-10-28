// @effect-diagnostics preferEffectArray:off -- tests of plain functions over native arrays.

import { type EnvironmentRecord, skillSourceText } from "@cloudpid/protocol";
import { describe, expect, it } from "vitest";
import {
  inheritedSkills,
  installedScopes,
  installOutcomeLines,
  skillCountText,
  updateOutcomeLines,
} from "./skills.ts";

describe("the Skills an Environment gets from every Environment", () => {
  const skill = (name: string) => ({ name, description: `What ${name} does.`, savedAt: 1 });

  it("are those kept for every Environment that it keeps none of its own of the name, by name", () => {
    const every = [skill("review"), skill("release"), skill("triage")];

    expect(inheritedSkills([skill("release")], every)).toEqual({
      inherited: ["review", "triage"],
      overridden: ["release"],
    });
    expect(inheritedSkills([], every)).toEqual({
      inherited: ["release", "review", "triage"],
      overridden: [],
    });
    expect(inheritedSkills([skill("mine")], [])).toEqual({ inherited: [], overridden: [] });
  });
});

describe("a Skill's source and the outcome of an install", () => {
  it("says where a Skill came from: its folder, the ref named, and the short commit", () => {
    const commit = "c0ffee0000000000000000000000000000000001";

    expect(
      skillSourceText({ repo: "mattpocock/skills", path: "skills/grill-me", ref: null, commit }),
    ).toBe("mattpocock/skills/skills/grill-me at c0ffee0");
    expect(skillSourceText({ repo: "o/one", path: "", ref: "v2", commit })).toBe(
      "o/one at v2, c0ffee0",
    );
  });

  it("says what each Skill of an install came to", () => {
    expect(
      installOutcomeLines([
        { name: "a", outcome: "installed" },
        { name: "b", outcome: "unchanged" },
        { name: "c", outcome: "rejected", message: "notes.md: a binary file" },
        { name: "d", outcome: "rejected" },
      ]),
    ).toEqual([
      "a: installed",
      "b: already installed from this commit, nothing changed",
      "c: refused: notes.md: a binary file",
      "d: refused",
    ]);
  });

  it("says what each Skill of an update came to", () => {
    expect(
      updateOutcomeLines([
        { name: "a", outcome: "updated" },
        { name: "b", outcome: "unchanged" },
        {
          name: "c",
          outcome: "modified",
          message: "it was edited, and an update would replace the edits",
        },
        { name: "c2", outcome: "modified" },
        { name: "d", outcome: "rejected", message: "GitHub's rate limit is used up" },
        { name: "e", outcome: "rejected" },
      ]),
    ).toEqual([
      "a: updated to the latest commit",
      "b: already up to date, nothing changed",
      "c: not updated: it was edited, and an update would replace the edits",
      "c2: not updated: it was edited since it was installed",
      "d: not updated: GitHub's rate limit is used up",
      "e: not updated",
    ]);
  });
});

describe("the line an Environment's card shows of its Skills", () => {
  const skill = (name: string) => ({ name, description: `What ${name} does.`, savedAt: 1 });

  it("counts the Skills its Workspaces serve: its own, and those it gets from every Environment", () => {
    expect(skillCountText([], [])).toBe("No skills");
    expect(skillCountText([skill("a")], [])).toBe("1 skill");
    expect(skillCountText([skill("a"), skill("b")], [skill("b")])).toBe("2 skills");
    expect(skillCountText([skill("a")], [skill("b"), skill("c")])).toBe(
      "3 skills, 2 from every environment",
    );
    expect(skillCountText([], [skill("b")])).toBe("1 skill, 1 from every environment");
  });

  it("counts those kept for every Environment on their own card", () => {
    expect(skillCountText([skill("a"), skill("b")])).toBe("2 skills");
    expect(skillCountText([])).toBe("No skills");
  });
});

describe("the sections the Installed tab shows", () => {
  const environment = (id: string): EnvironmentRecord => ({
    id,
    name: id,
    repos: [],
    createdAt: 1,
  });

  const known = [environment("default"), environment("work")];

  it("are every Environment's, then each Environment's, without a filter", () => {
    expect(installedScopes(known, undefined)).toEqual(["*", "default", "work"]);
  });

  it("are the one Environment named, or those kept for every Environment for *", () => {
    expect(installedScopes(known, "work")).toEqual(["work"]);
    expect(installedScopes(known, "*")).toEqual(["*"]);
  });

  it("are none for an Environment that is not listed", () => {
    expect(installedScopes(known, "gone")).toEqual([]);
  });
});
