// The Registry's sign-in network (`docs/architecture/mcp-sign-in.md` → Code, A hop to one of cloudpid's own hosts): which
// hop is read from `McpWorker`, what crosses, how its answer is read, and the fallback to this Worker's own `fetch`.
// @effect-diagnostics asyncFunction:off globalFetch:off preferEffectArray:off schemaSync:off
import { DnsResolver, type WebRequest, WebToolError, WebTransport } from "@cloudpid/extensions/web";
import { MAX_METADATA_BYTES } from "@cloudpid/mcp/oauth";
import { type McpPublicFetchRequest, McpPublicFetchResult } from "@cloudpid/mcp/types";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { guardedOAuthFetch } from "./oauth-fetch.ts";
import { ownHostRouted, type PublicReader, readsFromMcpWorker } from "./own-host-transport.ts";

const HOSTS = new Map<string, ReadonlyArray<string>>([
  ["as.example", ["93.184.216.34"]],
  ["pi.ianpascoe.dev", ["104.21.37.159"]],
]);

const ok = (body: string, contentType = "text/plain"): Response =>
  new Response(body, { status: 200, headers: { "content-type": contentType } });

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

  const routedLayer = ownHostRouted(read).pipe(Layer.provideMerge(layer));

  return { transport, fetch: guardedOAuthFetch(routedLayer) };
};

describe("which hop is read from McpWorker", () => {
  it.each([
    ["an https GET to the production host", { url: RESOURCE_METADATA, headers: {} }, true],
    [
      "a POST to cloudpid's host",
      { url: RESOURCE_METADATA, method: "POST" as const, headers: {}, body: "" },
      false,
    ],
    ["an http GET to cloudpid's host", { url: "http://pi.ianpascoe.dev/x", headers: {} }, false],
    ["an https GET to another host", { url: "https://as.example/x", headers: {} }, false],
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

  it("drops the upstream's length, encodings and hop-by-hop headers, which no longer describe the decoded body", async () => {
    const { read } = reader(async () => ({
      status: "fetched",
      code: 200,
      headers: {
        "content-type": "application/json",
        "content-length": "3",
        "content-encoding": "br",
        "transfer-encoding": "chunked",
        connection: "keep-alive",
        "keep-alive": "timeout=5",
        "cache-control": "no-store",
      },
      body: '{"resource":"https://pi.ianpascoe.dev/mcp"}',
    }));

    const { fetch } = routed(read, () => ok("direct"));
    const response = await fetch(RESOURCE_METADATA);

    expect(await response.json()).toEqual({ resource: "https://pi.ianpascoe.dev/mcp" });
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("transfer-encoding")).toBeNull();
    expect(response.headers.get("connection")).toBeNull();
    expect(response.headers.get("keep-alive")).toBeNull();
    expect(response.headers.get("content-length")).not.toBe("3");
    expect(response.headers.get("cache-control")).toBe("no-store");
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

  it("fails on an answer of a status it does not know (the Schema's fallback member), as on a refusal", async () => {
    const { read } = reader(async () =>
      Schema.decodeUnknownSync(McpPublicFetchResult)({ status: "later", detail: 1 }),
    );

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
