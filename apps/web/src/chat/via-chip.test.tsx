// The chip that marks an input sent over the MCP endpoint, rendered with `react-dom/server`.
import { describe, expect, it } from "@effect/vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ViaChip } from "./via-chip.tsx";

describe("the input's via chip", () => {
  it("names the client: via pi (MCP)", () => {
    const markup = renderToStaticMarkup(
      <ViaChip via={{ auth: "oauth", client: { name: "claude-code", version: "2.1" } }} />,
    );

    expect(markup).toContain("via claude-code (MCP)");
    expect(markup).not.toContain("2.1");
  });

  it("still renders a message written under the Local agent's old service token (#636)", () => {
    const markup = renderToStaticMarkup(
      <ViaChip via={{ auth: "service_token", client: { name: "pi" } }} />,
    );

    expect(markup).toContain("via pi (MCP)");
    expect(markup).not.toContain("service_token");
  });

  it("says via MCP when the caller gave no name, and never shows how it got in", () => {
    const markup = renderToStaticMarkup(
      <ViaChip via={{ auth: "service_token", clientId: "dcr-1" }} />,
    );

    expect(markup).toContain("via MCP");
    expect(markup).not.toContain("dcr-1");
    expect(markup).not.toContain("service_token");
  });

  it("shows a client's name as text, never as markup", () => {
    const markup = renderToStaticMarkup(
      <ViaChip via={{ auth: "oauth", client: { name: "<img src=x onerror=1>" } }} />,
    );

    expect(markup).not.toContain("<img");
    expect(markup).toContain("&lt;img");
  });

  it("names the Trigger for an input a Fire sent: via <name> (Trigger)", () => {
    const markup = renderToStaticMarkup(
      <ViaChip via={{ auth: "trigger", trigger: { id: "t1", name: "Weekly report" } }} />,
    );

    expect(markup).toContain("via Weekly report (Trigger)");
    expect(markup).not.toContain("t1");
  });
});
