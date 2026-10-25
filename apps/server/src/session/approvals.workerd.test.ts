// Approval over the Session socket (docs/spec.md → Approval), against real Durable Object storage and a test Registry:
// a change that needs the owner's yes reaches every client as a card's request, the owner's Approve applies it and
// records it as approved, a Decline gives the agent the owner's reason, a waiting request survives an eviction, and
// Stop withdraws it.
// workerd's Durable Object, WebSocket, and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off preferSchemaOverJson:off preferEffectArray:off
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  type ApprovalRequest,
  type ClientMessage,
  ServerMessageJson,
  type ServerMessage,
} from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vitest";
import type { TestRegistry } from "../registry/store.fixture.ts";
import type { TestSession } from "./host.fixture.ts";

declare global {
  namespace Cloudflare {
    /** The bindings `vitest.config.ts` gives the test Worker. */
    interface Env {
      readonly SESSIONS: DurableObjectNamespace<TestSession>;
      readonly REGISTRIES: DurableObjectNamespace<TestRegistry>;
    }
  }
}

const decode = Schema.decodeUnknownEffect(ServerMessageJson);

/** A new Workspace of the default Environment, as `createSession` makes one. */
const NEW_IN_DEFAULT = {
  kind: "new",
  id: "0a1b2c3d",
  environment: "default",
  branch: "cloudpid/0a1b2c3d",
  base: null,
} as const;

let counter = 0;

/** A Session whose name gives it the `settings_*` tools, registered in a fresh Registry it reports to. */
const registered = async () => {
  const sessionId = `settings-approval-${(counter += 1)}`;
  const registryName = `approval-registry-${counter}`;
  const registry = env.REGISTRIES.getByName(registryName);
  const stub = env.SESSIONS.getByName(sessionId);

  await registry.createSession({ id: sessionId, title: null, workspace: NEW_IN_DEFAULT }, 1);
  await runInDurableObject(stub, (instance: TestSession) => instance.reportTo(registryName));

  return { stub, registry };
};

/** A client of a Session's socket that keeps every message the Session sent it. */
const connect = async (stub: DurableObjectStub<TestSession>) => {
  const response = await stub.fetch("http://session/socket", { headers: { Upgrade: "websocket" } });
  const socket = response.webSocket;

  if (socket === null) throw new Error(`No socket: ${response.status}`);
  socket.accept();

  const received: ServerMessage[] = [];

  socket.addEventListener("message", (event) => {
    received.push(Effect.runSync(decode(event.data)));
  });

  /** The first message after `from` that `match` accepts. */
  const next = async <A extends ServerMessage>(
    match: (message: ServerMessage) => message is A,
    from = 0,
  ): Promise<A> => {
    for (let attempt = 0; attempt < 500; attempt++) {
      const found = received.slice(from).find(match);

      if (found !== undefined) return found;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    throw new Error(`Never received the expected message: ${JSON.stringify(received)}`);
  };

  return {
    received,
    send: (message: ClientMessage) => socket.send(JSON.stringify(message)),
    next,
    close: () => socket.close(),
  };
};

type Requests = Extract<ServerMessage, { type: "approval_requests" }>;

const isRequests = (message: ServerMessage): message is Requests =>
  message.type === "approval_requests";

const isPending = (message: ServerMessage): message is Requests =>
  isRequests(message) && message.requests.length > 0;

const isCleared = (message: ServerMessage): message is Requests =>
  isRequests(message) && message.requests.length === 0;

const isAnswer =
  (id: string) =>
  (message: ServerMessage): message is Extract<ServerMessage, { type: "result" | "error" }> =>
    (message.type === "result" || message.type === "error") && message.id === id;

/** The one request of an `approval_requests` message. */
const only = (message: Requests): ApprovalRequest => {
  const [request] = message.requests;

  if (request === undefined || message.requests.length !== 1) throw new Error("Not one request");

  return request;
};

/** Wait until `stub`'s Session has no work live. */
const idle = async (stub: DurableObjectStub<TestSession>) => {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (await runInDurableObject(stub, (instance: TestSession) => instance.idle())) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error("Never idle");
};

const script = (stub: DurableObjectStub<TestSession>, ...responses: string[]) =>
  runInDurableObject(stub, (instance: TestSession) => instance.script(responses));

const toolResults = (stub: DurableObjectStub<TestSession>) =>
  runInDurableObject(stub, (instance: TestSession) => instance.toolResults());

const RAISE = `call:settings_spend_limit_set:${JSON.stringify({ per_session: 25, reason: "The migration needs more requests" })}`;

describe("Approval over the Session socket", () => {
  it("shows the change on every client, applies it on Approve, and records it as approved", async () => {
    const { stub, registry } = await registered();

    await script(stub, RAISE, "Raised.");

    const owner = await connect(stub);
    const other = await connect(stub);

    // A client is told at once that nothing waits, so it clears any card it held.
    expect(await owner.next(isRequests)).toEqual({ type: "approval_requests", requests: [] });

    owner.send({ type: "submit", id: "go", input: "Raise the limit" });

    const request = only(await owner.next(isPending));

    expect(request).toEqual({
      id: expect.any(String),
      conversationId: expect.any(Number),
      tool: "settings_spend_limit_set",
      target: "the Settings",
      change: "Spend limit",
      before: expect.any(String),
      after: "$25 per Session",
      reason: "The migration needs more requests",
    });
    // What the call checks once approved stays in the Session.
    expect(JSON.stringify(owner.received)).not.toContain("expected");
    expect(only(await other.next(isPending))).toEqual(request);

    const seen = other.received.length;

    owner.send({ type: "approval_answer", id: "yes", request: request.id, approve: true });

    expect(await owner.next(isAnswer("yes"))).toEqual({ type: "result", id: "yes", result: null });
    // The other client's card closes.
    await other.next(isCleared, seen);
    await idle(stub);

    expect((await registry.getSettings()).settings.spendLimit.perSession).toBe(25);
    expect(await registry.listSettingsChanges()).toMatchObject([
      {
        field: "spendLimit.perSession",
        after: 25,
        tool: "settings_spend_limit_set",
        reason: "The migration needs more requests",
        approved: true,
      },
    ]);
    expect((await toolResults(stub)).at(-1)).toContain("The user approved");

    // The owner may not have the page open: the request is pushed to them, naming the change and why.
    await vi.waitFor(
      async () =>
        expect(
          await runInDurableObject(stub, (instance: TestSession) => instance.notified()),
        ).toContainEqual({
          kind: "input",
          names: [],
          approval: "Spend limit, the Settings",
          reason: "The migration needs more requests",
        }),
      { timeout: 10_000, interval: 50 },
    );
  });

  it("changes nothing on Decline, and gives the agent the owner's reason", async () => {
    const { stub, registry } = await registered();

    await script(stub, RAISE, "Left it.");

    const owner = await connect(stub);

    owner.send({ type: "submit", id: "go", input: "Raise the limit" });

    const request = only(await owner.next(isPending));

    owner.send({
      type: "approval_answer",
      id: "no",
      request: request.id,
      approve: false,
      reason: "Finish the cheap part first",
    });
    expect(await owner.next(isAnswer("no"))).toMatchObject({ type: "result" });
    await idle(stub);

    expect(await registry.listSettingsChanges()).toEqual([]);
    expect((await toolResults(stub)).at(-1)).toContain("Finish the cheap part first");
  });

  it("keeps a waiting request across an eviction, shows it again on reconnect, and applies the answer", async () => {
    const { stub, registry } = await registered();

    await script(stub, RAISE, "Raised.");

    const before = await connect(stub);

    before.send({ type: "submit", id: "go", input: "Raise the limit" });

    const asked = only(await before.next(isPending));

    before.close();
    await evictDurableObject(stub);

    const after = await connect(stub);
    const shown = only(await after.next(isPending));

    expect(shown).toEqual(asked);

    after.send({ type: "approval_answer", id: "yes", request: shown.id, approve: true });
    expect(await after.next(isAnswer("yes"))).toMatchObject({ type: "result" });
    await idle(stub);

    expect((await registry.getSettings()).settings.spendLimit.perSession).toBe(25);
  });

  it("withdraws the request when the owner stops the Run, and refuses a late answer", async () => {
    const { stub, registry } = await registered();

    await script(stub, RAISE, "Stopped.");

    const owner = await connect(stub);

    owner.send({ type: "submit", id: "go", input: "Raise the limit" });

    const request = only(await owner.next(isPending));
    const seen = owner.received.length;

    owner.send({ type: "abort", id: "stop" });
    await owner.next(isCleared, seen);
    await idle(stub);

    owner.send({ type: "approval_answer", id: "late", request: request.id, approve: true });
    expect(await owner.next(isAnswer("late"))).toMatchObject({ type: "error" });
    expect(await registry.listSettingsChanges()).toEqual([]);
  });

  it("withdraws a request whose call is gone once the Session is idle", async () => {
    const { stub } = await registered();

    // As an abandoned call leaves it: stored, with no call to come back for it.
    await runInDurableObject(stub, (_instance: TestSession, state) => {
      state.storage.kv.put("approval-requests", [
        {
          id: "99",
          conversationId: 0,
          tool: "settings_spend_limit_set",
          target: "the Settings",
          change: "Spend limit",
          before: "no limit",
          after: "$25 per Session",
          reason: "r",
          expected: null,
        },
      ]);
    });
    await evictDurableObject(stub);

    const stored = () =>
      runInDurableObject(stub, (_instance: TestSession, state) =>
        state.storage.kv.get("approval-requests"),
      );

    // The new instance settles with no work live.
    await vi.waitFor(async () => expect(await stored()).toEqual([]), {
      timeout: 10_000,
      interval: 20,
    });
  });
});
