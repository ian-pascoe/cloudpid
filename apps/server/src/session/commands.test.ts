// @effect-diagnostics preferEffectArray:off
import type { EntryRecord } from "@earendil-works/pi-durable";
import { SESSION_COMMANDS } from "@cloudpid/protocol";
import { describe, expect, it } from "vitest";
import { catalogOf, exportMarkdown, markdownExport } from "./commands.ts";

/** The parts of pi's entries a fixture sets. */
type FixtureValue =
  | string
  | number
  | boolean
  | null
  | readonly FixtureValue[]
  | { readonly [key: string]: FixtureValue };

// SAFETY: a fixture holds only the fields the projection reads; plain numbers stand in for the branded IDs.
const entry = (fields: { readonly [key: string]: FixtureValue }): EntryRecord => fields as never;

describe("catalogOf", () => {
  it("lists the server commands, then the templates and every Skill, in the order found", () => {
    expect(
      catalogOf(
        [
          {
            name: "review",
            description: "Review",
            filePath: "/a/SKILL.md",
            disableModelInvocation: false,
          },
          {
            name: "release",
            description: "Release",
            filePath: "/b/SKILL.md",
            disableModelInvocation: true,
          },
        ],
        [
          {
            name: "fix",
            description: "Fix it",
            argumentHint: "<issue>",
            filePath: "/p/fix.md",
          },
          { name: "plan", description: "Plan", filePath: "/p/plan.md" },
        ],
        true,
      ),
    ).toEqual({
      commands: SESSION_COMMANDS,
      templates: [
        { name: "fix", description: "Fix it", argumentHint: "<issue>" },
        { name: "plan", description: "Plan" },
      ],
      skills: [
        { name: "review", description: "Review" },
        { name: "release", description: "Release" },
      ],
    });
  });

  it("leaves /rollover out where the agent cannot roll over", () => {
    expect(catalogOf([], [], false).commands.map(({ name }) => name)).toEqual([
      "compact",
      "todo",
      "export",
    ]);
  });
});

describe("exportMarkdown", () => {
  it("writes the whole History: typed messages, answers, calls, results and notices", () => {
    const markdown = exportMarkdown(
      1,
      [
        entry({
          id: 1,
          kind: "cloudpid.user",
          data: {
            display: "/skill:review it",
            skills: [{ name: "review", location: "/s/SKILL.md" }],
          },
          model: [{ role: "user", content: "<skill …>\n\nit", timestamp: 1 }],
        }),
        entry({
          id: 2,
          kind: "pi.assistant",
          model: [
            {
              role: "assistant",
              content: [
                { type: "thinking", thinking: "Hmm" },
                { type: "text", text: "Looking." },
                { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } },
              ],
              stopReason: "toolUse",
              timestamp: 2,
            },
          ],
        }),
        entry({
          id: 3,
          kind: "pi.tool",
          model: [
            {
              role: "toolResult",
              toolCallId: "c1",
              toolName: "read",
              content: [{ type: "text", text: "const a = ```;" }],
              isError: false,
              timestamp: 3,
            },
          ],
        }),
        entry({
          id: 4,
          kind: "pi.reset",
          model: [{ role: "user", content: "Handoff text", timestamp: 4 }],
        }),
        entry({ id: 5, kind: "pi.system", model: [{ role: "system", content: "Prompt" }] }),
      ],
      "2026-01-02T00:00:00.000Z",
    );

    expect(markdown).toBe(
      [
        "# Conversation 1",
        "_Exported 2026-01-02T00:00:00.000Z_",
        "## Owner",
        "/skill:review it",
        "_Skills: `review`_",
        "## Agent",
        "<details><summary>Thinking</summary>\n\nHmm\n\n</details>",
        "Looking.",
        '**Tool call** `read`\n\n```json\n{\n  "path": "a.ts"\n}\n```',
        "**Tool result** `read`\n\n````\nconst a = ```;\n````",
        "### Handoff",
        "Handoff text",
      ].join("\n\n") + "\n",
    );
  });
});

describe("markdownExport", () => {
  const said = (id: number, text: string) =>
    entry({ id, kind: "pi.user", model: [{ role: "user", content: text, timestamp: id }] });

  it("counts each part as its JSON string weighs, escapes included, and stops past the limit", () => {
    const header = exportMarkdown(1, [], "now");
    // The header's JSON weight: newlines are two bytes there, as are the quotes and backslashes of the text below.
    const base = JSON.stringify(header).length - 2;
    const part = `## Owner\n\n${'"'.repeat(10)}`;
    const weight = JSON.stringify(`\n\n${part}`).length - 2;

    const fits = markdownExport(1, "now", base + weight);

    expect(fits.add([said(1, '"'.repeat(10))])).toBe(true);
    expect(JSON.stringify(fits.markdown()).length - 2).toBe(base + weight);

    const over = markdownExport(1, "now", base + weight - 1);

    expect(over.add([said(1, '"'.repeat(10))])).toBe(false);
    // Multi-byte text counts in UTF-8 bytes.
    expect(markdownExport(1, "now", base + 20).add([said(1, "é".repeat(10))])).toBe(false);
  });

  it("builds the export a page at a time", () => {
    const built = markdownExport(1, "now");

    expect(built.add([said(1, "One")])).toBe(true);
    expect(built.add([said(2, "Two")])).toBe(true);
    expect(built.markdown()).toBe(exportMarkdown(1, [said(1, "One"), said(2, "Two")], "now"));
  });
});
