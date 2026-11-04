// docs/architecture/mcp-apps.md → App Views in the transcript (Remounting). Loading a card's View: the record, then its page,
// kept in memory by (server, hash).
// @effect-diagnostics preferEffectArray:off -- counting calls a fake client was given.
import type { McpAppHtmlAnswer, McpAppMounted, McpAppRecord } from "@cloudpid/protocol";
import { beforeEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { SessionCommandError } from "../session/client.ts";
import { forgetPages, loadAppView, type AppClient } from "./load.ts";

const ORIGIN = "https://aaaaaaaaaaaaaaaaaaaaaaaaaa.ianpascoe.app";

const record = (over: Partial<McpAppRecord> = {}): McpAppRecord => ({
  callId: "c1",
  server: "docs",
  tool: "page",
  conversation: "1",
  arguments: {},
  htmlHash: "h1",
  result: {},
  audit: [],
  at: 1,
  ...over,
});

const html = (
  over: Partial<Extract<McpAppHtmlAnswer, { status: "html" }>> = {},
): McpAppHtmlAnswer => ({
  status: "html",
  hash: "h1",
  html: "<p>app</p>",
  meta: {},
  origin: ORIGIN,
  ...over,
});

/** A command the Session refused. */
const refused = (message: string) => Effect.fail(SessionCommandError.make({ message }));

/** A client that answers with `mounted` and `page`, counting each. */
const fake = (
  mounted: McpAppMounted | ReturnType<typeof refused>,
  page: McpAppHtmlAnswer | ReturnType<typeof refused>,
) => {
  const calls = { mount: 0, page: 0 };

  const client: AppClient = {
    mountApp: () => {
      calls.mount += 1;

      return Effect.isEffect(mounted) ? mounted : Effect.succeed(mounted);
    },
    appPage: () => {
      calls.page += 1;

      return Effect.isEffect(page) ? page : Effect.succeed(page);
    },
  };

  return { client, calls };
};

beforeEach(forgetPages);

describe("loadAppView", () => {
  it.effect("is the record and its page, at the origin the Session named", () =>
    Effect.gen(function* () {
      const { client } = fake({ status: "record", record: record() }, html());

      expect(yield* loadAppView(client, "c1")).toEqual({
        status: "view",
        record: record(),
        page: { html: "<p>app</p>", meta: {}, origin: ORIGIN },
      });
    }),
  );

  it.effect(
    "keeps a page by its server and hash: a second call of the App does not fetch it again",
    () =>
      Effect.gen(function* () {
        const { client, calls } = fake({ status: "record", record: record() }, html());

        yield* loadAppView(client, "c1");
        yield* loadAppView(client, "c1");
        expect(calls).toEqual({ mount: 2, page: 1 });

        // The same hash from another server is another entry: its origin is its own.
        const other = fake({ status: "record", record: record({ server: "other" }) }, html());

        yield* loadAppView(other.client, "c1");
        expect(other.calls.page).toBe(1);
      }),
  );

  it.effect("is the summary for an evicted call and nothing for one with no record", () =>
    Effect.gen(function* () {
      const stub = { callId: "c1", server: "docs", tool: "page", conversation: "1" };

      expect(yield* loadAppView(fake({ status: "stub", stub }, html()).client, "c1")).toEqual({
        status: "stub",
        stub,
      });
      expect(yield* loadAppView(fake({ status: "none" }, html()).client, "c1")).toEqual({
        status: "none",
      });
      expect(yield* loadAppView(fake({ status: "later" }, html()).client, "c1")).toEqual({
        status: "none",
      });
    }),
  );

  it.effect(
    "fails, never frames, when there is no page, no origin, or an origin that is no sandbox's",
    () =>
      Effect.gen(function* () {
        const mounted: McpAppMounted = { status: "record", record: record() };

        expect(
          yield* loadAppView(fake(mounted, { status: "missing", message: "No page" }).client, "c1"),
        ).toEqual({ status: "failed", reason: "No page" });

        expect(yield* loadAppView(fake(mounted, { status: "later" }).client, "c1")).toEqual({
          status: "failed",
          reason: "later",
        });

        const bare: McpAppHtmlAnswer = { status: "html", hash: "h1", html: "<p>app</p>", meta: {} };

        expect(yield* loadAppView(fake(mounted, bare).client, "c1")).toMatchObject({
          status: "failed",
        });
        expect(
          yield* loadAppView(fake(mounted, html({ origin: "https://evil.example" })).client, "c1"),
        ).toEqual({ status: "failed", reason: "The sandbox origin is not one the page frames" });
      }),
  );

  it.effect("reports a refused command as a failure with its message", () =>
    Effect.gen(function* () {
      const refusal = refused("No such call");

      expect(yield* loadAppView(fake(refusal, html()).client, "c1")).toEqual({
        status: "failed",
        reason: "No such call",
      });
      expect(
        yield* loadAppView(fake({ status: "record", record: record() }, refusal).client, "c1"),
      ).toEqual({ status: "failed", reason: "No such call" });
    }),
  );
});
