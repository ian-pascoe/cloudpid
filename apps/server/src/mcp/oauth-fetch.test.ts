// The Registry's OAuth requests (`docs/architecture/mcp-sign-in.md` → Bounds): every one is guarded, timed out and bounded.
// @effect-diagnostics asyncFunction:off globalFetch:off preferEffectArray:off globalTimers:off
import { DnsResolver, type WebRequest, WebToolError, WebTransport } from "@cloudpid/extensions/web";
import { MAX_METADATA_BYTES } from "@cloudpid/mcp/oauth";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vitest";
import type { McpPublicFetchRequest, McpPublicFetchResult } from "@cloudpid/mcp/types";
import {
  guardedOAuthFetch,
  ownHostTransport,
  type PublicReader,
  readsFromMcpWorker,
} from "./oauth-fetch.ts";

const HOSTS = new Map<string, ReadonlyArray<string>>([
  ["as.example", ["93.184.216.34"]],
  ["other.example", ["93.184.216.35"]],
  ["pi.ianpascoe.dev", ["104.21.37.159"]],
]);

const ok = (body: string, contentType = "text/plain"): Response =>
  new Response(body, { status: 200, headers: { "content-type": contentType } });

const redirect = (location: string): Response =>
  new Response(null, { status: 302, headers: { location } });

/** A network that answers each request with `answer`, resolves `HOSTS` only, and records what was sent. */
const network = (answer: (request: WebRequest) => Response) => {
  const requests: WebRequest[] = [];

  const transport = Layer.succeed(WebTransport, {
    fetch: (request) => {
      requests.push(request);

      return Effect.succeed(answer(request));
    },
  });

  const resolver = Layer.succeed(DnsResolver, {
    resolve: (hostname) => {
      const addresses = HOSTS.get(hostname);

      return addresses === undefined
        ? Effect.fail(WebToolError.make({ message: "host not found" }))
        : Effect.succeed(addresses);
    },
  });

  return { transport: { requests }, layer: Layer.mergeAll(transport, resolver) };
};

describe("an OAuth request", () => {
  it("is sent as the caller made it, and answered", async () => {
    const { transport, layer } = network(() =>
      ok('{"issuer":"https://as.example"}', "application/json"),
    );

    const response = await guardedOAuthFetch(layer)("https://as.example/.well-known/x", {
      headers: { accept: "application/json" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ issuer: "https://as.example" });
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]).toMatchObject({
      url: "https://as.example/.well-known/x",
      method: "GET",
      headers: { accept: "application/json" },
    });
  });

  it("sends a form and a text body as text", async () => {
    const { transport, layer } = network(() => ok("{}", "application/json"));
    const fetch = guardedOAuthFetch(layer);

    await fetch("https://as.example/token", {
      method: "POST",
      body: new URLSearchParams({ grant_type: "authorization_code", code: "abc" }),
    });
    await fetch("https://as.example/register", { method: "POST", body: '{"a":1}' });

    expect(transport.requests.map((sent) => sent.body)).toEqual([
      "grant_type=authorization_code&code=abc",
      '{"a":1}',
    ]);
  });

  it("is refused for a method the guard does not send", async () => {
    const { transport, layer } = network(() => ok(""));

    await expect(
      guardedOAuthFetch(layer)("https://as.example/x", { method: "DELETE" }),
    ).rejects.toThrow("never a DELETE");
    expect(transport.requests).toEqual([]);
  });

  it.each([
    ["a loopback address", "http://127.0.0.1/x"],
    ["a private address", "https://10.0.0.1/x"],
    ["a name that does not resolve", "https://nowhere.example/x"],
    ["a scheme that is not http", "file:///etc/passwd"],
  ])("never reaches %s", async (_name, url) => {
    const { transport, layer } = network(() => ok(""));

    await expect(guardedOAuthFetch(layer)(url)).rejects.toThrow();
    expect(transport.requests).toEqual([]);
  });

  it("has each redirect hop checked before it is sent", async () => {
    const { transport, layer } = network((request) =>
      request.url.startsWith("https://as.example")
        ? redirect("http://169.254.169.254/latest")
        : ok(""),
    );

    await expect(guardedOAuthFetch(layer)("https://as.example/x")).rejects.toThrow();
    expect(transport.requests.map(({ url }) => url)).toEqual(["https://as.example/x"]);
  });

  it("is refused when its response is longer than the bound", async () => {
    const { layer } = network(() => ok("x".repeat(MAX_METADATA_BYTES + 1)));

    await expect(guardedOAuthFetch(layer)("https://as.example/x")).rejects.toThrow(
      "longer than 64 KiB",
    );
  });

  it("takes a response of exactly the bound", async () => {
    const { layer } = network(() => ok("x".repeat(MAX_METADATA_BYTES)));
    const response = await guardedOAuthFetch(layer)("https://as.example/x");

    expect((await response.text()).length).toBe(MAX_METADATA_BYTES);
  });

  it("keeps a status that has no body", async () => {
    const { layer } = network(() => new Response(null, { status: 204 }));

    expect((await guardedOAuthFetch(layer)("https://as.example/x")).status).toBe(204);
  });

  it("stops a request that never answers when the caller aborts", async () => {
    const hanging = Layer.mergeAll(
      Layer.succeed(WebTransport, { fetch: () => Effect.never }),
      Layer.succeed(DnsResolver, { resolve: () => Effect.succeed(["93.184.216.34"]) }),
    );

    const controller = new AbortController();

    const pending = guardedOAuthFetch(hanging)("https://as.example/x", {
      signal: controller.signal,
    });

    setTimeout(() => controller.abort(), 10);

    await expect(pending).rejects.toThrow();
  });

  it("times out a body that drips, as it does a request that never answers", async () => {
    const encoder = new TextEncoder();

    const dripping = network(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode("{"));
            },
          }),
          { status: 200 },
        ),
    );

    await expect(guardedOAuthFetch(dripping.layer, 50)("https://as.example/x")).rejects.toThrow(
      "The request timed out",
    );
  });

  it("times out a request that never answers", async () => {
    const hanging = Layer.mergeAll(
      Layer.succeed(WebTransport, { fetch: () => Effect.never }),
      Layer.succeed(DnsResolver, { resolve: () => Effect.succeed(["93.184.216.34"]) }),
    );

    await expect(guardedOAuthFetch(hanging, 50)("https://as.example/x")).rejects.toThrow(
      "The request timed out",
    );
  });

  it("fails at once, and not as a timeout, when the body's source fails", async () => {
    const failing = network(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("connection reset"));
            },
          }),
          { status: 200 },
        ),
    );

    await expect(guardedOAuthFetch(failing.layer, 5000)("https://as.example/x")).rejects.toThrow(
      "connection reset",
    );
  });
});

const RESOURCE_METADATA =
  "https://pi.ianpascoe.dev/.well-known/cloudflare-access-protected-resource/mcp";

/** A reader that answers `answer` (or fails with it) and records what it was asked. */
const reader = (answer: () => Promise<McpPublicFetchResult>) => {
  const asked: Array<McpPublicFetchRequest> = [];

  const read: PublicReader = {
    fetchPublic: (request) => {
      asked.push(request);

      return answer();
    },
  };

  return { read, asked };
};

const fetched = (body: string, code = 200): McpPublicFetchResult => ({
  status: "fetched",
  code,
  headers: { "content-type": "application/json" },
  body,
});

/** The sign-in's fetch over `read` in front of the test network. */
const routed = (read: PublicReader | undefined, answer: (request: WebRequest) => Response) => {
  const { transport, layer } = network(answer);

  const routedLayer = Layer.effect(
    WebTransport,
    Effect.gen(function* () {
      return ownHostTransport(read, yield* WebTransport);
    }),
  ).pipe(Layer.provideMerge(layer));

  return { transport, fetch: guardedOAuthFetch(routedLayer) };
};

describe("which hop is read from McpWorker", () => {
  it.each([
    ["an https GET to the production host", { url: RESOURCE_METADATA, headers: {} }, true],
    [
      "an https GET to a preview's host",
      {
        url: "https://cloudpid-server-pr-9.ian-g-pascoe.workers.dev/.well-known/x",
        method: "GET" as const,
        headers: {},
      },
      true,
    ],
    [
      "a POST to cloudpid's host",
      { url: RESOURCE_METADATA, method: "POST" as const, headers: {}, body: "" },
      false,
    ],
    ["an http GET to cloudpid's host", { url: "http://pi.ianpascoe.dev/x", headers: {} }, false],
    ["an https GET to another host", { url: "https://as.example/x", headers: {} }, false],
    [
      "another Worker on the account's workers.dev",
      { url: "https://someone-else.ian-g-pascoe.workers.dev/x", headers: {} },
      false,
    ],
  ])("%s: %s", (_, request, expected) => {
    expect(readsFromMcpWorker(request)).toBe(expected);
  });
});

describe("an OAuth request to one of cloudpid's own hosts", () => {
  it("is read from McpWorker with only the content-negotiation headers, and answered as McpWorker read it", async () => {
    const { read, asked } = reader(async () =>
      fetched('{"resource":"https://pi.ianpascoe.dev/mcp"}'),
    );

    const { transport, fetch } = routed(read, () => ok("direct"));

    const response = await fetch(RESOURCE_METADATA, {
      headers: { accept: "application/json", authorization: "Bearer secret", cookie: "a=b" },
    });

    expect(await response.json()).toEqual({ resource: "https://pi.ianpascoe.dev/mcp" });
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(asked).toEqual([{ url: RESOURCE_METADATA, headers: { accept: "application/json" } }]);
    expect(transport.requests).toHaveLength(0);
  });

  it("has a redirect McpWorker answered checked here, and its next hop sent from here when it leaves cloudpid's hosts", async () => {
    const { read, asked } = reader(async () => ({
      status: "fetched",
      code: 302,
      headers: { location: "https://as.example/metadata" },
      body: "",
    }));

    const { transport, fetch } = routed(read, () => ok("{}", "application/json"));

    const response = await fetch(RESOURCE_METADATA);

    expect(response.status).toBe(200);
    expect(asked).toHaveLength(1);
    expect(transport.requests.map(({ url }) => url)).toEqual(["https://as.example/metadata"]);
  });

  it("is blocked when McpWorker answers a redirect to a private address, which is never asked", async () => {
    const { read, asked } = reader(async () => ({
      status: "fetched",
      code: 302,
      headers: { location: "http://127.0.0.1/" },
      body: "",
    }));

    const { transport, fetch } = routed(read, () => ok("{}"));

    await expect(fetch(RESOURCE_METADATA)).rejects.toThrow(/redirect blocked/);
    expect(asked).toHaveLength(1);
    expect(transport.requests).toHaveLength(0);
  });

  it("is sent from here, as before, when McpWorker does not have the method yet", async () => {
    const { read } = reader(async () => {
      throw new TypeError('The RPC receiver does not implement the method "fetchPublic".');
    });

    const { transport, fetch } = routed(read, () => ok("{}", "application/json"));

    expect((await fetch(RESOURCE_METADATA)).status).toBe(200);
    expect(transport.requests.map(({ url }) => url)).toEqual([RESOURCE_METADATA]);
  });

  it("is sent from here when the Worker has no McpWorker binding", async () => {
    const { transport, fetch } = routed(undefined, () => ok("{}", "application/json"));

    expect((await fetch(RESOURCE_METADATA)).status).toBe(200);
    expect(transport.requests).toHaveLength(1);
  });

  it("fails, and is not sent from here, when McpWorker cannot be reached", async () => {
    const { read } = reader(async () => {
      throw new Error("Network connection lost.");
    });

    const { transport, fetch } = routed(read, () => ok("{}"));

    await expect(fetch(RESOURCE_METADATA)).rejects.toThrow("McpWorker could not be reached");
    expect(transport.requests).toHaveLength(0);
  });

  it("fails with McpWorker's reason when it refused the read", async () => {
    const { read } = reader(async () => ({ status: "refused", message: "The request timed out" }));
    const { fetch } = routed(read, () => ok("{}"));

    await expect(fetch(RESOURCE_METADATA)).rejects.toThrow("The request timed out");
  });

  it("fails on an answer it cannot read, as on a refusal", async () => {
    // SAFETY: a newer `McpWorker`'s answer, of a shape this one's Schema does not have, is the case under test.
    const { read } = reader(async () => ({ status: "later", detail: 1 }) as never);
    const { fetch } = routed(read, () => ok("{}"));

    await expect(fetch(RESOURCE_METADATA)).rejects.toThrow(/does not read/);
  });

  it("is still bounded here: a body over the bound is refused", async () => {
    const { read } = reader(async () => fetched("x".repeat(MAX_METADATA_BYTES + 1)));
    const { fetch } = routed(read, () => ok("{}"));

    await expect(fetch(RESOURCE_METADATA)).rejects.toThrow(/longer than/);
  });
});

describe("an OAuth request elsewhere", () => {
  it("is sent from here, and McpWorker is never asked", async () => {
    const { read, asked } = reader(async () => fetched("{}"));
    const { transport, fetch } = routed(read, () => ok("{}", "application/json"));

    await fetch("https://as.example/.well-known/oauth-authorization-server");
    await fetch("https://pi.ianpascoe.dev/token", { method: "POST", body: "a=b" });

    expect(asked).toHaveLength(0);
    expect(transport.requests.map(({ url }) => url)).toEqual([
      "https://as.example/.well-known/oauth-authorization-server",
      "https://pi.ianpascoe.dev/token",
    ]);
  });
});
