// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off globalDate:off globalTimers:off newPromise:off
// The Approvals asked over the MCP endpoint, over real Durable Object SQLite (`docs/architecture/mcp-endpoint.md` →
// Approvals with no Session; `./approvals.ts`): an ask's dedupe, supersede, cap and `request_id`; lazy expiry and the
// 24 h retention; the owner's answer and the caller's withdrawal; the apply's lease and its settle; and the withdrawal
// with its Environment. Through the real Registry (`registry.fixture.ts`): a kept Secret in an argument refused with no
// row written, the `input` push, and the wait's cap and its end on an answer.
import {
  APPROVAL_LIFETIME_MS,
  APPROVAL_RETENTION_MS,
  type AgentChangeVia,
  DEFAULT_ENVIRONMENT,
  MAX_PENDING_APPROVALS,
} from "@cloudpid/protocol";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  APPROVAL_LEASE_MS,
  type ApprovalAsk,
  MAX_APPROVAL_WAITS,
  openApprovals,
  shownApproval,
} from "./approvals.ts";
import { ChangeRequestConflict, openChangeRequests } from "./change-requests.ts";
import { openAgentChanges } from "./agent-changes.ts";
import type { RegistryMethods } from "./Registry.ts";
import type { RealRegistry } from "./registry.fixture.ts";
import type { TestRegistry } from "./store.fixture.ts";
import { openRegistryStore } from "./store.ts";

declare global {
  namespace Cloudflare {
    interface Env {
      readonly REAL_REGISTRIES: DurableObjectNamespace<RealRegistry>;
    }
  }
}

const PI: AgentChangeVia = { auth: "oauth", client: { name: "pi" }, clientId: "grant-1" };

/** An ask for the spend limit at Global, from `expected` to `value`. */
const spendAsk = (value: number, expected: number | null = null): ApprovalAsk => ({
  tool: "settings_spend_limit_set",
  scope: "*",
  section: "limits",
  args: { scope: "*", per_session: value, reason: "Runs cost more now" },
  card: {
    tool: "settings_spend_limit_set",
    target: "Global",
    change: "Spend limit",
    before: "no limit",
    after: `$${value} per Session`,
    reason: "Runs cost more now",
  },
  expected,
  digest: `spend:${value}`,
  via: PI,
});

/** Run `body` over a fresh Registry's store, its Approvals and its `request_id` claims. */
const inRegistry = <A>(
  body: (registry: {
    readonly store: ReturnType<typeof openRegistryStore>;
    readonly approvals: ReturnType<typeof openApprovals>;
    readonly requests: ReturnType<typeof openChangeRequests>;
  }) => A,
) =>
  runInDurableObject(env.REGISTRIES.get(env.REGISTRIES.newUniqueId()), (_: TestRegistry, state) => {
    const store = openRegistryStore(state.storage);

    return body({
      store,
      approvals: openApprovals(state.storage),
      requests: openChangeRequests(state.storage, store, openAgentChanges(state.storage)),
    });
  });

describe("an ask", () => {
  it("keeps a waiting request with its card, who asked, and 7 days to expire", async () => {
    const asked = await inRegistry(({ approvals }) => approvals.ask(spendAsk(20), "a-1", 1_000));

    expect(asked).toMatchObject({
      status: "asked",
      fresh: true,
      approval: {
        id: "a-1",
        status: "pending",
        scope: "*",
        section: "limits",
        args: { per_session: 20 },
        expected: null,
        via: PI,
        createdAt: 1_000,
        expiresAt: 1_000 + APPROVAL_LIFETIME_MS,
      },
    });
  });

  it("answers the request waiting for the same change and expected, and supersedes one with another expected", async () => {
    const [again, newer, older] = await inRegistry(({ approvals }) => {
      approvals.ask(spendAsk(20), "a-1", 1_000);

      return [
        approvals.ask(spendAsk(20), "a-2", 2_000),
        approvals.ask(spendAsk(20, 5), "a-3", 3_000),
        approvals.get("a-1", 4_000),
      ];
    });

    expect(again).toMatchObject({ status: "asked", fresh: false, approval: { id: "a-1" } });
    expect(newer).toMatchObject({ status: "asked", fresh: true, approval: { id: "a-3" } });
    expect(older).toMatchObject({
      status: "withdrawn",
      withdrawal: "superseded",
      settledAt: 3_000,
    });
  });

  it("refuses past the cap per auth, counts approved ones not finished, and not a request it supersedes", async () => {
    const [refused, otherAuth, superseding, afterFinish] = await inRegistry(({ approvals }) => {
      for (let index = 0; index < MAX_PENDING_APPROVALS; index += 1) {
        approvals.ask(spendAsk(index + 1), `a-${index}`, 1_000);
      }

      // One approved and being applied still counts.
      approvals.answer({ id: "a-0", approved: true }, 1_100);

      return [
        approvals.ask(spendAsk(99), "a-over", 1_200),
        approvals.ask({ ...spendAsk(99), via: { auth: "local" } }, "a-local", 1_300),
        // The same change with another expected replaces its request, so it takes no new place.
        approvals.ask(spendAsk(2, 7), "a-replace", 1_400),
        (() => {
          approvals.claim("a-0", "run", 1_500);
          approvals.finish({ id: "a-0", token: "run", status: "finished" }, 1_600);

          return approvals.ask(spendAsk(98), "a-free", 1_700);
        })(),
      ];
    });

    expect(refused).toEqual({ status: "too_many", limit: MAX_PENDING_APPROVALS });
    expect(otherAuth).toMatchObject({ status: "asked", fresh: true });
    expect(superseding).toMatchObject({ status: "asked", fresh: true });
    expect(afterFinish).toMatchObject({ status: "asked", fresh: true });
  });

  it("answers the caller's earlier ask under the same request_id, and claims the id in the same transaction", async () => {
    const claim = { id: "req-1", tool: "settings_spend_limit_set", digest: "d", attempt: "t-1" };

    const [first, repeat, found] = await inRegistry(({ approvals, requests }) => {
      const asked = approvals.ask({ ...spendAsk(20), request: claim }, "a-1", 1_000);

      // Withdrawn since: the repeat still answers it, not a new request.
      approvals.withdraw("a-1", 1_100);

      return [
        asked,
        approvals.ask({ ...spendAsk(20), request: { ...claim, attempt: "t-2" } }, "a-2", 1_200),
        requests.lookup("req-1", 1_300),
      ];
    });

    expect(first).toMatchObject({ fresh: true, approval: { requestId: "req-1" } });
    expect(repeat).toMatchObject({ fresh: false, approval: { id: "a-1", status: "withdrawn" } });
    expect(found).toMatchObject({ attempt: "t-1", answer: null, changes: [] });
  });

  it("writes nothing when another call holds the request_id", async () => {
    const [thrown, listed] = await inRegistry(({ approvals }) => {
      approvals.ask(
        { ...spendAsk(20), request: { id: "req-1", tool: "t", digest: "d", attempt: "t-1" } },
        "a-1",
        1_000,
      );

      let error: unknown;

      try {
        approvals.ask(
          { ...spendAsk(30), request: { id: "req-1", tool: "t", digest: "other", attempt: "t-2" } },
          "a-2",
          1_100,
        );
      } catch (caught) {
        error = caught;
      }

      return [error, approvals.list(1_200).map(({ id }) => id)];
    });

    expect(thrown).toBeInstanceOf(ChangeRequestConflict);
    expect(listed).toEqual(["a-1"]);
  });
});

describe("expiry and retention", () => {
  it("expires a request past its days when it is next read, and forgets it 24 h after", async () => {
    const [expired, kept, gone] = await inRegistry(({ approvals }) => {
      approvals.ask(spendAsk(20), "a-1", 0);

      return [
        approvals.get("a-1", APPROVAL_LIFETIME_MS),
        approvals.get("a-1", APPROVAL_LIFETIME_MS + APPROVAL_RETENTION_MS - 1),
        approvals.get("a-1", APPROVAL_LIFETIME_MS + APPROVAL_RETENTION_MS),
      ];
    });

    expect(expired).toMatchObject({ status: "expired", settledAt: APPROVAL_LIFETIME_MS });
    expect(kept?.status).toBe("expired");
    expect(gone).toBeNull();
  });
});

describe("the owner's answer", () => {
  it("approves or declines a waiting request, and leaves any other as it is", async () => {
    const [approved, declined, expired] = await inRegistry(({ approvals }) => {
      approvals.ask(spendAsk(20), "a-1", 0);
      approvals.ask(spendAsk(30), "a-2", 0);
      approvals.ask(spendAsk(40), "a-3", 0);

      return [
        approvals.answer({ id: "a-1", approved: true }, 10),
        approvals.answer({ id: "a-2", approved: false, reason: "Too much" }, 10),
        approvals.answer({ id: "a-3", approved: true }, APPROVAL_LIFETIME_MS + 1),
      ];
    });

    expect(approved).toMatchObject({ status: "approved", answeredAt: 10, settledAt: null });
    expect(declined).toMatchObject({ status: "declined", reason: "Too much", settledAt: 10 });
    expect(expired).toMatchObject({ status: "expired" });
  });
});

describe("a withdrawal", () => {
  it("withdraws a waiting request, can be repeated, and leaves an approved one", async () => {
    const [withdrawn, again, approved] = await inRegistry(({ approvals }) => {
      approvals.ask(spendAsk(20), "a-1", 0);
      approvals.ask(spendAsk(30), "a-2", 0);
      approvals.answer({ id: "a-2", approved: true }, 5);

      return [
        approvals.withdraw("a-1", 10),
        approvals.withdraw("a-1", 20),
        approvals.withdraw("a-2", 10),
      ];
    });

    expect(withdrawn).toMatchObject({
      status: "withdrawn",
      withdrawal: "withdrawn",
      settledAt: 10,
    });
    expect(again).toMatchObject({ status: "withdrawn", settledAt: 10 });
    expect(approved?.status).toBe("approved");
  });

  it("withdraws an Environment's waiting requests when it is deleted", async () => {
    const found = await inRegistry(({ store, approvals }) => {
      store.createEnvironment("0000abcd", "Web", 0);
      approvals.ask({ ...spendAsk(20), scope: "0000abcd", digest: "web" }, "a-1", 0);
      approvals.ask(spendAsk(20), "a-global", 0);
      store.deleteEnvironment("0000abcd", 50);

      return [approvals.get("a-1", 60), approvals.get("a-global", 60)];
    });

    expect(found[0]).toMatchObject({
      status: "withdrawn",
      withdrawal: "environment_deleted",
      settledAt: 50,
    });
    expect(found[1]?.status).toBe("pending");
  });
});

describe("the apply's lease", () => {
  it("lets one run apply at a time, a renewal by the same run, and another once the lease lapses", async () => {
    const [first, other, renewed, lapsed, stale] = await inRegistry(({ approvals }) => {
      approvals.ask(spendAsk(20), "a-1", 0);
      approvals.answer({ id: "a-1", approved: true }, 0);

      return [
        approvals.claim("a-1", "run-1", 100),
        approvals.claim("a-1", "run-2", 200),
        approvals.claim("a-1", "run-1", 300),
        approvals.claim("a-1", "run-2", 300 + APPROVAL_LEASE_MS),
        approvals.stale(300 + APPROVAL_LEASE_MS + 1).map(({ id }) => id),
      ];
    });

    expect(first?.leased).toBe(true);
    expect(other?.leased).toBe(false);
    expect(renewed?.leased).toBe(true);
    expect(lapsed?.leased).toBe(true);
    // run-2 holds it until 300 + 2 × lease: not stale.
    expect(stale).toEqual([]);
  });

  it("is never taken on a request that is not approved", async () => {
    const claimed = await inRegistry(({ approvals }) => {
      approvals.ask(spendAsk(20), "a-1", 0);

      return approvals.claim("a-1", "run", 10);
    });

    expect(claimed).toMatchObject({ leased: false, approval: { status: "pending" } });
  });

  it("settles the request for the run that holds it only, and shows it applying meanwhile", async () => {
    const [applying, stolen, finished] = await inRegistry(({ approvals }) => {
      approvals.ask(spendAsk(20), "a-1", 0);
      approvals.answer({ id: "a-1", approved: true }, 0);
      approvals.claim("a-1", "run-1", 10);

      const shown = shownApproval(approvals.get("a-1", 20)!, 20);
      const other = approvals.finish({ id: "a-1", token: "run-2", status: "refused" }, 30);

      return [
        shown,
        other,
        approvals.finish(
          {
            id: "a-1",
            token: "run-1",
            status: "finished",
            result: { text: "Done", structured: { changes: [] } },
          },
          40,
        ),
      ];
    });

    expect(applying).toMatchObject({ status: "approved", applying: true });
    expect(stolen?.status).toBe("approved");
    expect(finished).toMatchObject({
      status: "finished",
      settledAt: 40,
      leaseToken: null,
      result: { text: "Done" },
    });
  });
});

describe("the Registry's Approvals", () => {
  /** A fresh real Registry; `call` runs its method. */
  const started = async () => {
    const stub = env.REAL_REGISTRIES.get(env.REAL_REGISTRIES.newUniqueId());

    const call = async <K extends keyof RegistryMethods>(
      method: K,
      ...input: Parameters<RegistryMethods[K]>
    ) => runInDurableObject(stub, (registry: RealRegistry) => registry.call(method, ...input));

    await call("agentChangeFeatures");

    return call;
  };

  it("refuses an ask whose arguments hold a kept Secret, writing no row", async () => {
    const call = await started();

    await call("setEnvironmentSecret", {
      environment: DEFAULT_ENVIRONMENT,
      name: "API_KEY",
      value: "sk-live-0123456789abcdef",
    });

    const ask = {
      ...spendAsk(20),
      scope: DEFAULT_ENVIRONMENT,
      args: { scope: DEFAULT_ENVIRONMENT, per_session: 20, reason: "key sk-live-0123456789abcdef" },
    };

    expect(await call("requestApproval", ask)).toMatchObject({ status: "refused" });
    expect(await call("listApprovals", {})).toEqual([]);
  });

  it("asks once, and pushes only a request that waits", async () => {
    const call = await started();
    const asked = await call("requestApproval", spendAsk(20));

    expect(asked).toMatchObject({ status: "asked", fresh: true });

    const id = asked.status === "asked" ? asked.approval.id : "";

    expect(await call("notifyApproval", { id })).toMatchObject({
      url: `/settings/all/limits?request=${id}`,
      tag: `approval:${id}`,
    });

    await call("withdrawApproval", { id });

    expect(await call("notifyApproval", { id })).toBeNull();
  });

  it("ends a wait when the request is answered, and refuses a wait past the caller's cap", async () => {
    const call = await started();
    const asked = await call("requestApproval", spendAsk(20));
    const id = asked.status === "asked" ? asked.approval.id : "";
    const deadline = Date.now() + 5_000;

    const waits = Array.from({ length: MAX_APPROVAL_WAITS }, () =>
      call("waitApproval", { id, seen: "pending", auth: "oauth", deadline }),
    );

    // Let the waits start, then one more is refused.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await call("waitApproval", { id, seen: "pending", auth: "oauth", deadline })).toEqual({
      status: "too_many_waits",
    });
    // A status the caller has not seen yet is answered at once.
    expect(
      await call("waitApproval", { id, seen: "approved", auth: "local", deadline }),
    ).toMatchObject({ status: "answered", approval: { status: "pending" } });

    await call("answerApproval", { id, approved: false });

    for (const answered of await Promise.all(waits)) {
      expect(answered).toMatchObject({ status: "answered", approval: { status: "declined" } });
    }
  });
});
