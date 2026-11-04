// docs/architecture/mcp-apps.md → App Views in the transcript (Remounting). Loading a card's View: the record, then its page,
// kept in memory by (server, hash).
// @effect-diagnostics preferEffectArray:off -- counting calls a fake client was given.
import type { McpAppHtmlAnswer, McpAppMounted, McpAppRecord } from "@cloudpid/protocol";
import { beforeEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { SessionCommandError } from "../session/client.ts";
import { forgetPages, loadAppView, loadRunningView, type AppClient } from "./load.ts";

const ORIGIN = "https://aaaaaaaaaaaaaaaaaaaaaaaaaa.ianpascoe.app";

/** The origin the page itself is served from. */
const PAGE = "https://pi.ianpascoe.dev";

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
  const tool: string[] = [];
  const calls = { mount: 0, page: 0, tool };

  const client: AppClient = {
    mountApp: () => {
      calls.mount += 1;

      return Effect.isEffect(mounted) ? mounted : Effect.succeed(mounted);
    },
    appPage: () => {
      calls.page += 1;

      return Effect.isEffect(page) ? page : Effect.succeed(page);
    },
    appToolPage: (tool) => {
      calls.tool.push(tool);

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

      expect(yield* loadAppView(client, "c1", PAGE)).toEqual({
        status: "view",
        record: record(),
        page: { html: "<p>app</p>", meta: {}, origin: ORIGIN },
      });
    }),
  );

  it.effect(
    "keeps a page by the viewHash of its record and its own hash: a second call does not fetch it again",
    () =>
      Effect.gen(function* () {
        const { client, calls } = fake(
          { status: "record", record: record({ viewHash: "v-one" }) },
          html(),
        );

        yield* loadAppView(client, "c1", PAGE);
        yield* loadAppView(client, "c1", PAGE);
        expect(calls).toEqual({ mount: 2, page: 1, tool: [] });
      }),
  );

  it.effect(
    "never hands one server's origin to another: the same page of the same server in two Environments is two entries",
    () =>
      Effect.gen(function* () {
        const other = "https://bbbbbbbbbbbbbbbbbbbbbbbbbb.ianpascoe.app";
        const first = fake({ status: "record", record: record({ viewHash: "env-one" }) }, html());

        const second = fake(
          { status: "record", record: record({ viewHash: "env-two" }) },
          html({ origin: other }),
        );

        const one = yield* loadAppView(first.client, "c1", PAGE);
        const two = yield* loadAppView(second.client, "c1", PAGE);

        expect(second.calls.page).toBe(1);
        expect(one).toMatchObject({ status: "view", page: { origin: ORIGIN } });
        expect(two).toMatchObject({ status: "view", page: { origin: other } });
      }),
  );

  it.effect("does not share a page of a record that pins no viewHash", () =>
    Effect.gen(function* () {
      const { client, calls } = fake({ status: "record", record: record() }, html());

      yield* loadAppView(client, "c1", PAGE);
      yield* loadAppView(client, "c1", PAGE);
      expect(calls.page).toBe(2);
    }),
  );

  it.effect("is unavailable, never framed, for a server that is no longer the call's", () =>
    Effect.gen(function* () {
      const mounted: McpAppMounted = {
        status: "record",
        record: record({ viewHash: "was-this" }),
      };

      expect(
        yield* loadAppView(
          fake(mounted, { status: "unavailable", message: "Shadowed" }).client,
          "c1",
          PAGE,
        ),
      ).toEqual({ status: "unavailable" });

      // A Session that sent the page of another server's anyway is not believed.
      expect(
        yield* loadAppView(fake(mounted, html({ view: "now-this" })).client, "c1", PAGE),
      ).toEqual({
        status: "unavailable",
      });
    }),
  );

  it.effect("is the summary for an evicted call and nothing for one with no record", () =>
    Effect.gen(function* () {
      const stub = { callId: "c1", server: "docs", tool: "page", conversation: "1" };

      expect(yield* loadAppView(fake({ status: "stub", stub }, html()).client, "c1", PAGE)).toEqual(
        {
          status: "stub",
          stub,
        },
      );
      expect(yield* loadAppView(fake({ status: "none" }, html()).client, "c1", PAGE)).toEqual({
        status: "none",
      });
      expect(yield* loadAppView(fake({ status: "later" }, html()).client, "c1", PAGE)).toEqual({
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
          yield* loadAppView(
            fake(mounted, { status: "missing", message: "No page" }).client,
            "c1",
            PAGE,
          ),
        ).toEqual({ status: "failed", reason: "No page" });

        expect(yield* loadAppView(fake(mounted, { status: "later" }).client, "c1", PAGE)).toEqual({
          status: "failed",
          reason: "later",
        });

        const bare: McpAppHtmlAnswer = { status: "html", hash: "h1", html: "<p>app</p>", meta: {} };

        expect(yield* loadAppView(fake(mounted, bare).client, "c1", PAGE)).toMatchObject({
          status: "failed",
        });
        expect(
          yield* loadAppView(
            fake(mounted, html({ origin: "https://evil.example" })).client,
            "c1",
            PAGE,
          ),
        ).toEqual({ status: "failed", reason: "The sandbox origin is not one the page frames" });
      }),
  );

  it.effect("reports a refused command as a failure with its message", () =>
    Effect.gen(function* () {
      const refusal = refused("No such call");

      expect(yield* loadAppView(fake(refusal, html()).client, "c1", PAGE)).toEqual({
        status: "failed",
        reason: "No such call",
      });
      expect(
        yield* loadAppView(
          fake({ status: "record", record: record() }, refusal).client,
          "c1",
          PAGE,
        ),
      ).toEqual({ status: "failed", reason: "No such call" });
    }),
  );
});

describe("loadRunningView", () => {
  it.effect(
    "is the page of the call's tool, at the origin the Session named, shared with the record's",
    () =>
      Effect.gen(function* () {
        const { client, calls } = fake(
          { status: "record", record: record({ viewHash: "v-one" }) },
          html({ view: "v-one" }),
        );

        expect(yield* loadRunningView(client, "mcp__docs__page", "c1", PAGE)).toEqual({
          status: "running",
          page: { html: "<p>app</p>", meta: {}, origin: ORIGIN, view: "v-one" },
        });
        expect(calls.tool).toEqual(["mcp__docs__page"]);

        // The record's own load finds the page in memory under the same server and hash.
        yield* loadAppView(client, "c1", PAGE);
        expect(calls.page).toBe(0);
      }),
  );

  it.effect("is none when the Session has no page for it, as one that predates it says", () =>
    Effect.gen(function* () {
      const { client } = fake(
        { status: "none" },
        { status: "missing", message: "The message names neither a call nor a page" },
      );

      expect(yield* loadRunningView(client, "mcp__docs__page", "c1", PAGE)).toEqual({
        status: "none",
      });
    }),
  );

  it.effect("fails with the reason, and never frames an origin that is no sandbox's", () =>
    Effect.gen(function* () {
      const failed = fake({ status: "none" }, { status: "failed", message: "boom" });

      expect(yield* loadRunningView(failed.client, "mcp__docs__page", "c1", PAGE)).toEqual({
        status: "failed",
        reason: "boom",
      });

      const odd = fake({ status: "none" }, html({ origin: "https://evil.example" }));

      expect((yield* loadRunningView(odd.client, "mcp__docs__page", "c1", PAGE)).status).toBe(
        "failed",
      );

      const refusedPage = fake({ status: "none" }, refused("down"));

      expect(yield* loadRunningView(refusedPage.client, "mcp__docs__page", "c1", PAGE)).toEqual({
        status: "failed",
        reason: "down",
      });
    }),
  );
});
