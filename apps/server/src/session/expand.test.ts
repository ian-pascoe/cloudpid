// @effect-diagnostics asyncFunction:off preferEffectArray:off
import { skillBlock } from "@cloudpid/protocol";
import { describe, expect, it } from "vitest";
import { MAX_EXPANDED_FILE_BYTES } from "@cloudpid/extensions/prompt-templates";
import {
  expandMessage,
  type ExpandOptions,
  MAX_EXPANSION_BYTES,
  mayExpand,
  type NamedSkill,
} from "./expand.ts";

const review = { name: "review", filePath: "/workspace/app/.agents/skills/review/SKILL.md" };
const deploy = { name: "deploy", filePath: "/workspace/.agents/skills/deploy/SKILL.md" };
const broken = { name: "broken", filePath: "/workspace/.agents/skills/broken/SKILL.md" };

const fix = { name: "fix", filePath: "/workspace/.agents/prompts/fix.md" };

const BODIES = new Map([
  [review.filePath, "# Review\n\nRead the diff."],
  [deploy.filePath, "# Deploy\n\nShip it."],
]);

const FILES = new Map([
  [
    review.filePath,
    `---\nname: review\ndescription: Review.\n---\n\n${BODIES.get(review.filePath)}\n`,
  ],
  [deploy.filePath, BODIES.get(deploy.filePath)!],
  [fix.filePath, "---\ndescription: Fix an issue\n---\nFix issue #$1: ${@:2}"],
]);

const reads: string[] = [];

const options: ExpandOptions = {
  skills: [review, deploy, broken],
  templates: [fix],
  read: (path) => {
    reads.push(path.split("/").at(-2) ?? path);

    return Promise.resolve(FILES.get(path));
  },
};

/** The expansion of `text` with `options`, if any. */
const expand = async (text: string, using: ExpandOptions = options) =>
  (await expandMessage(text, using)).expansion;

const block = (skill: NamedSkill) =>
  skillBlock({ name: skill.name, location: skill.filePath, body: BODIES.get(skill.filePath)! });

/** The link a `$name` reference to `skill` becomes. */
const link = (skill: NamedSkill) => `[$${skill.name}](${skill.filePath})`;

const expanded = (skills: ReadonlyArray<NamedSkill>) =>
  skills.map(({ name, filePath }) => ({ name, location: filePath }));

describe("expandMessage", () => {
  it("expands /skill:name into local pi's block, then the arguments", async () => {
    expect(await expand("/skill:review  the login change ", options)).toEqual({
      content: `${block(review)}\n\nthe login change`,
      data: { display: "/skill:review  the login change ", skills: expanded([review]) },
    });
    expect(block(review)).toBe(
      '<skill name="review" location="/workspace/app/.agents/skills/review/SKILL.md">\nReferences are relative to /workspace/app/.agents/skills/review.\n\n# Review\n\nRead the diff.\n</skill>',
    );
  });

  it("expands /skill:name alone into the block alone", async () => {
    expect((await expand("/skill:deploy", options))?.content).toBe(block(deploy));
  });

  it("leaves /skill: with an unknown name, or one whose file cannot be read, as typed", async () => {
    expect(await expand("/skill:nope do it", options)).toBeUndefined();
    expect(await expand("/skill:broken do it", options)).toBeUndefined();
  });

  it("links each known Skill named with $ in place, reading no file", async () => {
    reads.length = 0;

    const text = "Use $review, then $deploy and $review again.";

    expect(await expand(text, options)).toEqual({
      content: `Use ${link(review)}, then ${link(deploy)} and ${link(review)} again.`,
      data: { display: text, skills: [] },
    });
    expect(reads).toEqual([]);
  });

  it("links the Skills a /skill:'s arguments name with $ after its block", async () => {
    expect(await expand("/skill:review then $deploy", options)).toEqual({
      content: `${block(review)}\n\nthen ${link(deploy)}`,
      data: { display: "/skill:review then $deploy", skills: expanded([review]) },
    });
    // A `/skill:` that cannot be read is left as typed, its references linked.
    expect(await expandMessage("/skill:broken then $deploy", options)).toEqual({
      expansion: {
        content: `/skill:broken then ${link(deploy)}`,
        data: { display: "/skill:broken then $deploy", skills: [] },
      },
      unexpanded: [`Skill broken: ${broken.filePath} cannot be read`],
    });
  });

  it("leaves $ that names no Skill alone, $HOME included, and $ in a word or code", async () => {
    expect(await expand("echo $HOME and $nope", options)).toBeUndefined();
    expect((await expand("echo $HOME, $deploy", options))?.content).toBe(
      `echo $HOME, ${link(deploy)}`,
    );

    const text = [
      "a$review `$review` ``x $deploy`` \\$deploy",
      "```sh",
      "echo $deploy",
      "```",
      "",
      "    $review",
    ].join("\n");

    expect(await expand(text, options)).toBeUndefined();
  });

  it("expands a Prompt template's Slash command with its arguments", async () => {
    expect(await expand('/fix 42 "the login" flow', options)).toEqual({
      content: "Fix issue #42: the login flow",
      data: { display: '/fix 42 "the login" flow', skills: [] },
    });
  });

  it("leaves a Skill or template over 256 KiB as typed, and says why", async () => {
    const big = "x".repeat(MAX_EXPANDED_FILE_BYTES + 1);

    const sized: ExpandOptions = {
      ...options,
      read: (path) => Promise.resolve(path === deploy.filePath ? big : FILES.get(path)),
    };

    expect(await expandMessage("/skill:deploy now", sized)).toEqual({
      expansion: undefined,
      unexpanded: [`Skill deploy: ${deploy.filePath} is over 256 KiB`],
    });
    expect(await expandMessage("/fix 1", { ...options, read: () => Promise.resolve(big) })).toEqual(
      {
        expansion: undefined,
        unexpanded: [`Template /fix: ${fix.filePath} is over 256 KiB`],
      },
    );
    expect((await expandMessage("/skill:broken", options)).unexpanded).toEqual([
      `Skill broken: ${broken.filePath} cannot be read`,
    ]);
  });

  it("leaves the whole message as typed when its expansion would be over 1 MiB", async () => {
    const body = "y".repeat(MAX_EXPANDED_FILE_BYTES - 100);

    const args = "z".repeat(MAX_EXPANSION_BYTES);

    expect(
      await expandMessage(`/skill:deploy ${args}`, {
        ...options,
        read: () => Promise.resolve(body),
      }),
    ).toEqual({ expansion: undefined, unexpanded: ["the expanded message is over 1 MiB"] });
  });

  it("leaves other Slash commands and plain text alone", async () => {
    expect(await expand("/unknown thing", options)).toBeUndefined();
    expect(await expand("/tmp/x is full", options)).toBeUndefined();
    expect(await expand("just text", options)).toBeUndefined();
  });
});

describe("mayExpand", () => {
  it("looks only at messages that start with / or hold a $ word", () => {
    expect(mayExpand("/skill:x")).toBe(true);
    expect(mayExpand("use $x")).toBe(true);
    expect(mayExpand("use ($x)")).toBe(true);
    expect(mayExpand("costs 5$")).toBe(false);
    expect(mayExpand("plain")).toBe(false);
  });
});
