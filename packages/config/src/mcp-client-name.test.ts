import { describe, expect, it } from "vitest";
import { mcpClientNameFor } from "./mcp-client-name.ts";

describe("the client name cloudpid registers as", () => {
  it("is cloudpid on prod, and carries the label elsewhere, and local under alchemy dev", () => {
    expect(mcpClientNameFor({ local: false })).toBe("cloudpid");
    expect(mcpClientNameFor({ label: "pr-9", local: false })).toBe("cloudpid (pr-9)");
    expect(mcpClientNameFor({ label: "dev", local: true })).toBe("cloudpid (dev, local)");
  });

  it("puts the suffix on a configured name too, off prod", () => {
    expect(mcpClientNameFor({ local: false }, "Acme")).toBe("Acme");
    expect(mcpClientNameFor({ label: "pr-9", local: false }, "Acme")).toBe("Acme (pr-9)");
  });

  it("never cuts the suffix: a long configured name is shortened at a code point", () => {
    const name = mcpClientNameFor({ label: "pr-9", local: false }, "😀".repeat(120));

    expect(Array.from(name)).toHaveLength(100);
    expect(name.endsWith(" (pr-9)")).toBe(true);
  });
});
