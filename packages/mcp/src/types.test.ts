/**
 * The engine edge's failure Schema (`docs/architecture/mcp.md` → Deploys): `McpErrorWire` reads every known tag as
 * its `McpError` and anything else as an `OtherMcpError` that may have run, so a newer engine's new tag never fails a
 * decode on an older host. The fixtures are JSON text, as the edge carries them.
 */
// @effect-diagnostics asyncFunction:off
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  Cut,
  McpError,
  McpErrorWire,
  mayHaveRun,
  NotFound,
  OtherMcpError,
  ProtocolViolation,
  ServerError,
  SignInRequired,
  StepUpRequired,
  TimedOut,
  TooLarge,
  Unreachable,
  Unsupported,
} from "./types.ts";

const Wire = Schema.fromJsonString(McpErrorWire);

const decode = (text: string) => Schema.decodeEffect(Wire)(text).pipe(Effect.runPromise);

const encode = (error: McpErrorWire) => Schema.encodeEffect(Wire)(error).pipe(Effect.runPromise);

describe("McpErrorWire", () => {
  it("reads a known tag as its McpError", async () => {
    const error = await decode('{"_tag":"NotFound","message":"Unknown tool","code":-32602}');

    expect(error).toBeInstanceOf(NotFound);
    expect(error).toMatchObject({ message: "Unknown tool", code: -32602 });
    expect(mayHaveRun(error, "tools/call")).toBe(false);
  });

  it("reads an unknown tag as an OtherMcpError that may have run, and writes it back as it came", async () => {
    const error = await decode('{"_tag":"QuotaExceeded","message":"Over quota","retryAt":5}');

    expect(error).toBeInstanceOf(OtherMcpError);
    expect(Schema.is(McpError)(error)).toBe(false);
    expect(error).toMatchObject({ tag: "QuotaExceeded", message: "Over quota" });
    expect(mayHaveRun(error, "tools/call")).toBe(true);
    expect(await encode(error)).toBe('{"_tag":"QuotaExceeded","message":"Over quota"}');
  });

  it("reads a known tag whose fields do not fit as an OtherMcpError, never as that tag", async () => {
    const error = await decode('{"_tag":"Cut","message":"Cut short"}');

    expect(error).toBeInstanceOf(OtherMcpError);
    expect(Schema.is(Cut)(error)).toBe(false);
    expect(error).toMatchObject({ tag: "Cut", message: "Cut short" });
    expect(mayHaveRun(error, "tools/call")).toBe(true);
  });

  it("keeps an unknown tag's mayHaveRun when it says", async () => {
    const error = await decode('{"_tag":"Refused","message":"No","mayHaveRun":false}');

    expect(mayHaveRun(error, "tools/call")).toBe(false);
    expect(await encode(error)).toBe('{"_tag":"Refused","message":"No","mayHaveRun":false}');
  });

  it("writes a known McpError as its fields", async () => {
    const error = NotFound.make({ message: "Unknown tool", code: -32602 });

    expect(await encode(error)).toBe('{"_tag":"NotFound","message":"Unknown tool","code":-32602}');
  });
});

/** Each failure, whether a `tools/call` that failed with it may have run, and whether a read may have. */
const RUNS: ReadonlyArray<readonly [string, McpErrorWire, boolean, boolean]> = [
  ["a Cut that may have run", Cut.make({ message: "Cut", mayHaveRun: true }), true, true],
  ["a Cut that did not run", Cut.make({ message: "Cut", mayHaveRun: false }), false, false],
  ["an OtherMcpError", OtherMcpError.make({ message: "New", tag: "New" }), true, false],
  [
    "an OtherMcpError that says it did not run",
    OtherMcpError.make({ message: "New", tag: "New", mayHaveRun: false }),
    false,
    false,
  ],
  ["TimedOut", TimedOut.make({ message: "Late" }), true, false],
  ["TooLarge", TooLarge.make({ message: "Big", limit: 1 }), true, false],
  ["ProtocolViolation", ProtocolViolation.make({ message: "HTML" }), true, false],
  ["Unreachable with a 5xx", Unreachable.make({ message: "Down", status: 503 }), true, false],
  ["Unreachable with a 429", Unreachable.make({ message: "Busy", status: 429 }), false, false],
  ["Unreachable with a 408", Unreachable.make({ message: "Slow", status: 408 }), false, false],
  ["Unreachable with no status", Unreachable.make({ message: "Gone" }), false, false],
  ["SignInRequired", SignInRequired.make({ message: "Sign in", rejected: false }), false, false],
  ["StepUpRequired", StepUpRequired.make({ message: "Scope" }), false, false],
  ["ServerError", ServerError.make({ message: "Bad", code: -32603 }), false, false],
  ["NotFound", NotFound.make({ message: "Unknown tool", code: -32602 }), false, false],
  ["Unsupported", Unsupported.make({ message: "No" }), false, false],
];

describe("mayHaveRun", () => {
  it.each(RUNS)("%s: a tools/call may have run: %s; a read: %s", (_name, error, call, read) => {
    expect(mayHaveRun(error, "tools/call")).toBe(call);
    expect(mayHaveRun(error, "tools/list")).toBe(read);
  });
});
