import type { ConversationId, McpTask } from "@cloudpid/protocol";
import { describe, expect, it } from "@effect/vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { McpTaskStripView } from "./mcp-task-strip.tsx";

const task = (more: Partial<McpTask> = {}): McpTask => ({
  task: "mcp-task-1",
  server: "docs",
  tool: "mcp__docs__index",
  status: "working",
  background: false,
  callId: "call-1",
  // SAFETY: a number is what the Session sends for a conversation ID.
  conversationId: 1 as ConversationId,
  startedAt: 0,
  ...more,
});

const render = (shown: McpTask, disabled = false) =>
  renderToStaticMarkup(
    <McpTaskStripView
      task={shown}
      now={42_000}
      disabled={disabled}
      onCancel={() => Promise.resolve(null)}
      onKeep={() => Promise.resolve(null)}
    />,
  );

describe("McpTaskStripView", () => {
  it("reads a call that waits inline with its status and Cancel", () => {
    const markup = render(task({ statusMessage: "indexing <b>" }));

    expect(markup).toContain("Running as an MCP task · indexing &lt;b&gt; · 0:42");
    expect(markup).toContain("Cancel");
    expect(markup).not.toContain("Keep the Container");
  });

  it("warns of the Container and offers to keep it for a stdio task in the background", () => {
    const markup = render(task({ background: true, stdio: true }));

    expect(markup).toContain("In the background");
    expect(markup).toContain("Keep the Container");
    expect(markup).toContain("Container");
    expect(render(task({ background: true }))).not.toContain("Keep the Container");
  });

  it("is off while the Session is not live and while a cancel is asked, and offers nothing once it ended", () => {
    expect(render(task(), true)).toMatch(/<button[^>]*disabled[^>]*>Cancel/);
    expect(render(task({ cancel: { by: "owner", at: 1 } }))).toContain("Cancelling…");
    expect(render(task({ cancel: { by: "owner", at: 1 } }))).toMatch(/<button[^>]*disabled/);

    const ended = render(
      task({
        status: "unknown",
        endedAt: 9_000,
        end: { by: "cloudpid", reason: "the Container stopped" },
      }),
    );

    expect(ended).toContain("cloudpid lost track of it: the Container stopped");
    expect(ended).not.toContain("Cancel");
  });
});
