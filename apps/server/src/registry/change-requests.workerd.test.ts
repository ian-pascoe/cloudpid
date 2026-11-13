// The `request_id` claims over real Durable Object SQLite (`docs/architecture/mcp-endpoint.md` → Retries: `request_id`):
// a claim commits with its write, a conflicting attempt rolls the whole write back, and the lookup, the settle, the 24 h
// memory and the 64 KiB cap behave as the dispatcher relies on.
// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off preferEffectRecord:off
import { runInDurableObject } from "cloudflare:test";
import {
  DEFAULT_ENVIRONMENT,
  GLOBAL_SCOPE,
  SETTINGS_SCOPE,
  variableField,
} from "@cloudpid/protocol";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import {
  type AgentChangeAuthor,
  changeEnvironment,
  changeGlobal,
  type ContainerFieldChange,
  openAgentChanges,
} from "./agent-changes.ts";
import {
  CHANGE_REQUEST_MEMORY_MS,
  ChangeRequestConflict,
  MAX_CHANGE_ANSWER_BYTES,
  openChangeRequests,
} from "./change-requests.ts";
import type { TestRegistry } from "./store.fixture.ts";
import { openRegistryStore } from "./store.ts";

const claim = { id: "req-1", tool: "environment_variable_set", digest: "d-1", attempt: "a-1" };

const authorOf = (request: typeof claim | undefined): AgentChangeAuthor => ({
  via: { auth: "oauth", client: { name: "pi" } },
  tool: "environment_variable_set",
  reason: "The tests need it",
  request,
});

const setVariable = (name: string, value: string): ContainerFieldChange => ({
  field: variableField(name),
  value,
});

/** Run `body` over a fresh Registry's store, Agent changes and `request_id` claims. */
const inRegistry = <A>(
  body: (registry: {
    readonly store: ReturnType<typeof openRegistryStore>;
    readonly storage: DurableObjectStorage;
    readonly changes: ReturnType<typeof openAgentChanges>;
    readonly requests: ReturnType<typeof openChangeRequests>;
    /** Change a variable of the default Environment under `request`. */
    readonly set: (
      name: string,
      value: string,
      request: typeof claim | undefined,
      at?: number,
    ) => ReturnType<typeof changeEnvironment>;
  }) => A,
) =>
  runInDurableObject(env.REGISTRIES.get(env.REGISTRIES.newUniqueId()), (_: TestRegistry, state) => {
    const store = openRegistryStore(state.storage);
    const changes = openAgentChanges(state.storage);

    return body({
      store,
      storage: state.storage,
      changes,
      requests: openChangeRequests(state.storage, store, changes),
      set: (name, value, request, at = 1_000) =>
        changeEnvironment(
          state.storage,
          store,
          changes,
          {
            environment: DEFAULT_ENVIRONMENT,
            change: setVariable(name, value),
            author: authorOf(request),
          },
          at,
        ),
    });
  });

describe("a claim", () => {
  it("is written with the change it was made for, and a lookup answers it with the changes it recorded", async () => {
    const found = await inRegistry(({ set, requests }) => {
      set("API_URL", "https://example.test", claim, 5_000);

      return requests.lookup("req-1", 6_000);
    });

    expect(found).toEqual({
      tool: "environment_variable_set",
      digest: "d-1",
      attempt: "a-1",
      at: 5_000,
      answer: null,
      changes: [
        {
          id: 1,
          scope: DEFAULT_ENVIRONMENT,
          scopeName: "Default",
          field: "variables.API_URL",
          before: null,
          after: "https://example.test",
        },
      ],
    });
  });

  it("holds every change one attempt's writes record, with each Scope's name", async () => {
    const found = await inRegistry(({ set, store, storage, changes, requests }) => {
      set("A", "1", claim);
      set("B", "2", claim, 1_100);

      changeGlobal(
        storage,
        store,
        changes,
        { change: setVariable("G", "3"), author: authorOf(claim) },
        1_200,
      );

      return requests.lookup("req-1", 2_000);
    });

    expect(found?.changes.map(({ id, scopeName, field }) => ({ id, scopeName, field }))).toEqual([
      { id: 1, scopeName: "Default", field: "variables.A" },
      { id: 2, scopeName: "Default", field: "variables.B" },
      { id: 3, scopeName: "Global", field: "variables.G" },
    ]);
    // The first write's time stays the claim's.
    expect(found?.at).toBe(1_000);
  });

  it("names the Settings' scope, and a scope whose Environment is gone by its id", async () => {
    const names = await inRegistry(({ changes, requests }) => {
      for (const scope of [SETTINGS_SCOPE, "0000dead"]) {
        changes.record({
          scope,
          at: 1_000,
          actor: "agent",
          session: null,
          conversation: null,
          tool: "settings_set",
          via: { auth: "oauth" },
          request: claim,
          reason: "r",
          field: "f",
          before: null,
          after: 1,
          reverts: null,
        });
      }

      return requests.lookup("req-1", 2_000)?.changes.map(({ scopeName }) => scopeName);
    });

    expect(names).toEqual(["Settings", "0000dead"]);
  });

  it("makes a write that records nothing claim nothing", async () => {
    const [outcome, found] = await inRegistry(({ set, requests }) => {
      set("A", "1", undefined);

      return [set("A", "1", claim, 2_000), requests.lookup("req-1", 3_000)];
    });

    expect(outcome).toMatchObject({ status: "unchanged" });
    expect(found).toBeNull();
  });

  it("rolls the whole write back when another attempt holds the id", async () => {
    const [thrown, settings, listed, found] = await inRegistry(
      ({ set, store, changes, requests }) => {
        set("A", "1", claim);

        let thrown: unknown;

        try {
          set("B", "2", { ...claim, attempt: "a-2" }, 1_500);
        } catch (error) {
          thrown = error;
        }

        return [
          thrown,
          store.getEnvironmentSettings(DEFAULT_ENVIRONMENT),
          changes.list(DEFAULT_ENVIRONMENT).map(({ field }) => field),
          requests.lookup("req-1", 2_000),
        ];
      },
    );

    expect(thrown).toBeInstanceOf(ChangeRequestConflict);
    // Nothing of the second write stayed: not the setting, not its record, not a second change on the claim.
    expect(settings).toEqual({ variables: { A: "1" } });
    expect(listed).toEqual(["variables.A"]);
    expect(found).toMatchObject({ attempt: "a-1", changes: [{ id: 1 }] });
  });

  it("is held against the same attempt with other arguments", async () => {
    const thrown = await inRegistry(({ set }) => {
      set("A", "1", claim);

      try {
        set("B", "2", { ...claim, digest: "d-2" }, 1_500);
      } catch (error) {
        return error;
      }

      return undefined;
    });

    expect(thrown).toBeInstanceOf(ChangeRequestConflict);
  });

  it("is free again once its day is past", async () => {
    const [before, expired, again, found] = await inRegistry(({ set, requests }) => {
      set("A", "1", claim, 1_000);

      return [
        requests.lookup("req-1", 1_000 + CHANGE_REQUEST_MEMORY_MS - 1)?.attempt,
        requests.lookup("req-1", 1_000 + CHANGE_REQUEST_MEMORY_MS),
        set("B", "2", { ...claim, attempt: "a-2" }, 1_000 + CHANGE_REQUEST_MEMORY_MS + 1),
        requests.lookup("req-1", 1_000 + CHANGE_REQUEST_MEMORY_MS + 2),
      ];
    });

    expect(before).toBe("a-1");
    expect(expired).toBeNull();
    expect(again).toMatchObject({ status: "changed" });
    expect(found).toMatchObject({ attempt: "a-2", changes: [{ field: "variables.B" }] });
  });

  it("lists only the changes the Registry still keeps", async () => {
    const found = await inRegistry(({ set, storage, requests }) => {
      set("A", "1", claim);
      set("B", "2", claim, 1_100);
      storage.sql.exec("DELETE FROM agent_changes WHERE id = 1");

      return requests.lookup("req-1", 2_000);
    });

    expect(found?.changes.map(({ id }) => id)).toEqual([2]);
  });
});

describe("settling a claim", () => {
  const answer = { text: "Done.", structured: { scope: "Default", changes: [{ id: 1 }] } };

  it("keeps the answer for the attempt that holds the claim, and a lookup answers it", async () => {
    const [settled, found] = await inRegistry(({ set, requests }) => {
      set("A", "1", claim);

      return [
        requests.settle({ id: "req-1", attempt: "a-1", answer }),
        requests.lookup("req-1", 2_000),
      ];
    });

    expect(settled).toBe(true);
    expect(found?.answer).toEqual(answer);
  });

  it("is refused for another attempt, and for an id nobody claimed, leaving the claim as it was", async () => {
    const [other, unknown, found] = await inRegistry(({ set, requests }) => {
      set("A", "1", claim);

      return [
        requests.settle({ id: "req-1", attempt: "a-2", answer }),
        requests.settle({ id: "req-9", attempt: "a-1", answer }),
        requests.lookup("req-1", 2_000),
      ];
    });

    expect(other).toBe(false);
    expect(unknown).toBe(false);
    expect(found?.answer).toBeNull();
  });

  it("keeps the first answer when it is settled again", async () => {
    const [again, found] = await inRegistry(({ set, requests }) => {
      set("A", "1", claim);
      requests.settle({ id: "req-1", attempt: "a-1", answer });

      return [
        requests.settle({
          id: "req-1",
          attempt: "a-1",
          answer: { text: "Other", structured: {} },
        }),
        requests.lookup("req-1", 2_000),
      ];
    });

    expect(again).toBe(true);
    expect(found?.answer).toEqual(answer);
  });

  it("keeps an answer of exactly 64 KiB and drops one a byte over, as multi-byte text counts", async () => {
    const sized = (bytes: number) => {
      const overhead = JSON.stringify({ text: "", structured: {} }).length;

      return { text: "a".repeat(bytes - overhead), structured: {} };
    };

    const [atCap, overCap, multibyte] = await inRegistry(({ set, requests }) => {
      const results: unknown[] = [];

      for (const [index, size] of [
        MAX_CHANGE_ANSWER_BYTES,
        MAX_CHANGE_ANSWER_BYTES + 1,
      ].entries()) {
        const id = `req-${index}`;

        set(`V${index}`, "1", { ...claim, id, attempt: id });
        expect(requests.settle({ id, attempt: id, answer: sized(size) })).toBe(true);
        results.push(requests.lookup(id, 2_000)?.answer?.text.length);
      }

      // Characters of three bytes each: far fewer than the cap's, yet over it.
      const wide = { text: "€".repeat(MAX_CHANGE_ANSWER_BYTES / 3), structured: {} };

      set("W", "1", { ...claim, id: "req-w", attempt: "req-w" });
      requests.settle({ id: "req-w", attempt: "req-w", answer: wide });
      results.push(requests.lookup("req-w", 2_000)?.answer);

      return results;
    });

    expect(atCap).toBe(sized(MAX_CHANGE_ANSWER_BYTES).text.length);
    expect(overCap).toBeUndefined();
    expect(multibyte).toBeNull();
  });
});

describe("a claim of a write at Global", () => {
  it("names Global's changes under Global", async () => {
    const found = await inRegistry(({ store, storage, changes, requests }) => {
      changeGlobal(
        storage,
        store,
        changes,
        { change: setVariable("G", "1"), author: authorOf(claim) },
        1_000,
      );

      return requests.lookup("req-1", 2_000);
    });

    expect(found?.changes).toMatchObject([{ scope: GLOBAL_SCOPE, scopeName: "Global" }]);
  });
});
