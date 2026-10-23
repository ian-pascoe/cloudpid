// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off
import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { BrowserHostRpc } from "@cloudpid/extensions/browser/contract";

declare global {
  namespace Cloudflare {
    /** The bindings `vitest.config.ts` gives the test Worker. */
    interface Env {
      /** Typed by its methods rather than by the class: the RPC types of a result with JSON details recurse without end. */
      readonly BROWSER_HOST: { getByName(name: string): BrowserHostRpc };
    }
  }
}

describe("the browser Worker", () => {
  it("describes the browser tool", async () => {
    const description = await env.BROWSER_HOST.getByName("session").describe();

    expect(description).toMatch(/Chrome DevTools Protocol/);
  });

  it("runs the model's code in a Worker Loader isolate, through the CodemodeRuntime facet it exports", async () => {
    const run = await env.BROWSER_HOST.getByName("session").run("async () => 6 * 7", 1);

    expect(run.isError).not.toBe(true);
    expect(run.details).toMatchObject({ status: "completed" });
    expect(JSON.stringify(run.output)).toContain("42");
  });

  it("closes nothing when no browser was started", async () => {
    expect(await env.BROWSER_HOST.getByName("idle").close()).toBe(false);
  });

  it("hands over no tab for a conversation that has none, without starting a browser for it", async () => {
    // Starting a browser would reach the binding, which fails with a 503 here: this answer is from the stored records.
    const failure = await env.BROWSER_HOST.getByName("no-tab")
      .startHandoff({
        requestId: "1",
        conversationId: 1,
        instructions: "Log in",
        timeoutMs: 60_000,
      })
      .then(
        () => undefined,
        (error: Error) => error,
      );

    expect(String(failure)).toMatch(/no open tab/);
  });

  it("mints no Live View link for a handoff it does not have, and says so over RPC", async () => {
    const failure = await env.BROWSER_HOST.getByName("no-handoff")
      .liveView("1")
      .then(
        () => undefined,
        (error: Error) => error,
      );

    expect(String(failure)).toContain("the handoff is over");
  });

  it("answers an HTTP request with 404", async () => {
    const response = await SELF.fetch("https://browser.example/");

    expect(response.status).toBe(404);
  });
});
