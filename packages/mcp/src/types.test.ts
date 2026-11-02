/**
 * The engine edge's failure Schema (`docs/architecture/mcp.md` → Deploys): `McpErrorWire` reads every known tag as
 * its `McpError` and anything else as an `OtherMcpError` that may have run, so a newer engine's new tag never fails a
 * decode on an older host. The fixtures are JSON text, as the edge carries them.
 */
// @effect-diagnostics asyncFunction:off
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { Cut, McpError, McpErrorWire, mayHaveRun, NotFound, OtherMcpError } from "./types.ts";

const Wire = Schema.fromJsonString(McpErrorWire);

const decode = (text: string) => Schema.decodeEffect(Wire)(text).pipe(Effect.runPromise);

const encode = (error: McpErrorWire) => Schema.encodeEffect(Wire)(error).pipe(Effect.runPromise);

describe("McpErrorWire", () => {
  it("reads a known tag as its McpError", async () => {
    const error = await decode('{"_tag":"NotFound","message":"Unknown tool","code":-32602}');

    expect(error).toBeInstanceOf(NotFound);
    expect(error).toMatchObject({ message: "Unknown tool", code: -32602 });
    expect(mayHaveRun(error)).toBe(false);
  });

  it("reads an unknown tag as an OtherMcpError that may have run, and writes it back as it came", async () => {
    const error = await decode('{"_tag":"QuotaExceeded","message":"Over quota","retryAt":5}');

    expect(error).toBeInstanceOf(OtherMcpError);
    expect(Schema.is(McpError)(error)).toBe(false);
    expect(error).toMatchObject({ tag: "QuotaExceeded", message: "Over quota" });
    expect(mayHaveRun(error)).toBe(true);
    expect(await encode(error)).toBe('{"_tag":"QuotaExceeded","message":"Over quota"}');
  });

  it("reads a known tag whose fields do not fit as an OtherMcpError, never as that tag", async () => {
    const error = await decode('{"_tag":"Cut","message":"Cut short"}');

    expect(error).toBeInstanceOf(OtherMcpError);
    expect(Schema.is(Cut)(error)).toBe(false);
    expect(error).toMatchObject({ tag: "Cut", message: "Cut short" });
    expect(mayHaveRun(error)).toBe(true);
  });

  it("keeps an unknown tag's mayHaveRun when it says", async () => {
    const error = await decode('{"_tag":"Refused","message":"No","mayHaveRun":false}');

    expect(mayHaveRun(error)).toBe(false);
    expect(await encode(error)).toBe('{"_tag":"Refused","message":"No","mayHaveRun":false}');
  });

  it("writes a known McpError as its fields", async () => {
    const error = NotFound.make({ message: "Unknown tool", code: -32602 });

    expect(await encode(error)).toBe('{"_tag":"NotFound","message":"Unknown tool","code":-32602}');
  });
});

describe("mayHaveRun", () => {
  it("is what a Cut says", () => {
    expect(mayHaveRun(Cut.make({ message: "Cut", mayHaveRun: true }))).toBe(true);
    expect(mayHaveRun(Cut.make({ message: "Cut", mayHaveRun: false }))).toBe(false);
  });
});
