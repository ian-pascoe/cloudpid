// @effect-diagnostics nodeBuiltinImport:off preferEffectArray:off preferEffectRecord:off
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { parseSkill } from "@cloudpid/extensions/skills";
import { describe, expect, it } from "vitest";
import { BUNDLED_SKILLS } from "./bundled-skills.generated.ts";

const skillsDirectory = decodeURIComponent(new URL("../../../../skills", import.meta.url).pathname);

/** The files of the skill directories below `directory`, as `skill/path` keys. */
const filesBelow = (directory: string): string[] =>
  readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);

    return statSync(path).isDirectory()
      ? filesBelow(path)
      : [relative(skillsDirectory, path).split(sep).join("/")];
  });

const skillDirectories = readdirSync(skillsDirectory).filter((name) =>
  statSync(join(skillsDirectory, name)).isDirectory(),
);

const bundled = BUNDLED_SKILLS.files;

describe("the bundled skills", () => {
  it("are every file of the skill directories in `skills/`, as `node scripts/sync-skills.mjs` generates them", () => {
    const onDisk = skillDirectories.flatMap((name) => filesBelow(join(skillsDirectory, name)));

    expect(Object.keys(bundled).toSorted()).toEqual(onDisk.toSorted());

    for (const key of onDisk) {
      expect(bundled[key]).toBe(readFileSync(join(skillsDirectory, key), "utf8"));
    }
  });

  it("each declare a name and a description in their SKILL.md", () => {
    expect(skillDirectories.length).toBeGreaterThan(0);

    for (const name of skillDirectories) {
      const text = bundled[`${name}/SKILL.md`];

      expect(text, `${name}/SKILL.md`).toEqual(expect.any(String));

      expect(parseSkill(`/workspace/.agents/skills/${name}/SKILL.md`, String(text))).toMatchObject({
        name,
      });
    }
  });
});
