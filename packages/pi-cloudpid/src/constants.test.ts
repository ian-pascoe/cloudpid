// @effect-diagnostics *:off -- a test, on the owner's machine, not Effect code.
import { readFileSync } from "node:fs";
import { THINKING_LEVELS as CONFIG_THINKING_LEVELS } from "@cloudpid/config";
import {
  MAX_MCP_IMPORT_BYTES,
  MAX_MCP_SLICE_BYTES,
  PI_SESSION_FORMAT,
} from "@cloudpid/protocol/mcp-api";
import { MCP_TOOL_OPERATIONS } from "@cloudpid/protocol/mcp-tools";
import { MAX_TITLE_LENGTH as PROTOCOL_MAX_TITLE_LENGTH } from "@cloudpid/protocol";
import { describe, expect, it } from "vitest";
import {
  MAX_IMPORT_BYTES,
  MAX_SLICE_BYTES,
  MAX_TITLE_LENGTH,
  PI_SESSION_FORMAT as FORMAT,
  REQUIRED_TOOLS,
  THINKING_LEVELS,
} from "./constants.ts";

describe("the copies of the endpoint's constants", () => {
  it("are the protocol's values", () => {
    expect(FORMAT).toBe(PI_SESSION_FORMAT);
    expect(MAX_SLICE_BYTES).toBe(MAX_MCP_SLICE_BYTES);
    expect(MAX_IMPORT_BYTES).toBe(MAX_MCP_IMPORT_BYTES);
    expect(MAX_TITLE_LENGTH).toBe(PROTOCOL_MAX_TITLE_LENGTH);
    expect([...THINKING_LEVELS]).toEqual([...CONFIG_THINKING_LEVELS]);
  });

  it("name tools the endpoint has", () => {
    for (const tool of REQUIRED_TOOLS) expect(Object.keys(MCP_TOOL_OPERATIONS)).toContain(tool);
  });
});

/** A `dependencies` pin in a workspace package's `package.json`. */
const pinOf = (directory: string, name: string): string | undefined => {
  const manifest: { readonly dependencies?: { readonly [name: string]: string } } = JSON.parse(
    readFileSync(new URL(`../../${directory}/package.json`, import.meta.url), "utf8"),
  );

  return manifest.dependencies?.[name];
};

describe("the bundled SDK", () => {
  // docs/development/dependencies.md: the extension's copy of the client is the core's version, moved together.
  it("is the core's pin of @modelcontextprotocol/client", () => {
    const core = pinOf("mcp", "@modelcontextprotocol/client");

    expect(core).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pinOf("pi-cloudpid", "@modelcontextprotocol/client")).toBe(core);
  });
});
