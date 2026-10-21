// @effect-diagnostics asyncFunction:off
import {
  DEFAULT_SETTINGS,
  DEFAULT_WORKSPACE_SETTINGS,
  SettingsError,
  type WorkspaceSettings,
} from "@cloudpid/config";
import { RegistryRpcs, RPC_PATH, SessionNotFound, WorkspaceError } from "@cloudpid/protocol";
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
import type { Repos } from "../workspace/repos.ts";
import type { WorkspaceSettingsRemote } from "../workspace/settings.ts";
import type { SessionRecord, WorkspaceRecord } from "./store.ts";

/** The overrides the fake saved, as the fields of the settings they replace. */
// SAFETY: the tests only save overrides of the settings' own shape.
const asSettings = (overrides: Schema.Json) => overrides as Partial<WorkspaceSettings>;

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
    createSession: ({
      title,
      workspace,
      repo,
    }: {
      title?: string | undefined;
      workspace?: string;
      repo?: string;
    }) =>
      Effect.sync(() => {
        calls.push("createSession");

        const record: SessionRecord = {
          id: `session-${sessions.length + 1}`,
          title: title ?? null,
          titleSource: title === undefined ? null : "owner",
          workspace: workspace ?? "default",
          repo: repo ?? null,
          status: "idle",
          createdAt: 1,
          updatedAt: 1,
        };

        sessions.unshift(record);

        return record;
      }),
    listSessions: () => Effect.sync(() => [...sessions]),
    renameSession: ({ id, title }: { id: string; title: string }) =>
      Effect.sync(() => {
        calls.push("renameSession");

        const index = sessions.findIndex((session) => session.id === id);
        const found = sessions[index];

        if (found === undefined) return null;

        const renamed: SessionRecord = { ...found, title, titleSource: "owner" };

        sessions[index] = renamed;

        return renamed;
      }),
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

  /** The Workspaces' repos: what `list` answers per slug, and the clones asked for. */
  const held = new Map<string, string[]>([["cloudpid", ["pi"]]]);
  const clones: Array<{ slug: string; url: string; name: string }> = [];
  let cloneFails: string | undefined;

  const repos: Repos = {
    list: (slug) => {
      calls.push("list");

      return Promise.resolve(held.get(slug) ?? []);
    },
    clone: (slug, { url, name }) => {
      calls.push("clone");

      if (cloneFails !== undefined) return Promise.reject(new Error(cloneFails));

      clones.push({ slug, url, name });
      held.set(slug, [...(held.get(slug) ?? []), name]);

      return Promise.resolve();
    },
  };

  /** The Workspaces' own settings: the overrides saved per slug. */
  const saved = new Map<string, Schema.Json>();

  const workspaceSettings: WorkspaceSettingsRemote = {
    read: (slug) => {
      calls.push("readWorkspaceSettings");

      const overrides = saved.get(slug) ?? {};

      return Promise.resolve({
        settings: { ...DEFAULT_WORKSPACE_SETTINGS, ...asSettings(overrides) },
        overrides,
      });
    },
    write: (slug, overrides) => {
      calls.push("writeWorkspaceSettings");

      if (overrides === null)
        return Promise.resolve({ ok: false, message: "instance: Expected a string" });

      saved.set(slug, overrides);

      return Promise.resolve({
        ok: true,
        state: { settings: { ...DEFAULT_WORKSPACE_SETTINGS, ...asSettings(overrides) }, overrides },
      });
    },
  };

  return {
    names,
    calls,
    repos,
    workspaceSettings,
    saved,
    clones,
    failClones: (message: string) => {
      cloneFails = message;
    },
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

    return serveRegistryRpc(fake.registries, fake.repos, fake.workspaceSettings).pipe(
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

it("renames a Session, which is the owner's title from then on", async () => {
  const fake = fakeRegistries();

  const [renamed, listed] = await withClient(
    Effect.gen(function* () {
      const registry = yield* Registry;
      const session = yield* registry.createSession({});

      return [
        yield* registry.renameSession({ id: session.id, title: "Fix the build" }),
        yield* registry.listSessions(),
      ] as const;
    }),
    fake,
  );

  expect(renamed).toMatchObject({ title: "Fix the build", titleSource: "owner" });
  expect(listed).toEqual([renamed]);
});

it("fails to rename a Session the Registry does not know", async () => {
  const error = await withClient(
    Effect.flip(
      Effect.flatMap(Registry, (registry) =>
        registry.renameSession({ id: "ghost", title: "Nope" }),
      ),
    ),
  );

  expect(error).toBeInstanceOf(SessionNotFound);
  expect(error.message).toContain("ghost");
});

it("rejects a new title that is blank or longer than 200 characters, before it reaches the Registry", async () => {
  for (const title of ["   ", "a".repeat(201)]) {
    const { text, calls } = await callRaw("renameSession", { id: "s", title });

    expect(text).toContain('"Failure"');
    expect(calls).toEqual([]);
  }
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
  const endpoint = "https://updates.push.services.mozilla.com/wpush/v2/abc";

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

it("rejects a subscription that is not at a known push service over https, before it reaches the Registry", async () => {
  for (const endpoint of [
    "http://updates.push.services.mozilla.com/wpush/v2/abc",
    "http://169.254.169.254/latest",
    "https://127.0.0.1/x",
    "https://internal.example/x",
    "https://user:pass@fcm.googleapis.com/fcm/send/abc",
    "https://fcm.googleapis.com:8443/fcm/send/abc",
    "https://fcm.googleapis.com.evil.example/fcm/send/abc",
    "https://push.apple.com/x",
  ]) {
    const { text, calls } = await callRaw("subscribePush", {
      subscription: { endpoint, keys: { p256dh: "k", auth: "a" } },
    });

    expect(text, endpoint).toContain('"Failure"');
    expect(calls).toEqual([]);
  }
});

it("binds a Session to a repo its Workspace holds", async () => {
  const fake = fakeRegistries();

  const created = await withClient(
    Effect.flatMap(Registry, (registry) =>
      registry.createSession({ workspace: "cloudpid", repo: "pi" }),
    ),
    fake,
  );

  expect(created).toMatchObject({ workspace: "cloudpid", repo: "pi" });
  expect(fake.calls).toEqual(["list", "createSession"]);
});

it("refuses a Session on a repo its Workspace does not hold, before it is registered", async () => {
  const fake = fakeRegistries();

  const error = await withClient(
    Effect.flatMap(Registry, (registry) =>
      Effect.flip(registry.createSession({ workspace: "cloudpid", repo: "ghost" })),
    ),
    fake,
  );

  expect(error).toBeInstanceOf(WorkspaceError);
  expect(error.message).toBe('Workspace "cloudpid" has no repo "ghost"');
  expect(fake.calls).toEqual(["list"]);
});

it("checks a repo against the default Workspace when the Session names none", async () => {
  const fake = fakeRegistries();

  const error = await withClient(
    Effect.flatMap(Registry, (registry) => Effect.flip(registry.createSession({ repo: "pi" }))),
    fake,
  );

  expect(error.message).toBe('Workspace "default" has no repo "pi"');
});

it("rejects a repo name that is a path or an option, before it reaches the Workspace", async () => {
  for (const repo of ["..", "../x", "a/b", "-x", ".git", "a b"]) {
    const { text, calls } = await callRaw("createSession", { workspace: "cloudpid", repo });

    expect(text).toContain('"Failure"');
    expect(calls).toEqual([]);
  }
});

it("accepts the endpoints the browsers' push services give out", async () => {
  for (const endpoint of [
    "https://fcm.googleapis.com/fcm/send/abc",
    "https://updates.push.services.mozilla.com/wpush/v2/abc",
    "https://web.push.apple.com/QGx",
    "https://wns2-by3p.notify.windows.com/?token=abc",
  ]) {
    const { calls } = await callRaw("subscribePush", {
      subscription: { endpoint, keys: { p256dh: "k", auth: "a" } },
    });

    expect(calls, endpoint).toEqual(["subscribePush"]);
  }
});

it("reads a Workspace's own settings from its object, not the Registry", async () => {
  const fake = fakeRegistries();

  const state = await withClient(
    Effect.flatMap(Registry, (registry) =>
      registry
        .createWorkspace({ slug: "cloudpid" })
        .pipe(Effect.andThen(registry.getWorkspaceSettings({ workspace: "cloudpid" }))),
    ),
    fake,
  );

  expect(state.settings).toEqual(DEFAULT_WORKSPACE_SETTINGS);
  expect(fake.calls).toEqual(["createWorkspace", "readWorkspaceSettings"]);
});

it("saves a Workspace's settings in its object and answers the state in force", async () => {
  const fake = fakeRegistries();

  const state = await withClient(
    Effect.flatMap(Registry, (registry) =>
      registry.createWorkspace({ slug: "cloudpid" }).pipe(
        Effect.andThen(
          registry.updateWorkspaceSettings({
            workspace: "cloudpid",
            overrides: { instance: "standard-4", idleMinutes: 5 },
          }),
        ),
      ),
    ),
    fake,
  );

  expect(state.settings).toEqual({ instance: "standard-4", idleMinutes: 5 });
  expect(fake.saved.get("cloudpid")).toEqual({ instance: "standard-4", idleMinutes: 5 });
});

it("answers overrides a Workspace refuses as a WorkspaceError with its message", async () => {
  const error = await withClient(
    Effect.flatMap(Registry, (registry) =>
      registry
        .createWorkspace({ slug: "cloudpid" })
        .pipe(
          Effect.andThen(
            registry.updateWorkspaceSettings({ workspace: "cloudpid", overrides: null }),
          ),
        ),
    ).pipe(Effect.flip),
  );

  expect(error).toBeInstanceOf(WorkspaceError);
  expect(error.message).toBe("instance: Expected a string");
});

it("refuses the settings of a Workspace the Registry does not list, and touches no object", async () => {
  const fake = fakeRegistries();

  const error = await withClient(
    Effect.flatMap(Registry, (registry) =>
      Effect.flip(
        registry.updateWorkspaceSettings({ workspace: "typo", overrides: { idleMinutes: 5 } }),
      ),
    ),
    fake,
  );

  expect(error).toBeInstanceOf(WorkspaceError);
  expect(error.message).toContain("typo");
  expect(fake.saved.size).toBe(0);
  expect(fake.calls).not.toContain("writeWorkspaceSettings");

  const read = await withClient(
    Effect.flatMap(Registry, (registry) =>
      Effect.flip(registry.getWorkspaceSettings({ workspace: "typo" })),
    ),
    fake,
  );

  expect(read.message).toContain("typo");
  expect(fake.calls).not.toContain("readWorkspaceSettings");
});

it("lists the repos of a Workspace", async () => {
  const repos = await withClient(
    Effect.flatMap(Registry, (registry) => registry.listRepos({ workspace: "cloudpid" })),
  );

  expect(repos).toEqual(["pi"]);
});

it("clones a repo into a Workspace, registering it, under the name the repo has", async () => {
  const fake = fakeRegistries();

  const name = await withClient(
    Effect.flatMap(Registry, (registry) =>
      registry.cloneRepo({ workspace: "fresh", source: "octocat/Hello-World" }),
    ),
    fake,
  );

  expect(name).toBe("Hello-World");
  expect(fake.calls).toEqual(["createWorkspace", "clone"]);
  expect(fake.clones).toEqual([
    { slug: "fresh", url: "https://github.com/octocat/Hello-World.git", name: "Hello-World" },
  ]);
});

it("clones into the directory the owner names", async () => {
  const fake = fakeRegistries();

  const name = await withClient(
    Effect.flatMap(Registry, (registry) =>
      registry.cloneRepo({
        workspace: "cloudpid",
        source: "https://github.com/octocat/Hello-World",
        name: "hello",
      }),
    ),
    fake,
  );

  expect(name).toBe("hello");
  expect(fake.clones).toMatchObject([
    { url: "https://github.com/octocat/Hello-World", name: "hello" },
  ]);
});

it("refuses a clone source that is not a plain repo address, before it reaches the Workspace", async () => {
  const fake = fakeRegistries();

  const error = await withClient(
    Effect.flatMap(Registry, (registry) =>
      Effect.flip(registry.cloneRepo({ workspace: "cloudpid", source: "file:///etc" })),
    ),
    fake,
  );

  expect(error).toBeInstanceOf(WorkspaceError);
  expect(error.message).toContain("https");
  expect(fake.calls).toEqual([]);

  for (const name of ["..", "a/b", "-x"]) {
    const { text, calls } = await callRaw("cloneRepo", {
      workspace: "cloudpid",
      source: "octocat/Hello-World",
      name,
    });

    expect(text).toContain('"Failure"');
    expect(calls).toEqual([]);
  }
});

it("fails a clone that does not finish with git's message", async () => {
  const fake = fakeRegistries();

  fake.failClones("git clone failed (exit 128): fatal: repository not found");

  const error = await withClient(
    Effect.flatMap(Registry, (registry) =>
      Effect.flip(registry.cloneRepo({ workspace: "cloudpid", source: "octocat/missing" })),
    ),
    fake,
  );

  expect(error).toBeInstanceOf(WorkspaceError);
  expect(error.message).toBe(
    "Clone failed: git clone failed (exit 128): fatal: repository not found",
  );
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
