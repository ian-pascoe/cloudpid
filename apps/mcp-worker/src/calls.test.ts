/**
 * What an engine call records in its span (`docs/architecture/mcp-connections.md` → Telemetry): the wire's counts and
 * status, the server's name and origin, and no value (header, token, URL path or query, argument, result, log).
 */
// @effect-diagnostics asyncFunction:off globalFetch:off preferEffectArray:off strictEffectProvide:off schemaSync:off
import { fetchTo, modernServer } from "@cloudpid/mcp/testing";
import { McpEngineDiscoverResult } from "@cloudpid/mcp/types";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ByteBudget } from "./budget.ts";
import { discover } from "./calls.ts";
import { Validators } from "./validators.ts";

const SECRET = "sk-echoed-secret-0123456789";

const TOKEN = "tok-from-the-host-0123456789";

const HEADER = `Bearer ${SECRET}`;

afterEach(() => {
  vi.unstubAllGlobals();
});

/** `discover` against a Modern server that logs the secret, with the spans it made. */
const discovering = async (url: string) => {
  const server = modernServer({
    logs: [{ level: "warning", data: `rejected ${HEADER} and ${TOKEN}`, logger: "auth" }],
  });

  vi.stubGlobal("fetch", fetchTo(server));

  const spans: Array<Tracer.NativeSpan> = [];

  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);

      spans.push(span);

      return span;
    },
  });

  const target = {
    kind: "http" as const,
    conn: "conn-1",
    name: "docs",
    url,
    headers: { authorization: HEADER },
    redact: [SECRET],
  };

  const answer = await Effect.runPromise(
    discover(
      target,
      {},
      { auth: () => Promise.resolve(TOKEN) },
      { version: "test", hold: () => undefined },
    ).pipe(
      Effect.provide(Layer.mergeAll(ByteBudget.layer, Validators.layer)),
      Effect.provideService(Tracer.Tracer, tracer),
    ),
  );

  return { answer: Schema.decodeSync(McpEngineDiscoverResult)(answer), spans };
};

describe("an engine call's span", () => {
  it("records the wire's counts, the server's name and origin, and nothing it was sent or told", async () => {
    const { answer, spans } = await discovering(
      "https://mcp.example.test/private/path?key=querysecret",
    );

    const call = spans.find((span) => span.name === "mcp.engine.discover");

    expect(answer.kind).toBe("discovered");
    expect(Record.fromEntries(call?.attributes ?? [])).toMatchObject({
      "mcp.server": "docs",
      "mcp.server.origin": "https://mcp.example.test",
      "mcp.http.status": 200,
      "mcp.logs": 1,
    });

    const recorded = JSON.stringify(
      spans.map((span) => [span.name, Record.fromEntries(span.attributes), span.events]),
    );

    for (const value of [SECRET, TOKEN, "querysecret", "/private/path", "Bearer"]) {
      expect(recorded).not.toContain(value);
    }
  });

  it("hands the host the logs, scrubbed of the Secret and the token", async () => {
    const { answer } = await discovering("https://mcp.example.test/mcp");

    expect(answer).toMatchObject({
      kind: "discovered",
      logs: [
        { level: "warning", logger: "auth", data: "rejected Bearer [REDACTED] and [REDACTED]" },
      ],
    });
    expect(JSON.stringify(answer)).not.toContain(SECRET);
    expect(JSON.stringify(answer)).not.toContain(TOKEN);
  });
});
