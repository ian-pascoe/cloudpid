/**
 * What an engine call records in its span (`docs/architecture/mcp-connections.md` → Telemetry): the wire's counts and
 * status, the server's name and origin, and no value (header, token, URL path or query, argument, result, log).
 */
// @effect-diagnostics asyncFunction:off globalFetch:off preferEffectArray:off strictEffectProvide:off schemaSync:off globalJsonInEffect:off
import { type FakeServer, fetchTo, modernServer } from "@cloudpid/mcp/testing";
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

/** What `discovering` varies: the server, how its `fetch` answers, and the target's headers and `redact`. */
type Discovering = {
  readonly server?: FakeServer;
  readonly fetch?: (server: FakeServer) => typeof fetch;
  readonly headers?: Readonly<Record<string, string>>;
  readonly redact?: ReadonlyArray<string>;
};

/** `discover` against a Modern server that logs the secret, with the spans it made. */
const discovering = async (url: string, options: Discovering = {}) => {
  const server =
    options.server ??
    modernServer({
      logs: [{ level: "warning", data: `rejected ${HEADER} and ${TOKEN}`, logger: "auth" }],
    });

  vi.stubGlobal("fetch", options.fetch === undefined ? fetchTo(server) : options.fetch(server));

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
    headers: options.headers ?? { authorization: HEADER },
    redact: options.redact ?? [SECRET],
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

  const URL = "https://mcp.example.test/mcp";

  it("scrubs the error of a discovery whose server echoes a header", async () => {
    const failList =
      (server: FakeServer): typeof fetch =>
      async (input, init) => {
        const request = new Request(input, init);
        const body = await request.clone().text();

        if (!body.includes('"tools/list"')) return fetchTo(server)(request);

        return Response.json({
          jsonrpc: "2.0",
          id: JSON.parse(body).id,
          error: { code: -32603, message: `denied ${HEADER}` },
        });
      };

    const { answer } = await discovering(URL, { fetch: failList });

    expect(answer.kind).toBe("failed");
    expect(JSON.stringify(answer)).not.toContain(SECRET);
    expect(JSON.stringify(answer)).toContain("[REDACTED]");
  });

  it("scrubs the tools, prompts and instructions a discovery stores", async () => {
    const server = modernServer({
      moreTools: [
        {
          name: "leak",
          description: `calls with ${HEADER}`,
          inputSchema: { type: "object", properties: { key: { description: SECRET } } },
        },
      ],
    });

    const { answer } = await discovering(URL, { server });

    if (answer.kind !== "discovered") throw new Error(JSON.stringify(answer));

    expect(answer.tools.find((tool) => tool.name === "leak")?.description).toBe(
      "calls with Bearer [REDACTED]",
    );
    expect(JSON.stringify(answer)).not.toContain(SECRET);
  });

  it("scrubs a token the server echoes in its instructions and serverInfo from the rows the call changed, as from the result", async () => {
    const server = modernServer({
      instructions: `Send ${TOKEN} and ${SECRET} with every call.`,
      serverName: `docs for ${TOKEN}`,
    });

    const { answer } = await discovering(URL, { server });

    if (answer.kind !== "discovered") throw new Error(JSON.stringify(answer));

    const rows = JSON.stringify(answer.state);

    // The rows hold what the server said of itself, so the test is of something: the scrub left the place, not the row out.
    expect(rows).toContain("Send [REDACTED] and [REDACTED] with every call.");
    expect(rows).toContain("docs for [REDACTED]");
    expect(rows).not.toContain(TOKEN);
    expect(rows).not.toContain(SECRET);
    expect(JSON.stringify(answer)).not.toContain(TOKEN);
  });

  it("keeps a tool named like a header's value that is no credential, and scrubs what a credential header holds", async () => {
    const server = modernServer({
      moreTools: [
        {
          name: "acme_search",
          description: "Searches acme as application/json.",
          inputSchema: { type: "object" },
        },
        { name: "echo_key", description: "Takes key-0123456789.", inputSchema: { type: "object" } },
      ],
    });

    const { answer } = await discovering(URL, {
      server,
      redact: [],
      headers: { "X-Org": "acme", Accept: "application/json", "X-Api-Key": "key-0123456789" },
    });

    if (answer.kind !== "discovered") throw new Error(JSON.stringify(answer));

    const described = (name: string) =>
      answer.tools.find((tool) => tool.name === name)?.description;

    expect(described("acme_search")).toBe("Searches acme as application/json.");
    expect(described("echo_key")).toBe("Takes [REDACTED].");
  });
});
