/**
 * `xMcpHeaderProblems` (SEP-2243): the rules the SDK's `listTools` applies, which discovery applies to the core's list
 * (`docs/architecture/mcp-connections.md` → Discovery and the MCP inventory).
 */
import type * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { xMcpHeaderProblems } from "./types.ts";

const objectWith = (properties: Schema.Json): Schema.Json => ({ type: "object", properties });

describe("xMcpHeaderProblems", () => {
  it("finds nothing in a schema without declarations, or with valid ones at any depth", () => {
    expect(xMcpHeaderProblems(objectWith({ q: { type: "string" } }))).toEqual([]);
    expect(
      xMcpHeaderProblems(
        objectWith({
          region: { type: "string", "x-mcp-header": "Region" },
          nested: {
            type: "object",
            properties: { count: { type: "integer", "x-mcp-header": "Count" } },
          },
          dry: { type: "boolean", "x-mcp-header": "Dry-Run" },
        }),
      ),
    ).toEqual([]);
  });

  it("refuses an empty header, and one that is no HTTP token", () => {
    expect(xMcpHeaderProblems(objectWith({ a: { type: "string", "x-mcp-header": "" } }))).toEqual([
      "a: x-mcp-header must be a non-empty string",
    ]);
    expect(
      xMcpHeaderProblems(objectWith({ a: { type: "string", "x-mcp-header": "Bad Header" } })),
    ).toEqual(["a: x-mcp-header 'Bad Header' is not an HTTP token"]);
  });

  it("refuses a declaration on anything but a string, integer or boolean (number included)", () => {
    expect(
      xMcpHeaderProblems(objectWith({ a: { type: "number", "x-mcp-header": "A" } })),
    ).toHaveLength(1);
    expect(
      xMcpHeaderProblems(objectWith({ a: { type: "object", "x-mcp-header": "A" } })),
    ).toHaveLength(1);
    expect(xMcpHeaderProblems(objectWith({ a: { "x-mcp-header": "A" } }))).toEqual([
      "a: x-mcp-header is only allowed on a string, integer or boolean (got none)",
    ]);
  });

  it("refuses a header declared twice, case-insensitively", () => {
    expect(
      xMcpHeaderProblems(
        objectWith({
          a: { type: "string", "x-mcp-header": "Region" },
          b: { type: "string", "x-mcp-header": "region" },
        }),
      ),
    ).toEqual(["b: x-mcp-header 'region' is also declared as 'Region'"]);
  });

  it("refuses a declaration at the root, or under a keyword a properties chain never passes through", () => {
    expect(xMcpHeaderProblems(JSON.parse('{"type":"string","x-mcp-header":"Root"}'))).toHaveLength(
      1,
    );
    expect(
      xMcpHeaderProblems(
        objectWith({
          list: { type: "array", items: { type: "string", "x-mcp-header": "Item" } },
        }),
      ),
    ).toEqual([
      "list.<items>: x-mcp-header is only allowed on a property reached through 'properties' alone",
    ]);
    expect(
      xMcpHeaderProblems(
        JSON.parse(
          '{"type":"object","$defs":{"x":{"type":"string","x-mcp-header":"X"}},"anyOf":[{"properties":{"y":{"type":"string","x-mcp-header":"Y"}}}]}',
        ),
      ),
    ).toHaveLength(2);
  });
});
