// The Session's Sign-in requests (`docs/architecture/mcp-sign-in.md` → Sign-in requests): asked by a call, answered by the
// owner's sign-in or decline, durable across an eviction, and one request however many calls ask.
// @effect-diagnostics strictEffectProvide:off preferEffectArray:off preferEffectRecord:off anyUnknownInErrorContext:off preferSchemaOverJson:off
import type { McpSignInKnownAskAnswer } from "@cloudpid/mcp/types";
import type { McpSignInRequest } from "@cloudpid/protocol";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it } from "vitest";
import {
  createMcpSignIns,
  type McpSignInAsk,
  McpSignInsError,
  type McpSignInStorage,
} from "./mcp/sign-in.ts";

/** A Durable Object's key-value storage, in memory: what an evicted Session's next instance finds again. */
const memoryStorage = () => {
  const map = new Map<string, unknown>();

  const storage: McpSignInStorage = {
    // SAFETY: the requests read back only what they wrote under each key.
    get: <T>(key: string) => map.get(key) as T | undefined,
    put: (key, value) => {
      map.set(key, structuredClone(value));
    },
    delete: (key) => map.delete(key),
  };

  return { storage, dump: () => JSON.stringify([...map]) };
};

const OPEN: McpSignInKnownAskAnswer = {
  status: "open",
  first: true,
  key: "key-1",
  why: "required",
  scopes: [],
  source: { kind: "global" },
  urlHost: "mcp.sentry.dev",
};

const ASK: McpSignInAsk = {
  callId: "call-1",
  conversationId: ROOT_CONVERSATION_ID,
  environment: "env_1",
  server: "sentry",
  reason: "I need the issue list",
};

/** The Registry as a script: what it answers (by call, so a test can change its mind), and what it was asked and told. */
const registryOf = (answer: () => McpSignInKnownAskAnswer = () => OPEN) => {
  const asked: Array<{ server: string; request: string }> = [];
  const withdrawn: Array<string> = [];
  const state = { answer, down: false };

  return {
    asked,
    withdrawn,
    state,
    registry: {
      ask: (input: { server: string; request: string }) =>
        state.down
          ? Effect.fail(McpSignInsError.make({ message: "down" }))
          : Effect.sync(() => {
              asked.push({ server: input.server, request: input.request });

              return state.answer();
            }),
      withdraw: (request: string) =>
        Effect.sync(() => {
          withdrawn.push(request);
        }),
    },
  };
};

const open = (storage: McpSignInStorage, script = registryOf()) => {
  const announced: Array<ReadonlyArray<McpSignInRequest>> = [];
  const told: Array<{ server: string; reason: string; key: string }> = [];

  const signIns = createMcpSignIns({
    storage,
    registry: script.registry,
    announce: (requests) =>
      Effect.sync(() => {
        announced.push(requests);
      }),
    notify: (who) =>
      Effect.sync(() => {
        told.push(who);
      }),
    redact: (value) => Effect.succeed(value),
  });

  return { signIns, announced, told, script };
};

const test = (name: string, body: () => Effect.Effect<void, unknown>) =>
  it(name, () => Effect.runPromise(body().pipe(Effect.provide(TestClock.layer()))));

/** A moment for the fibers forked so far to run. */
const settle = Effect.repeat(Effect.yieldNow, { times: 8 });

describe("Sign-in requests", () => {
  test("show the card to every client, tell the owner once, and hand the call the sign-in", () =>
    Effect.gen(function* () {
      const { storage } = memoryStorage();
      const { signIns, announced, told } = open(storage);
      const waiting = yield* Effect.forkChild(signIns.ask(ASK));

      yield* settle;

      const [request] = yield* signIns.pending;

      expect(request).toMatchObject({
        id: "signin-1",
        server: "sentry",
        environment: "env_1",
        urlHost: "mcp.sentry.dev",
        reason: "I need the issue list",
        why: "required",
      });
      expect(announced.at(-1)).toHaveLength(1);
      expect(told).toEqual([{ server: "sentry", reason: "I need the issue list", key: "key-1" }]);

      expect(yield* signIns.resolve(["signin-1"])).toBe(1);
      expect(yield* Fiber.join(waiting)).toEqual({ kind: "signed_in" });
      expect(announced.at(-1)).toEqual([]);
      expect(yield* signIns.pending).toEqual([]);
    }));

  test("sends no Notification for a request that is not the first of its key", () =>
    Effect.gen(function* () {
      const { storage } = memoryStorage();

      const { signIns, told } = open(
        storage,
        registryOf(() => ({ ...OPEN, first: false })),
      );

      yield* Effect.forkChild(signIns.ask(ASK));
      yield* settle;

      expect(yield* signIns.pending).toHaveLength(1);
      expect(told).toEqual([]);
    }));

  test("are one request when calls ask in parallel, and one sign-in ends every call", () =>
    Effect.gen(function* () {
      const { storage } = memoryStorage();
      const { signIns, told } = open(storage);

      const first = yield* Effect.forkChild(signIns.ask(ASK));
      const second = yield* Effect.forkChild(signIns.ask({ ...ASK, callId: "call-2" }));

      yield* settle;

      expect(yield* signIns.pending).toHaveLength(1);
      expect(told).toHaveLength(1);

      yield* signIns.resolve(["signin-1"]);

      expect(yield* Fiber.join(first)).toEqual({ kind: "signed_in" });
      expect(yield* Fiber.join(second)).toEqual({ kind: "signed_in" });
    }));

  test("are one request per server: another server gets its own", () =>
    Effect.gen(function* () {
      const { storage } = memoryStorage();
      const { signIns } = open(storage);

      yield* Effect.forkChild(signIns.ask(ASK));
      yield* Effect.forkChild(signIns.ask({ ...ASK, callId: "call-2", server: "linear" }));
      yield* settle;

      expect((yield* signIns.pending).map((request) => request.server)).toEqual([
        "sentry",
        "linear",
      ]);
    }));

  test("survive an eviction: the call that asked reruns and finds its request again", () =>
    Effect.gen(function* () {
      const { storage } = memoryStorage();
      const before = open(storage);

      yield* Effect.forkChild(before.signIns.ask(ASK));
      yield* settle;

      // The Session is evicted: a new instance reads the same storage, with no call waiting yet.
      const after = open(storage);

      expect((yield* after.signIns.pending).map((request) => request.id)).toEqual(["signin-1"]);

      const rerun = yield* Effect.forkChild(after.signIns.ask(ASK));

      yield* settle;

      // The rerun joined the request it held: no second request, no second Notification.
      expect(yield* after.signIns.pending).toHaveLength(1);
      expect(after.told).toEqual([]);
      expect(after.script.asked.map((ask) => ask.request)).toEqual(["signin-1"]);

      yield* after.signIns.resolve(["signin-1"]);
      expect(yield* Fiber.join(rerun)).toEqual({ kind: "signed_in" });
    }));

  test("mark the call's wait once its request is stored, at each rerun, and not for an outcome kept", () =>
    Effect.gen(function* () {
      const { storage } = memoryStorage();
      const marks: (readonly string[])[] = [];

      /** The wait mark of a call over `signIns`: the requests stored when it was made. */
      const marking = (signIns: ReturnType<typeof open>["signIns"]) =>
        Effect.flatMap(signIns.pending, (pending) =>
          Effect.sync(() => void marks.push(pending.map((request) => request.id))),
        );

      const before = open(storage);

      yield* Effect.forkChild(before.signIns.ask(ASK, marking(before.signIns)));
      yield* settle;

      // An eviction leaves the request stored, and the rerun of its call waits for it again.
      const again = open(storage);

      yield* Effect.forkChild(again.signIns.ask(ASK, marking(again.signIns)));
      yield* settle;

      // Signed in while no call waited: the next rerun takes the outcome, and has no wait to mark.
      const after = open(storage);

      yield* after.signIns.resolve(["signin-1"]);
      expect(yield* after.signIns.ask(ASK, marking(after.signIns))).toEqual({ kind: "signed_in" });

      expect(marks).toEqual([["signin-1"], ["signin-1"]]);
    }));

  test("let the Session settle a call that ended in another instance: a request it alone held is withdrawn", () =>
    Effect.gen(function* () {
      const { storage } = memoryStorage();
      const before = open(storage);

      yield* Effect.forkChild(before.signIns.ask(ASK));
      yield* Effect.forkChild(before.signIns.ask({ ...ASK, callId: "call-2" }));
      yield* Effect.forkChild(before.signIns.ask({ ...ASK, callId: "call-3", server: "linear" }));
      yield* settle;

      // An eviction leaves the requests stored; the Session ends calls 1 and 3 before they rerun.
      const after = open(storage);

      yield* after.signIns.settleCall("call-1");
      yield* after.signIns.settleCall("call-3");

      // The request call 2 still holds stays; the one only call 3 held goes, with the Registry's waiter.
      expect((yield* after.signIns.pending).map((request) => request.server)).toEqual([ASK.server]);
      expect(after.script.withdrawn).toEqual(["signin-2"]);
    }));

  test("survive an eviction with the sign-in completed meanwhile: the rerun call learns it at once", () =>
    Effect.gen(function* () {
      const { storage } = memoryStorage();
      const before = open(storage);

      yield* Effect.forkChild(before.signIns.ask(ASK));
      yield* settle;

      const after = open(storage);

      // The main Worker's call arrives while no call waits: the outcome is kept for the call that reruns.
      expect(yield* after.signIns.resolve(["signin-1"])).toBe(1);
      expect(yield* after.signIns.pending).toEqual([]);
      expect(yield* after.signIns.ask(ASK)).toEqual({ kind: "signed_in" });

      // Taken: nothing is left in storage.
      expect(yield* after.signIns.pending).toEqual([]);
      expect(yield* open(storage).signIns.resolve(["signin-1"])).toBe(0);
    }));

  test("survive an eviction with a deploy that missed the call: the rerun asks the Registry and finds it signed in", () =>
    Effect.gen(function* () {
      const { storage } = memoryStorage();
      const before = open(storage);

      yield* Effect.forkChild(before.signIns.ask(ASK));
      yield* settle;

      const after = open(
        storage,
        registryOf(() => ({ status: "signed_in" })),
      );

      expect(yield* after.signIns.ask(ASK)).toEqual({ kind: "signed_in" });
      expect(yield* after.signIns.pending).toEqual([]);
    }));

  test("are checked again with the Registry, ending those whose sign-in stands now", () =>
    Effect.gen(function* () {
      const { storage } = memoryStorage();
      const { signIns, script } = open(storage);
      const waiting = yield* Effect.forkChild(signIns.ask(ASK));

      yield* settle;

      // A Registry that cannot be reached leaves the request open.
      script.state.down = true;
      yield* signIns.recheck;
      expect(yield* signIns.pending).toHaveLength(1);

      script.state.down = false;
      script.state.answer = () => ({ status: "signed_in" });
      yield* signIns.recheck;

      expect(yield* Fiber.join(waiting)).toEqual({ kind: "signed_in" });
      expect(yield* signIns.pending).toEqual([]);
    }));

  test("show a failed callback on every open request of the key, and keep them open", () =>
    Effect.gen(function* () {
      const { storage } = memoryStorage();
      const { signIns, announced } = open(storage);
      const waiting = yield* Effect.forkChild(signIns.ask(ASK));

      const other = yield* Effect.forkChild(
        signIns.ask({ ...ASK, callId: "call-2", server: "linear" }),
      );

      yield* settle;

      expect(yield* signIns.failed(["signin-1"], "The authorization server refused the code")).toBe(
        1,
      );
      expect((yield* signIns.pending).map((request) => request.problem)).toEqual([
        "The authorization server refused the code",
        undefined,
      ]);
      expect(announced.at(-1)?.[0]?.problem).toBe("The authorization server refused the code");

      // The same words again change nothing, and tell no one.
      const told = announced.length;

      expect(yield* signIns.failed(["signin-1"], "The authorization server refused the code")).toBe(
        0,
      );
      expect(announced).toHaveLength(told);

      // Still waiting: a failed callback ends nothing, and a later sign-in still ends it.
      yield* signIns.resolve(["signin-1"]);
      expect(yield* Fiber.join(waiting)).toEqual({ kind: "signed_in" });
      yield* Fiber.interrupt(other);
    }));

  test("keep a failure a failed attempt carried over the Registry's older last failure at a re-check", () =>
    Effect.gen(function* () {
      const { storage } = memoryStorage();
      const { signIns, script } = open(storage);

      yield* Effect.forkChild(signIns.ask(ASK));
      yield* settle;
      yield* signIns.failed(["signin-1"], "The code was refused");

      // The Registry's `lastError` has no time: it is no newer than what the card shows.
      script.state.answer = () => ({ ...OPEN, problem: "An older failure" });
      yield* signIns.recheck;
      expect((yield* signIns.pending)[0]?.problem).toBe("The code was refused");

      // A carried failure is the newest word, and replaces whatever shows.
      yield* signIns.failed(["signin-1"], "The code was refused again");
      expect((yield* signIns.pending)[0]?.problem).toBe("The code was refused again");
    }));

  test("fill a card that shows no problem with the Registry's last failure at a re-check, and keep it when the Registry has none", () =>
    Effect.gen(function* () {
      const { storage } = memoryStorage();
      const { signIns, script } = open(storage);

      yield* Effect.forkChild(signIns.ask(ASK));
      yield* settle;

      script.state.answer = () => ({ ...OPEN, problem: "The exchange failed (invalid_grant)" });
      yield* signIns.recheck;
      expect((yield* signIns.pending)[0]?.problem).toBe("The exchange failed (invalid_grant)");

      script.state.answer = () => OPEN;
      yield* signIns.recheck;
      expect((yield* signIns.pending)[0]?.problem).toBe("The exchange failed (invalid_grant)");
    }));

  test("end only their own with a decline, which carries the owner's reason and drops the waiter", () =>
    Effect.gen(function* () {
      const { storage } = memoryStorage();
      const { signIns, script, announced } = open(storage);

      const sentry = yield* Effect.forkChild(signIns.ask(ASK));

      const linear = yield* Effect.forkChild(
        signIns.ask({ ...ASK, callId: "call-2", server: "linear" }),
      );

      yield* settle;
      yield* signIns.decline("signin-1", "  not that one ");

      expect(yield* Fiber.join(sentry)).toEqual({ kind: "declined", reason: "not that one" });
      expect(script.withdrawn).toEqual(["signin-1"]);
      expect((yield* signIns.pending).map((request) => request.server)).toEqual(["linear"]);
      expect(announced.at(-1)).toHaveLength(1);

      // A request that ended cannot be declined again.
      const again = yield* Effect.exit(signIns.decline("signin-1", undefined));

      expect(again._tag).toBe("Failure");

      yield* signIns.decline("signin-2", undefined);
      expect(yield* Fiber.join(linear)).toEqual({ kind: "declined" });
    }));

  test("are withdrawn by Stop, with the Registry's waiter, once no call is left on them", () =>
    Effect.gen(function* () {
      const { storage } = memoryStorage();
      const { signIns, script, announced } = open(storage);

      const first = yield* Effect.forkChild(signIns.ask(ASK));
      const second = yield* Effect.forkChild(signIns.ask({ ...ASK, callId: "call-2" }));

      yield* settle;

      // One call is stopped: the other still waits, so the request stays.
      yield* Fiber.interrupt(first);
      yield* settle;
      expect(yield* signIns.pending).toHaveLength(1);
      expect(script.withdrawn).toEqual([]);

      yield* Fiber.interrupt(second);
      yield* settle;

      expect(yield* signIns.pending).toEqual([]);
      expect(script.withdrawn).toEqual(["signin-1"]);
      expect(announced.at(-1)).toEqual([]);
    }));

  test("are withdrawn when their server leaves the set", () =>
    Effect.gen(function* () {
      const { storage } = memoryStorage();
      const { signIns, script } = open(storage);
      const waiting = yield* Effect.forkChild(signIns.ask(ASK));

      const other = yield* Effect.forkChild(
        signIns.ask({ ...ASK, callId: "call-2", server: "linear" }),
      );

      yield* settle;
      yield* signIns.withdrawServer("sentry", "sentry was removed");

      expect(yield* Fiber.join(waiting)).toEqual({
        kind: "withdrawn",
        reason: "sentry was removed",
      });
      expect(script.withdrawn).toEqual(["signin-1"]);
      expect((yield* signIns.pending).map((request) => request.server)).toEqual(["linear"]);
      yield* Fiber.interrupt(other);
    }));

  test("tell no client when nothing was abandoned, which is how every idle Session runs it", () =>
    Effect.gen(function* () {
      const { storage } = memoryStorage();
      const { signIns, announced } = open(storage);

      yield* signIns.dropAbandoned;
      expect(announced).toEqual([]);

      const waiting = yield* Effect.forkChild(signIns.ask(ASK));

      yield* settle;

      const told = announced.length;

      yield* signIns.dropAbandoned;
      expect(announced).toHaveLength(told);
      yield* Fiber.interrupt(waiting);
    }));

  test("are dropped with their waiters when no call waits for them any more", () =>
    Effect.gen(function* () {
      const { storage } = memoryStorage();
      const before = open(storage);

      yield* Effect.forkChild(before.signIns.ask(ASK));
      yield* settle;

      const after = open(storage);

      yield* after.signIns.dropAbandoned;

      expect(yield* after.signIns.pending).toEqual([]);
      expect(after.script.withdrawn).toEqual(["signin-1"]);
    }));

  it.each([
    ["a sign-in that stands", { status: "signed_in" }, { kind: "signed_in" }],
    [
      "a server with no sign-in to give",
      { status: "not_applicable", reason: "It sends its own Authorization header" },
      { kind: "not_applicable", reason: "It sends its own Authorization header" },
    ],
    [
      "a step-up asked for too often",
      { status: "step_up_failed", reason: "Still short of access", scopes: ["a"] },
      { kind: "step_up_failed", reason: "Still short of access" },
    ],
    [
      "a server that is not in the set",
      { status: "unavailable", reason: "No such server" },
      { kind: "unavailable", reason: "No such server" },
    ],
  ] as const)("end at once for %s, keeping nothing", (_name, answer, outcome) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { storage, dump } = memoryStorage();

        const { signIns, announced, told } = open(
          storage,
          registryOf(() => answer),
        );

        expect(yield* signIns.ask(ASK)).toEqual(outcome);
        expect(yield* signIns.pending).toEqual([]);
        expect(announced).toEqual([]);
        expect(told).toEqual([]);
        expect(dump()).not.toContain("call-1");
      }),
    ),
  );

  test("end as unavailable when the Registry cannot be reached", () =>
    Effect.gen(function* () {
      const { storage } = memoryStorage();
      const script = registryOf();

      script.state.down = true;

      const { signIns } = open(storage, script);

      expect(yield* signIns.ask(ASK)).toMatchObject({ kind: "unavailable" });
    }));

  test("carry no URL, code or token: only the hosts, the reason and what stands in the way", () =>
    Effect.gen(function* () {
      const { storage, dump } = memoryStorage();

      const { signIns } = open(
        storage,
        registryOf(() => ({
          ...OPEN,
          why: "step_up",
          scopes: ["issues:read"],
          issuerHost: "auth.sentry.dev",
        })),
      );

      yield* Effect.forkChild(signIns.ask(ASK));
      yield* settle;

      const [request] = yield* signIns.pending;

      expect(request).toMatchObject({
        why: "step_up",
        scopes: ["issues:read"],
        issuerHost: "auth.sentry.dev",
      });
      expect(dump()).not.toContain("https://");
    }));
});
