// The web tools run in workerd: the HTML conversion and the SSRF guard under the Workers runtime (`URL`, `Response`,
// `TextDecoder`), over a fake network. The Session host's own tests cover the extension's wiring into a Session.
// workerd's `fetch` and the Harness are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off strictEffectProvide:off
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { DnsResolver, Web, WebConfig, WebTransport } from "@cloudpid/extensions/web";
import type { ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { expect, it } from "vitest";

const PAGE = `<html><head><title>Hello page</title></head><body><nav>NavAlpha</nav>
<main><h1>Hello</h1><p>world <strong>wide</strong> and <a href="https://example.com/x">linked</a></p></main></body></html>`;

const network = Layer.mergeAll(
  Layer.succeed(WebTransport, {
    fetch: (request) =>
      Effect.succeed(
        request.url === "https://example.com/redirect"
          ? new Response(null, {
              status: 302,
              headers: { location: "http://169.254.169.254/latest/meta-data/" },
            })
          : new Response(PAGE, { headers: { "content-type": "text/html" } }),
      ),
  }),
  Layer.succeed(DnsResolver, { resolve: () => Effect.succeed(["93.184.216.34"]) }),
  Layer.succeed(WebConfig, { exaApiKey: Option.none(), parallelApiKey: Option.none() }),
);

const tool = async (name: string): Promise<ToolRegistration> => {
  const extension = await Effect.runPromise(Web.pipe(Effect.provide(network)));
  const found = Arr.findFirst(extension.tools ?? [], (candidate) => candidate.name === name);

  if (Option.isNone(found)) throw new Error(`No tool ${name}`);

  return found.value;
};

/** These tools do not use the invocation's API. */
// SAFETY: `web_fetch` never reads `api`.
const api = {} as ToolExecutionApi;

const text = (result: Awaited<ReturnType<ToolRegistration["execute"]>>): string =>
  Arr.join(
    Arr.map(result.output ?? [], (block) => (block.type === "text" ? block.text : "")),
    "",
  );

it("converts a page to Markdown, keeping the main content", async () => {
  const fetch = await tool("web_fetch");

  expect(text(await fetch.execute({ url: "https://example.com/" }, api, BACKGROUND_CONTEXT))).toBe(
    "# Hello page\n\n*Site chrome outside the main content was removed.*\n\n# Hello\n\nworld **wide** and [linked](https://example.com/x)",
  );
});

it("refuses a redirect to the metadata service, and a literal one", async () => {
  const fetch = await tool("web_fetch");

  const redirected = await fetch.execute(
    { url: "https://example.com/redirect" },
    api,
    BACKGROUND_CONTEXT,
  );

  const literal = await fetch.execute({ url: "http://[fd00:ec2::254]/" }, api, BACKGROUND_CONTEXT);

  expect(redirected.isError).toBe(true);
  expect(text(redirected)).toBe(
    "Unable to fetch https://example.com/redirect: redirect blocked: cloud metadata address",
  );
  expect(text(literal)).toBe(
    "Unable to fetch http://[fd00:ec2::254]/: blocked: unique-local address",
  );
});
