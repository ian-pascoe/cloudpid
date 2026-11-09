// @effect-diagnostics schemaSync:off
/**
 * The host's RPC types (`docs/architecture/mcp.md` → Deploys): an `apply` answer with a tag this build does not know
 * reads as `HostFailed` and never fails a decode, an entry decodes without the keys a later build adds, and a source
 * of a kind this build does not know keeps its kind.
 */
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  HostFailed,
  McpApplySet,
  McpApplySignIns,
  McpSetSource,
  readMcpApplyResult,
} from "./types.ts";

/** An `apply` answer as the edge carries it: JSON text. */
const read = (text: string) => readMcpApplyResult(JSON.parse(text));

describe("readMcpApplyResult", () => {
  it("reads a tag it does not know as a generic failure that keeps the tag", () => {
    expect(read('{"_tag":"Throttled","message":"slow down","retryAfter":3}')).toEqual(
      HostFailed.make({ message: "slow down", tag: "Throttled" }),
    );
  });

  it("reads a known tag whose fields do not fit, and a value that is no result, as a failure", () => {
    expect(read('{"_tag":"Applied"}')).toEqual(
      HostFailed.make({
        message: "The MCP host answered with something this build does not know (Applied)",
        tag: "Applied",
      }),
    );
    expect(read('"nope"')).toEqual(
      HostFailed.make({ message: "The MCP host answered apply with something that is no result" }),
    );
  });
});

describe("the set's schemas", () => {
  it("drop the keys they do not know, so an older host reads a newer Registry's entry", () => {
    const entry = {
      name: "docs",
      source: { kind: "global" },
      server: { type: "http", url: "https://example.com/mcp" },
      hash: "a",
      conn: "b",
      identity: "c",
      addedLater: true,
    };

    const set = Schema.decodeUnknownSync(McpApplySet)({
      kind: "set",
      hash: "h",
      revision: 2,
      entries: [entry],
      alsoLater: 1,
    });

    expect(set.entries[0]).not.toHaveProperty("addedLater");
    expect(set).not.toHaveProperty("alsoLater");
  });

  it("keeps the kind of a source it does not know", () => {
    expect(Schema.decodeUnknownSync(McpSetSource)({ kind: "workspace", x: 1 })).toEqual({
      kind: "workspace",
    });
  });
});

describe("the sign-ins operation", () => {
  const decode = Schema.decodeUnknownSync(McpApplySignIns);

  it("reads a change this build knows and one a newer build adds, dropping keys it does not know", () => {
    const base = { kind: "sign_ins", servers: ["linear"], revision: 3 };

    expect(decode({ ...base, change: "signed_in", later: 1 })).toEqual({
      ...base,
      change: "signed_in",
    });
    expect(decode({ ...base, change: "refreshed_somehow" }).change).toBe("refreshed_somehow");
  });
});
