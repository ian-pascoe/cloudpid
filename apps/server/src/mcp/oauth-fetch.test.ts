// The Registry's OAuth requests (`docs/architecture/mcp-sign-in.md` → Bounds): every one is guarded, timed out and bounded.
// @effect-diagnostics asyncFunction:off globalFetch:off preferEffectArray:off globalTimers:off
import { DnsResolver, type WebRequest, WebToolError, WebTransport } from "@cloudpid/extensions/web";
import { MAX_METADATA_BYTES } from "@cloudpid/mcp/oauth";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vitest";
import { guardedOAuthFetch } from "./oauth-fetch.ts";

const HOSTS = new Map<string, ReadonlyArray<string>>([
  ["as.example", ["93.184.216.34"]],
  ["other.example", ["93.184.216.35"]],
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
});
