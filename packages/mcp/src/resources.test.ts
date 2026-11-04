/**
 * The core's resource requests, in both eras (`docs/architecture/mcp-in-a-session.md` → Resource tools): a page of
 * `resources/list` and `resources/templates/list` at a time with the server's cache hints, and `resources/read` with the
 * SHA-256 of what it answered, a Legacy server's question during it included.
 */
// @effect-diagnostics asyncFunction:off preferEffectArray:off
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import { describe, expect, it } from "vitest";
import { AGENT, completed, failedWith, run, settled, TARGET, testDeps } from "./core.fixture.ts";
import {
  type FakeOptions,
  type FakeResource,
  type FakeServer,
  fetchTo,
  legacyStatefulServer,
  legacyStatelessServer,
  modernServer,
  rpcMethods,
} from "./fakes.fixture.ts";
import { connect, type PagesRequired } from "./index.ts";
import type { ReadComplete } from "./connection.ts";
import { contentsSha256 } from "./read-hash.ts";
import { type McpCallContext, type McpInputAnswer, ServerError } from "./types.ts";

const NOTES: FakeResource = {
  uri: "file:///notes.md",
  name: "notes",
  mimeType: "text/markdown",
  contents: [{ uri: "file:///notes.md", mimeType: "text/markdown", text: "# Notes" }],
};

const LOGO: FakeResource = {
  uri: "file:///logo.png",
  name: "logo",
  mimeType: "image/png",
  contents: [{ uri: "file:///logo.png", mimeType: "image/png", blob: "iVBORw0KGgo=" }],
};

const TEMPLATES = [
  { uriTemplate: "file:///{path}", name: "files", mimeType: "text/plain" },
  { uriTemplate: "db:///{table}/{id}", name: "rows" },
];

const servers: ReadonlyArray<readonly [string, (options?: FakeOptions) => FakeServer, string]> = [
  ["Modern", modernServer, "modern"],
  ["Legacy stateless", legacyStatelessServer, "legacy"],
  ["Legacy stateful", legacyStatefulServer, "legacy"],
];

describe.each(servers)("against a %s server", (_name, makeServer, era) => {
  it("lists a page of resources at a time, from a cursor, and says where the next page is", async () => {
    const server = makeServer({ resources: [NOTES, LOGO], resourcePageSize: 1 });

    const { first, second } = await run(
      Effect.gen(function* () {
        const connection = yield* connect(TARGET, testDeps(fetchTo(server)));
        const first = yield* connection.listPage("resources", undefined, AGENT);
        const second = yield* connection.listPage("resources", first.value.nextCursor, AGENT);

        return { first: completed(first), second: completed(second) };
      }),
    );

    expect(first.value.items.map((item) => item.uri)).toEqual([NOTES.uri]);
    expect(first.value.nextCursor).toBe("1");
    expect(second.value.items.map((item) => item.uri)).toEqual([LOGO.uri]);
    expect(second.value.nextCursor).toBeUndefined();
    expect(rpcMethods(server).filter((method) => method === "resources/list")).toHaveLength(2);
  });

  it("lists resource templates, and an empty page without a request for a server with no resources", async () => {
    const withTemplates = makeServer({ resourceTemplates: TEMPLATES });
    const bare = makeServer();

    const { templates, none } = await run(
      Effect.gen(function* () {
        const connection = yield* connect(TARGET, testDeps(fetchTo(withTemplates)));
        const templates = yield* connection.listPage("resources/templates", undefined, AGENT);
        const other = yield* connect(TARGET, testDeps(fetchTo(bare)));
        const none = yield* other.listPage("resources", undefined, AGENT);

        return { templates, none };
      }),
    );

    expect(templates.value.items.map((item) => item.uriTemplate)).toEqual([
      "file:///{path}",
      "db:///{table}/{id}",
    ]);
    expect(none.value).toEqual({ items: [] });
    expect(rpcMethods(bare)).not.toContain("resources/list");
  });

  it(`${era === "modern" ? "carries" : "has none of"} the server's cache hints on a list`, async () => {
    const server = makeServer({
      resources: [NOTES],
      listCache: { ttlMs: 90_000, cacheScope: "public" },
    });

    const page = await run(
      Effect.gen(function* () {
        const connection = yield* connect(TARGET, testDeps(fetchTo(server)));

        return completed(yield* connection.listPage("resources", undefined, AGENT));
      }),
    );

    expect(page.ttlMs).toBe(era === "modern" ? 90_000 : undefined);
    expect(page.cacheScope).toBe(era === "modern" ? "public" : undefined);
  });

  it("reads a resource with the SHA-256 of its contents, which a blob and a text each change", async () => {
    const server = makeServer({ resources: [NOTES, LOGO] });

    const { text, blob, again } = await run(
      Effect.gen(function* () {
        const connection = yield* connect(TARGET, testDeps(fetchTo(server)));
        const text = readComplete(yield* connection.readResource(NOTES.uri, AGENT));
        const blob = readComplete(yield* connection.readResource(LOGO.uri, AGENT));
        const again = readComplete(yield* connection.readResource(NOTES.uri, AGENT));

        return { text, blob, again };
      }),
    );

    expect(text.value.contents).toEqual([
      { uri: NOTES.uri, mimeType: "text/markdown", text: "# Notes" },
    ]);
    expect(blob.value.contents).toEqual([
      { uri: LOGO.uri, mimeType: "image/png", blob: "iVBORw0KGgo=" },
    ]);
    expect(text.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(text.sha256).toBe(await contentsSha256(text.value.contents));
    expect(again.sha256).toBe(text.sha256);
    expect(blob.sha256).not.toBe(text.sha256);
  });

  it("fails a read of a resource the server does not have", async () => {
    const server = makeServer({ resources: [NOTES] });

    const outcome = await run(
      Effect.gen(function* () {
        const connection = yield* connect(TARGET, testDeps(fetchTo(server)));

        return yield* settled(connection.readResource("file:///none", AGENT));
      }),
    );

    expect(outcome).toEqual(failedWith(ServerError));
  });
});

/** A read that completed: these callers keep no pages, so a `-32042` is never kept for them. */
const readComplete = (read: ReadComplete | PagesRequired): ReadComplete => {
  if (read.kind !== "complete") throw new Error("Expected the read to complete");

  return read;
};

describe("the SHA-256 of a read's contents", () => {
  const item = { uri: "file:///a", mimeType: "text/plain", text: "one" };

  it("covers each item's uri, type and body, in order, and nothing else", async () => {
    const same = await contentsSha256([item]);

    expect(await contentsSha256([{ ...item, _meta: { read: 2 } }])).toBe(same);
    expect(await contentsSha256([{ ...item, text: "two" }])).not.toBe(same);
    expect(await contentsSha256([{ ...item, uri: "file:///b" }])).not.toBe(same);
    expect(await contentsSha256([{ ...item, mimeType: "text/markdown" }])).not.toBe(same);
    expect(
      await contentsSha256([{ uri: item.uri, mimeType: item.mimeType, blob: "b25l" }]),
    ).not.toBe(same);
    expect(await contentsSha256([item, item])).not.toBe(same);
    expect(await contentsSha256([])).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("a read the Legacy server asks a question during", () => {
  const ASKING: McpCallContext = {
    ...AGENT,
    answers: { elicitation: true, inputWaitMs: 600_000 },
  };

  const WHO: FakeResource = {
    uri: "file:///who.json",
    name: "who",
    contents: [],
    asks: { message: "Who is reading?" },
  };

  const read = (
    server: FakeServer,
    ctx: McpCallContext,
    answer: McpInputAnswer,
    asked: Array<string> = [],
  ) =>
    run(
      Effect.gen(function* () {
        const connection = yield* connect(TARGET, {
          ...testDeps(fetchTo(server)),
          capabilities: () => ({ elicitation: { form: {} } }),
          onInput: (request) =>
            Effect.sync(() => {
              asked.push(
                Predicate.isString(request.params["message"]) ? request.params["message"] : "",
              );

              return answer;
            }),
        });

        return yield* settled(connection.readResource(WHO.uri, ctx));
      }),
    );

  it("is answered with what onInput gives, as a call's is", async () => {
    const asked: Array<string> = [];
    const server = legacyStatefulServer({ resources: [WHO] });

    const outcome = await read(
      server,
      ASKING,
      { kind: "answered", result: { action: "accept", content: {} } },
      asked,
    );

    expect(asked).toEqual(["Who is reading?"]);
    expect(outcome).toEqual({
      value: expect.objectContaining({
        value: {
          contents: [
            {
              uri: WHO.uri,
              mimeType: "application/json",
              text: JSON.stringify({ action: "accept", content: {} }),
            },
          ],
        },
      }),
    });
  });

  it("is cancelled for a read whose caller can answer nothing", async () => {
    const asked: Array<string> = [];
    const server = legacyStatefulServer({ resources: [WHO] });

    const outcome = await read(
      server,
      AGENT,
      { kind: "answered", result: { action: "accept", content: {} } },
      asked,
    );

    expect(asked).toEqual([]);
    expect(outcome).toEqual({
      value: expect.objectContaining({
        value: {
          contents: [expect.objectContaining({ text: JSON.stringify({ action: "cancel" }) })],
        },
      }),
    });
  });
});
