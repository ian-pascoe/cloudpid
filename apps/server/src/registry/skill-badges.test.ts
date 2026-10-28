// How the Skill directory's rows say where their Skill is installed (GLOSSARY.md → Skill directory): matched by Skill
// source repo and path, not by name alone.
import { describe, expect, it } from "vitest";
import { installedIn, type InstalledSkillRef, withInstalled } from "./skill-badges.ts";

const ref = (
  scope: string,
  repo: string,
  path: string,
  extra: Partial<InstalledSkillRef> = {},
): InstalledSkillRef => ({
  scope,
  name: path.split("/").pop() ?? "",
  repo,
  path,
  updateAvailable: false,
  ...extra,
});

describe("installedIn", () => {
  it("says nothing for a Skill no scope keeps", () => {
    expect(
      installedIn([ref("*", "o/skills", "skills/tdd")], { repo: "o/skills", skillId: "grill-me" }),
    ).toBeUndefined();
  });

  it("does not take a Skill of the same name from another repo for it", () => {
    const installed = [ref("*", "someone/else", "skills/grill-me")];

    expect(installedIn(installed, { repo: "o/skills", skillId: "grill-me" })).toBeUndefined();
  });

  it("says Global, and lists the Environments that keep their own, in order", () => {
    const installed = [
      ref("work", "o/skills", "skills/grill-me"),
      ref("*", "o/skills", "skills/grill-me"),
      ref("default", "o/skills", "skills/grill-me"),
      ref("work", "o/skills", "skills/tdd"),
    ];

    expect(installedIn(installed, { repo: "o/skills", skillId: "grill-me" })).toEqual({
      global: true,
      environments: ["default", "work"],
      updateAvailable: false,
    });
  });

  it("matches the repo whatever its case, and a folder by its name's slug", () => {
    const installed = [ref("work", "Mattpocock/Skills", "skills/productivity/Grill_Me")];

    expect(installedIn(installed, { repo: "mattpocock/skills", skillId: "grill-me" })).toEqual({
      global: false,
      environments: ["work"],
      updateAvailable: false,
    });
  });

  it("matches a Skill at the repo's root by its name, as an install does", () => {
    const installed = [ref("*", "o/one", "", { name: "one-skill" })];

    expect(installedIn(installed, { repo: "o/one", skillId: "one-skill" })).toMatchObject({
      global: true,
    });
    expect(installedIn(installed, { repo: "o/one", skillId: "another" })).toBeUndefined();
  });

  it("finds a Skill whose folder is not named like it, by the name skills.sh lists it under", () => {
    // vercel-labs/agent-skills keeps vercel-react-best-practices in skills/react-best-practices/.
    const installed = [
      ref("*", "vercel-labs/agent-skills", "skills/react-best-practices", {
        name: "vercel-react-best-practices",
      }),
    ];

    expect(
      installedIn(installed, {
        repo: "vercel-labs/agent-skills",
        skillId: "vercel-react-best-practices",
      }),
    ).toMatchObject({ global: true });
    // Its folder's name finds it too, as an install resolves it; another Skill of the repo is not it.
    expect(
      installedIn(installed, { repo: "vercel-labs/agent-skills", skillId: "react-best-practices" }),
    ).toMatchObject({ global: true });
    expect(
      installedIn(installed, { repo: "vercel-labs/agent-skills", skillId: "composition-patterns" }),
    ).toBeUndefined();
  });

  it("prefers the Skill of that name over one whose folder is named so, as an install does", () => {
    const installed = [
      ref("*", "o/skills", "a/foo", { name: "bar" }),
      ref("work", "o/skills", "b/baz", { name: "foo" }),
    ];

    expect(installedIn(installed, { repo: "o/skills", skillId: "foo" })).toEqual({
      global: false,
      environments: ["work"],
      updateAvailable: false,
    });
    expect(installedIn(installed, { repo: "o/skills", skillId: "bar" })).toMatchObject({
      global: true,
    });
  });

  it("matches a path exactly when the list knows it", () => {
    const installed = [ref("*", "o/skills", "a/tdd"), ref("work", "o/skills", "b/tdd")];

    expect(installedIn(installed, { repo: "o/skills", path: "b/tdd" })).toEqual({
      global: false,
      environments: ["work"],
      updateAvailable: false,
    });
  });

  it("marks update available when any copy is", () => {
    const installed = [
      ref("*", "o/skills", "skills/tdd"),
      ref("work", "o/skills", "skills/tdd", { updateAvailable: true }),
    ];

    expect(installedIn(installed, { repo: "o/skills", skillId: "tdd" })?.updateAvailable).toBe(
      true,
    );
  });
});

describe("withInstalled", () => {
  it("adds installed to the rows whose Skill is kept, and leaves the others as they are", () => {
    const rows = [
      { source: "o/skills", skillId: "tdd", name: "tdd", installs: 1 },
      { source: "o/skills", skillId: "grill-me", name: "grill-me", installs: 2 },
    ];

    expect(withInstalled(rows, [ref("*", "o/skills", "skills/tdd")])).toEqual([
      {
        ...rows[0],
        installed: { global: true, environments: [], updateAvailable: false },
      },
      rows[1],
    ]);
  });
});
