// @effect-diagnostics preferEffectArray:off
import type { EntryRecord } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { catalogOf, exportMarkdown, SERVER_COMMANDS } from "./commands.ts";

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
            content: "x",
            filePath: "/p/fix.md",
          },
          { name: "plan", description: "Plan", content: "y", filePath: "/p/plan.md" },
        ],
      ),
    ).toEqual({
      commands: SERVER_COMMANDS,
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

  it("offers /compact, /rollover, /todo clear and /export", () => {
    expect(SERVER_COMMANDS.map(({ name }) => name)).toEqual([
      "compact",
      "rollover",
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
          data: { display: "$review it", skills: [{ name: "review", location: "/s/SKILL.md" }] },
          model: [{ role: "user", content: "<skill …>\n\n$review it", timestamp: 1 }],
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
        "$review it",
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
