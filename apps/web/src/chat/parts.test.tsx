// The tool call card, rendered with `react-dom/server`: the calls of a code mode script it lists, and the note on those its
// result left out (docs/architecture/workspace.md → The rest of one tool result).

import { RegistryContext } from "@effect/atom-react";
import { describe, expect, it } from "@effect/vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { ShownSession } from "./conversation.ts";
import type { NestedCall, OmittedCalls } from "./nested-calls.ts";
import { ToolCallCard } from "./parts.tsx";

const CALL: NestedCall = { id: "1", name: "read", args: { path: "a.ts" }, status: "ok" };

/** A settled `codemode` card whose artifact is `artifact`. */
const render = (
  artifact: { nested: NestedCall[]; omittedCalls?: OmittedCalls } | { elicitations: unknown[] },
  toolName = "codemode",
) => {
  const registry = AtomRegistry.make();

  const markup = renderToStaticMarkup(
    <RegistryContext.Provider value={registry}>
      <ShownSession.Provider value="s1">
        <ToolCallCard
          type="tool-call"
          toolCallId="t1"
          toolName={toolName}
          args={{}}
          argsText="{}"
          result="done"
          artifact={artifact}
          status={{ type: "complete" }}
          addResult={() => {}}
          resume={() => {}}
          respondToApproval={() => Promise.resolve()}
        />
      </ShownSession.Provider>
    </RegistryContext.Provider>,
  );

  registry.dispose();

  return markup;
};

/** The note about omitted calls in the text of `markup`, if it has one. */
const omittedNote = (markup: string) =>
  /[\d,]+ more calls?(, [\d,]+ failed)?/.exec(markup.replaceAll(/<[^>]*>/g, ""))?.[0];

describe("ToolCallCard's omitted calls", () => {
  it("says how many calls the list left out, and how many of them failed", () => {
    const markup = render({ nested: [CALL], omittedCalls: { count: 1234, failed: 1200 } });

    expect(omittedNote(markup)).toBe("1,234 more calls, 1,200 failed");
  });

  it("says nothing of failures when none of the omitted calls failed", () => {
    expect(omittedNote(render({ nested: [CALL], omittedCalls: { count: 7, failed: 0 } }))).toBe(
      "7 more calls",
    );
  });

  it("uses the singular for one call and one failure", () => {
    expect(omittedNote(render({ nested: [CALL], omittedCalls: { count: 1, failed: 0 } }))).toBe(
      "1 more call",
    );
    expect(omittedNote(render({ nested: [CALL], omittedCalls: { count: 1, failed: 1 } }))).toBe(
      "1 more call, 1 failed",
    );
  });

  it("shows the line when the list is empty", () => {
    const markup = render({ nested: [], omittedCalls: { count: 5, failed: 2 } });

    expect(markup).toContain(">Calls<");
    expect(omittedNote(markup)).toBe("5 more calls, 2 failed");
  });

  it("is absent when the result left no calls out", () => {
    const markup = render({ nested: [CALL] });

    expect(markup).toContain(">Calls<");
    expect(markup).not.toContain("more call");
  });
});

describe("ToolCallCard's MCP questions", () => {
  it("says what became of each question its server asked, and why when cloudpid ended one", () => {
    const text = render(
      {
        elicitations: [
          { server: "docs", action: "accept", by: "owner", fields: ["name", "count"] },
          { server: "docs", action: "decline", by: "owner", fields: [] },
          {
            server: "docs",
            action: "decline",
            by: "cloudpid",
            fields: [],
            reason:
              "it asked for a credential ('API key'), which MCP servers must not ask for in a form",
          },
          {
            server: "docs",
            action: "cancel",
            by: "cloudpid",
            fields: [],
            reason: "the owner did not answer in time",
          },
        ],
      },
      "mcp__docs__ask",
    ).replaceAll(/<[^>]*>/g, "");

    expect(text).toContain("You answered docs&#x27;s form (name, count)");
    expect(text).toContain("You declined docs&#x27;s form");
    expect(text).toContain(
      "cloudpid declined docs&#x27;s form: it asked for a credential (&#x27;API key&#x27;)",
    );
    expect(text).toContain("cloudpid cancelled docs&#x27;s form: the owner did not answer in time");
  });
});
