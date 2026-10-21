// Ported whole from the owner's pi-skills-selector (`test/skill-references.test.ts`), but for the cases of
// `getSkillReferencePrefix`, the composer's completion, which the Session does not port; the catalogue entries use
// `filePath`, as the Session's Skills do. The last cases are the Session's own.
import { describe, expect, it } from "vitest";
import { linkSkillReferences, type ReferencedSkill } from "./skill-references.ts";

const skills: ReferencedSkill[] = [
  { name: "review", filePath: "/skills/review/SKILL.md" },
  { name: "test-first", filePath: "/skills/test-first/SKILL.md" },
];

const link = linkSkillReferences;

describe("Skill References", () => {
  it("only replaces exact original spelling when Markdown removes an escape", () => {
    const text = "| $a\\|b |\n| --- |";
    expect(link(text, [{ name: "a|b", filePath: "/skills/pipe/SKILL.md" }])).toBe(text);
  });

  it("maps table cells after escaped pipes without moving references between rows", () => {
    const text =
      "| a\\|b | $review |\n| --- | --- |\n| `a\\|$review` | $review |\n| row | extra | $review |\n| $review | last |";

    expect(link(text, skills)).toBe(
      "| a\\|b | [$review](/skills/review/SKILL.md) |\n| --- | --- |\n| `a\\|$review` | [$review](/skills/review/SKILL.md) |\n| row | extra | $review |\n| [$review](/skills/review/SKILL.md) | last |",
    );
  });
  it("links table prose while preserving literal cells", () => {
    expect(
      link("| $review | `$review` |\n| --- | --- |\n| [$review](/target) | $test-first |", skills),
    ).toBe(
      "| [$review](/skills/review/SKILL.md) | `$review` |\n| --- | --- |\n| [$review](/target) | [$test-first](/skills/test-first/SKILL.md) |",
    );
  });

  it("uses catalogue names even when Pi reports naming warnings", () => {
    const catalogue: ReferencedSkill[] = [
      { name: "style.guide", filePath: "/skills/style/SKILL.md" },
      { name: "c++", filePath: "/skills/cpp/SKILL.md" },
    ];

    expect(link("$style.guide and $c++.", catalogue)).toBe(
      "[$style.guide](/skills/style/SKILL.md) and [$c++](/skills/cpp/SKILL.md).",
    );
    expect(link("$review.extra", skills)).toBe("$review.extra");
  });

  it("projects tab-expanded list content and native single-tilde formatting", () => {
    expect(link("- $review\n\ttext", skills)).toBe("- [$review](/skills/review/SKILL.md)\n\ttext");
    expect(link("~$review~", skills)).toBe("~[$review](/skills/review/SKILL.md)~");
  });

  it("uses block-local inline contexts and strips link continuation prefixes", () => {
    for (const text of ["> [$review](\n> /target\n> )", "- [$review](\n  /target\n  )"]) {
      expect(link(text, skills)).toBe(text);
    }

    expect(link("`literal\n\n$review\n\n`", skills)).toBe(
      "`literal\n\n[$review](/skills/review/SKILL.md)\n\n`",
    );
    expect(link("[text](\n\n$review)", skills)).toBe(
      "[text](\n\n[$review](/skills/review/SKILL.md))",
    );
  });

  it("handles a large pasted blockquote without overflowing source projection", () => {
    const prefix = `> ${"x".repeat(150_000)} `;
    expect(link(`${prefix}$review`, skills)).toBe(`${prefix}[$review](/skills/review/SKILL.md)`);
  });

  it("keeps token boundaries when Markdown splits adjacent escape tokens", () => {
    expect(link(String.raw`\$$review`, skills)).toBe(String.raw`\$$review`);
    expect(link(String.raw`\_$review $review\_extra`, skills)).toBe(
      String.raw`\_$review $review\_extra`,
    );
    expect(link(String.raw`\\$review`, skills)).toBe(
      String.raw`\\[$review](/skills/review/SKILL.md)`,
    );
  });

  it("encodes absolute link destinations without changing their target", () => {
    expect(link("$review", [{ name: "review", filePath: "/tmp/a b(1)#draft?%/語/SKILL.md" }])).toBe(
      "[$review](/tmp/a%20b%281%29%23draft%3F%25/%E8%AA%9E/SKILL.md)",
    );
    expect(link("$review", [{ name: "review", filePath: "relative/SKILL.md" }])).toBe("$review");
  });

  it("honors nested code containers without extending them into following prose", () => {
    const literal = "> ```\r\n> $review";
    expect(link(`${literal}\r\n\r\n$review`, skills)).toBe(
      `${literal}\r\n\r\n[$review](/skills/review/SKILL.md)`,
    );
    expect(link("- ```\n  $review", skills)).toBe("- ```\n  $review");
    expect(link("- $review\n  - ```\n    $review\n    ```\n\n$test-first", skills)).toBe(
      "- [$review](/skills/review/SKILL.md)\n  - ```\n    $review\n    ```\n\n[$test-first](/skills/test-first/SKILL.md)",
    );
  });

  it("preserves multiline, reference, shortcut and automatic links and their definitions", () => {
    const literal =
      '[$review](\r\n/target "$review")\r\n[$review][guide] [$review][]\r\n<https://example.test/$review>\r\n\r\n[guide]: /$review\r\n[$review]: /target\r\n  "$review"';

    expect(link(`${literal}\r\n\r\n$review`, skills)).toBe(
      `${literal}\r\n\r\n[$review](/skills/review/SKILL.md)`,
    );
  });

  it("preserves fenced and indented code with original CRLF and tabs", () => {
    const literal =
      "```ts\r\n$review\r\n````\r\n\r\n    $review\r\n\t$review\r\n\r\n~~~\r\n$review\r\n~~~";

    expect(link(`${literal}\r\n\r\n$test-first`, skills)).toBe(
      `${literal}\r\n\r\n[$test-first](/skills/test-first/SKILL.md)`,
    );
    const unfinished = "before\n~~~text\n$review";
    expect(link(unfinished, skills)).toBe(unfinished);
  });

  it("preserves code, links, and escapes while linking formatted prose", () => {
    const literal = "`$review` ``a `$review` b`` [$review](/docs) ![$review](/image) \\$review";
    const result = link(`${literal} **$review** and _$test-first_.`, skills);
    expect(result).toBe(
      `${literal} **[$review](/skills/review/SKILL.md)** and _[$test-first](/skills/test-first/SKILL.md)_.`,
    );
    expect(link(result, skills)).toBe(result);
  });

  it("links known references in order without changing surrounding source", () => {
    expect(link("😀 Use $review, then $test-first.\r\nAgain $review!", skills)).toBe(
      "😀 Use [$review](/skills/review/SKILL.md), then [$test-first](/skills/test-first/SKILL.md).\r\nAgain [$review](/skills/review/SKILL.md)!",
    );
  });

  it("matches complete names and leaves dollar expressions and escaped references literal", () => {
    const text =
      "$unknown $HOME ${review} $$review $1 $review-extra $review_thing é$review $reviewé \\$review";

    expect(link(text, skills)).toBe(text);
    expect(link("($review).", skills)).toBe("([$review](/skills/review/SKILL.md)).");
  });

  it("links the text of brackets that are not a link", () => {
    expect(link("[$review] and [$review][nothing]", skills)).toBe(
      "[[$review](/skills/review/SKILL.md)] and [[$review](/skills/review/SKILL.md)][nothing]",
    );
  });

  it("links no path that is not well formed, no other case, and nothing without a catalogue", () => {
    expect(link("$review", [{ name: "review", filePath: "/bad\uD800/SKILL.md" }])).toBe("$review");
    expect(link("$Review foo_$review", skills)).toBe("$Review foo_$review");
    expect(link("$review", [])).toBe("$review");
    expect(link("no dollars here", skills)).toBe("no dollars here");
  });
});
