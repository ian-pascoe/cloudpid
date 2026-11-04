import type { ConversationId, McpWatchEntry } from "@cloudpid/protocol";
import { describe, expect, it } from "@effect/vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { WatchedResources } from "./watched-resources.tsx";

const watch = (conversationId: number, uri: string): McpWatchEntry => ({
  // SAFETY: a number is what the Session sends for a conversation ID.
  conversationId: conversationId as ConversationId,
  server: "docs",
  uri,
});

const render = (watches: ReadonlyArray<McpWatchEntry>, live = true) =>
  renderToStaticMarkup(
    <WatchedResources
      watches={watches}
      holder={(each) => (each.conversationId === 1 ? undefined : "agent-1")}
      live={live}
      onEnd={() => undefined}
    />,
  );

describe("WatchedResources", () => {
  it("renders nothing when no resource is watched", () => {
    expect(render([])).toBe("");
  });

  it("lists each watch with a ✕ to end it, and the subagent that holds it when it is not the root", () => {
    const html = render([watch(1, "file:///a.md"), watch(2, "file:///b.md")]);

    expect(html).toContain("Watched resources");
    expect(html).toContain("file:///a.md");
    expect(html).toContain("(agent-1)");
    expect(html.match(/<button/g)).toHaveLength(2);
    expect(html).toContain('aria-label="Stop watching file:///a.md on docs"');
    expect(html).not.toContain(' disabled=""');
  });

  it("turns the ✕ off while the Session is not live", () => {
    expect(render([watch(1, "file:///a.md")], false)).toContain(' disabled=""');
  });
});
