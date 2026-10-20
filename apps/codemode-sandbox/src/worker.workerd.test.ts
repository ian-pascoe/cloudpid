// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off
import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { CodemodeSandboxDurableObject } from "@earendil-works/pi-codemode/cloudflare";
import { RemoteCodemodeSandbox } from "@earendil-works/pi-codemode/portable";
import { describe, expect, it } from "vitest";

declare global {
  namespace Cloudflare {
    /** The bindings `vitest.config.ts` gives the test Worker. */
    interface Env {
      readonly CODEMODE_SANDBOX: DurableObjectNamespace<CodemodeSandboxDurableObject>;
    }
  }
}

describe("the codemode sandbox Worker", () => {
  it("runs a script that calls a tool, in its Durable Object", async () => {
    const sandbox = new RemoteCodemodeSandbox({
      tools: [{ name: "add", execute: () => 5 }],
      remote: () => env.CODEMODE_SANDBOX.getByName("session"),
    });

    const result = await sandbox.execute(
      'const n = await tools.add({ a: 2, b: 3 }); text("sum " + n); return n * 2;',
    );

    expect(result).toMatchObject({
      ok: true,
      value: 10,
      output: [{ type: "text", text: "sum 5" }],
    });
  });

  it("answers an HTTP request with 404", async () => {
    const response = await SELF.fetch("https://sandbox.example/");

    expect(response.status).toBe(404);
  });
});
