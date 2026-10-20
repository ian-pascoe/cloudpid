// The tool seam: a scripted model calls `web_search` through a real Harness, over a fake network that answers as the
// Exa and Parallel MCP endpoints do. The live check of each provider is in `search.live.test.ts`.
// @effect-diagnostics asyncFunction:off preferEffectArray:off schemaSync:off
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { WebToolError } from "./errors.ts";
import { openWebHarness } from "./harness.fixture.ts";
import { selectSearchProvider } from "./search.ts";
import { type WebRequest } from "./transport.ts";
import { ok } from "./web.fixture.ts";

const EXA_KEY = "exa-key-1234567890";
const PARALLEL_KEY = "par-key-abcdef0123";

/** An MCP `tools/call` result carrying `text`. */
type McpExtra = { readonly isError?: boolean; readonly _meta?: Readonly<Record<string, boolean>> };

const mcp = (text: string, extra: McpExtra = {}): Response =>
  ok(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text }], ...extra },
    }),
    "application/json",
  );

const sse = (payloads: readonly unknown[]): Response =>
  ok(
    payloads.map((payload) => `event: message\ndata: ${JSON.stringify(payload)}\n\n`).join(""),
    "text/event-stream",
  );

const open = (
  keys: { exa?: string; parallel?: string },
  answer: (request: WebRequest) => Response | WebToolError,
) => openWebHarness({ answer }, keys, []);

const ProviderBody = Schema.Struct({
  params: Schema.Struct({
    name: Schema.String,
    arguments: Schema.Record(Schema.String, Schema.Unknown),
  }),
});

const decodeBody = Schema.decodeUnknownSync(Schema.fromJsonString(ProviderBody));

const body = (request: WebRequest | undefined) => decodeBody(request?.body);

const exaResult = (title: string, bodyText: string) =>
  `Title: ${title}\nURL: https://example.com/${title}\nPublished Date: N/A\nAuthor: N/A\nHighlights:\n${bodyText}`;

describe("web_search", () => {
  it("says so when neither key is set, and sends nothing", async () => {
    const web = await open({}, () => mcp("never"));
    const result = await web.call("web_search", { query: "anything" });

    expect(result.isError).toBe(true);
    expect(result.text).toBe(
      "Web search is not configured: neither EXA_API_KEY nor PARALLEL_API_KEY is set on this deployment. Ask the owner to set one of them, or use web_fetch on a known URL.",
    );
    expect(web.sent).toEqual([]);
  });

  it("rejects an empty query", async () => {
    const web = await open({ exa: EXA_KEY }, () => mcp("never"));

    expect((await web.call("web_search", { query: "  " })).text).toBe(
      "Unable to search the web: query is empty (provide the text to search the web for)",
    );
  });

  it("searches Exa with its key, query, objective, and result count", async () => {
    const web = await open({ exa: EXA_KEY }, () =>
      mcp(exaResult("one", "A short body of text that Exa highlighted.")),
    );

    const result = await web.call("web_search", { query: "effect schema", numResults: 3 });

    expect(result).toEqual({
      text: exaResult("one", "A short body of text that Exa highlighted.").replace(
        "Published Date: N/A\nAuthor: N/A\n",
        "",
      ),
      isError: false,
    });
    expect(web.sent).toHaveLength(1);
    expect(web.sent[0]?.method).toBe("POST");
    expect(web.sent[0]?.url).toBe(`https://mcp.exa.ai/mcp?exaApiKey=${EXA_KEY}`);
    expect(web.sent[0]?.headers.accept).toBe("application/json, text/event-stream");
    expect(body(web.sent[0]).params).toEqual({
      name: "web_search_exa",
      arguments: { query: "effect schema", objective: "effect schema", numResults: 3 },
    });
  });

  it("searches Parallel with a bearer key and the conversation as its session, and trims the results to numResults", async () => {
    const results = Array.from({ length: 6 }, (_, index) => ({
      url: `https://example.com/${index}`,
      title: `Result ${index}`,
    }));

    const web = await open({ parallel: PARALLEL_KEY }, () =>
      mcp(JSON.stringify({ search_id: "s1", results }, null, 2)),
    );

    const result = await web.call("web_search", { query: "pi durable", numResults: 2 });

    expect(JSON.parse(result.text)).toEqual({ search_id: "s1", results: results.slice(0, 2) });
    expect(web.sent[0]?.url).toBe("https://search.parallel.ai/mcp");
    expect(web.sent[0]?.headers.authorization).toBe(`Bearer ${PARALLEL_KEY}`);

    const { arguments: args } = body(web.sent[0]).params;

    expect(args).toMatchObject({ objective: "pi durable", search_queries: ["pi durable"] });
    expect(args.session_id).toEqual(expect.any(String));
  });

  it("uses one provider for a whole conversation when both keys are set", async () => {
    const web = await open({ exa: EXA_KEY, parallel: PARALLEL_KEY }, () => mcp("text"));

    await web.call("web_search", { query: "one" });
    await web.call("web_search", { query: "two" });

    expect(new Set(web.sent.map((request) => request.url.includes("exa.ai"))).size).toBe(1);
  });

  describe("selectSearchProvider", () => {
    it("picks the only provider with a key, and none without", () => {
      expect(selectSearchProvider({ exa: true, parallel: false }, "s")).toBe("exa");
      expect(selectSearchProvider({ exa: false, parallel: true }, "s")).toBe("parallel");
      expect(selectSearchProvider({ exa: false, parallel: false }, "s")).toBeUndefined();
    });

    it("splits sessions between the two by a stable checksum", () => {
      const keys = { exa: true, parallel: true };

      const picks = ["a", "b", "c", "d", "e", "f", "g", "h"].map((id) =>
        selectSearchProvider(keys, id),
      );

      expect(new Set(picks)).toEqual(new Set(["exa", "parallel"]));
      expect(selectSearchProvider(keys, "a")).toBe(selectSearchProvider(keys, "a"));
      // FNV-1a("a") = 0xe40c292c, base 36 "1c0u5rk"; parity decides.
      expect(selectSearchProvider(keys, "")).toBe("exa");
    });
  });

  it("reads a Server-Sent Events answer, skipping notifications", async () => {
    const web = await open({ exa: EXA_KEY }, () =>
      sse([
        { jsonrpc: "2.0", method: "notifications/progress", params: {} },
        { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "from sse" }] } },
      ]),
    );

    expect((await web.call("web_search", { query: "q" })).text).toBe("from sse");
  });

  it("says when there are no results", async () => {
    const web = await open({ exa: EXA_KEY }, () => mcp("", {}));

    expect((await web.call("web_search", { query: "q" })).text).toBe(
      "No search results found. Please try a different query.",
    );
  });

  describe("failures", () => {
    it("names an HTTP status, with the JSON-RPC error a small JSON body gave", async () => {
      const web = await open(
        { exa: EXA_KEY },
        () =>
          new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: null,
              error: { code: -32001, message: "Invalid API key" },
            }),
            { status: 401, headers: { "content-type": "application/json" } },
          ),
      );

      expect((await web.call("web_search", { query: "find me" })).text).toBe(
        "Unable to search the web for find me: HTTP 401 Unauthorized: Exa returned error -32001: Invalid API key",
      );
    });

    it("names a bare HTTP status", async () => {
      const web = await open(
        { parallel: PARALLEL_KEY },
        () =>
          new Response("<html>oops</html>", {
            status: 503,
            headers: { "content-type": "text/html" },
          }),
      );

      expect((await web.call("web_search", { query: "q" })).text).toBe(
        "Unable to search the web for q: HTTP 503 Service Unavailable",
      );
    });

    it("reports a JSON-RPC error, and never echoes a key in any encoding", async () => {
      const key = "k/e y+1";

      const web = await open({ exa: key }, () =>
        ok(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            error: {
              code: -1,
              message: `bad ${key} ${encodeURIComponent(key)} \u001b[31mred\u001b[0m`,
            },
          }),
          "application/json",
        ),
      );

      const { text } = await web.call("web_search", { query: "q" });

      expect(text).toBe(
        "Unable to search the web for q: Exa returned error -1: bad [REDACTED] [REDACTED] red",
      );
      expect(text).not.toContain(key);
    });

    it("reports Exa's rate limit and a provider-reported error", async () => {
      const limited = await open({ exa: EXA_KEY }, () =>
        mcp("Slow down", { _meta: { "ai.exa/rateLimited": true } }),
      );

      const errored = await open({ parallel: PARALLEL_KEY }, () =>
        mcp("It broke", { isError: true }),
      );

      expect((await limited.call("web_search", { query: "q" })).text).toBe(
        "Unable to search the web for q: Exa rate limit reached: Slow down",
      );
      expect((await errored.call("web_search", { query: "q" })).text).toBe(
        "Unable to search the web for q: Parallel reported an error: It broke",
      );
    });

    it("reports an unrecognized answer and a network failure", async () => {
      const garbage = await open({ exa: EXA_KEY }, () => ok("<html>not mcp</html>", "text/html"));

      const down = await open({ exa: EXA_KEY }, () =>
        WebToolError.make({ message: "network error" }),
      );

      expect((await garbage.call("web_search", { query: "q" })).text).toBe(
        "Unable to search the web for q: Exa returned an unrecognized response",
      );
      expect((await down.call("web_search", { query: "q" })).text).toBe(
        "Unable to search the web for q: network error",
      );
    });
  });

  describe("contextMaxCharacters", () => {
    const three = [
      exaResult("a", "alpha ".repeat(1000)),
      exaResult("b", "beta ".repeat(1000)),
      exaResult("c", "short body ".repeat(20)),
    ].join("\n\n");

    it("shares the budget across Exa results so each keeps its Title and URL, and says how to read more", async () => {
      const web = await open({ exa: EXA_KEY }, () => mcp(three));
      const { text } = await web.call("web_search", { query: "q" });

      expect(Array.from(text).length).toBeLessThan(6000 + 300);

      for (const title of ["a", "b", "c"])
        expect(text).toContain(`Title: ${title}\nURL: https://example.com/${title}`);
      expect(text).toMatch(
        /\[Search results cut at 6000 characters, shared across 3 results; results? [\d, ]+ shortened; pass contextMaxCharacters \(up to 50000\) for more; web_fetch a result's URL for the full page\]$/,
      );
    });

    it("does not suggest a bigger budget the model already chose", async () => {
      const web = await open({ exa: EXA_KEY }, () => mcp(three));
      const { text } = await web.call("web_search", { query: "q", contextMaxCharacters: 900 });

      expect(text).toContain("cut at 900 characters");
      expect(text).not.toContain("pass contextMaxCharacters");
    });

    it("cuts other text once, at code points", async () => {
      const web = await open({ parallel: PARALLEL_KEY }, () => mcp("😀".repeat(100)));
      const { text } = await web.call("web_search", { query: "q", contextMaxCharacters: 10 });

      expect(text).toBe(`${"😀".repeat(10)}\n\n[Search results cut at 10 characters]`);
    });

    it("gives programs the cut provider text and the provider's name", async () => {
      const web = await open({ exa: EXA_KEY }, () => mcp("plain answer"));
      const result = await web.callAsProgram("web_search", { query: "q" });

      expect(result).toEqual({
        isError: false,
        structuredOutput: { provider: "exa", content: "plain answer" },
      });
    });
  });
});
