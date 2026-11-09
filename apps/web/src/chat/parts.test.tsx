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
  artifact: { nested: NestedCall[]; omittedCalls?: OmittedCalls } | { samplings: unknown[] },
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

describe("ToolCallCard's MCP model use", () => {
  it("says what became of each request its server made to use a model, and opens the ones with a record", () => {
    const markup = render(
      {
        samplings: [
          {
            server: "docs",
            status: "answered",
            by: "owner",
            role: "small",
            model: "m/small",
            tokens: 1200,
            id: "s-1",
          },
          { server: "docs", status: "refused", by: "grant", grant: "session" },
          { server: "docs", status: "refused", by: "cloudpid", reason: "over the Spend limit" },
        ],
      },
      "mcp__docs__sample",
    );

    const text = markup.replaceAll(/<[^>]*>/g, "");

    expect(markup).toContain(">Model use<");
    expect(text).toContain("You let docs use a model (small · m/small, 1.2k tokens)");
    expect(text).toContain(
      "You refused docs&#x27;s request to use a model, as you chose for this Session",
    );
    expect(text).toContain(
      "cloudpid refused docs&#x27;s request to use a model: over the Spend limit",
    );
    // Only the one with a record is a disclosure.
    expect(markup.match(/<details/g)?.length).toBe(2);
  });
});
