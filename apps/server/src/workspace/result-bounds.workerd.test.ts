// The parts of a tool result besides its text and images, through a Session's `codemode` on a real Workspace: a script
// that makes thousands of nested calls lists them in its result's details, which code mode stores in its run's document
// and in the result entry, each one SQLite row (docs/architecture/workspace.md → The rest of one tool result). miniflare's
// SQLite does not enforce Cloudflare's 2 MB row cap, so the sizes are what is checked.
// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off cryptoRandomUUID:off preferEffectArray:off
import { MAX_CODEMODE_CALLS_BYTES } from "@cloudpid/extensions/result-bounds";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { TestWorkspaceSession } from "./session.fixture.ts";
import { call, uniqueWorkspace } from "./session.workerd.helpers.ts";

/**
 * How many calls the script makes. Each failing one's row is about 720 bytes (its arguments and error cut for display),
 * so the unbounded list would weigh about 720 KB, 22 times its bound; past about 2,800 calls it would pass the 2 MB row,
 * which miniflare takes over a minute to run.
 */
const CALLS = 1000;

/** A script that makes `CALLS` `read` calls with arguments the tool refuses, each listed with its error. */
const MANY_CALLS = `const path = "missing/".repeat(40);
const calls = [];
for (let index = 0; index < ${CALLS}; index++) calls.push(tools.read({ path, offset: "first" }).catch(() => null));
await Promise.all(calls);
return "made ${CALLS} calls";`;

describe("a tool result's details", () => {
  it("list a script's first calls within their bound and count the rest, and the Session keeps running", async () => {
    const stub = env.WORKSPACE_SESSIONS.get(env.WORKSPACE_SESSIONS.newUniqueId());

    await runInDurableObject(stub, async (instance: TestWorkspaceSession) => {
      instance.bindWorkspace(uniqueWorkspace());
      instance.script([call("codemode", { code: MANY_CALLS }), "done"]);

      const answer = await instance.prompt({ requestId: crypto.randomUUID(), text: "go" });

      expect(answer).toMatchObject({ status: "answered", text: "done" });

      const [details] = await instance.toolResultDetails();
      const [result] = await instance.toolResults();

      expect(result).toContain(`made ${CALLS} calls`);
      expect(details).toMatchObject({ omittedCalls: { failed: expect.any(Number) } });

      // SAFETY: matched above: an object with a call list and the count of the calls left out.
      const { calls, omittedCalls } = details as {
        readonly calls: ReadonlyArray<{ readonly status: string }>;
        readonly omittedCalls: { readonly count: number; readonly failed: number };
      };

      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every((row) => row.status === "error")).toBe(true);
      expect(calls.length + omittedCalls.count).toBe(CALLS);
      expect(omittedCalls.failed).toBe(omittedCalls.count);
      expect(new TextEncoder().encode(JSON.stringify(calls)).length).toBeLessThanOrEqual(
        MAX_CODEMODE_CALLS_BYTES,
      );
      expect(instance.longestHarnessRow()).toBeLessThan(500_000);

      // The Session answers the next turn.
      instance.script(["still here"]);

      expect(
        await instance.prompt({ requestId: crypto.randomUUID(), text: "again" }),
      ).toMatchObject({ status: "answered", text: "still here" });
    });
  }, 60_000);
});
