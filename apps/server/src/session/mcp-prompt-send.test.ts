// The pure parts of sending an MCP prompt: the order of the message's parts, and how the owner's input is split.
// @effect-diagnostics preferEffectArray:off -- plain fixtures.
import { UPLOADS_ROOT } from "@cloudpid/protocol";
import { describe, expect, it } from "vitest";
import {
  imageCharacters,
  promptContent,
  promptPartCount,
  typedAndBeside,
} from "./mcp-prompt-send.ts";

const image = (data: string) => ({ type: "image" as const, data, mimeType: "image/png" });

describe("the parts of a message that got an MCP prompt", () => {
  it("are the block and the prompt's images, then the typed text, then what came beside it", () => {
    const made = { block: "<mcp_prompt/>", images: [image("P1"), image("P2")] };
    const beside = [{ type: "text" as const, text: `@${UPLOADS_ROOT}/s/a.txt` }, image("OWN")];

    expect(promptContent(made, "my words", beside)).toEqual([
      { type: "text", text: "<mcp_prompt/>" },
      image("P1"),
      image("P2"),
      { type: "text", text: "my words" },
      ...beside,
    ]);
    // The prompt's own parts are the block and its images: Attached pages are placed after them.
    expect(promptPartCount(made)).toBe(3);
    expect(promptContent(made, "", [])).toHaveLength(promptPartCount(made));
  });
});

describe("the owner's input beside an MCP prompt", () => {
  it("is the typed text and the other blocks, or no typed text when the first text is the Attachments' paths", () => {
    expect(typedAndBeside("go")).toEqual({ typed: "go", beside: [] });
    expect(typedAndBeside([{ type: "text", text: "go" }, image("A")])).toEqual({
      typed: "go",
      beside: [image("A")],
    });

    const paths = [{ type: "text" as const, text: `@${UPLOADS_ROOT}/s/a.txt` }, image("A")];

    expect(typedAndBeside(paths)).toEqual({ typed: "", beside: paths });
    expect(imageCharacters([image("AAAA"), image("BB")])).toBe(6);
  });
});
