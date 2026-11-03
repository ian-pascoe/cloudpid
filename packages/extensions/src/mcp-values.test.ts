// The script's schema and value, and the stream of a large result (`docs/architecture/mcp-in-a-session.md` → Calls and
// results): the output schema relocated under `structuredContent`, text cut largest-first to the nested bound, and the
// one decode slot of an isolate.
// @effect-diagnostics asyncFunction:off preferEffectArray:off newPromise:off globalTimers:off
import type { JsonObject } from "@cloudpid/mcp/types";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { scriptSchemaOf } from "./mcp/schema.ts";
import { DECODE_SLOT_OVER, readStreamed } from "./mcp/stream.ts";
import { scriptValueOf } from "./mcp/value.ts";
import { storedBytes } from "./stored-bytes.ts";

const Content = Schema.Array(
  Schema.Struct({
    text: Schema.optionalKey(Schema.String),
    data: Schema.optionalKey(Schema.String),
    resource: Schema.optionalKey(Schema.Struct({ text: Schema.String })),
  }),
);

/** The `content` of a script's value. */
const contentOf = (value: JsonObject) =>
  Option.getOrThrow(Schema.decodeUnknownOption(Content)(value["content"]));

describe("the script's schema", () => {
  it("types structuredContent by the outputSchema, its local $refs moved below it", () => {
    const schema = scriptSchemaOf({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://x.test/out",
      type: "object",
      properties: {
        items: { type: "array", items: { $ref: "#/$defs/Item" } },
        self: { $ref: "#" },
      },
      $defs: { Item: { type: "object", properties: { next: { $ref: "#/$defs/Item" } } } },
    });

    expect(schema).toMatchObject({
      required: ["content"],
      properties: {
        isError: { type: "boolean" },
        structuredContent: {
          type: "object",
          properties: {
            items: { type: "array", items: { $ref: "#/properties/structuredContent/$defs/Item" } },
            self: { $ref: "#/properties/structuredContent" },
          },
          $defs: {
            Item: {
              properties: { next: { $ref: "#/properties/structuredContent/$defs/Item" } },
            },
          },
        },
      },
    });
    expect(schema).not.toHaveProperty("properties.structuredContent.$schema");
    expect(schema).not.toHaveProperty("properties.structuredContent.$id");
  });

  it("leaves a ref that is a property's name, or in a default, as it is, and gives any JSON for one that cannot move", () => {
    const named = scriptSchemaOf({
      type: "object",
      properties: { $ref: { type: "string", default: { $ref: "#/x" } } },
    });

    expect(named).toMatchObject({
      properties: {
        structuredContent: {
          properties: { $ref: { type: "string", default: { $ref: "#/x" } } },
        },
      },
    });

    for (const outputSchema of [
      { $ref: "https://x.test/other.json" },
      { properties: { a: { $ref: "#anchor" } } },
      { properties: { a: { $anchor: "anchor" } } },
      { properties: { a: { $id: "https://x.test/a" } } },
    ]) {
      expect(scriptSchemaOf(outputSchema)).toMatchObject({ properties: { structuredContent: {} } });
      expect(scriptSchemaOf(outputSchema)).toHaveProperty("properties.structuredContent", {});
    }

    expect(scriptSchemaOf(undefined)).toHaveProperty("properties.structuredContent", {});
  });
});

describe("the script's value", () => {
  it("is the result as sent, without _meta, and untruncated within the budget", () => {
    const value = scriptValueOf({
      content: [{ type: "text", text: "hi", annotations: { audience: ["user"] } }],
      structuredContent: [1, 2],
      isError: false,
      _meta: { a: 1 },
    });

    expect(value).toEqual({
      content: [{ type: "text", text: "hi", annotations: { audience: ["user"] } }],
      structuredContent: [1, 2],
      isError: false,
    });
  });

  it("cuts the largest text first, then the next, and never the original", () => {
    const original = {
      content: [
        { type: "text", text: "a".repeat(6000) },
        { type: "text", text: "b".repeat(3000) },
        { type: "resource", resource: { uri: "u", text: "c".repeat(2000) } },
      ],
    };

    const value = scriptValueOf(original, 7000);
    const content = contentOf(value);

    expect(value["truncated"]).toBe(true);
    expect(storedBytes(value)).toBeLessThanOrEqual(7000);
    // The largest took the whole cut, so the others are whole.
    expect(content[0]?.text?.length).toBeLessThan(6000);
    expect(content[1]?.text).toBe("b".repeat(3000));
    expect(content[2]?.resource?.text).toBe("c".repeat(2000));
    expect(original.content[0]?.text).toBe("a".repeat(6000));
  });

  it("cuts binary data only once no text is left, and never structuredContent", () => {
    const value = scriptValueOf(
      {
        content: [
          { type: "text", text: "t".repeat(500) },
          { type: "image", data: "I".repeat(5000), mimeType: "image/png" },
        ],
        structuredContent: { keep: "k".repeat(1000) },
      },
      3000,
    );

    const content = contentOf(value);

    // The text goes first, all of it; then the data.
    expect(content[0]?.text).toBe("\n[cut to fit]");
    expect(content[1]?.data?.length).toBeLessThan(5000);
    expect(storedBytes(value)).toBeLessThanOrEqual(3000);
    expect(value["structuredContent"]).toEqual({ keep: "k".repeat(1000) });
    expect(value["truncated"]).toBe(true);
  });
});

/** A stream of JSON text, noting in `order` when it is first pulled and when it ends. */
const streamed = (json: string, label: string, order: Array<string>) => {
  const data = new TextEncoder().encode(json);
  let first = true;
  let offset = 0;

  return {
    bytes: data.byteLength,
    body: new ReadableStream<Uint8Array>(
      {
        pull: (controller) => {
          if (first) {
            first = false;
            order.push(`${label}:start`);
          }

          if (offset >= data.byteLength) {
            order.push(`${label}:end`);

            return controller.close();
          }

          controller.enqueue(data.slice(offset, offset + 65_536));
          offset += 65_536;
        },
      },
      { highWaterMark: 0 },
    ),
  };
};

describe("reading a result's stream", () => {
  it("reads one result over 4 MiB at a time per isolate, and smaller ones at once", async () => {
    const big = JSON.stringify({ content: [{ type: "text", text: "z".repeat(DECODE_SLOT_OVER) }] });
    const order: Array<string> = [];

    const first = streamed(big, "first", order);
    const second = streamed(big, "second", order);
    const small = streamed('{"content":[]}', "small", order);

    const answers = await Promise.all([
      readStreamed(first.body, first.bytes, undefined),
      readStreamed(second.body, second.bytes, undefined),
      readStreamed(small.body, small.bytes, undefined),
    ]);

    // The second big one starts only once the first has ended; the small one waits for neither.
    expect(order.indexOf("second:start")).toBeGreaterThan(order.indexOf("first:end"));
    expect(order.indexOf("small:end")).toBeLessThan(order.indexOf("first:end"));
    expect(answers.map((answer) => answer.kind)).toEqual(["value", "value", "value"]);
  });

  it("is aborted by Stop, which cancels the stream", async () => {
    const controller = new AbortController();
    let cancelled = false;

    const body = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => undefined),
      cancel: () => {
        cancelled = true;
      },
    });

    const reading = readStreamed(body, 1000, controller.signal);

    controller.abort();

    expect(await reading).toEqual({ kind: "aborted" });
    expect(cancelled).toBe(true);
  });
});
