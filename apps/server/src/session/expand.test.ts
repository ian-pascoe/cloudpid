// @effect-diagnostics asyncFunction:off preferEffectArray:off
import { skillBlock } from "@cloudpid/protocol";
import { describe, expect, it } from "vitest";
import {
  expandMessage,
  mayExpand,
  mentionedNames,
  type NamedSkill,
  withoutCode,
} from "./expand.ts";

const review = { name: "review", filePath: "/workspace/app/.agents/skills/review/SKILL.md" };
const deploy = { name: "deploy", filePath: "/workspace/.agents/skills/deploy/SKILL.md" };
const broken = { name: "broken", filePath: "/workspace/.agents/skills/broken/SKILL.md" };

const BODIES = new Map([
  [review.filePath, "# Review\n\nRead the diff."],
  [deploy.filePath, "# Deploy\n\nShip it."],
]);

const reads: string[] = [];

const options = {
  skills: [review, deploy, broken],
  templates: [{ name: "fix", content: "Fix issue #$1: ${@:2}" }],
  body: (skill: NamedSkill) => {
    reads.push(skill.name);

    return Promise.resolve(BODIES.get(skill.filePath));
  },
};

const block = (skill: NamedSkill) =>
  skillBlock({ name: skill.name, location: skill.filePath, body: BODIES.get(skill.filePath)! });

const expanded = (skills: ReadonlyArray<NamedSkill>) =>
  skills.map(({ name, filePath }) => ({ name, location: filePath }));

describe("expandMessage", () => {
  it("expands /skill:name into local pi's block, then the arguments", async () => {
    expect(await expandMessage("/skill:review  the login change ", options)).toEqual({
      content: `${block(review)}\n\nthe login change`,
      data: { display: "/skill:review  the login change ", skills: expanded([review]) },
    });
    expect(block(review)).toBe(
      '<skill name="review" location="/workspace/app/.agents/skills/review/SKILL.md">\nReferences are relative to /workspace/app/.agents/skills/review.\n\n# Review\n\nRead the diff.\n</skill>',
    );
  });

  it("expands /skill:name alone into the block alone", async () => {
    expect((await expandMessage("/skill:deploy", options))?.content).toBe(block(deploy));
  });

  it("leaves /skill: with an unknown name, or one whose file cannot be read, as typed", async () => {
    expect(await expandMessage("/skill:nope do it", options)).toBeUndefined();
    expect(await expandMessage("/skill:broken do it", options)).toBeUndefined();
  });

  it("puts a block for each Skill named with $ before the typed text, each once", async () => {
    const text = "Use $review, then $deploy and $review again.";

    expect(await expandMessage(text, options)).toEqual({
      content: `${block(review)}\n\n${block(deploy)}\n\n${text}`,
      data: { display: text, skills: expanded([review, deploy]) },
    });
  });

  it("expands the Skills a /skill:'s arguments name with $ after it", async () => {
    expect((await expandMessage("/skill:review then $deploy", options))?.content).toBe(
      `${block(review)}\n\n${block(deploy)}\n\nthen $deploy`,
    );
    expect((await expandMessage("/skill:broken then $deploy", options))?.content).toBe(
      `${block(deploy)}\n\n/skill:broken then $deploy`,
    );
  });

  it("leaves $ that names no Skill alone, $HOME included", async () => {
    expect(await expandMessage("echo $HOME and $nope", options)).toBeUndefined();
    expect((await expandMessage("echo $HOME, $deploy", options))?.data.skills).toEqual(
      expanded([deploy]),
    );
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

    expect(await expandMessage(text, options)).toBeUndefined();
    expect(reads).toEqual([]);
  });

  it("takes $ after a fenced block is closed, and after an unclosed backtick", async () => {
    expect((await expandMessage("```\n$deploy\n```\nnow $review", options))?.data.skills).toEqual(
      expanded([review]),
    );
    expect((await expandMessage("a ` stray $deploy", options))?.data.skills).toEqual(
      expanded([deploy]),
    );
  });

  it("expands a Prompt template's Slash command with its arguments", async () => {
    expect(await expandMessage('/fix 42 "the login" flow', options)).toEqual({
      content: "Fix issue #42: the login flow",
      data: { display: '/fix 42 "the login" flow', skills: [] },
    });
  });

  it("leaves other Slash commands and plain text alone", async () => {
    expect(await expandMessage("/unknown thing", options)).toBeUndefined();
    expect(await expandMessage("/tmp/x is full", options)).toBeUndefined();
    expect(await expandMessage("just text", options)).toBeUndefined();
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
});
