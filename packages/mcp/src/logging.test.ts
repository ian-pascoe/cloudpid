/**
 * Server logging (`docs/architecture/mcp-in-a-session.md` → Server logging): `warning` in both eras, asked only of a
 * server that declares `logging`, and every `notifications/message` handed to `onLog`.
 */
// @effect-diagnostics asyncFunction:off preferEffectArray:off
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  ECHO_TOOL,
  type FakeServer,
  fetchTo,
  legacyStatefulServer,
  legacyStatelessServer,
  modernServer,
} from "./fakes.fixture.ts";
import { AGENT, run, TARGET, testDeps } from "./core.fixture.ts";
import { connect, type McpLog } from "./index.ts";

const LOGS = [
  { level: "debug", data: "too quiet" },
  { level: "info", data: "still quiet" },
  { level: "warning", data: { note: "disk low" }, logger: "disk" },
  { level: "error", data: "failed" },
] as const;

/** Name, a server sending `logs`, its era, and whether its answers can carry notifications (a JSON-only one cannot). */
const servers: ReadonlyArray<
  readonly [string, (logs?: typeof LOGS) => FakeServer, "modern" | "legacy", boolean]
> = [
  ["Modern", (logs) => modernServer({ logs }), "modern", true],
  [
    "Legacy stateless, answering in JSON",
    (logs) => legacyStatelessServer({ logs }),
    "legacy",
    false,
  ],
  ["Legacy stateful", (logs) => legacyStatefulServer({ logs }), "legacy", true],
];

/** The logs `onLog` heard over one `tools/call`, and the server the call went to. */
const callHearing = (server: FakeServer) =>
  run(
    Effect.gen(function* () {
      const heard: Array<McpLog> = [];
      const deps = testDeps(fetchTo(server), { onLog: (log) => heard.push(log) });
      const connection = yield* connect(TARGET, deps);

      yield* connection.callTool({ tool: ECHO_TOOL, arguments: { text: "hi" } }, AGENT);

      return heard;
    }),
  );

const LOG_LEVEL_KEY = "io.modelcontextprotocol/logLevel";

/** `logging/setLevel`, Legacy's way of asking for a level. */
const SetLevel = Schema.Struct({
  method: Schema.Literal("logging/setLevel"),
  params: Schema.Struct({ level: Schema.String }),
});

/** Any request carrying the level in its `_meta`, Modern's way. */
const MetaLevel = Schema.Struct({
  method: Schema.String,
  params: Schema.Struct({ _meta: Schema.Struct({ [LOG_LEVEL_KEY]: Schema.String }) }),
});

const readLevel = Schema.decodeUnknownOption(Schema.Union([SetLevel, MetaLevel]));

const levelsAsked = (server: FakeServer) =>
  server.received.flatMap((received) =>
    Option.match(readLevel(received.rpc), {
      onNone: () => [],
      onSome: (asked) =>
        "level" in asked.params
          ? [`setLevel:${asked.params.level}`]
          : [`${asked.method}:${asked.params._meta[LOG_LEVEL_KEY]}`],
    }),
  );

describe.each(servers)(
  "against a %s server that declares logging",
  (_name, makeServer, era, streams) => {
    it("asks for warning, and hands onLog what the server sends", async () => {
      const server = makeServer(LOGS);
      const heard = await callHearing(server);

      // The level asked is `warning` in this era's way: `logging/setLevel` once on Legacy, `_meta` on every Modern request.
      const asked = levelsAsked(server);

      if (era === "legacy") {
        expect(asked).toEqual(["setLevel:warning"]);
      } else {
        expect(asked).toEqual(["tools/call:warning"]);
      }

      // Only what the server's filter lets through arrives: nothing below `warning` where the filter holds.
      expect(heard.map((log) => log.level)).toEqual(streams ? ["warning", "error"] : []);

      if (streams) {
        expect(heard[0]).toEqual({ level: "warning", logger: "disk", data: { note: "disk low" } });
      }
    });

    it("asks for nothing when nothing listens", async () => {
      const server = makeServer(LOGS);

      await run(
        Effect.gen(function* () {
          const connection = yield* connect(TARGET, testDeps(fetchTo(server)));

          yield* connection.callTool({ tool: ECHO_TOOL, arguments: { text: "hi" } }, AGENT);
        }),
      );

      expect(levelsAsked(server)).toEqual([]);
    });
  },
);

describe.each(servers)("against a %s server that does not declare logging", (_name, makeServer) => {
  it("asks for no level", async () => {
    const server = makeServer();

    await callHearing(server);

    expect(levelsAsked(server)).toEqual([]);
  });
});

describe("a connection's stats", () => {
  it("count the responses, the last status, and no retries on a clean run", async () => {
    const server = modernServer();

    const stats = await run(
      Effect.gen(function* () {
        const connection = yield* connect(TARGET, testDeps(fetchTo(server)));

        yield* connection.list("tools", AGENT);

        return connection.stats();
      }),
    );

    expect(stats).toMatchObject({ retries: 0, eraDrops: 0, reinitializes: 0, lastStatus: 200 });
    expect(stats.responses).toBeGreaterThanOrEqual(2);
  });
});
