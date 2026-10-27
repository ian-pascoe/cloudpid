// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off
import { SELF } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { BrowserHostRpc } from "@cloudpid/extensions/browser/contract";
import type { ContainerPreviewProps } from "./container-preview.ts";

declare global {
  namespace Cloudflare {
    /** The bindings `vitest.config.ts` gives the test Worker. */
    interface Env {
      /** Typed by its methods rather than by the class: the RPC types of a result with JSON details recurse without end. */
      readonly BROWSER_HOST: { getByName(name: string): BrowserHostRpc };
    }
  }
}

/** The Session's Workspace, as the calls that can acquire a browser name it. */
const WORKSPACE = "ws:abc";

/** The `ContainerPreviews` entrypoint the entry exports, made for `workspace` as the browser host makes it. */
const containerPreviewsFor = (workspace: string): Fetcher =>
  // SAFETY: the entry (`worker.ts`) exports `ContainerPreviews`; `exports` is untyped without the main module's types.
  (
    exports as {
      readonly ContainerPreviews: (options: { readonly props: ContainerPreviewProps }) => Fetcher;
    }
  ).ContainerPreviews({ props: { workspace } });

describe("the browser Worker", () => {
  it("describes the browser tool", async () => {
    const description = await env.BROWSER_HOST.getByName("session").describe();

    expect(description).toMatch(/Chrome DevTools Protocol/);
  });

  it("runs the model's code in a Worker Loader isolate, through the CodemodeRuntime facet it exports", async () => {
    const run = await env.BROWSER_HOST.getByName("session").run(
      "async () => 6 * 7",
      1,
      undefined,
      WORKSPACE,
    );

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

  it("says the Owner tab is gone over RPC, starting no browser, when the Browser Pane asks again and the owner has none", async () => {
    // Starting a browser would reach the binding, which fails with a 503 here: this answer is from the stored records.
    const failure = await env.BROWSER_HOST.getByName("no-owner-tab")
      .ownerTabView(false, WORKSPACE)
      .then(
        () => undefined,
        (error: Error) => error,
      );

    expect(String(failure)).toContain("the Owner tab is gone");
  });

  it("lists no Owner tabs over RPC, starting no browser, and cannot show or close one the owner does not have", async () => {
    // As above: none of these may reach the binding, which fails with a 503 here.
    const host = env.BROWSER_HOST.getByName("no-owner-tabs");

    expect(await host.ownerTabs()).toEqual({ tabs: [] });
    expect(await host.closeOwnerTab("nope")).toEqual({ tabs: [] });

    const failure = await host.showOwnerTab("nope").then(
      () => undefined,
      (error: Error) => error,
    );

    expect(String(failure)).toContain("the Owner tab is gone");
  });

  it("answers an HTTP request with 404", async () => {
    const response = await SELF.fetch("https://browser.example/");

    expect(response.status).toBe(404);
  });
});

describe("the Container previews' entrypoint", () => {
  it("hands a request to the Workspaces Worker for the Workspace its props name, with the port its host is for, as the browser sent it", async () => {
    const response = await containerPreviewsFor(WORKSPACE).fetch(
      "http://5173.cloudpid.internal/src/main.js?t=1",
      {
        method: "POST",
        headers: { origin: "http://5173.cloudpid.internal" },
        body: "hello",
      },
    );

    // The stand-in Workspaces Worker (`vitest.config.ts`) answers with what it was asked.
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      workspace: WORKSPACE,
      port: 5173,
      method: "POST",
      url: "http://5173.cloudpid.internal/src/main.js?t=1",
      origin: "http://5173.cloudpid.internal",
      body: "hello",
    });
  });

  it("answers 404 for a host that is not one of the eight, computerd's port among them, waking no Workspace", async () => {
    const containerPreviews = containerPreviewsFor(WORKSPACE);

    for (const url of [
      "http://8080.cloudpid.internal/health",
      "http://9999.cloudpid.internal/",
      "http://5173.cloudpid.internal:8080/",
      "http://example.com/",
    ]) {
      const response = await containerPreviews.fetch(url);

      expect(response.status, url).toBe(404);
      expect(await response.text(), url).not.toContain(WORKSPACE);
    }
  });

  it("answers 502, in plain text, when the Workspace cannot be reached", async () => {
    // The stand-in Workspaces Worker throws for this one.
    const response = await containerPreviewsFor("ws:unreachable").fetch(
      "http://3000.cloudpid.internal/",
    );

    expect(response.status).toBe(502);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toContain("could not be reached");
  });
});
