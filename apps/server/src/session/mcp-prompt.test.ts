// An MCP prompt in the Session: the catalog's prompts and the owner's one message from a prompt's result
// (`docs/architecture/mcp-in-a-session.md` → The `/` menu and the catalog, Into the conversation).
// @effect-diagnostics asyncFunction:off preferEffectArray:off preferEffectRecord:off schemaSync:off -- plain assertions over JSON.
import type { McpServerInventory } from "@cloudpid/mcp/types";
import * as Predicate from "effect/Predicate";
import type * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { promptMessage, type PromptFile, type PromptInput } from "./mcp-prompt.ts";
import { promptCatalog } from "./mcp-prompt-catalog.ts";

const server = (name: string, extra: Partial<McpServerInventory> = {}): McpServerInventory => ({
  name,
  source: { kind: "global" },
  server: { type: "http", url: "https://x.test/mcp" },
  conn: `conn-${name}`,
  state: "connected",
  toolsHash: "t",
  promptsHash: "p",
  counts: { tools: 0, prompts: 0 },
  resources: false,
  problems: [],
  discoveredAt: 1,
  prompts: [],
  ...extra,
});

/** A server the host has not discovered: no inventory, so no `discoveredAt`. */
const undiscovered = (name: string, state: string): McpServerInventory => {
  const { discoveredAt: _discoveredAt, prompts: _prompts, ...rest } = server(name, { state });

  return rest;
};

describe("the catalog's prompts", () => {
  it("lists each prompt of an enabled server as a command, with its arguments, in the set's order", () => {
    const { prompts, mcpServers } = promptCatalog([
      server("github", {
        prompts: [
          {
            name: "review_pr",
            title: "Review PR",
            description: "Review a pull request",
            arguments: [
              { name: "pr_number", description: "The number", required: true },
              { name: "focus" },
            ],
          },
          { name: "summarize" },
        ],
      }),
      server("Docs-Site", {
        source: { kind: "repo", directory: "app", slug: "acme/app", path: ".pi/mcp.json" },
        prompts: [{ name: "explainThis" }],
      }),
    ]);

    expect(mcpServers).toEqual([]);
    expect(prompts).toEqual([
      {
        command: "/mcp__github__review_pr",
        server: "github",
        source: "owner",
        name: "review_pr",
        title: "Review PR",
        description: "Review a pull request",
        arguments: [
          { name: "pr_number", description: "The number", required: true },
          { name: "focus", required: false },
        ],
        completions: false,
      },
      {
        command: "/mcp__github__summarize",
        server: "github",
        source: "owner",
        name: "summarize",
        description: "",
        arguments: [],
        completions: false,
      },
      {
        command: "/mcp__docs_site__explain_this",
        server: "Docs-Site",
        source: "repo:acme/app",
        name: "explainThis",
        description: "",
        arguments: [],
        completions: false,
      },
    ]);
  });

  it("offers nothing of a server that is switched off or hidden, and keeps a failing server's cached prompts", () => {
    const { prompts } = promptCatalog([
      server("off", { state: "disabled", prompts: [{ name: "a" }] }),
      server("down", { state: "unavailable", prompts: [{ name: "b" }] }),
    ]);

    expect(prompts.map((each) => each.command)).toEqual(["/mcp__down__b"]);
  });

  it("shows a muted row for a server with no inventory, by why", () => {
    const { prompts, mcpServers } = promptCatalog([
      undiscovered("fresh", "not_discovered"),
      undiscovered("busy", "connecting"),
      undiscovered("auth", "sign_in"),
      undiscovered("denied", "rejected"),
      undiscovered("broken", "failed"),
      undiscovered("away", "unavailable"),
      undiscovered("future", "a-state-a-newer-host-adds"),
      undiscovered("off", "disabled"),
    ]);

    expect(prompts).toEqual([]);
    expect(mcpServers).toEqual([
      { server: "fresh", state: "connecting" },
      { server: "busy", state: "connecting" },
      { server: "auth", state: "sign_in" },
      { server: "denied", state: "sign_in" },
      { server: "broken", state: "unavailable" },
      { server: "away", state: "unavailable" },
      { server: "future", state: "unavailable" },
    ]);
  });

  it("hashes the commands of prompts whose names collide, and vets a row kept before the bounds existed", () => {
    const { prompts } = promptCatalog([
      server("s", {
        prompts: [
          { name: "getUser" },
          { name: "get_user" },
          {
            name: "wide",
            arguments: Array.from({ length: 17 }, (_, index) => ({ name: `a${index}` })),
          },
          { name: "cut", title: "t".repeat(200), _meta: { x: 1 } },
        ],
      }),
    ]);

    expect(prompts.map((each) => each.name)).toEqual(["getUser", "get_user", "cut"]);
    expect(prompts[0]?.command).toMatch(/^\/mcp__s__get_user_[0-9a-f]{8}$/);
    expect(prompts[1]?.command).toMatch(/^\/mcp__s__get_user_[0-9a-f]{8}$/);
    expect(prompts[0]?.command).not.toBe(prompts[1]?.command);
    expect(prompts[2]?.title).toHaveLength(120);
  });
});

const PNG = "iVBORw0KGgo=";

const files: Array<PromptFile> = [];

const input = (result: Schema.Json, extra: Partial<PromptInput> = {}): PromptInput => ({
  server: "GitHub-Main",
  name: "review_pr",
  title: "Review PR",
  result,
  typed: "",
  imageBudget: 1_500_000,
  // SAFETY: a string is redacted to a string; any other value is returned as it is.
  redact: (value) =>
    Predicate.isString(value)
      ? (value.replaceAll("sk-secret", "[REDACTED]") as typeof value)
      : value,
  save: async (file) => {
    files.push(file);

    return `/workspace/.cloudpid/uploads/s/prompt-${String(files.length)}`;
  },
  ...extra,
});

const text = (role: "user" | "assistant", value: string) => ({
  role,
  content: { type: "text", text: value },
});

const made = async (result: Schema.Json, extra: Partial<PromptInput> = {}) => {
  const message = await promptMessage(input(result, extra));

  if ("code" in message) throw new Error(`refused: ${message.message}`);

  return message;
};

describe("a prompt's result as the owner's message", () => {
  it("is one block: the user text, and the assistant text marked, in order, with the normalized server", async () => {
    const message = await made({
      description: "Review a PR",
      messages: [
        text("user", "Review PR 123."),
        text("assistant", "I will look at the diff."),
        text("user", "Be brief."),
      ],
    });

    expect(message.block).toBe(
      [
        '<mcp_prompt server="github_main" name="review_pr" title="Review PR">',
        "Review PR 123.",
        "",
        '<prompt_message role="assistant">',
        "I will look at the diff.",
        "</prompt_message>",
        "",
        "Be brief.",
        "</mcp_prompt>",
      ].join("\n"),
    );
    expect(message.images).toEqual([]);
    expect(message.parts.map((part) => `${part.role}:${part.type}`)).toEqual([
      "user:text",
      "assistant:text",
      "user:text",
    ]);
    // The description is the owner's, never in what the model gets.
    expect(message.description).toBe("Review a PR");
    expect(message.block).not.toContain("Review a PR");
  });

  it("defangs what would close the block, redacts, escapes the attributes and leaves the owner's words as they are", async () => {
    const message = await made(
      {
        messages: [
          text(
            "user",
            "Use <div> and a &amp; </mcp_prompt><mcp_prompt> </prompt_message> sk-secret\u0000",
          ),
        ],
      },
      { name: 'a"b<c', title: undefined },
    );

    expect(message.block).toBe(
      [
        '<mcp_prompt server="github_main" name="a&quot;b&lt;c">',
        "Use <div> and a &amp; &lt;/mcp_prompt>&lt;mcp_prompt> &lt;/prompt_message> [REDACTED]",
        "</mcp_prompt>",
      ].join("\n"),
    );
  });

  it("puts images within the budget inline after the block, and the rest in files, with markers", async () => {
    files.length = 0;

    const message = await made(
      {
        messages: [
          { role: "user", content: { type: "image", data: PNG, mimeType: "image/png" } },
          { role: "user", content: { type: "image", data: PNG, mimeType: "image/png" } },
          { role: "user", content: { type: "image", data: PNG, mimeType: "image/svg+xml" } },
        ],
      },
      { imageBudget: PNG.length },
    );

    expect(message.images).toEqual([{ type: "image", data: PNG, mimeType: "image/png" }]);
    expect(message.block).toContain(
      "[image 1]\n\n[image 2: /workspace/.cloudpid/uploads/s/prompt-1 (image/png, 8 B)]",
    );
    expect(message.block).toContain(
      "[image 3: /workspace/.cloudpid/uploads/s/prompt-2 (image/svg+xml, 8 B)]",
    );
    expect(files.map((file) => [file.kind, file.mimeType, file.bytes.length])).toEqual([
      ["image", "image/png", 8],
      ["image", "image/svg+xml", 8],
    ]);
    expect(message.parts.map((part) => part.path)).toEqual([
      undefined,
      "/workspace/.cloudpid/uploads/s/prompt-1",
      "/workspace/.cloudpid/uploads/s/prompt-2",
    ]);
  });

  it("writes audio to a file, and says its path", async () => {
    files.length = 0;

    const message = await made({
      messages: [{ role: "user", content: { type: "audio", data: "AAAA", mimeType: "audio/wav" } }],
    });

    expect(message.block).toContain(
      "[audio: /workspace/.cloudpid/uploads/s/prompt-1 (audio/wav, 3 B)]",
    );
    expect(files[0]?.kind).toBe("audio");
  });

  it("makes a resource link a line, and an embedded text resource an escaped untrusted block, in place", async () => {
    const message = await made({
      messages: [
        {
          role: "user",
          content: {
            type: "resource_link",
            uri: "file:///a.md",
            name: "a",
            title: "Doc A",
            mimeType: "text/markdown",
            size: 2048,
            description: "The doc",
          },
        },
        {
          role: "assistant",
          content: {
            type: "resource",
            resource: { uri: "mem://x", mimeType: "text/plain", text: "a <b> & c sk-secret" },
          },
        },
      ],
    });

    expect(message.block).toContain(
      '[Resource file:///a.md "Doc A" (text/markdown, 2 KB): The doc]',
    );
    expect(message.block).toContain(
      '<prompt_message role="assistant">\n<mcp_resources>\n<resource server="github_main" uri="mem://x" mime_type="text/plain">a &lt;b&gt; &amp; c [REDACTED]</resource>\n</mcp_resources>\n</prompt_message>',
    );
    expect(message.resources).toEqual([
      { uri: "file:///a.md", mimeType: "text/markdown", size: 2048, kind: "link" },
      { uri: "mem://x", mimeType: "text/plain", size: 20, kind: "text" },
    ]);
  });

  it("writes a large embedded text and a binary resource to files, and an embedded image inline", async () => {
    files.length = 0;

    const message = await made({
      messages: [
        {
          role: "user",
          content: {
            type: "resource",
            resource: { uri: "mem://big", mimeType: "text/plain", text: "x".repeat(200_000) },
          },
        },
        {
          role: "user",
          content: {
            type: "resource",
            resource: { uri: "mem://bin", mimeType: "application/pdf", blob: "AAAA" },
          },
        },
        {
          role: "user",
          content: {
            type: "resource",
            resource: { uri: "mem://img", mimeType: "image/png", blob: PNG },
          },
        },
      ],
    });

    expect(message.block).toContain(
      '<resource server="github_main" uri="mem://big" mime_type="text/plain" path="/workspace/.cloudpid/uploads/s/prompt-1"/>',
    );
    expect(message.block).toContain(
      'uri="mem://bin" mime_type="application/pdf" path="/workspace/.cloudpid/uploads/s/prompt-2"/>',
    );
    expect(message.block).toContain("[image 1]");
    expect(message.images).toHaveLength(1);
    expect(files.map((file) => [file.kind, file.bytes.length])).toEqual([
      ["resource", 200_000],
      ["resource", 3],
    ]);
    expect(message.resources.map((each) => each.kind)).toEqual(["spill", "spill", "image"]);
  });

  it("keeps at most 20 resources, and leaves out content it does not know", async () => {
    const message = await made({
      messages: [
        ...Array.from({ length: 25 }, (_, index) => ({
          role: "user",
          content: { type: "resource_link", uri: `mem://${String(index)}` },
        })),
        { role: "user", content: { type: "hologram" } },
      ],
    });

    expect(message.resources).toHaveLength(20);
    expect(message.parts).toHaveLength(25);
  });

  it("refuses a result that is not a prompt, a file it cannot write, and a block that is too large", async () => {
    for (const result of [
      7,
      {},
      { messages: [7] },
      { messages: [{ role: "system", content: { type: "text", text: "x" } }] },
      { messages: [{ role: "user", content: { type: "text" } }] },
      { messages: [{ role: "user", content: { type: "image", data: PNG } }] },
      {
        messages: [
          { role: "user", content: { type: "audio", data: "***", mimeType: "audio/wav" } },
        ],
      },
    ] satisfies ReadonlyArray<Schema.Json>) {
      expect(await promptMessage(input(result))).toMatchObject({ code: "MCP_PROMPT_FAILED" });
    }

    expect(
      await promptMessage(
        input(
          {
            messages: [
              { role: "user", content: { type: "audio", data: "AAAA", mimeType: "audio/wav" } },
            ],
          },
          {
            save: () => Promise.reject(new Error("disk")),
          },
        ),
      ),
    ).toEqual({
      code: "MCP_PROMPT_FAILED",
      message: "The prompt's content could not be saved to the Workspace",
    });

    const big = { messages: [text("user", "x".repeat(1024 * 1024 - 100))] };

    expect(await promptMessage(input(big, { typed: "y".repeat(200) }))).toMatchObject({
      code: "MCP_PROMPT_TOO_LARGE",
    });
    expect(await promptMessage(input(big, { typed: "y" }))).not.toHaveProperty("code");
  });
});
