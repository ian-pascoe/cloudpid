// @effect-diagnostics asyncFunction:off globalFetch:off newPromise:off schemaSync:off
import { describe, expect, it, vi } from "vitest";
import { MAX_METADATA_BYTES } from "./oauth-http.ts";
import * as Schema from "effect/Schema";
import {
  fetchPublic,
  McpPublicFetched,
  McpPublicFetchResult,
  McpPublicRefused,
  publicFetchHeaders,
  publicFetchRefusal,
} from "./public-fetch.ts";

const URL_OF = "https://pi.ianpascoe.dev/.well-known/cloudflare-access-protected-resource/mcp";

/** A `fetch` that answers `response` and records what it was sent. */
const answering = (response: () => Response) => {
  const sent: Array<{ readonly url: string; readonly init: RequestInit | undefined }> = [];

  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: input instanceof Request ? input.url : input.toString(), init });

    return response();
  });

  return { fetch, sent };
};

describe("a public read's URL", () => {
  it.each([
    ["not a URL", "nope"],
    ["http", "http://pi.ianpascoe.dev/x"],
    ["credentials", "https://user:pass@pi.ianpascoe.dev/x"],
    ["a user alone", "https://user@pi.ianpascoe.dev/x"],
  ])("is refused when it is %s", (_, url) => {
    expect(publicFetchRefusal(url)).toBeDefined();
  });

  it("is read when it is https with no credentials", () => {
    expect(publicFetchRefusal(URL_OF)).toBeUndefined();
  });
});

describe("fetchPublic", () => {
  it("sends a GET with no redirect followed and only the content-negotiation headers", async () => {
    const { fetch, sent } = answering(() =>
      Response.json({ resource: "https://pi.ianpascoe.dev/mcp" }),
    );

    const answer = await fetchPublic(
      {
        url: URL_OF,
        headers: {
          Accept: "application/json",
          "MCP-Protocol-Version": "2025-11-25",
          Authorization: "Bearer secret",
          Cookie: "CF_Authorization=secret",
        },
      },
      fetch,
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe(URL_OF);
    expect(sent[0]?.init?.method).toBe("GET");
    expect(sent[0]?.init?.redirect).toBe("manual");
    expect(sent[0]?.init?.body).toBeUndefined();
    expect(sent[0]?.init?.headers).toEqual({
      accept: "application/json",
      "mcp-protocol-version": "2025-11-25",
    });
    expect(answer).toMatchObject({
      status: "fetched",
      code: 200,
      body: JSON.stringify({ resource: "https://pi.ianpascoe.dev/mcp" }),
    });
    expect(answer.status === "fetched" && answer.headers["content-type"]).toContain(
      "application/json",
    );
  });

  it("answers a redirect as it is, with its location, for the caller to check and follow", async () => {
    const { fetch } = answering(
      () =>
        new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } }),
    );

    const answer = await fetchPublic({ url: URL_OF }, fetch);

    expect(answer).toMatchObject({
      status: "fetched",
      code: 302,
      headers: { location: "https://elsewhere.example/" },
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    ["malformed", { href: URL_OF }],
    ["not https", { url: "http://pi.ianpascoe.dev/x" }],
    ["carrying credentials", { url: "https://a:b@pi.ianpascoe.dev/x" }],
  ])("refuses a request that is %s and sends nothing", async (_, request) => {
    const { fetch } = answering(() => new Response("{}"));

    // SAFETY: a request that does not match the Schema, as one over RPC may not, is the case under test.
    expect(await fetchPublic(request as never, fetch)).toMatchObject({ status: "refused" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a body over 64 KiB", async () => {
    const { fetch } = answering(() => new Response("x".repeat(MAX_METADATA_BYTES + 1)));

    expect(await fetchPublic({ url: URL_OF }, fetch)).toEqual({
      status: "refused",
      message: "The response is longer than 64 KiB",
    });
  });

  it("answers a failed fetch as refused, never throwing", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("network");
    });

    expect(await fetchPublic({ url: URL_OF }, fetch)).toEqual({
      status: "refused",
      message: "The request failed",
    });
  });

  it("gives up at the timeout", async () => {
    const fetch = vi.fn(
      (_: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );

    expect(await fetchPublic({ url: URL_OF }, fetch, 10)).toEqual({
      status: "refused",
      message: "The request timed out",
    });
  });
});

describe("a public read's answer", () => {
  it("decodes a status a later McpWorker may answer as the fallback member, which is neither a response nor a refusal", () => {
    const answer = Schema.decodeUnknownSync(McpPublicFetchResult)({ status: "later", detail: 1 });

    expect(answer.status).toBe("later");
    expect(Schema.is(McpPublicFetched)(answer)).toBe(false);
    expect(Schema.is(McpPublicRefused)(answer)).toBe(false);
  });
});

describe("the headers a public read passes on", () => {
  it("are the content-negotiation ones alone, by lowercase name", () => {
    expect(
      publicFetchHeaders({
        Accept: "application/json",
        "MCP-Protocol-Version": "2025-11-25",
        Authorization: "Bearer secret",
        Cookie: "a=b",
      }),
    ).toEqual({ accept: "application/json", "mcp-protocol-version": "2025-11-25" });
    expect(publicFetchHeaders(undefined)).toEqual({});
  });
});
