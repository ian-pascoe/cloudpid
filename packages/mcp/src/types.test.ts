/**
 * The engine edge's failure Schema (`docs/architecture/mcp.md` → Deploys): `McpErrorWire` reads every known tag as
 * its `McpError` and any other as a generic failure that may have run, so a newer engine's new tag never fails a
 * decode on an older host. The fixtures are JSON text, as the edge carries them.
 */
// @effect-diagnostics asyncFunction:off
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { McpError, McpErrorWire, NotFound } from "./types.ts";

const Wire = Schema.fromJsonString(McpErrorWire);

const decode = (text: string) => Effect.runPromise(Schema.decodeEffect(Wire)(text));

const encode = (error: McpErrorWire) => Effect.runPromise(Schema.encodeEffect(Wire)(error));

describe("McpErrorWire", () => {
  it("reads a known tag as its McpError", async () => {
    const error = await decode('{"_tag":"NotFound","message":"Unknown tool","code":-32602}');

    expect(error).toBeInstanceOf(NotFound);
    expect(error).toMatchObject({ message: "Unknown tool", code: -32602 });
  });

  it("reads an unknown tag as a generic failure that may have run, keeping its tag and message", async () => {
    const error = await decode('{"_tag":"QuotaExceeded","message":"Over quota","retryAt":5}');

    expect(Schema.is(McpError)(error)).toBe(false);
    expect(error._tag).toBe("QuotaExceeded");
    expect(error.message).toBe("Over quota");
    expect("retryAt" in error || "mayHaveRun" in error).toBe(false);
    expect(await encode(error)).toBe('{"_tag":"QuotaExceeded","message":"Over quota"}');
  });

  it("keeps an unknown tag's mayHaveRun when it says", async () => {
    const error = await decode('{"_tag":"Refused","message":"No","mayHaveRun":false}');

    expect(error).toMatchObject({ message: "No", mayHaveRun: false });
    expect(await encode(error)).toBe('{"_tag":"Refused","message":"No","mayHaveRun":false}');
  });

  it("writes a known McpError as its fields", async () => {
    expect(await encode(NotFound.make({ message: "Unknown tool", code: -32602 }))).toBe(
      '{"_tag":"NotFound","message":"Unknown tool","code":-32602}',
    );
  });
});
