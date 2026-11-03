// @effect-diagnostics preferEffectArray:off globalDate:off -- the markup is matched over native arrays and a change's time is read against now.

// One Agent change of an MCP server as the Agent changes section lists it: the server and key in words, the values as
// on/off or exposure lines, a whole entry as a line diff, and the note that a value was Global's.

import type { AgentChange } from "@cloudpid/protocol";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentChangeRow } from "./agent-change-list.tsx";

const change = (field: string, more: Partial<AgentChange>): AgentChange => ({
  id: 4,
  scope: "work",
  at: Date.now(),
  actor: "agent",
  session: "s-1",
  conversation: 1,
  tool: "settings_mcp_disable",
  reason: "It was noisy",
  field,
  before: true,
  after: false,
  reverts: null,
  revertedBy: null,
  ...more,
});

const render = (found: AgentChange): string =>
  renderToStaticMarkup(
    <ul>
      <AgentChangeRow
        change={found}
        session={undefined}
        reverting={false}
        onRevert={() => undefined}
        dismissing={false}
        onDismiss={() => undefined}
      />
    </ul>,
  );

describe("an Agent change of an MCP server", () => {
  it("says the server and key, with the values in words, and a revert", () => {
    const markup = render(change("mcp.servers.linear.enabled", {}));

    expect(markup).toContain('id="agent-change-4"');
    expect(markup).toContain("MCP server linear · on/off");
    expect(markup).toContain(">on</pre>");
    expect(markup).toContain(">off</pre>");
    expect(markup).toContain("Revert change 4");
  });

  it("says a value was inherited from Global, and one not set", () => {
    const markup = render(
      change("mcp.servers.linear.exposure", {
        before: "direct",
        beforeInherited: true,
        after: "hidden",
      }),
    );

    expect(markup).toContain("Before · Inherited from Global");
    expect(markup).not.toContain("After ·");
    expect(markup).toContain(">direct</pre>");
    expect(render(change("mcp.servers.linear.exposure", { before: null }))).toContain(
      ">not set</pre>",
    );
  });

  it("shows each tool exposure key on a line", () => {
    const markup = render(
      change("mcp.servers.linear.toolExposure", {
        before: {},
        after: { "delete_*": "hidden" },
      }),
    );

    expect(markup).toContain("no keys");
    expect(markup).toContain("delete_* → hidden");
  });

  it("shows a whole entry as a line diff, with Global's entry noted as inherited", () => {
    const markup = render(
      change("mcp.servers.linear", {
        before: { url: "https://mcp.linear.app", enabled: true },
        beforeInherited: true,
        after: { url: "https://mcp.linear.app", enabled: false },
      }),
    );

    expect(markup).toContain("MCP server linear");
    expect(markup).toContain("Before: Global&#x27;s entry (inherited)");
    expect(markup).toContain("&quot;enabled&quot;: false");
  });
});
