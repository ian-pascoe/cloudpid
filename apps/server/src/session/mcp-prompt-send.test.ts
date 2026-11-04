// The pure parts of sending an MCP prompt: the order of the message's parts, and how the owner's input is split.
// @effect-diagnostics preferEffectArray:off -- plain fixtures.
import type { PromptSummaries } from "@cloudpid/extensions/mcp";
import { UPLOADS_ROOT } from "@cloudpid/protocol";
import { describe, expect, it } from "vitest";
import {
  imageCharacters,
  NO_SUMMARIES,
  promptContent,
  promptData,
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

describe("what the entry keeps of an MCP prompt (`promptData`)", () => {
  const entry = { server: "docs", command: "/mcp__docs__review", name: "review", title: "Review" };
  const made = { description: undefined, parts: [], resources: [] };

  const asked: PromptSummaries = {
    elicitation: [
      { server: "docs", mode: "form", action: "accept", by: "owner", fields: ["team"] },
      {
        server: "docs",
        mode: "url",
        action: "cancel",
        by: "cloudpid",
        reason: "x",
        fields: [],
        host: "login.example.com",
      },
    ],
    sampling: [{ server: "docs", status: "answered", by: "owner", role: "small", tokens: 12 }],
  };

  it("adds what the server's questions came to, in order, and nothing for a get that asked none", () => {
    expect(promptData(entry, {}, made, NO_SUMMARIES)).not.toHaveProperty("elicitation");
    expect(promptData(entry, {}, made, NO_SUMMARIES)).not.toHaveProperty("sampling");
    expect(promptData(entry, {}, made, { elicitation: [], sampling: [] })).not.toHaveProperty(
      "sampling",
    );

    expect(promptData(entry, {}, made, asked)).toMatchObject({
      elicitation: asked.elicitation,
      sampling: asked.sampling,
    });
  });

  it("keeps the first 20 of each kind", () => {
    const many = {
      elicitation: Array.from({ length: 25 }, () => asked.elicitation[0]!),
      sampling: Array.from({ length: 25 }, () => asked.sampling[0]!),
    };

    const data = promptData(entry, {}, made, many);

    expect(data.elicitation).toHaveLength(20);
    expect(data.sampling).toHaveLength(20);
  });
});
