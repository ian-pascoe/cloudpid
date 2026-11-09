// @effect-diagnostics asyncFunction:off globalFetch:off globalJsonInEffect:off preferEffectArray:off preferEffectRecord:off
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { pushNotifier, pushOwner } from "./notify.ts";
import { base64UrlEncode, exportPublicKey, generateEcdhKeys, type Vapid } from "./webpush.ts";

const SESSION = { id: "s-1", title: "Fix the build", titleSource: "owner" as const };

/** A browser's subscription keys, as `PushSubscription.toJSON()` gives them. */
const newKeys = async () => ({
  p256dh: await exportPublicKey((await generateEcdhKeys()).publicKey),
  auth: base64UrlEncode(crypto.getRandomValues(new Uint8Array(16))),
});

const newVapid = async (): Promise<Vapid> => {
  const pair = await generateEcdhKeys();
  // SAFETY: the JWK format exports a `JsonWebKey`; the typings' overloads cannot narrow it.
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;

  return {
    subject: "mailto:owner@example.com",
    publicKey: await exportPublicKey(pair.publicKey),
    privateKey: jwk.d ?? "",
  };
};

/** The Registry's tables the notifier uses, in memory, and a push service answering by endpoint. */
const setup = async (endpoints: Readonly<Record<string, number>>) => {
  const subscriptions = await Promise.all(
    Object.keys(endpoints).map(async (endpoint) => ({ endpoint, keys: await newKeys() })),
  );

  const deleted: string[] = [];
  const posted: string[] = [];

  const store = {
    getSession: (id: string) =>
      id === SESSION.id
        ? {
            ...SESSION,
            environment: "default",
            workspace: "0a1b2c3d",
            status: "idle" as const,
            createdAt: 1,
            updatedAt: 1,
            archivedAt: null,
          }
        : null,
    listPushSubscriptions: () => subscriptions,
    deletePushSubscription: (endpoint: string) => {
      deleted.push(endpoint);
    },
  };

  const fake = (input: RequestInfo | URL) => {
    const { url } = new Request(input);

    posted.push(url);

    return Promise.resolve(new Response(null, { status: endpoints[url] ?? 500 }));
  };

  const vapid = await newVapid();

  // SAFETY: the notifiers call `fetch` with a URL and an init, which `fake` takes.
  const fetcher = fake as typeof fetch;
  const notify = pushNotifier({ store, vapid, fetch: fetcher });

  // The owner's push needs the subscriptions only: no Session is looked up.
  const owner = pushOwner({
    store: {
      listPushSubscriptions: store.listPushSubscriptions,
      deletePushSubscription: store.deletePushSubscription,
    },
    vapid,
    fetch: fetcher,
  });

  return { notify, owner, deleted, posted };
};

describe("the notifier", () => {
  it("pushes to every subscribed browser", async () => {
    const { notify, posted, deleted } = await setup({
      "https://push.a.example/1": 201,
      "https://push.b.example/2": 201,
    });

    await Effect.runPromise(notify("s-1", { kind: "finished" }));

    expect(posted.toSorted()).toEqual(["https://push.a.example/1", "https://push.b.example/2"]);
    expect(deleted).toEqual([]);
  });

  it("deletes a subscription the push service no longer knows, and keeps the rest", async () => {
    const { notify, deleted, posted } = await setup({
      "https://push.a.example/1": 410,
      "https://push.b.example/2": 404,
      "https://push.c.example/3": 201,
      "https://push.d.example/4": 503,
    });

    await Effect.runPromise(notify("s-1", { kind: "finished" }));

    expect(posted).toHaveLength(4);
    expect(deleted.toSorted()).toEqual(["https://push.a.example/1", "https://push.b.example/2"]);
  });

  it("does not stop at a push service that cannot be reached", async () => {
    const { notify, posted } = await setup({ "https://push.a.example/1": 201 });

    await Effect.runPromise(notify("s-1", { kind: "finished" }));
    expect(posted).toHaveLength(1);

    const failing = pushNotifier({
      store: {
        getSession: () => ({
          ...SESSION,
          environment: "default",
          workspace: "0a1b2c3d",
          status: "idle",
          createdAt: 1,
          updatedAt: 1,
          archivedAt: null,
        }),
        listPushSubscriptions: () => [
          { endpoint: "https://push.a.example/1", keys: { p256dh: "not a key", auth: "x" } },
        ],
        deletePushSubscription: () => undefined,
      },
      vapid: await newVapid(),
    });

    // An unusable subscription is logged, not thrown.
    await expect(Effect.runPromise(failing("s-1", { kind: "finished" }))).resolves.toBeUndefined();
  });

  it("ignores a Session the Registry does not know", async () => {
    const { notify, posted } = await setup({ "https://push.a.example/1": 201 });

    await Effect.runPromise(notify("unknown", { kind: "finished" }));

    expect(posted).toEqual([]);
  });
});

const PAYLOAD = {
  title: "Changed over MCP · pi",
  body: "Default: variables.API_URL",
  url: "/settings/default/agent-changes#agent-change-41",
  tag: "mcp-changes:pi",
};

describe("the owner's push", () => {
  it("reaches every subscription, with no Session", async () => {
    const { owner, posted, deleted } = await setup({
      "https://push.a.example/1": 201,
      "https://push.b.example/2": 201,
    });

    await Effect.runPromise(owner(PAYLOAD));

    expect(posted.toSorted()).toEqual(["https://push.a.example/1", "https://push.b.example/2"]);
    expect(deleted).toEqual([]);
  });

  it("prunes the subscriptions that are gone, and keeps the rest", async () => {
    const { owner, deleted, posted } = await setup({
      "https://push.a.example/1": 410,
      "https://push.b.example/2": 404,
      "https://push.c.example/3": 201,
      "https://push.d.example/4": 503,
    });

    await Effect.runPromise(owner(PAYLOAD));

    expect(posted).toHaveLength(4);
    expect(deleted.toSorted()).toEqual(["https://push.a.example/1", "https://push.b.example/2"]);
  });

  it("sends nothing when no browser is subscribed, and does not fail on an unusable subscription", async () => {
    const { owner, posted } = await setup({});

    await Effect.runPromise(owner(PAYLOAD));
    expect(posted).toEqual([]);

    const failing = pushOwner({
      store: {
        listPushSubscriptions: () => [
          { endpoint: "https://push.a.example/1", keys: { p256dh: "not a key", auth: "x" } },
        ],
        deletePushSubscription: () => undefined,
      },
      vapid: await newVapid(),
    });

    await expect(Effect.runPromise(failing(PAYLOAD))).resolves.toBeUndefined();
  });
});
