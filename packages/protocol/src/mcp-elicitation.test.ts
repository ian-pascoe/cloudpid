// The page of a waiting MCP question as a client decodes it (`docs/architecture/mcp-server-requests.md` → Elicitation
// requests, URL mode).
// @effect-diagnostics schemaSync:off
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { McpElicitationPage } from "./mcp-elicitation.ts";

const PAGE = { url: "https://a.example/x", host: "a.example", domain: "a.example", opened: false };

describe("McpElicitationPage", () => {
  it("reads an era this version does not know as unknown, never as a failure", () => {
    const read = (era: string) => Schema.decodeUnknownSync(McpElicitationPage)({ ...PAGE, era });

    expect(read("modern").era).toBe("modern");
    expect(read("legacy").era).toBe("legacy");
    expect(read("future").era).toBe("unknown");
    expect(Schema.decodeSync(McpElicitationPage)(PAGE)).not.toHaveProperty("era");
  });
});
