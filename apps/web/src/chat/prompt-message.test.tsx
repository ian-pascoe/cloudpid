// The MCP prompt in the owner's message, rendered with `react-dom/server`: the chip, the arguments, and the closed
// block the model got.

import { RegistryContext } from "@effect/atom-react";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { renderToStaticMarkup } from "react-dom/server";
import type { ShownMcpPrompt } from "../session/thread-messages.ts";
import { ShownSession } from "./conversation.ts";
import { McpPromptChipLine, McpPromptDisclosure } from "./prompt-message.tsx";

const PROMPT: ShownMcpPrompt = {
  server: "docs",
  command: "/mcp__docs__review",
  name: "review",
  title: "Review PR",
  arguments: { pr: "7" },
  description: "Reviews a pull request.",
  parts: [],
  resources: [{ uri: "file:///repo/notes.md", kind: "link" }],
  text: Arr.join(
    [
      '<mcp_prompt server="docs" name="review" title="Review PR">',
      "Review pull request 7 <b>now</b>.",
      "",
      '<prompt_message role="assistant">',
      "Starting with the tests.",
      "</prompt_message>",
      "</mcp_prompt>",
    ],
    "\n",
  ),
};

const render = (prompt: ShownMcpPrompt) => {
  const registry = AtomRegistry.make();

  const markup = renderToStaticMarkup(
    <RegistryContext.Provider value={registry}>
      <ShownSession.Provider value="s1">
        <McpPromptChipLine prompt={prompt} />
        <p>typed text</p>
        <McpPromptDisclosure prompt={prompt} messageId="4" />
      </ShownSession.Provider>
    </RegistryContext.Provider>,
  );

  registry.dispose();

  return markup;
};

describe("an MCP prompt in the owner's message", () => {
  it("shows the chip with its arguments, and the block closed under it", () => {
    const markup = render(PROMPT);

    expect(markup).toContain("MCP prompt · docs · Review PR");
    expect(markup).toContain("pr: 7");
    expect(markup).toContain("Reviews a pull request.");
    expect(markup).toContain("What the model got");
    expect(markup).not.toContain("<details open");
  });

  it("puts the chip line above the typed text and the closed block below it", () => {
    const markup = render(PROMPT);

    expect(markup.indexOf("MCP prompt · docs")).toBeLessThan(markup.indexOf("typed text"));
    expect(markup.indexOf("typed text")).toBeLessThan(markup.indexOf("What the model got"));
  });

  it("quotes the assistant's messages in the prompt as the prompt's", () => {
    const markup = render(PROMPT);

    expect(markup).toContain("Assistant (from the prompt)");
    expect(markup).toContain("Starting with the tests.");
    expect(markup).not.toContain("&lt;prompt_message");
  });

  it("shows the prompt's text as text, never as markup, and lists its resources", () => {
    const markup = render(PROMPT);

    expect(markup).toContain("&lt;b&gt;now&lt;/b&gt;");
    expect(markup).not.toContain("<b>");
    expect(markup).toContain("link · file:///repo/notes.md");
  });

  it("tells of each question cloudpid ended unseen, in the call card's words, and not of what the owner answered", () => {
    const markup = render({
      ...PROMPT,
      elicitation: [
        {
          server: "docs",
          mode: "form",
          action: "decline",
          by: "cloudpid",
          reason: "it asked for a credential ('API token')",
          fields: [],
        },
        { server: "docs", mode: "form", action: "accept", by: "owner", fields: ["team"] },
        { server: "docs", mode: "url", action: "decline", by: "owner", fields: [] },
      ],
      sampling: [
        { server: "docs", status: "refused", by: "cloudpid", reason: "over the budget" },
        { server: "docs", status: "refused", by: "owner" },
        { server: "docs", status: "answered", by: "owner" },
      ],
    });

    expect(markup).toContain(
      "cloudpid declined docs&#x27;s form: it asked for a credential (&#x27;API token&#x27;)",
    );
    expect(markup).toContain(
      "cloudpid refused docs&#x27;s request to use a model: over the budget",
    );
    expect(markup).not.toContain("You answered");
    expect(markup).not.toContain("You refused");
    expect(markup).not.toContain("You declined");
  });

  it("shows no line for the questions of a prompt that asked none, or only the owner answered", () => {
    expect(render(PROMPT)).not.toContain("Questions cloudpid ended");
    expect(
      render({
        ...PROMPT,
        elicitation: [
          { server: "docs", mode: "form", action: "accept", by: "owner", fields: ["team"] },
        ],
      }),
    ).not.toContain("Questions cloudpid ended");
  });

  it("shows no arguments list for a prompt that took none", () => {
    expect(render({ ...PROMPT, arguments: {} })).not.toContain("Prompt arguments");
  });
});
