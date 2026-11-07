// The Session's `fire` (`docs/architecture/triggers.md` → Pending Fires; Fire records, origin marks and notifications),
// against real Durable Object storage: the header, the Trigger's mark, the Run's Notification and the Fire's key.
// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off globalDate:off
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { type ApiResult, type FireRequest, renderFireHeader } from "@cloudpid/protocol";
import { describe, expect, it } from "vitest";
import { poll, pollFor } from "../poll.fixture.ts";
import type { TestSession } from "./host.fixture.ts";

declare global {
  namespace Cloudflare {
    /** The bindings `vitest.config.ts` gives the test Worker. */
    interface Env {
      readonly SESSIONS: DurableObjectNamespace<TestSession>;
    }
  }
}

const fresh = () => env.SESSIONS.get(env.SESSIONS.newUniqueId());

const script = (stub: DurableObjectStub<TestSession>, ...responses: string[]) =>
  runInDurableObject(stub, (instance: TestSession) => instance.script(responses));

const okValue = <T>(result: ApiResult<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);

  return result.value;
};

const header = {
  name: "Weekly report",
  zone: "America/Chicago",
  scheduledAt: Date.parse("2026-11-09T15:00:00Z"),
  firedAt: Date.parse("2026-11-09T15:00:04Z"),
};

const fireOf = (request: Partial<FireRequest> = {}): FireRequest => ({
  trigger: { id: "t1", name: "Weekly report" },
  requestId: "t1:2026-11-09T15:00:00.000Z",
  message: "Summarize last week's PRs.",
  header,
  ...request,
});

describe("fire", () => {
  it("sends the Trigger message under cloudpid's header, marked as the Trigger's", async () => {
    const stub = fresh();

    await script(stub, "Summary sent");

    expect(okValue(await stub.fire(fireOf())).delivery).toBe("started");

    const page = await pollFor(
      async () => {
        const read = okValue(await stub.mcpTranscript({}));

        return read.entries.some((entry) => entry.role === "assistant") ? read : undefined;
      },
      () => "the Fire's Run never answered",
    );

    const input = page.entries.find((entry) => entry.role === "user");

    expect(input?.text).toMatch(/^### user · \d\d:\d\d · via Weekly report \(Trigger\)\n/);
    expect(input?.text).toContain(`${renderFireHeader(header)}\n\nSummarize last week's PRs.`);
  });

  it("tells the owner how the Fire's Run ended", async () => {
    const stub = fresh();

    await script(stub, "Summary sent");
    await stub.fire(fireOf());

    await poll(
      async () => (await stub.notified()).length > 0,
      () => "the Run's end was never notified",
    );
    expect(await stub.notified()).toEqual([{ kind: "finished" }]);
  });

  it("finds the first input again for the same Fire, and sends nothing twice", async () => {
    const stub = fresh();

    await script(stub, "once");
    await stub.fire(fireOf());
    await poll(
      async () => okValue(await stub.mcpStatus()).status === "idle",
      () => "the Fire's Run never ended",
    );

    expect(okValue(await stub.fire(fireOf())).delivery).toBe("started");

    const page = okValue(await stub.mcpTranscript({}));

    expect(page.entries.filter((entry) => entry.role === "user")).toHaveLength(1);
  });

  it("refuses a message no Trigger could hold, sending nothing", async () => {
    const stub = fresh();

    expect(await stub.fire(fireOf({ message: " " }))).toMatchObject({
      ok: false,
      error: { code: "invalid_argument" },
    });
    expect(okValue(await stub.mcpTranscript({})).entries).toEqual([]);
  });
});
