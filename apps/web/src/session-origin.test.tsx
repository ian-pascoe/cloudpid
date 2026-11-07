// What a Session came from, under its title: the chip of a Session the MCP endpoint started or imported, rendered with
// `react-dom/server`; or Trigger · <name> for one a Trigger's Fire started.
import type { SessionRecord } from "@cloudpid/protocol";
import { describe, expect, it } from "@effect/vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Origin } from "./session-origin.tsx";

const session = (extra: Partial<SessionRecord>): SessionRecord => ({
  id: "0190f0a8-1b2c-7d3e-8f40-123456789abc",
  title: "A Session",
  titleSource: "owner",
  environment: "default",
  workspace: "abcd1234",
  status: "idle",
  createdAt: 1,
  updatedAt: 1,
  archivedAt: null,
  ...extra,
});

describe("the Session's origin chip", () => {
  it("is MCP · <client> for a Session started over MCP, and Imported · <client> for an import", () => {
    expect(
      renderToStaticMarkup(
        <Origin
          session={session({ marks: { kind: "mcp", auth: "oauth", client: { name: "pi" } } })}
        />,
      ),
    ).toBe("MCP · pi");
    expect(
      renderToStaticMarkup(
        <Origin
          session={session({
            marks: { kind: "import", auth: "service_token", client: { name: "pi" } },
          })}
        />,
      ),
    ).toBe("Imported · pi");
  });

  it("is MCP alone when the caller gave no name, and nothing for a Session started afresh", () => {
    expect(
      renderToStaticMarkup(<Origin session={session({ marks: { kind: "mcp", auth: "local" } })} />),
    ).toBe("MCP");
    expect(renderToStaticMarkup(<Origin session={session({})} />)).toBe("");
  });

  it("is Trigger · <name> for a Session a Trigger's Fire started", () => {
    expect(
      renderToStaticMarkup(
        <Origin
          session={session({
            marks: {
              kind: "trigger",
              auth: "trigger",
              trigger: { id: "t1", name: "Weekly report" },
            },
          })}
        />,
      ),
    ).toBe("Trigger · Weekly report");
  });
});
