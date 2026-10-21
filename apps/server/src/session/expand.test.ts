// @effect-diagnostics asyncFunction:off preferEffectArray:off
import { skillBlock } from "@cloudpid/protocol";
import { describe, expect, it } from "vitest";
import { MAX_EXPANDED_FILE_BYTES } from "@cloudpid/extensions/prompt-templates";
import {
  expandMessage,
  type ExpandOptions,
  MAX_EXPANSION_BYTES,
  mayExpand,
  mentionedNames,
  type NamedSkill,
  withoutCode,
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

  it("puts a block for each Skill named with $ before the typed text, each once", async () => {
    const text = "Use $review, then $deploy and $review again.";

    expect(await expand(text, options)).toEqual({
      content: `${block(review)}\n\n${block(deploy)}\n\n${text}`,
      data: { display: text, skills: expanded([review, deploy]) },
    });
  });

  it("expands the Skills a /skill:'s arguments name with $ after it", async () => {
    expect((await expand("/skill:review then $deploy", options))?.content).toBe(
      `${block(review)}\n\n${block(deploy)}\n\nthen $deploy`,
    );
    expect((await expand("/skill:broken then $deploy", options))?.content).toBe(
      `${block(deploy)}\n\n/skill:broken then $deploy`,
    );
  });

  it("leaves $ that names no Skill alone, $HOME included", async () => {
    expect(await expand("echo $HOME and $nope", options)).toBeUndefined();
    expect((await expand("echo $HOME, $deploy", options))?.data.skills).toEqual(expanded([deploy]));
  });

  it("does not take $ inside a word, inline code or a fenced block", async () => {
    reads.length = 0;

    const text = [
      "a$review `$review` ``x $deploy``",
      "```sh",
      "echo $deploy",
      "```",
      "~~~",
      "$review",
      "~~~",
    ].join("\n");

    expect(await expand(text, options)).toBeUndefined();
    expect(reads).toEqual([]);
  });

  it("takes $ after a fenced block is closed, and after an unclosed backtick", async () => {
    expect((await expand("```\n$deploy\n```\nnow $review", options))?.data.skills).toEqual(
      expanded([review]),
    );
    expect((await expand("a ` stray $deploy", options))?.data.skills).toEqual(expanded([deploy]));
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

    expect(await expandMessage("use $deploy and $review", sized)).toEqual({
      expansion: {
        content: `${block(review)}\n\nuse $deploy and $review`,
        data: { display: "use $deploy and $review", skills: expanded([review]) },
      },
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

    const many = Array.from({ length: 5 }, (_, index) => ({
      name: `s${index}`,
      filePath: `/workspace/.agents/skills/s${index}/SKILL.md`,
    }));

    const result = await expandMessage("$s0 $s1 $s2 $s3 $s4", {
      skills: many,
      templates: [],
      read: () => Promise.resolve(body),
    });

    expect(5 * body.length).toBeGreaterThan(MAX_EXPANSION_BYTES);
    expect(result).toEqual({
      expansion: undefined,
      unexpanded: ["the expanded message is over 1 MiB"],
    });
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
    expect(mayExpand("costs 5$")).toBe(false);
    expect(mayExpand("plain")).toBe(false);
  });
});

describe("withoutCode", () => {
  it("drops fenced blocks to their end, and inline spans", () => {
    expect(withoutCode("a `b` c\n```\nd\n").trim()).toBe("a   c");
    expect(mentionedNames("$a `$b` $c $a")).toEqual(["a", "c"]);
  });

  it("closes a span only with a run of its own length", () => {
    expect(mentionedNames("``a` $b")).toEqual(["b"]);
    expect(mentionedNames("``a` $b``")).toEqual([]);
    expect(mentionedNames("`a``b` $c")).toEqual(["c"]);
  });

  it("drops indented code after a blank line, and keeps an indented line that continues a paragraph", () => {
    expect(mentionedNames("Run:\n\n    echo $a\n    $b\n\n$c")).toEqual(["c"]);
    expect(mentionedNames("    $a\nthen $b")).toEqual(["b"]);
    expect(mentionedNames("- item\n    with $a")).toEqual(["a"]);
  });
});
