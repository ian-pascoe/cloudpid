import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import { promptArgumentLines, promptHead, promptSegments } from "./prompt-disclosure.ts";

describe("an MCP prompt in the transcript", () => {
  it("heads the chip with the server and the title, else the name", () => {
    expect(promptHead({ server: "docs", name: "review", title: "Review PR" })).toBe(
      "MCP prompt · docs · Review PR",
    );
    expect(promptHead({ server: "docs", name: "review" })).toBe("MCP prompt · docs · review");
  });

  it("lists the arguments on one line each, cut, and leaves an empty one out", () => {
    const lines = promptArgumentLines({
      arguments: { pr: "7", note: "a\nb  c", skipped: " ", long: "x".repeat(200) },
    });

    expect(lines.slice(0, 2)).toEqual(["pr: 7", "note: a b c"]);
    expect(lines).toHaveLength(3);
    expect(lines[2]?.endsWith("…")).toBe(true);
    expect(lines[2]?.length).toBeLessThan(100);
  });

  it("reads the block back into the messages it came from", () => {
    const block = Arr.join(
      [
        '<mcp_prompt server="docs" name="review" title="Review PR">',
        "Review pull request 7.",
        "",
        '<prompt_message role="assistant">',
        "I will start with the tests.",
        "</prompt_message>",
        "",
        "Then the docs.",
        "</mcp_prompt>",
      ],
      "\n",
    );

    expect(promptSegments(block)).toEqual([
      { role: "user", text: "Review pull request 7." },
      { role: "assistant", text: "I will start with the tests." },
      { role: "user", text: "Then the docs." },
    ]);
  });

  it("shows a block that does not read as one whole, and an empty one as no messages", () => {
    expect(promptSegments("just text")).toEqual([{ role: "user", text: "just text" }]);
    expect(promptSegments('<mcp_prompt server="a" name="b">\n\n</mcp_prompt>')).toEqual([]);
  });
});
