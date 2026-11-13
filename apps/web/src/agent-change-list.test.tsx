// @effect-diagnostics preferEffectArray:off globalDate:off -- the markup is matched over native arrays and a change's time is read against now.

// One Agent change of an MCP server as the Agent changes section lists it: the server and key in words, the values as
// on/off or exposure lines, a whole entry as a line diff, and the note that a value was Global's.

import type { AgentChange } from "@cloudpid/protocol";
import { describe, expect, it } from "vite-plus/test";
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

describe("the byline of an Agent change", () => {
  it("says a Session's agent made it, and that its Session is gone when it is not listed", () => {
    const markup = render(change("variables.API_URL", { before: null, after: "x" }));

    expect(markup).toContain("The agent, just now, with settings_mcp_disable");
    expect(markup).toContain(", in a session that is gone");
  });

  it("says a change over the MCP endpoint was, with the client, and never that a session is gone", () => {
    const markup = render(
      change("variables.API_URL", {
        before: null,
        after: "x",
        session: null,
        conversation: null,
        via: { auth: "oauth", client: { name: "pi", version: "1.2" } },
      }),
    );

    expect(markup).toContain("Changed over MCP · pi, just now");
    expect(markup).not.toContain("The agent");
    expect(markup).not.toContain("a session that is gone");
    expect(markup).not.toContain("1.2");
  });

  it("says a change over the MCP endpoint without a client's name was Changed over MCP", () => {
    const markup = render(
      change("variables.API_URL", {
        session: null,
        conversation: null,
        via: { auth: "local" },
      }),
    );

    expect(markup).toContain("Changed over MCP, just now");
    expect(markup).not.toContain("Changed over MCP ·");
    expect(markup).not.toContain("a session that is gone");
  });
});
