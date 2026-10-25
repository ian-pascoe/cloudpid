import { describe, expect, it } from "vitest";
import { messageText } from "./message-text.ts";

describe("a copied message's text", () => {
  it("is its text parts, a blank line between each, without its tool calls or thinking", () => {
    expect(
      messageText([
        { type: "reasoning", text: "Let me look." },
        { type: "text", text: "First I read it.\n" },
        { type: "tool-call" },
        { type: "text", text: "  " },
        { type: "text", text: "**Done.**" },
      ]),
    ).toBe("First I read it.\n\n**Done.**");
  });

  it("is empty for a message without text", () => {
    expect(messageText([{ type: "image" }])).toBe("");
  });
});
