// The script's schema and value, and the stream of a large result (`docs/architecture/mcp-in-a-session.md` → Calls and
// results): the output schema relocated under `structuredContent`, text cut largest-first to the nested bound, the
// head of a result's text and what is bounded in `details`, and the one decode slot of an isolate.
// @effect-diagnostics asyncFunction:off preferEffectArray:off newPromise:off globalTimers:off
import { type JsonObject, MCP_STREAM_HOLD_MS } from "@cloudpid/mcp/types";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { boundedMeta, MAX_META_BYTES } from "./mcp/details.ts";
import { headWithin, MAX_TEXT_BYTES, MAX_TEXT_LINES } from "./mcp/head.ts";
import { resultFor } from "./mcp/result.ts";
import { scriptSchemaOf } from "./mcp/schema.ts";
import type { Spilled } from "./mcp/spill.ts";
import { DECODE_SLOT_OVER, MCP_STREAM_SLOT_WAIT_MS, readStreamed } from "./mcp/stream.ts";
import { modelValueOf, scriptValueOf } from "./mcp/value.ts";
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

  it("never cuts binary data: a block that does not fit is replaced whole by a line, before any text is cut", () => {
    const value = scriptValueOf(
      {
        content: [
          { type: "text", text: "t".repeat(500) },
          { type: "image", data: "I".repeat(5000), mimeType: "image/png" },
          { type: "image", data: "J".repeat(200), mimeType: "image/png" },
        ],
        structuredContent: { keep: "k".repeat(1000) },
      },
      3000,
    );

    const content = contentOf(value);

    // The large image is a line; the text and the small image, which fit, are whole.
    expect(content[0]?.text).toBe("t".repeat(500));
    expect(content[1]?.text).toBe("[image content omitted: too large for a script's value]");
    expect(content[1]?.data).toBeUndefined();
    expect(content[2]?.data).toBe("J".repeat(200));
    expect(storedBytes(value)).toBeLessThanOrEqual(3000);
    expect(value["structuredContent"]).toEqual({ keep: "k".repeat(1000) });
    expect(value["truncated"]).toBe(true);
  });

  it("drops a block of binary data longer than the whole budget at once, and cuts the text only as far as it must", () => {
    const value = scriptValueOf(
      {
        content: [
          { type: "resource", resource: { uri: "u", blob: "B".repeat(9000) } },
          { type: "text", text: "t".repeat(4000) },
        ],
      },
      3000,
    );

    const content = contentOf(value);

    expect(content[0]?.text).toBe("[resource content omitted: too large for a script's value]");
    expect(content[1]?.text?.length).toBeLessThan(4000);
    expect(content[1]?.text?.startsWith("ttt")).toBe(true);
    expect(storedBytes(value)).toBeLessThanOrEqual(3000);
  });
});

describe("the value of a result with a large structuredContent", () => {
  it("is measured once: no block is dropped or cut when structuredContent alone is over the budget", () => {
    const value = scriptValueOf(
      {
        content: [
          { type: "image", data: "I".repeat(500), mimeType: "image/png" },
          { type: "text", text: "t".repeat(500) },
        ],
        structuredContent: { rows: "r".repeat(5000) },
      },
      2000,
    );

    expect(value).toEqual({
      content: [],
      structuredContent: { rows: "r".repeat(5000) },
      truncated: true,
    });
  });

  it("is nothing of the result for a model's call, which pi-durable only checks against the schema", () => {
    expect(modelValueOf()).toEqual({ content: [] });
  });
});

describe("the head of a result's text", () => {
  it("is nothing for a text within 2000 lines and 50 KiB, a trailing newline not a line more", () => {
    expect(headWithin("short")).toBeUndefined();
    expect(headWithin("x".repeat(MAX_TEXT_BYTES))).toBeUndefined();
    expect(headWithin(`${"l\n".repeat(MAX_TEXT_LINES - 1)}l\n`)).toBeUndefined();
  });

  it("keeps the first 2000 lines of a longer text, and never half a line past the bytes", () => {
    const lines = headWithin("line\n".repeat(MAX_TEXT_LINES + 5));

    // Whole lines, each with its newline, as pi-durable's own cut leaves them.
    expect(lines?.split("\n")).toHaveLength(MAX_TEXT_LINES + 1);
    expect(lines?.endsWith("\n")).toBe(true);

    const bytes = headWithin(`${"b".repeat(100)}\n`.repeat(1000));

    expect(new TextEncoder().encode(bytes).length).toBeLessThanOrEqual(MAX_TEXT_BYTES);
    expect(bytes?.endsWith(`${"b".repeat(100)}\n`)).toBe(true);
  });

  it("cuts a first line over the bytes by characters, whole multi-byte ones", () => {
    const head = headWithin("é".repeat(MAX_TEXT_BYTES));

    expect(new TextEncoder().encode(head).length).toBeLessThanOrEqual(MAX_TEXT_BYTES);
    expect(head).toBe("é".repeat(MAX_TEXT_BYTES / 2));
  });

  it("is all that a 16 MiB result hands on: the whole text goes to the spill, and the head to the call's result", async () => {
    const text = "0123456789abcdef\n".repeat(1024 * 1024 - 1024);
    const spilled: Array<string | Uint8Array> = [];

    const result = await resultFor({ content: [{ type: "text", text }] }, undefined, {
      kind: "model",
      details: { server: "s", tool: "t" },
      spill: async (data): Promise<Spilled> => {
        spilled.push(data);

        return { path: "/tmp/mcp-1.txt" };
      },
    });

    const [block] = result.output ?? [];

    expect(block?.type === "text" ? block.text.length : -1).toBeLessThanOrEqual(MAX_TEXT_BYTES);
    expect(spilled).toEqual([text]);
    expect(result.details).toMatchObject({ full_output_path: "/tmp/mcp-1.txt" });
  });
});

/** A spill that keeps what it is given, and where it says it went. */
const keeping = () => {
  const spilled: Array<string | Uint8Array> = [];

  return {
    spilled,
    spill: async (data: string | Uint8Array): Promise<Spilled> => {
      spilled.push(data);

      return { path: `/tmp/mcp-${spilled.length}` };
    },
  };
};

describe("the text of a result over the limits", () => {
  it("joins the server's text as pi-durable does, cuts it in place of the first block, and keeps images and notes", async () => {
    const kept = keeping();

    const result = await resultFor(
      {
        content: [
          { type: "text", text: `${"a".repeat(30_000)}\n` },
          { type: "image", data: "aGk=", mimeType: "image/png" },
          { type: "text", text: `${"b".repeat(30_000)}\n` },
          { type: "resource_link", uri: "file:///x.txt", name: "x" },
          {
            type: "resource",
            resource: { uri: "file:///y.pdf", mimeType: "application/pdf", blob: "JVBERi0=" },
          },
        ],
      },
      undefined,
      { kind: "model", details: { server: "s", tool: "t" }, spill: kept.spill },
    );

    const output = result.output ?? [];

    // The head where the first text was, the image after it, then the link and the saved file: the second text is in the head.
    expect(output.map((block) => block.type)).toEqual(["text", "image", "text", "text"]);
    expect(output[0]?.type === "text" ? output[0].text.startsWith("aaa") : false).toBe(true);
    expect(output[2]?.type === "text" ? output[2].text : "").toMatch(
      /^\[Resource file:\/\/\/x\.txt/,
    );
    expect(output[3]?.type === "text" ? output[3].text : "").toMatch(/saved to \/tmp\/mcp-1\]$/);
    // The whole, joined with nothing between the blocks, is what the spill has.
    expect(kept.spilled[1]).toBe(`${"a".repeat(30_000)}\n${"b".repeat(30_000)}\n`);
    expect(result.diagnostics).toContainEqual({
      severity: "warn",
      code: "truncated",
      message: expect.stringMatching(
        /^Output truncated to its beginning: \d+ lines, \d+ bytes dropped$/,
      ),
    });
  });

  it("is cut for a script's call too, with the same warning, and nothing is spilled", async () => {
    const result = await resultFor(
      { content: [{ type: "text", text: "line\n".repeat(MAX_TEXT_LINES + 10) }] },
      undefined,
      { kind: "script", details: { server: "s", tool: "t" } },
    );

    expect(result.diagnostics).toEqual([
      {
        severity: "warn",
        code: "truncated",
        message: "Output truncated to its beginning: 10 lines, 50 bytes dropped",
      },
    ]);
    expect(result.details).not.toHaveProperty("full_output_path");
  });
});

describe("the _meta that details keep", () => {
  it("is all of it within its bound", () => {
    expect(boundedMeta({ a: 1, ui: { resourceUri: "ui://x/y" } })).toEqual({
      a: 1,
      ui: { resourceUri: "ui://x/y" },
    });
  });

  it("keeps ui whole past the bound, with the other keys that fit, smallest first, and drops the rest", () => {
    const meta = {
      big: "b".repeat(MAX_META_BYTES),
      ui: { resourceUri: "ui://x/y", visibility: ["app"] },
      small: "s",
      medium: "m".repeat(1000),
    };

    expect(boundedMeta(meta)).toEqual({
      ui: { resourceUri: "ui://x/y", visibility: ["app"] },
      small: "s",
      medium: "m".repeat(1000),
    });
  });

  it("is nothing for what is not an object", () => {
    expect(boundedMeta(undefined)).toBeUndefined();
    expect(boundedMeta("text")).toBeUndefined();
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

/** What reading `body` comes to, with `use` the identity; a stream quiet for `idleMs` is lost. */
const readOf = (
  body: ReadableStream<Uint8Array>,
  bytes: number,
  signal?: AbortSignal,
  idleMs = 5000,
) => readStreamed(body, bytes, { signal, idleMs }, async (read) => read);

describe("reading a result's stream", () => {
  it("reads one result over 4 MiB at a time per isolate, and smaller ones at once", async () => {
    const big = JSON.stringify({ content: [{ type: "text", text: "z".repeat(DECODE_SLOT_OVER) }] });
    const order: Array<string> = [];

    const first = streamed(big, "first", order);
    const second = streamed(big, "second", order);
    const small = streamed('{"content":[]}', "small", order);

    const answers = await Promise.all([
      readOf(first.body, first.bytes),
      readOf(second.body, second.bytes),
      readOf(small.body, small.bytes),
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

    const reading = readOf(body, 1000, controller.signal);

    controller.abort();

    expect(await reading).toEqual({ kind: "aborted" });
    expect(cancelled).toBe(true);
  });

  /** A stream that sends nothing and ends only when cancelled. */
  const silent = () => {
    const seen = { cancelled: false };

    const body = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => undefined),
      cancel: () => {
        seen.cancelled = true;
      },
    });

    return { body, seen };
  };

  it("reads a stream that goes quiet as lost at its idle deadline, and lets it go", async () => {
    const { body, seen } = silent();

    expect(await readOf(body, 1000, undefined, 30)).toEqual({ kind: "lost" });
    expect(seen.cancelled).toBe(true);
  });

  it("gives up a wait for the slot at its own deadline, before the engine lets the stream go, and lets it go", async () => {
    const holder = silent();
    const waiting = silent();

    const holding = readOf(holder.body, DECODE_SLOT_OVER + 1, undefined, 400);

    const waited = readStreamed(
      waiting.body,
      DECODE_SLOT_OVER + 1,
      { idleMs: 5000, waitMs: 40 },
      async (read) => read,
    );

    expect(await waited).toEqual({ kind: "waited" });
    expect(waiting.seen.cancelled).toBe(true);
    expect(holder.seen.cancelled).toBe(false);
    expect(await holding).toEqual({ kind: "lost" });
    expect(MCP_STREAM_SLOT_WAIT_MS).toBeLessThan(MCP_STREAM_HOLD_MS);
  });

  it("gives the slot up when the result is used, not when it is read", async () => {
    const big = JSON.stringify({ content: [{ type: "text", text: "z".repeat(DECODE_SLOT_OVER) }] });
    const order: Array<string> = [];
    const first = streamed(big, "first", order);
    const second = streamed(big, "second", order);
    const used = Promise.withResolvers<void>();

    const firstRead = readStreamed(first.body, first.bytes, { idleMs: 5000 }, async () => {
      order.push("first:use");
      await used.promise;
      order.push("first:used");
    });

    const secondRead = readOf(second.body, second.bytes);

    // The first is read and in use; the second has not started to read.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(order).toContain("first:use");
    expect(order).not.toContain("second:start");

    used.resolve();
    await Promise.all([firstRead, secondRead]);

    expect(order.indexOf("second:start")).toBeGreaterThan(order.indexOf("first:used"));
  });

  it("ends a wait for the slot at Stop at once, without waiting for the holder, and keeps the line in order", async () => {
    const order: Array<string> = [];
    const holder = silent();
    const stopped = new AbortController();
    const waiting = silent();
    const last = streamed(JSON.stringify({ content: [] }), "last", order);

    const holding = readOf(holder.body, DECODE_SLOT_OVER + 1, undefined, 400);
    const stopping = readOf(waiting.body, DECODE_SLOT_OVER + 1, stopped.signal);
    const behind = readOf(last.body, DECODE_SLOT_OVER + 1);

    await new Promise((resolve) => setTimeout(resolve, 30));
    stopped.abort();

    // The waiter answers while the holder is still reading, and lets its stream go.
    expect(await stopping).toEqual({ kind: "aborted" });
    expect(waiting.seen.cancelled).toBe(true);
    expect(holder.seen.cancelled).toBe(false);
    // The one behind it still waits for the holder.
    expect(order).toEqual([]);

    expect(await holding).toEqual({ kind: "lost" });
    expect(await behind).toMatchObject({ kind: "value" });
    expect(order[0]).toBe("last:start");
  });
});
