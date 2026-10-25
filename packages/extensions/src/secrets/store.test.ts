// The Secrets store: masked asks answered over the client, encrypted values at rest, their lifetime, forgetting, and
// the scrubbing of provider requests, across an "eviction" (a second store over the same storage).
// @effect-diagnostics strictEffectProvide:off anyUnknownInErrorContext:off preferEffectArray:off
import type { Message } from "@earendil-works/pi-ai";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it } from "vitest";
import { KEPT_REFRESH_MS, KEPT_RETRY_MS, type KeptSecret } from "./kept.ts";
import { secretReference } from "./references.ts";
import {
  type KeepRequest,
  type KeepResult,
  SECRET_LIFETIME_MS,
  type SecretAsk,
  Secrets,
  secretsLayer,
  type SecretStorage,
} from "./store.ts";
import { openVault } from "./vault.ts";

const MASTER = "test-master-key-0123456789abcdef0123456789";
const VALUE = "sk-live-abcdefghijkl";

/** A Durable Object's key-value storage, in memory. */
const memoryStorage = () => {
  const map = new Map<string, unknown>();

  const storage: SecretStorage = {
    // SAFETY: the store reads back only what it wrote under each key.
    get: <T>(key: string) => map.get(key) as T | undefined,
    put: (key, value) => {
      map.set(key, structuredClone(value));
    },
    delete: (key) => map.delete(key),
  };

  return { storage, dump: () => JSON.stringify([...map]) };
};

/** A store over `storage`, recording every list of pending asks it announces. */
const open = (
  storage: SecretStorage,
  master = MASTER,
  notify?: (ask: SecretAsk) => Effect.Effect<void>,
  kept?: Effect.Effect<ReadonlyArray<KeptSecret>, unknown>,
  keep?: (request: KeepRequest) => Effect.Effect<ReadonlyArray<KeepResult>>,
) =>
  Effect.gen(function* () {
    const announced: (readonly SecretAsk[])[] = [];
    const asked: SecretAsk[] = [];
    const vault = yield* openVault(master, "session-1");

    const secrets = yield* Effect.provide(
      Effect.service(Secrets),
      secretsLayer({
        storage,
        vault,
        announce: (asks) =>
          Effect.sync(() => {
            announced.push(asks);
          }),
        asked: (ask) =>
          Effect.sync(() => {
            asked.push(ask);
          }).pipe(Effect.andThen(notify?.(ask) ?? Effect.void)),
        kept: kept ?? Effect.succeed([]),
        keep,
      }),
    );

    return { secrets, announced, asked };
  });

const ASK: SecretAsk = {
  id: "7",
  conversationId: 1,
  names: ["API_KEY", "OTHER"],
  reason: "deploy",
};

const test = (name: string, body: () => Effect.Effect<void, unknown>) =>
  it(name, () => Effect.runPromise(body().pipe(Effect.provide(TestClock.layer()))));

const userMessage = (text: string): Message => ({ role: "user", content: text, timestamp: 1 });

describe("Secrets", () => {
  test("holds what the owner enters in an ask, encrypted at rest", () =>
    Effect.gen(function* () {
      const { storage, dump } = memoryStorage();
      const { secrets, announced } = yield* open(storage);
      const asking = yield* Effect.forkChild(secrets.ask(ASK));

      yield* Effect.yieldNow;
      expect(yield* secrets.pending).toEqual([ASK]);
      expect(announced.at(-1)).toEqual([ASK]);

      yield* secrets.answer("7", { API_KEY: VALUE, OTHER: "" });

      expect(yield* Fiber.join(asking)).toEqual([
        { name: "API_KEY", status: "provided", expiresAt: SECRET_LIFETIME_MS },
        { name: "OTHER", status: "skipped" },
      ]);
      expect(yield* secrets.pending).toEqual([]);
      expect(announced.at(-1)).toEqual([]);
      expect(yield* secrets.resolve("API_KEY")).toBe(VALUE);
      expect(yield* secrets.held).toEqual([{ name: "API_KEY", expiresAt: SECRET_LIFETIME_MS }]);
      expect(dump()).not.toContain(VALUE);
    }));

  test("says once that an ask is new, not again when a rerun finds it waiting", () =>
    Effect.gen(function* () {
      const { storage } = memoryStorage();
      const first = yield* open(storage);

      yield* Effect.forkChild(first.secrets.ask(ASK));
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      expect(first.asked).toEqual([ASK]);

      // An eviction leaves the ask stored, and the rerun of its call asks again.
      const second = yield* open(storage);

      yield* Effect.forkChild(second.secrets.ask(ASK));
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      expect(second.asked).toEqual([]);
    }));

  test("does not wait for a notification that is slow, and withdraws the ask when interrupted meanwhile", () =>
    Effect.gen(function* () {
      const { secrets, asked } = yield* open(memoryStorage().storage, MASTER, () => Effect.never);
      const asking = yield* Effect.forkChild(secrets.ask(ASK));

      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      // The ask is waiting for the owner although its notification has not finished.
      expect(asked).toEqual([ASK]);
      expect(yield* secrets.pending).toEqual([ASK]);

      yield* Fiber.interrupt(asking);
      expect(yield* secrets.pending).toEqual([]);
    }));

  test("holds nothing when the owner cancels", () =>
    Effect.gen(function* () {
      const { secrets } = yield* open(memoryStorage().storage);
      const asking = yield* Effect.forkChild(secrets.ask(ASK));

      yield* Effect.yieldNow;
      yield* secrets.answer("7", null);

      expect(yield* Fiber.join(asking)).toEqual([
        { name: "API_KEY", status: "cancelled" },
        { name: "OTHER", status: "cancelled" },
      ]);
      expect(yield* secrets.held).toEqual([]);
    }));

  test("refuses an answer to an ask that is not waiting, or with names it did not ask for", () =>
    Effect.gen(function* () {
      const { secrets } = yield* open(memoryStorage().storage);

      expect(Exit.isFailure(yield* Effect.exit(secrets.answer("nope", {})))).toBe(true);

      yield* Effect.forkChild(secrets.ask(ASK));
      yield* Effect.yieldNow;

      expect(Exit.isFailure(yield* Effect.exit(secrets.answer("7", { SURPRISE: VALUE })))).toBe(
        true,
      );
    }));

  test("withdraws an ask whose call was cancelled", () =>
    Effect.gen(function* () {
      const { secrets, announced } = yield* open(memoryStorage().storage);
      const asking = yield* Effect.forkChild(secrets.ask(ASK));

      yield* Effect.yieldNow;
      yield* Fiber.interrupt(asking);

      expect(yield* secrets.pending).toEqual([]);
      expect(announced.at(-1)).toEqual([]);
    }));

  test("keeps a pending ask across an eviction, and answers the call that asks again", () =>
    Effect.gen(function* () {
      const { storage } = memoryStorage();
      const first = yield* open(storage);

      // The instance is evicted while the ask waits: nothing of it runs again.
      yield* Effect.forkChild(first.secrets.ask(ASK));
      yield* Effect.yieldNow;

      const second = yield* open(storage);

      expect(yield* second.secrets.pending).toEqual([ASK]);

      // The owner answers before the call reruns; the rerun finds the answer.
      yield* second.secrets.answer("7", { API_KEY: VALUE });

      expect(yield* second.secrets.ask(ASK)).toEqual([
        { name: "API_KEY", status: "provided", expiresAt: SECRET_LIFETIME_MS },
        { name: "OTHER", status: "skipped" },
      ]);

      const third = yield* open(storage);

      expect(yield* third.secrets.resolve("API_KEY")).toBe(VALUE);
    }));

  test("drops the Secrets that no longer open after the key changes, instead of failing", () =>
    Effect.gen(function* () {
      const { storage, dump } = memoryStorage();
      const { secrets } = yield* open(storage);

      yield* Effect.forkChild(secrets.ask(ASK));
      yield* Effect.yieldNow;
      yield* secrets.answer("7", { API_KEY: VALUE });

      const rotated = yield* open(storage, `${MASTER}-rotated`);

      expect(yield* rotated.secrets.held).toEqual([]);
      expect(dump()).not.toContain('"API_KEY":{');
    }));

  test("forgets Secrets after their lifetime and deletes their ciphertext", () =>
    Effect.gen(function* () {
      const { storage, dump } = memoryStorage();
      const { secrets } = yield* open(storage);
      const asking = yield* Effect.forkChild(secrets.ask(ASK));

      yield* Effect.yieldNow;
      yield* secrets.answer("7", { API_KEY: VALUE });
      yield* Fiber.join(asking);

      expect(yield* secrets.nextExpiry).toBe(SECRET_LIFETIME_MS);

      const sealed = dump();

      yield* TestClock.adjust(SECRET_LIFETIME_MS);

      expect(yield* secrets.resolve("API_KEY")).toBeUndefined();
      expect(yield* secrets.held).toEqual([]);

      yield* secrets.sweep;

      expect(dump()).not.toBe(sealed);
      expect(dump()).not.toContain("ciphertext");
      expect(yield* secrets.nextExpiry).toBeUndefined();
      // Output printed later is still redacted in this instance.
      expect(secrets.redact(`token ${VALUE}`)).toBe(`token ${secretReference("API_KEY")}`);
    }));

  test("forgets a Secret on request", () =>
    Effect.gen(function* () {
      const { storage, dump } = memoryStorage();
      const { secrets } = yield* open(storage);
      const asking = yield* Effect.forkChild(secrets.ask(ASK));

      yield* Effect.yieldNow;
      yield* secrets.answer("7", { API_KEY: VALUE });
      yield* Fiber.join(asking);

      expect(yield* secrets.forget(["API_KEY", "NEVER_HELD"])).toEqual([
        { name: "API_KEY", forgotten: true },
        { name: "NEVER_HELD", forgotten: false },
      ]);
      expect(yield* secrets.resolve("API_KEY")).toBeUndefined();
      expect(dump()).not.toContain("ciphertext");
    }));

  test("gives every held Secret as a command environment variable", () =>
    Effect.gen(function* () {
      const { secrets } = yield* open(memoryStorage().storage);
      const asking = yield* Effect.forkChild(secrets.ask(ASK));

      yield* Effect.yieldNow;
      yield* secrets.answer("7", { API_KEY: VALUE, OTHER: "other-value" });
      yield* Fiber.join(asking);

      expect(yield* secrets.environment).toEqual({
        ["PI_SECRET_" + "API_KEY"]: VALUE,
        ["PI_SECRET_" + "OTHER"]: "other-value",
      });
    }));

  test("scrubs provider requests, and each message the same way on every later request", () =>
    Effect.gen(function* () {
      const { storage } = memoryStorage();
      const { secrets } = yield* open(storage);
      const asking = yield* Effect.forkChild(secrets.ask(ASK));

      yield* Effect.yieldNow;
      yield* secrets.answer("7", { API_KEY: VALUE });
      yield* Fiber.join(asking);

      const pasted = userMessage(`oops: ${VALUE}`);
      const before = userMessage("later-held-value-9876");

      expect(yield* secrets.scrub([pasted, before])).toEqual([
        userMessage(`oops: ${secretReference("API_KEY")}`),
        before,
      ]);

      // A value held later never rewrites a message already sent, which keeps the cached prompt prefix valid.
      const again = yield* Effect.forkChild(secrets.ask({ ...ASK, id: "8", names: ["LATER"] }));

      yield* Effect.yieldNow;
      yield* secrets.answer("8", { LATER: "later-held-value-9876" });
      yield* Fiber.join(again);

      expect(yield* secrets.scrub([pasted, before])).toEqual([
        userMessage(`oops: ${secretReference("API_KEY")}`),
        before,
      ]);

      // After an eviction and the end of the lifetime, the message already sent is still scrubbed.
      yield* TestClock.adjust(SECRET_LIFETIME_MS);

      const evicted = yield* open(storage);

      expect(yield* evicted.secrets.scrub([pasted])).toEqual([
        userMessage(`oops: ${secretReference("API_KEY")}`),
      ]);

      // Also after the deployment's key changes, which drops every Secret held.
      const rotated = yield* open(storage, `${MASTER}-rotated`);

      expect(yield* rotated.secrets.scrub([pasted])).toEqual([
        userMessage(`oops: ${secretReference("API_KEY")}`),
      ]);
    }));

  test("drops an ask no call came back for, once no work is live, and keeps one a call waits on", () =>
    Effect.gen(function* () {
      const { storage } = memoryStorage();
      const first = yield* open(storage);

      // Evicted while the ask waits; the call is then abandoned, so nothing reruns it.
      yield* Effect.forkChild(first.secrets.ask(ASK));
      yield* Effect.yieldNow;

      const second = yield* open(storage);
      const waiting = yield* Effect.forkChild(second.secrets.ask({ ...ASK, id: "8" }));

      yield* Effect.yieldNow;
      yield* second.secrets.dropAbandoned;

      expect(yield* second.secrets.pending).toEqual([{ ...ASK, id: "8" }]);
      expect(second.announced.at(-1)).toEqual([{ ...ASK, id: "8" }]);

      yield* second.secrets.answer("8", null);
      yield* Fiber.join(waiting);
    }));

  test("leaves requests alone while no Secret was ever held", () =>
    Effect.gen(function* () {
      const { secrets } = yield* open(memoryStorage().storage);
      const messages = [userMessage("hello")];

      expect(yield* secrets.scrub(messages)).toBe(messages);
    }));
});

describe("Secrets kept for the Environment", () => {
  const KEPT_VALUE = "postgres://user:kept-password-123@db";

  const kept = (value = KEPT_VALUE, scope: KeptSecret["scope"] = "environment"): KeptSecret => ({
    name: "DATABASE_URL",
    value,
    scope,
    build: false,
  });

  /** What the Registry answers, which a test changes, and how often it was asked. */
  const registry = (initial: ReadonlyArray<KeptSecret>) => {
    const state = { secrets: initial, fail: false, asked: 0 };

    const load = Effect.suspend(() => {
      state.asked++;

      return state.fail ? Effect.fail("unreachable") : Effect.succeed(state.secrets);
    });

    return { state, load };
  };

  test("are held in memory only, resolved, given to commands and redacted", () =>
    Effect.gen(function* () {
      const { storage, dump } = memoryStorage();
      const { load } = registry([kept()]);
      const { secrets } = yield* open(storage, MASTER, undefined, load);

      expect(yield* secrets.resolve("DATABASE_URL")).toBe(KEPT_VALUE);
      expect(yield* secrets.environment).toEqual({ ["PI_SECRET_" + "DATABASE_URL"]: KEPT_VALUE });
      expect(yield* secrets.held).toEqual([{ name: "DATABASE_URL", kept: "environment" }]);
      expect(secrets.redact(`url=${KEPT_VALUE}`)).toBe(`url=${secretReference("DATABASE_URL")}`);
      expect(dump()).not.toContain("kept-password-123");
    }));

  test("are loaded by the first provider request, so what it carries is scrubbed", () =>
    Effect.gen(function* () {
      const { load, state } = registry([kept()]);
      const { secrets } = yield* open(memoryStorage().storage, MASTER, undefined, load);

      expect(state.asked).toBe(0);
      expect(yield* secrets.scrub([userMessage(`see ${KEPT_VALUE}`)])).toEqual([
        userMessage(`see ${secretReference("DATABASE_URL")}`),
      ]);
      expect(state.asked).toBe(1);
    }));

  test("lose to a Secret of the same name the owner entered in this Session", () =>
    Effect.gen(function* () {
      const { load } = registry([{ ...kept(), name: "API_KEY" }]);
      const { secrets } = yield* open(memoryStorage().storage, MASTER, undefined, load);
      const asking = yield* Effect.forkChild(secrets.ask(ASK));

      yield* Effect.yieldNow;
      yield* secrets.answer("7", { API_KEY: VALUE });
      yield* Fiber.join(asking);

      expect(yield* secrets.resolve("API_KEY")).toBe(VALUE);
      expect(yield* secrets.environment).toEqual({ ["PI_SECRET_" + "API_KEY"]: VALUE });
      expect(yield* secrets.held).toEqual([{ name: "API_KEY", expiresAt: SECRET_LIFETIME_MS }]);

      // Forgetting the asked one leaves the kept one in use.
      expect(yield* secrets.forget(["API_KEY"])).toEqual([
        { name: "API_KEY", forgotten: true, kept: "environment" },
      ]);
      expect(yield* secrets.resolve("API_KEY")).toBe(KEPT_VALUE);
    }));

  test("cannot be forgotten in a Session", () =>
    Effect.gen(function* () {
      const { load } = registry([kept(KEPT_VALUE, "every")]);
      const { secrets } = yield* open(memoryStorage().storage, MASTER, undefined, load);

      expect(yield* secrets.forget(["DATABASE_URL"])).toEqual([
        { name: "DATABASE_URL", forgotten: false, kept: "every" },
      ]);
      expect(yield* secrets.resolve("DATABASE_URL")).toBe(KEPT_VALUE);
    }));

  test("follow the Registry after the refresh: a changed value is used and a deleted one is no longer held", () =>
    Effect.gen(function* () {
      const { load, state } = registry([kept()]);
      const { secrets } = yield* open(memoryStorage().storage, MASTER, undefined, load);

      expect(yield* secrets.resolve("DATABASE_URL")).toBe(KEPT_VALUE);

      state.secrets = [kept("postgres://user:rotated-password-456@db")];
      expect(yield* secrets.resolve("DATABASE_URL")).toBe(KEPT_VALUE);

      yield* TestClock.adjust(KEPT_REFRESH_MS);
      expect(yield* secrets.resolve("DATABASE_URL")).toBe(
        "postgres://user:rotated-password-456@db",
      );

      state.secrets = [];
      yield* TestClock.adjust(KEPT_REFRESH_MS);
      expect(yield* secrets.resolve("DATABASE_URL")).toBeUndefined();
      expect(yield* secrets.environment).toEqual({});
      // What was held in this instance stays redacted.
      expect(secrets.redact(KEPT_VALUE)).toBe(secretReference("DATABASE_URL"));
    }));

  test("keep what was held when the Registry cannot be reached, and ask again soon", () =>
    Effect.gen(function* () {
      const { load, state } = registry([kept()]);
      const { secrets } = yield* open(memoryStorage().storage, MASTER, undefined, load);

      expect(yield* secrets.resolve("DATABASE_URL")).toBe(KEPT_VALUE);

      state.fail = true;
      yield* TestClock.adjust(KEPT_REFRESH_MS);
      expect(yield* secrets.resolve("DATABASE_URL")).toBe(KEPT_VALUE);
      expect(state.asked).toBe(2);

      state.fail = false;
      state.secrets = [];
      yield* TestClock.adjust(KEPT_RETRY_MS);
      expect(yield* secrets.resolve("DATABASE_URL")).toBeUndefined();
      expect(state.asked).toBe(3);
    }));
});

/** What the fake Registry of the keep tests holds, and what its hook was asked. */
type FakeRegistry = {
  secrets: KeptSecret[];
  requests: KeepRequest[];
  problem: string | undefined;
  shadowed: boolean;
};

describe("Secrets the owner chooses to keep when they answer", () => {
  /**
   * A Registry that keeps what the hook is handed (as the Session's hook has it save), with the requests the hook got.
   * `problem` makes it refuse, `shadowed` says the Environment keeps its own Secret of that name.
   */
  const registry = () => {
    const state: FakeRegistry = { secrets: [], requests: [], problem: undefined, shadowed: false };

    const load = Effect.sync(() => state.secrets);

    const keep = (request: KeepRequest) =>
      Effect.sync((): ReadonlyArray<KeepResult> => {
        state.requests.push(request);

        if (state.problem !== undefined) {
          const { problem } = state;

          return request.secrets.map(({ name }) => ({ name, kept: false, problem }));
        }

        for (const { name, value } of request.secrets) {
          state.secrets = [
            ...state.secrets.filter((secret) => secret.name !== name),
            { name, value, scope: request.scope, build: false },
          ];
        }

        return request.secrets.map(({ name }) =>
          state.shadowed ? { name, kept: true, shadowed: true } : { name, kept: true },
        );
      });

    return { state, load, keep };
  };

  const answered = (
    secrets: Effect.Success<ReturnType<typeof open>>["secrets"],
    keep: Parameters<typeof secrets.answer>[2],
    values: Readonly<Record<string, string>> = { API_KEY: VALUE, OTHER: "" },
    ask: SecretAsk = ASK,
  ) =>
    Effect.gen(function* () {
      const asking = yield* Effect.forkChild(secrets.ask(ask));

      yield* Effect.yieldNow;
      yield* secrets.answer(ask.id, values, keep);

      return yield* Fiber.join(asking);
    });

  test("keeps a Secret for the Environment the owner chose, which then stops expiring", () =>
    Effect.gen(function* () {
      const { storage, dump } = memoryStorage();
      const { load, keep, state } = registry();
      const { secrets } = yield* open(storage, MASTER, undefined, load, keep);

      expect(yield* answered(secrets, "environment")).toEqual([
        { name: "API_KEY", status: "kept", scope: "environment" },
        { name: "OTHER", status: "skipped" },
      ]);
      // Only what the owner gave, with the ask that it answers.
      expect(state.requests).toEqual([
        { ask: ASK, scope: "environment", secrets: [{ name: "API_KEY", value: VALUE }] },
      ]);
      expect(yield* secrets.held).toEqual([{ name: "API_KEY", kept: "environment" }]);
      expect(yield* secrets.resolve("API_KEY")).toBe(VALUE);
      // Nothing of it is entered for 15 minutes in this Session's storage, and the answer holds no value.
      expect(dump()).not.toContain(VALUE);

      yield* TestClock.adjust(SECRET_LIFETIME_MS * 2);
      yield* secrets.sweep;
      expect(yield* secrets.resolve("API_KEY")).toBe(VALUE);
      expect(yield* secrets.nextExpiry).toBeUndefined();
    }));

  test("keeps a Secret for every Environment when the owner chose that", () =>
    Effect.gen(function* () {
      const { load, keep, state } = registry();
      const { secrets } = yield* open(memoryStorage().storage, MASTER, undefined, load, keep);

      expect(yield* answered(secrets, "all")).toEqual([
        { name: "API_KEY", status: "kept", scope: "every" },
        { name: "OTHER", status: "skipped" },
      ]);
      expect(state.requests.map(({ scope }) => scope)).toEqual(["every"]);
      expect(yield* secrets.held).toEqual([{ name: "API_KEY", kept: "every" }]);
    }));

  test("holds it for the Session only, as before, when the owner chose that or left the choice out", () =>
    Effect.gen(function* () {
      const { load, keep, state } = registry();
      const { secrets } = yield* open(memoryStorage().storage, MASTER, undefined, load, keep);

      expect(yield* answered(secrets, "session")).toEqual([
        { name: "API_KEY", status: "provided", expiresAt: SECRET_LIFETIME_MS },
        { name: "OTHER", status: "skipped" },
      ]);
      expect(yield* answered(secrets, undefined, { API_KEY: VALUE })).toEqual([
        { name: "API_KEY", status: "provided", expiresAt: SECRET_LIFETIME_MS },
        { name: "OTHER", status: "skipped" },
      ]);
      expect(state.requests).toEqual([]);
    }));

  test("shows the agent's suggestion in the request, and keeps nothing for a cancelled one", () =>
    Effect.gen(function* () {
      const { load, keep, state } = registry();

      const { secrets, announced } = yield* open(
        memoryStorage().storage,
        MASTER,
        undefined,
        load,
        keep,
      );

      const ask: SecretAsk = { ...ASK, keep: "environment" };
      const asking = yield* Effect.forkChild(secrets.ask(ask));

      yield* Effect.yieldNow;
      expect(announced.at(-1)).toEqual([ask]);

      yield* secrets.answer("7", null, "all");
      expect(yield* Fiber.join(asking)).toEqual([
        { name: "API_KEY", status: "cancelled" },
        { name: "OTHER", status: "cancelled" },
      ]);
      expect(state.requests).toEqual([]);
    }));

  test("holds it for the Session and says why when it could not be kept", () =>
    Effect.gen(function* () {
      const { storage, dump } = memoryStorage();
      const { load, keep, state } = registry();
      const { secrets } = yield* open(storage, MASTER, undefined, load, keep);

      state.problem = "At most 100 Secrets are kept for this environment";

      expect(yield* answered(secrets, "environment")).toEqual([
        {
          name: "API_KEY",
          status: "provided",
          expiresAt: SECRET_LIFETIME_MS,
          notKept: "At most 100 Secrets are kept for this environment",
        },
        { name: "OTHER", status: "skipped" },
      ]);
      expect(yield* secrets.held).toEqual([{ name: "API_KEY", expiresAt: SECRET_LIFETIME_MS }]);
      expect(dump()).not.toContain(VALUE);
    }));

  test("holds it for the Session when the Session cannot keep Secrets", () =>
    Effect.gen(function* () {
      const { secrets } = yield* open(memoryStorage().storage);
      const [first] = yield* answered(secrets, "all");

      expect(first).toMatchObject({ name: "API_KEY", status: "provided" });
      expect(first).toHaveProperty("notKept");
      expect(yield* secrets.resolve("API_KEY")).toBe(VALUE);
    }));

  test("replaces a Secret of the same name entered earlier, which would otherwise win over it", () =>
    Effect.gen(function* () {
      const { load, keep } = registry();
      const { secrets } = yield* open(memoryStorage().storage, MASTER, undefined, load, keep);

      yield* answered(secrets, "session", { API_KEY: "older-entered-value-1" });
      expect(yield* secrets.resolve("API_KEY")).toBe("older-entered-value-1");

      yield* answered(secrets, "environment", { API_KEY: VALUE }, { ...ASK, id: "8" });
      expect(yield* secrets.resolve("API_KEY")).toBe(VALUE);
      expect(yield* secrets.held).toEqual([{ name: "API_KEY", kept: "environment" }]);
      // Both stay redacted in this instance.
      expect(secrets.redact("older-entered-value-1")).toBe(secretReference("API_KEY"));
    }));

  test("says when the Environment's own Secret of the name wins over one kept for every Environment", () =>
    Effect.gen(function* () {
      const { load, keep, state } = registry();
      const { secrets } = yield* open(memoryStorage().storage, MASTER, undefined, load, keep);

      state.shadowed = true;
      expect((yield* answered(secrets, "all"))[0]).toEqual({
        name: "API_KEY",
        status: "kept",
        scope: "every",
        shadowed: true,
      });
    }));

  test("keeps the answer across an eviction without a value, and redacts the value from the first request", () =>
    Effect.gen(function* () {
      const { storage, dump } = memoryStorage();
      const { load, keep } = registry();
      const first = yield* open(storage, MASTER, undefined, load, keep);
      const asking = yield* Effect.forkChild(first.secrets.ask(ASK));

      yield* Effect.yieldNow;
      yield* first.secrets.answer("7", { API_KEY: VALUE }, "environment");

      // The call was cut off before it took the answer; the rerun finds it in storage.
      yield* Fiber.interrupt(asking);

      const second = yield* open(storage, MASTER, undefined, load, keep);

      expect(dump()).not.toContain(VALUE);
      expect(yield* second.secrets.scrub([userMessage(`key ${VALUE}`)])).toEqual([
        userMessage(`key ${secretReference("API_KEY")}`),
      ]);
    }));
});
