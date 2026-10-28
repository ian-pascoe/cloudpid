// @effect-diagnostics preferEffectArray:off -- tests of plain functions over native arrays.

import { type EnvironmentRecord, type SkillSource, skillSourceText } from "@cloudpid/protocol";
import { describe, expect, it } from "vitest";
import {
  changeText,
  copiesOfSkill,
  directoryBadges,
  githubFileUrl,
  githubSource,
  inheritedSkills,
  installedScopes,
  installSource,
  installOutcomeLines,
  skillCountText,
  skillMdBody,
  skillPageOfSource,
  updateOutcomeLines,
} from "./skills.ts";

describe("the Skills an Environment gets from Global", () => {
  const skill = (name: string) => ({ name, description: `What ${name} does.`, savedAt: 1 });

  it("are those kept Global that it keeps none of its own of the name, by name", () => {
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

  it("counts the Skills its Workspaces serve: its own, and those it gets from Global", () => {
    expect(skillCountText([], [])).toBe("No skills");
    expect(skillCountText([skill("a")], [])).toBe("1 skill");
    expect(skillCountText([skill("a"), skill("b")], [skill("b")])).toBe("2 skills");
    expect(skillCountText([skill("a")], [skill("b"), skill("c")])).toBe("3 skills, 2 from Global");
    expect(skillCountText([], [skill("b")])).toBe("1 skill, 1 from Global");
  });

  it("counts those kept Global on their own card", () => {
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

  it("are each Environment's, then each Environment's, without a filter", () => {
    expect(installedScopes(known, undefined)).toEqual(["*", "default", "work"]);
  });

  it("are the one Environment named, or those kept Global for *", () => {
    expect(installedScopes(known, "work")).toEqual(["work"]);
    expect(installedScopes(known, "*")).toEqual(["*"]);
  });

  it("are none for an Environment that is not listed", () => {
    expect(installedScopes(known, "gone")).toEqual([]);
  });
});

describe("githubSource", () => {
  it("splits an owner/repo, and is null for a source that is not one", () => {
    expect(githubSource("mattpocock/skills")).toEqual({ owner: "mattpocock", repo: "skills" });
    expect(githubSource("uizze.sh")).toBeNull();
    expect(githubSource("a/b/c")).toBeNull();
    expect(githubSource("a/ b")).toBeNull();
  });
});

describe("directoryBadges", () => {
  it("says nothing for a Skill installed nowhere", () => {
    expect(directoryBadges(undefined)).toEqual([]);
  });

  it("says Global, or in how many Environments, and update available", () => {
    expect(
      directoryBadges({ global: true, environments: ["work"], updateAvailable: false }),
    ).toEqual(["Installed · Global"]);
    expect(directoryBadges({ global: false, environments: ["a"], updateAvailable: false })).toEqual(
      ["Installed · in 1 environment"],
    );
    expect(
      directoryBadges({ global: false, environments: ["a", "b"], updateAvailable: true }),
    ).toEqual(["Installed · in 2 environments", "update available"]);
  });
});

describe("changeText", () => {
  it("signs the Hot tab's change", () => {
    expect(changeText(4)).toBe("+4");
    expect(changeText(-3)).toBe("\u22123");
  });
});

describe("installSource", () => {
  it("is the source itself without a ref, and a tree URL with one, the ref kept as one segment", () => {
    expect(installSource("o/skills")).toBe("o/skills");
    expect(installSource("o/skills", "")).toBe("o/skills");
    expect(installSource("o/skills", "v2")).toBe("https://github.com/o/skills/tree/v2");
    expect(installSource("o/skills", "feature/x")).toBe(
      "https://github.com/o/skills/tree/feature%2Fx",
    );
  });
});

describe("a Skill's page link from an installed copy", () => {
  const source = (over: Partial<SkillSource> = {}): SkillSource => ({
    repo: "o/skills",
    path: "skills/tdd",
    ref: null,
    commit: "c0ffee0000000000000000000000000000000001",
    ...over,
  });

  it("is the Skill's page naming its folder, and the ref it was installed from when it named one", () => {
    expect(skillPageOfSource("tdd", source())).toBe("/skills/o/skills/tdd?path=skills%2Ftdd");
    expect(skillPageOfSource("TDD", source({ ref: "feature/x" }))).toBe(
      "/skills/o/skills/TDD?ref=feature%2Fx&path=skills%2Ftdd",
    );
    // A Skill at the repo's root has an empty folder, which is a folder.
    expect(skillPageOfSource("root", source({ path: "" }))).toBe("/skills/o/skills/root?path=");
  });

  it("is none when the Skill source's repo is not one of GitHub's", () => {
    expect(skillPageOfSource("tdd", source({ repo: "skills.example.com" }))).toBeNull();
  });
});

describe("the copies of a Skill", () => {
  const copy = (name: string, repo: string, path: string) => ({
    name,
    description: "",
    savedAt: 1,
    source: { repo, path, ref: null, commit: "c" },
  });

  it("are those whose Skill source is the repo and folder, ignoring the case of GitHub's names, and not those of the name alone", () => {
    const skills = [
      copy("tdd", "o/skills", "skills/tdd"),
      copy("tdd-2", "O/Skills", "skills/tdd"),
      copy("tdd", "o/skills", "other/tdd"),
      copy("tdd", "x/skills", "skills/tdd"),
      { name: "tdd", description: "", savedAt: 1 },
    ];

    expect(copiesOfSkill(skills, "o/skills", "skills/tdd").map(({ name }) => name)).toEqual([
      "tdd",
      "tdd-2",
    ]);
  });
});

describe("a SKILL.md's body", () => {
  it("is the text without its frontmatter", () => {
    expect(skillMdBody("---\nname: a\ndescription: b\n---\n\n# Title\n\ntext\n")).toBe(
      "# Title\n\ntext\n",
    );
    expect(skillMdBody("---\r\nname: a\r\n---\r\nbody")).toBe("body");
    expect(skillMdBody("---\n---\nbody")).toBe("body");
    expect(skillMdBody("\uFEFF---\nname: a\n---\nbody")).toBe("body");
  });

  it("is the whole text when it has none, or when a rule in the text is not one", () => {
    expect(skillMdBody("# Title\n")).toBe("# Title\n");
    expect(skillMdBody("text\n---\nmore")).toBe("text\n---\nmore");
    // Opened and never closed: not frontmatter.
    expect(skillMdBody("---\nname: a\nbody")).toBe("---\nname: a\nbody");
  });
});

describe("a file on GitHub", () => {
  it("is at the commit, each segment of its path encoded", () => {
    expect(githubFileUrl("o/skills", "abc", "skills/my tdd/a#b.md")).toBe(
      "https://github.com/o/skills/blob/abc/skills/my%20tdd/a%23b.md",
    );
  });
});
