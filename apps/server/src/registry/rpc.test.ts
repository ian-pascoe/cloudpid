// @effect-diagnostics asyncFunction:off
import { DEFAULT_SETTINGS, SettingsError } from "@cloudpid/config";
import { RegistryRpcs, RPC_PATH } from "@cloudpid/protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as RpcClient from "effect/rpc/RpcClient";
import type { RpcClientError } from "effect/rpc/RpcClientError";
import type * as Schema from "effect/Schema";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import { expect, it } from "vitest";
import { isRegistryRpc } from "../routes.ts";
import { serveRegistryRpc } from "./rpc.ts";
import { SettingsUpdate } from "./settings.ts";
import type { SessionRecord, WorkspaceRecord } from "./store.ts";

/** An in-memory Registry behind `getByName`, as the Worker's binding presents it. */
const fakeRegistries = () => {
  const sessions: SessionRecord[] = [];
  const workspaces: WorkspaceRecord[] = [];
  const names: string[] = [];
  /** The endpoints of the Web Push subscriptions kept. */
  const pushes = new Set<string>();
  /** The Registry methods called, in order. */
  const calls: string[] = [];

  const registry = {
    createSession: ({ title, workspace }: { title?: string | undefined; workspace?: string }) =>
      Effect.sync(() => {
        calls.push("createSession");

        const record: SessionRecord = {
          id: `session-${sessions.length + 1}`,
          title: title ?? null,
          workspace: workspace ?? "default",
          status: "idle",
          createdAt: 1,
          updatedAt: 1,
        };

        sessions.unshift(record);

        return record;
      }),
    listSessions: () => Effect.sync(() => [...sessions]),
    createWorkspace: ({ slug }: { slug: string }) =>
      Effect.sync(() => {
        calls.push("createWorkspace");

        const record: WorkspaceRecord = { slug, createdAt: 1 };

        workspaces.push(record);

        return record;
      }),
    listWorkspaces: () => Effect.sync(() => [...workspaces]),
    getSettings: () =>
      Effect.sync(() => {
        calls.push("getSettings");

        return { settings: DEFAULT_SETTINGS, overrides: {} };
      }),
    getPush: ({ endpoint }: { endpoint?: string | undefined }) =>
      Effect.sync(() => {
        calls.push("getPush");

        return { publicKey: "PUBLIC", subscribed: endpoint !== undefined && pushes.has(endpoint) };
      }),
    subscribePush: ({ subscription }: { subscription: { endpoint: string } }) =>
      Effect.sync(() => {
        calls.push("subscribePush");
        pushes.add(subscription.endpoint);
      }),
    unsubscribePush: ({ endpoint }: { endpoint: string }) =>
      Effect.sync(() => {
        calls.push("unsubscribePush");
        pushes.delete(endpoint);
      }),
    updateSettings: ({ overrides }: { overrides: Schema.Json }) =>
      Effect.sync(() => {
        calls.push("updateSettings");

        return overrides === null
          ? SettingsUpdate.Rejected({ message: "model: Expected an object" })
          : SettingsUpdate.Saved({
              state: {
                settings: { ...DEFAULT_SETTINGS, thinkingLevel: "low" },
                overrides: { thinkingLevel: "low" },
              },
            });
      }),
  };

  return {
    names,
    calls,
    // SAFETY: the endpoint only calls `getByName` on the namespace, and the result only through the methods above.
    registries: {
      getByName: (name: string) => {
        names.push(name);

        return registry;
      },
    } as never,
  };
};

class Registry extends Context.Service<
  Registry,
  RpcClient.FromGroup<typeof RegistryRpcs, RpcClientError>
>()("@cloudpid/server/registry/rpc.test/Registry") {}

/** The main Worker's routing and `RegistryRpcs` endpoint, answering `fetch` calls in memory. */
const worker =
  (fake: ReturnType<typeof fakeRegistries>) => (input: RequestInfo | URL, init?: RequestInit) => {
    const request = HttpServerRequest.fromWeb(new Request(input, init));

    // Routed as the main Worker routes it.
    if (!isRegistryRpc(request)) return Promise.resolve(new Response(null, { status: 404 }));

    return serveRegistryRpc(fake.registries).pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, request),
      Effect.map(HttpServerResponse.toWeb),
      Effect.runPromise,
    );
  };

/** Run `program` with a client of `RegistryRpcs` whose requests the main Worker's endpoint answers in memory. */
const withClient = <A, E>(
  program: Effect.Effect<A, E, Registry>,
  fake = fakeRegistries(),
): Promise<A> => {
  const client = Layer.effect(Registry, RpcClient.make(RegistryRpcs)).pipe(
    Layer.provide(RpcClient.layerProtocolHttp({ url: `http://worker.test${RPC_PATH}` })),
    Layer.provide(RpcSerialization.layerJson),
    Layer.provide(FetchHttpClient.layer),
    // SAFETY: the client calls `fetch` with a URL and an init only, which `worker` takes.
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, worker(fake) as typeof fetch)),
  );

  // The test is the client's entry point.
  // @effect-diagnostics-next-line strictEffectProvide:off
  return Effect.runPromise(program.pipe(Effect.provide(client)));
};

/**
 * Call `tag` with `payload` as a hand-written client would: one Effect RPC request in JSON, unchecked by the shared
 * schemas. The answer is the endpoint's JSON text, and the Registry methods the call reached.
 */
const callRaw = async (tag: string, payload: Schema.Json) => {
  const fake = fakeRegistries();

  const response = await worker(fake)(`http://worker.test${RPC_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: `{"_tag":"Request","id":"1","tag":"${tag}","payload":${JSON.stringify(payload)},"headers":[]}`,
  });

  return { text: await response.text(), calls: fake.calls };
};

it("creates a Session in the singleton Registry and lists it", async () => {
  const fake = fakeRegistries();

  const [created, listed] = await withClient(
    Effect.gen(function* () {
      const registry = yield* Registry;
      const session = yield* registry.createSession({ title: "Fix the build" });

      return [session, yield* registry.listSessions()] as const;
    }),
    fake,
  );

  expect(created).toMatchObject({ id: "session-1", title: "Fix the build", status: "idle" });
  expect(listed).toEqual([created]);
  expect(fake.names).toEqual(["registry", "registry"]);
});

it("binds a created Session to the Workspace it names, and rejects a slug that is not one", async () => {
  const fake = fakeRegistries();

  const created = await withClient(
    Effect.flatMap(Registry, (registry) => registry.createSession({ workspace: "cloudpid" })),
    fake,
  );

  expect(created.workspace).toBe("cloudpid");

  const { text, calls } = await callRaw("createSession", { workspace: "Not A Slug" });

  expect(text).toContain('"Failure"');
  expect(calls).toEqual([]);
});

it("trims a title on the server", async () => {
  const { text } = await callRaw("createSession", { title: "  Fix the build \n" });

  expect(JSON.parse(text)).toMatchObject([{ exit: { value: { title: "Fix the build" } } }]);
});

it("rejects a title that is blank or longer than 200 characters, before it reaches the Registry", async () => {
  for (const title of ["   ", "a".repeat(201)]) {
    const { text, calls } = await callRaw("createSession", { title });

    expect(text).toContain('"Failure"');
    expect(calls).toEqual([]);
  }

  expect((await callRaw("createSession", { title: "a".repeat(200) })).calls).toEqual([
    "createSession",
  ]);
});

it("rejects a Workspace slug that is not lowercase letters, digits and dashes, before it reaches the Registry", async () => {
  const { text, calls } = await callRaw("createWorkspace", { slug: "Not A Slug" });

  expect(text).toContain('"Failure"');
  expect(calls).toEqual([]);
});

it("creates and lists Workspaces", async () => {
  const workspaces = await withClient(
    Effect.gen(function* () {
      const registry = yield* Registry;

      yield* registry.createWorkspace({ slug: "cloudpid" });

      return yield* registry.listWorkspaces();
    }),
  );

  expect(workspaces).toEqual([{ slug: "cloudpid", createdAt: 1 }]);
});

it("subscribes a browser to Web Push, tells it so, and forgets it when it unsubscribes", async () => {
  const endpoint = "https://push.example.net/wpush/v2/abc";

  const [before, after, gone] = await withClient(
    Effect.gen(function* () {
      const registry = yield* Registry;
      const before = yield* registry.getPush({ endpoint });

      yield* registry.subscribePush({
        subscription: { endpoint, keys: { p256dh: "k", auth: "a" } },
      });

      const after = yield* registry.getPush({ endpoint });

      yield* registry.unsubscribePush({ endpoint });

      return [before, after, yield* registry.getPush({ endpoint })] as const;
    }),
  );

  expect(before).toEqual({ publicKey: "PUBLIC", subscribed: false });
  expect(after).toEqual({ publicKey: "PUBLIC", subscribed: true });
  expect(gone.subscribed).toBe(false);
});

it("serves the VAPID public key to a browser that has no subscription yet", async () => {
  const state = await withClient(Effect.flatMap(Registry, (registry) => registry.getPush({})));

  expect(state).toEqual({ publicKey: "PUBLIC", subscribed: false });
});

it("rejects a subscription whose endpoint is not https, before it reaches the Registry", async () => {
  const { text, calls } = await callRaw("subscribePush", {
    subscription: { endpoint: "http://169.254.169.254/latest", keys: { p256dh: "k", auth: "a" } },
  });

  expect(text).toContain('"Failure"');
  expect(calls).toEqual([]);
});

it("reads the settings from the singleton Registry", async () => {
  const fake = fakeRegistries();

  const state = await withClient(
    Effect.gen(function* () {
      const registry = yield* Registry;

      return yield* registry.getSettings();
    }),
    fake,
  );

  expect(state).toEqual({ settings: DEFAULT_SETTINGS, overrides: {} });
  expect(fake.names).toEqual(["registry"]);
});

it("saves settings overrides in the Registry and answers the settings in force", async () => {
  const state = await withClient(
    Effect.gen(function* () {
      const registry = yield* Registry;

      return yield* registry.updateSettings({ overrides: { thinkingLevel: "low" } });
    }),
  );

  expect(state).toMatchObject({
    settings: { thinkingLevel: "low" },
    overrides: { thinkingLevel: "low" },
  });
});

it("fails an update the Registry rejects with the Registry's readable message", async () => {
  const error = await withClient(
    Effect.gen(function* () {
      const registry = yield* Registry;

      return yield* Effect.flip(registry.updateSettings({ overrides: null }));
    }),
  );

  expect(error).toBeInstanceOf(SettingsError);
  expect(error.message).toBe("model: Expected an object");
});
