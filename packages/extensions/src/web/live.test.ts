// Opt-in checks against the real network and the real providers: `WEB_TOOLS_LIVE=1 EXA_API_KEY=… PARALLEL_API_KEY=… pnpm
// exec vitest run src/web/live.test.ts`. They are skipped otherwise, and a provider is skipped without its key. Nothing
// here prints a key.
// @effect-diagnostics asyncFunction:off strictEffectProvide:off processEnv:off globalDate:off
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vitest";
import { Web, WebNetworkLive } from "../web.ts";
import { WebConfig } from "./config.ts";

const live = process.env.WEB_TOOLS_LIVE === "1";
const exa = process.env.EXA_API_KEY ?? "";
const parallel = process.env.PARALLEL_API_KEY ?? "";

const key = (value: string) => (value === "" ? Option.none() : Option.some(Redacted.make(value)));

const tools = async (
  exaKey: string,
  parallelKey: string,
): Promise<ReadonlyMap<string, ToolRegistration>> => {
  const extension = await Effect.runPromise(
    Web.pipe(
      Effect.provide(
        Layer.mergeAll(
          WebNetworkLive,
          Layer.succeed(WebConfig, { exaApiKey: key(exaKey), parallelApiKey: key(parallelKey) }),
        ),
      ),
    ),
  );

  return new Map(Arr.map(extension.tools ?? [], (tool) => [tool.name, tool]));
};

// The tools read only `conversationId` from the invocation's API.
const api: ToolExecutionApi = Object.create(null, { conversationId: { value: 1 } });

const text = (result: Awaited<ReturnType<ToolRegistration["execute"]>>): string =>
  Arr.join(
    Arr.map(result.output ?? [], (block) => (block.type === "text" ? block.text : "")),
    "",
  );

const run = async (
  all: ReadonlyMap<string, ToolRegistration>,
  name: string,
  args: Record<string, string | number>,
) =>
  // SAFETY: the arguments are the tool's JSON parameters.
  (all.get(name) as ToolRegistration).execute(args as never, api, BACKGROUND_CONTEXT);

describe.skipIf(!live)("live web_fetch", () => {
  it("fetches a public page as Markdown", async () => {
    const result = await run(await tools("", ""), "web_fetch", { url: "https://example.com/" });

    expect(text(result)).toContain("Example Domain");
  });

  it("refuses a public name that resolves to loopback (localtest.me), found by the DoH lookup", async () => {
    const result = await run(await tools("", ""), "web_fetch", { url: "http://localtest.me/" });

    expect(text(result)).toBe(
      "Unable to fetch http://localtest.me/: blocked: host resolves to a loopback address",
    );
  });

  it("refuses a public page that redirects to the metadata address", async () => {
    const result = await run(await tools("", ""), "web_fetch", {
      url: "https://httpbin.org/redirect-to?url=http%3A%2F%2F169.254.169.254%2F&status_code=302",
    });

    expect(text(result)).toContain("redirect blocked: cloud metadata address");
  });

  it("follows a redirect between public pages", async () => {
    const result = await run(await tools("", ""), "web_fetch", {
      url: "https://httpbingo.org/redirect-to?url=https%3A%2F%2Fexample.com%2F&status_code=302",
    });

    expect(text(result)).toContain("Example Domain");
  });
});

describe.skipIf(!live)("live web_search", () => {
  it.skipIf(exa === "")("searches Exa", async () => {
    const result = await run(await tools(exa, ""), "web_search", {
      query: "Cloudflare Workers Durable Objects",
      numResults: 3,
    });

    expect(result.isError).not.toBe(true);
    expect(text(result)).toContain("URL: ");
    expect(text(result)).not.toContain(exa);
  });

  it.skipIf(parallel === "")("searches Parallel", async () => {
    const result = await run(await tools("", parallel), "web_search", {
      query: "Cloudflare Workers Durable Objects",
      numResults: 3,
    });

    expect(result.isError).not.toBe(true);
    expect(text(result).length).toBeGreaterThan(50);
    expect(text(result)).not.toContain(parallel);
  });
});
