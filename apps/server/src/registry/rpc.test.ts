// @effect-diagnostics asyncFunction:off
import { DEFAULT_CONTAINER_SETTINGS, DEFAULT_SETTINGS, SettingsError } from "@cloudpid/config";
import {
  DEFAULT_ENVIRONMENT,
  EnvironmentError,
  RegistryRpcs,
  RPC_PATH,
  SessionActionError,
  SessionNotFound,
  workspaceDirectory,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as RpcClient from "effect/rpc/RpcClient";
import type { RpcClientError } from "effect/rpc/RpcClientError";
import type * as Schema from "effect/Schema";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import { expect, it } from "vitest";
import { isRegistryRpc } from "../routes.ts";
import type { WorkspaceObjects } from "../workspace/lifecycle.ts";
import type { RegistryMethods } from "./Registry.ts";
import { legacyCleanup, serveRegistryRpc, type SessionObjects } from "./rpc.ts";
import { SettingsUpdate } from "./settings.ts";
import type {
  EnvironmentNaming,
  EnvironmentRecord,
  LegacyObject,
  RepoChange,
  SessionRecord,
  SessionRefusal,
  WorkspaceRecord,
} from "./store.ts";

/** An in-memory Registry behind `getByName`, as the Worker's binding presents it. */
const fakeRegistries = () => {
  const sessions: SessionRecord[] = [];
  const workspaces: WorkspaceRecord[] = [];

  const environments: EnvironmentRecord[] = [
    { id: DEFAULT_ENVIRONMENT, name: "Default", repos: [], createdAt: 0 },
  ];
  /** The Container settings overrides saved per Environment. */

  const overridesOf = new Map<string, Schema.Json>();
  /** What is left from before Environments, to wipe. */
  const legacyObjects: LegacyObject[] = [];
  const names: string[] = [];
  /** The endpoints of the Web Push subscriptions kept. */
  const pushes = new Set<string>();
  /** The Registry methods called, in order. */
  const calls: string[] = [];

  /** Replace the first of `list` that `matches` with what `change` makes of it; the changed one, or null. */
  const replace = <A>(list: A[], matches: (item: A) => boolean, change: (item: A) => A) =>
    Option.getOrNull(
      Option.map(Arr.findFirstIndex(list, matches), (index) => {
        // SAFETY: the index was just found in `list`.
        const changed = change(list[index] as A);

        list.splice(index, 1, changed);

        return changed;
      }),
    );

  /** Remove the first of `list` that `matches`; says whether there was one. */
  const remove = <A>(list: A[], matches: (item: A) => boolean) =>
    Option.match(Arr.findFirstIndex(list, matches), {
      onNone: () => false,
      onSome: (index) => {
        list.splice(index, 1);

        return true;
      },
    });

  const setArchived = (id: string, archivedAt: number | null, call: string) =>
    Effect.sync(() => {
      calls.push(call);

      return replace(
        sessions,
        (session) => session.id === id,
        (session): SessionRecord => ({ ...session, archivedAt }),
      );
    });

  /** Whether `name` is another Environment's, whatever the case. */
  const nameTaken = (name: string, id: string) =>
    Arr.some(
      environments,
      (other) => other.id !== id && other.name.toLowerCase() === name.toLowerCase(),
    );

  /** The Sessions whose object fails every call, with the message it fails with. */
  const brokenSessions = new Map<string, string>();

  /** An object that throws, or cannot be reached, is a defect of the call. */
  const sessionCall = (call: string, id: string) =>
    Effect.suspend(() => {
      calls.push(`${call}:${id}`);

      const broken = brokenSessions.get(id);

      return broken === undefined ? Effect.void : Effect.die(new Error(broken));
    });

  /** The objects behind the Sessions: what was asked of each, in `calls`. */
  const sessionObjects: SessionObjects = {
    stop: (id) => sessionCall("stop", id),
    destroy: (id) => sessionCall("destroy", id),
  };

  /** Runs the next times a Workspace's object is wiped: what happens meanwhile. */
  let duringDestroy: Array<() => void> = [];

  /** Why the Workspace objects' calls fail, if they do. */
  let workspaceFails: string | undefined;

  const workspaceCall = (call: string, name: string) => {
    calls.push(`${call}:${name}`);

    return workspaceFails === undefined
      ? Promise.resolve()
      : Promise.reject(new Error(workspaceFails));
  };

  /** The objects behind the Workspaces, by object name. */
  const workspaceObjects: WorkspaceObjects = {
    destroy: (name) => {
      const result = workspaceCall("destroyWorkspace", name);

      duringDestroy.shift()?.();

      return result;
    },
    restartContainer: (name) => workspaceCall("restartContainer", name),
  };

  /** Runs once, when the next Registry `createSession` is called: what happens just before it is answered. */
  let beforeCreate: (() => void) | undefined;

  /** The work the endpoint handed to `background`, not yet run. */
  const queued: Array<Effect.Effect<void>> = [];

  const registry = {
    createSession: ({ title, workspace }) =>
      Effect.sync((): SessionRecord | SessionRefusal => {
        calls.push("createSession");
        beforeCreate?.();
        beforeCreate = undefined;

        let record: WorkspaceRecord | undefined;

        if (workspace.kind === "existing") {
          record = Arr.findFirst(workspaces, (held) => held.id === workspace.id).pipe(
            Option.getOrUndefined,
          );

          if (record === undefined) return { refused: "no-workspace" };
        } else {
          const environment = Arr.findFirst(
            environments,
            (held) => held.id === workspace.environment,
          );

          if (Option.isNone(environment)) return { refused: "no-environment" };

          const id = String(workspaces.length + 1).padStart(8, "0");
          const branch = workspace.branch ?? `cloudpid/${id}`;

          const taken = Arr.findFirst(
            workspaces,
            (held) => held.environment === workspace.environment && held.branch === branch,
          );

          if (Option.isSome(taken)) return { refused: "branch-taken", workspace: taken.value.id };

          const repoNames = Arr.map(environment.value.repos, (repo) => repo.name);

          record = {
            id,
            environment: workspace.environment,
            branch,
            base: workspace.base ?? null,
            repos: repoNames,
            directory: workspaceDirectory(repoNames),
            createdAt: 1,
          };
          workspaces.unshift(record);
        }

        const created: SessionRecord = {
          id: `session-${sessions.length + 1}`,
          title: title ?? null,
          titleSource: title === undefined ? null : "owner",
          environment: record.environment,
          workspace: record.id,
          status: "idle",
          createdAt: 1,
          updatedAt: 1,
          archivedAt: null,
        };

        sessions.unshift(created);

        return created;
      }),
    listSessions: () => Effect.sync(() => [...sessions]),
    getSession: ({ id }) =>
      Effect.sync(() => Option.getOrNull(Arr.findFirst(sessions, (session) => session.id === id))),
    archiveSession: ({ id }) => setArchived(id, 7, "archiveSession"),
    unarchiveSession: ({ id }) => setArchived(id, null, "unarchiveSession"),
    deleteSession: ({ id }) =>
      Effect.sync(() => {
        calls.push(`deleteSession:${id}`);

        return remove(sessions, (session) => session.id === id);
      }),
    renameSession: ({ id, title }) =>
      Effect.sync(() => {
        calls.push("renameSession");

        const found = Arr.findFirst(sessions, (session) => session.id === id);

        if (Option.isNone(found)) return null;

        const renamed: SessionRecord = { ...found.value, title, titleSource: "owner" };

        sessions.splice(sessions.indexOf(found.value), 1, renamed);

        return renamed;
      }),
    setSessionStatus: () => Effect.void,
    setGeneratedTitle: () => Effect.succeed(false),
    createEnvironment: ({ name }) =>
      Effect.sync((): EnvironmentNaming => {
        calls.push("createEnvironment");

        if (nameTaken(name, "")) return { status: "taken" };

        const environment: EnvironmentRecord = {
          id: String(environments.length).padStart(8, "0"),
          name,
          repos: [],
          createdAt: environments.length,
        };

        environments.unshift(environment);

        return { status: "named", environment };
      }),
    getEnvironment: ({ id }) =>
      Effect.sync(() => Option.getOrNull(Arr.findFirst(environments, (item) => item.id === id))),
    listEnvironments: () => Effect.sync(() => [...environments]),
    renameEnvironment: ({ id, name }) =>
      Effect.sync((): EnvironmentNaming => {
        calls.push("renameEnvironment");

        if (nameTaken(name, id)) return { status: "taken" };

        const renamed = replace(
          environments,
          (item) => item.id === id,
          (item): EnvironmentRecord => ({ ...item, name }),
        );

        return renamed === null ? { status: "missing" } : { status: "named", environment: renamed };
      }),
    deleteEnvironment: ({ id }) =>
      Effect.sync(() => {
        calls.push(`deleteEnvironment:${id}`);

        if (Arr.some(workspaces, (workspace) => workspace.environment === id)) {
          return "in-use" as const;
        }

        return remove(environments, (item) => item.id === id)
          ? ("deleted" as const)
          : ("missing" as const);
      }),
    addRepo: ({ environment, name, url }) =>
      Effect.sync((): RepoChange => {
        calls.push("addRepo");

        const found = Arr.findFirst(environments, (item) => item.id === environment);

        if (Option.isNone(found)) return "missing";

        if (Arr.some(found.value.repos, (repo) => repo.name === name)) return "taken";

        replace(
          environments,
          (item) => item.id === environment,
          (item): EnvironmentRecord => ({ ...item, repos: [...item.repos, { name, url }] }),
        );

        return "changed";
      }),
    removeRepo: ({ environment, name }) =>
      Effect.sync((): RepoChange => {
        calls.push("removeRepo");

        const found = Arr.findFirst(environments, (item) => item.id === environment);

        if (Option.isNone(found)) return "missing";

        if (!Arr.some(found.value.repos, (repo) => repo.name === name)) return "absent";

        replace(
          environments,
          (item) => item.id === environment,
          (item): EnvironmentRecord => ({
            ...item,
            repos: Arr.filter(item.repos, (repo) => repo.name !== name),
          }),
        );

        return "changed";
      }),
    getEnvironmentSettings: ({ environment }) =>
      Effect.sync(() => {
        if (!Arr.some(environments, (item) => item.id === environment)) return null;

        const overrides = overridesOf.get(environment) ?? {};

        return {
          // SAFETY: the tests only save overrides of the settings' own shape.
          settings: { ...DEFAULT_CONTAINER_SETTINGS, ...(overrides as object) },
          overrides,
        };
      }),
    updateEnvironmentSettings: ({ environment, overrides }) =>
      Effect.sync(() => {
        calls.push("updateEnvironmentSettings");

        if (!Arr.some(environments, (item) => item.id === environment)) {
          return { status: "missing" as const };
        }

        if (overrides === null) {
          return { status: "rejected" as const, message: "idleMinutes: Expected a number" };
        }

        overridesOf.set(environment, overrides);

        return {
          status: "saved" as const,
          // SAFETY: the tests only save overrides of the settings' own shape.
          state: {
            settings: { ...DEFAULT_CONTAINER_SETTINGS, ...(overrides as object) },
            overrides,
          },
        };
      }),
    getWorkspace: ({ id }) =>
      Effect.sync(() =>
        Option.getOrNull(Arr.findFirst(workspaces, (workspace) => workspace.id === id)),
      ),
    getWorkspaceSetup: ({ id }) =>
      Effect.sync(() => {
        const found = Arr.findFirst(workspaces, (workspace) => workspace.id === id);

        if (Option.isNone(found)) return null;

        const { environment, branch, base } = found.value;

        return {
          id,
          environment,
          branch,
          base,
          repos: [],
          settings: overridesOf.get(environment) ?? {},
        };
      }),
    listWorkspaces: () => Effect.sync(() => [...workspaces]),
    deleteWorkspace: ({ id }) =>
      Effect.sync(() => {
        calls.push(`deleteWorkspace:${id}`);

        if (Arr.some(sessions, (session) => session.workspace === id)) return "in-use" as const;

        return remove(workspaces, (workspace) => workspace.id === id)
          ? ("deleted" as const)
          : ("missing" as const);
      }),
    takeLegacy: ({ limit }) =>
      Effect.sync(() => {
        calls.push("takeLegacy");

        return legacyObjects.slice(0, limit);
      }),
    forgetLegacy: (object) =>
      Effect.sync(() => {
        calls.push(`forgetLegacy:${object.kind}:${object.id}`);
        remove(legacyObjects, (held) => held.kind === object.kind && held.id === object.id);
      }),
    getSettings: () =>
      Effect.sync(() => {
        calls.push("getSettings");

        return { settings: DEFAULT_SETTINGS, overrides: {} };
      }),
    getPush: ({ endpoint }) =>
      Effect.sync(() => {
        calls.push("getPush");

        return { publicKey: "PUBLIC", subscribed: endpoint !== undefined && pushes.has(endpoint) };
      }),
    subscribePush: ({ subscription }) =>
      Effect.sync(() => {
        calls.push("subscribePush");
        pushes.add(subscription.endpoint);
      }),
    unsubscribePush: ({ endpoint }) =>
      Effect.sync(() => {
        calls.push("unsubscribePush");
        pushes.delete(endpoint);
      }),
    notify: () => Effect.void,
    updateSettings: ({ overrides }) =>
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
  } satisfies RegistryMethods;

  return {
    names,
    calls,
    sessions,
    workspaces,
    environments,
    sessionObjects,
    workspaceObjects,
    breakSession: (id: string, message: string) => {
      brokenSessions.set(id, message);
    },
    /** Register the Session `make` gives while each of the next `times` Workspace objects is wiped, as a client starting one then would. */
    startDuringDestroy: (make: () => SessionRecord, times = 1) => {
      duringDestroy = Arr.makeBy(times, () => () => {
        sessions.push(make());
      });
    },
    /** Run `change` as the next `createSession` reaches the Registry, before it looks at what it is asked for. */
    beforeCreate: (change: () => void) => {
      beforeCreate = change;
    },
    /** Fail the Workspace objects' calls with `message`. */
    failWorkspace: (message: string) => {
      workspaceFails = message;
    },
    /** The objects left from before Environments. */
    legacyObjects,
    /** What `legacy` ran: the cleanup the endpoint starts after a Session list. */
    legacy: Effect.sync(() => {
      calls.push("legacy");
    }),
    /** The work handed to `background` is run when the test says so. */
    background: (effect: Effect.Effect<void>) =>
      Effect.sync(() => {
        queued.push(effect);
      }),
    /** Run the work handed to `background` so far. */
    runBackground: async () => {
      for (const effect of queued.splice(0)) await Effect.runPromise(effect);
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

    return serveRegistryRpc(fake.registries, {
      workspaces: fake.workspaceObjects,
      sessions: fake.sessionObjects,
      legacy: fake.legacy,
      background: fake.background,
    }).pipe(
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
    Registry.pipe(
      Effect.flatMap((registry) => registry.renameSession({ id: "ghost", title: "Nope" })),
      Effect.flip,
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

/** A client of the endpoint, as `withClient` gives it. */
const call = <A, E>(
  fake: ReturnType<typeof fakeRegistries>,
  use: (registry: Registry["Service"]) => Effect.Effect<A, E>,
) => withClient(Effect.flatMap(Registry, use), fake);

/** The calls that reached a Session's or a Workspace's object, or forgot or archived a record, in order. */
const lifecycle = (fake: ReturnType<typeof fakeRegistries>) =>
  Arr.filter(fake.calls, (name) =>
    /^(stop|destroy|destroyWorkspace|restartContainer|deleteSession|deleteWorkspace|deleteEnvironment):|^(archive|unarchive)Session$/.test(
      name,
    ),
  );

/** Make an Environment named `name`; its id. */
const makeEnvironment = (fake: ReturnType<typeof fakeRegistries>, name: string) =>
  call(fake, (registry) => registry.createEnvironment({ name })).then((made) => made.id);

it("creates a Session in a new Workspace of the default Environment, on its own branch", async () => {
  const fake = fakeRegistries();

  const created = await call(fake, (registry) => registry.createSession({}));
  const [workspace] = await call(fake, (registry) => registry.listWorkspaces());

  expect(created).toMatchObject({ environment: DEFAULT_ENVIRONMENT, workspace: "00000001" });
  expect(workspace).toEqual({
    id: "00000001",
    environment: DEFAULT_ENVIRONMENT,
    branch: "cloudpid/00000001",
    base: null,
    repos: [],
    directory: "/workspace",
    createdAt: 1,
  });
});

it("makes a new Workspace of the Environment, branch and base the Session names", async () => {
  const fake = fakeRegistries();
  const environment = await makeEnvironment(fake, "Cloudpid");

  await call(fake, (registry) => registry.addRepo({ environment, source: "ian-pascoe/cloudpid" }));

  const created = await call(fake, (registry) =>
    registry.createSession({ environment, workspace: "new", branch: "feature/x", base: "dev" }),
  );

  expect(created).toMatchObject({ environment, workspace: "00000001" });
  expect(await call(fake, (registry) => registry.listWorkspaces())).toMatchObject([
    {
      environment,
      branch: "feature/x",
      base: "dev",
      repos: ["cloudpid"],
      directory: "/workspace/cloudpid",
    },
  ]);
});

it("makes every new Session a Workspace of its own", async () => {
  const fake = fakeRegistries();

  const first = await call(fake, (registry) => registry.createSession({}));
  const second = await call(fake, (registry) => registry.createSession({}));

  expect(second.workspace).not.toBe(first.workspace);
  expect(fake.workspaces).toHaveLength(2);
});

it("creates a Session in a Workspace that exists, which brings its Environment", async () => {
  const fake = fakeRegistries();
  const environment = await makeEnvironment(fake, "Cloudpid");
  const first = await call(fake, (registry) => registry.createSession({ environment }));

  const second = await call(fake, (registry) =>
    registry.createSession({ workspace: first.workspace }),
  );

  const third = await call(fake, (registry) =>
    registry.createSession({ workspace: first.workspace, environment }),
  );

  expect(second).toMatchObject({ environment, workspace: first.workspace });
  expect(third).toMatchObject({ environment, workspace: first.workspace });
  expect(fake.workspaces).toHaveLength(1);
});

it("refuses a Session in a Workspace of another Environment than the one it names", async () => {
  const fake = fakeRegistries();
  const first = await call(fake, (registry) => registry.createSession({}));
  const other = await makeEnvironment(fake, "Other");

  fake.calls.length = 0;

  const error = await call(fake, (registry) =>
    Effect.flip(registry.createSession({ workspace: first.workspace, environment: other })),
  );

  expect(error).toBeInstanceOf(EnvironmentError);
  expect(error.message).toBe(
    `Workspace "${first.workspace}" is in environment "${DEFAULT_ENVIRONMENT}"`,
  );
  expect(fake.calls).toEqual([]);
});

it("refuses a branch or a base for a Workspace that exists, before it reaches the Registry", async () => {
  const fake = fakeRegistries();
  const first = await call(fake, (registry) => registry.createSession({}));

  fake.calls.length = 0;

  for (const extra of [{ branch: "x" }, { base: "main" }]) {
    const error = await call(fake, (registry) =>
      Effect.flip(registry.createSession({ workspace: first.workspace, ...extra })),
    );

    expect(error).toBeInstanceOf(EnvironmentError);
    expect(error.message).toBe("A branch and a base are only for a new workspace");
  }

  expect(fake.calls).toEqual([]);
});

it("refuses a Session in a Workspace the Registry does not list", async () => {
  const fake = fakeRegistries();

  const error = await call(fake, (registry) =>
    Effect.flip(registry.createSession({ workspace: "deadbeef" })),
  );

  expect(error).toBeInstanceOf(EnvironmentError);
  expect(error.message).toBe('No workspace "deadbeef"');
  expect(fake.calls).toEqual([]);
});

it("says so when the Workspace is removed just before the Session is registered in it", async () => {
  const fake = fakeRegistries();
  const first = await call(fake, (registry) => registry.createSession({}));

  fake.beforeCreate(() => {
    fake.workspaces.length = 0;
  });

  const error = await call(fake, (registry) =>
    Effect.flip(registry.createSession({ workspace: first.workspace })),
  );

  expect(error.message).toBe("That workspace does not exist any more");
});

it("refuses a Session in an Environment the Registry does not list", async () => {
  const fake = fakeRegistries();

  const error = await call(fake, (registry) =>
    Effect.flip(registry.createSession({ environment: "0000beef" })),
  );

  expect(error).toBeInstanceOf(EnvironmentError);
  expect(error.message).toBe('Environment "0000beef" does not exist');
  expect(fake.workspaces).toEqual([]);
});

it("refuses a new Workspace on a branch another Workspace of the Environment is on, naming it", async () => {
  const fake = fakeRegistries();

  await call(fake, (registry) => registry.createSession({ branch: "feature" }));

  const error = await call(fake, (registry) =>
    Effect.flip(registry.createSession({ branch: "feature" })),
  );

  expect(error.message).toBe(
    'Workspace "00000001" is already on branch feature: start a session in it instead',
  );
  expect(fake.workspaces).toHaveLength(1);
  expect(fake.sessions).toHaveLength(1);
});

it("rejects an Environment, Workspace or branch that is not one, before it reaches the Registry", async () => {
  for (const payload of [
    { environment: "Not An Id" },
    { workspace: "Not-An-Id" },
    { workspace: "123" },
    { branch: "a..b" },
    { branch: "-x" },
    { base: "HEAD" },
  ]) {
    const { text, calls } = await callRaw("createSession", payload);

    expect(text, JSON.stringify(payload)).toContain('"Failure"');
    expect(calls).toEqual([]);
  }
});

it("deletes a Session without touching its Workspace", async () => {
  const fake = fakeRegistries();
  const session = await call(fake, (registry) => registry.createSession({}));

  fake.calls.length = 0;

  await call(fake, (registry) => registry.deleteSession({ id: session.id }));

  expect(lifecycle(fake)).toEqual([`destroy:${session.id}`, `deleteSession:${session.id}`]);
  expect(await call(fake, (registry) => registry.listSessions())).toEqual([]);
  expect(await call(fake, (registry) => registry.listWorkspaces())).toMatchObject([
    { id: session.workspace },
  ]);
});

it("lists the default Environment, and the ones created, newest first", async () => {
  const fake = fakeRegistries();

  const made = await call(fake, (registry) => registry.createEnvironment({ name: "Cloudpid" }));
  const listed = await call(fake, (registry) => registry.listEnvironments());

  expect(made).toEqual({ id: "00000001", name: "Cloudpid", repos: [], createdAt: 1 });
  expect(Arr.map(listed, (environment) => environment.id)).toEqual([
    "00000001",
    DEFAULT_ENVIRONMENT,
  ]);
});

it("trims an Environment name on the server, and rejects one that is blank or too long", async () => {
  const { text } = await callRaw("createEnvironment", { name: "  Cloudpid \n" });

  expect(JSON.parse(text)).toMatchObject([{ exit: { value: { name: "Cloudpid" } } }]);

  for (const name of ["   ", "a".repeat(81)]) {
    const rejected = await callRaw("createEnvironment", { name });

    expect(rejected.text).toContain('"Failure"');
    expect(rejected.calls).toEqual([]);
  }
});

it("refuses an Environment name another has in any case", async () => {
  const fake = fakeRegistries();

  const error = await call(fake, (registry) =>
    Effect.flip(registry.createEnvironment({ name: "DEFAULT" })),
  );

  expect(error).toBeInstanceOf(EnvironmentError);
  expect(error.message).toBe('Another environment is already named "DEFAULT"');
});

it("renames an Environment, and refuses a name another has or an Environment that is not listed", async () => {
  const fake = fakeRegistries();
  const id = await makeEnvironment(fake, "Cloudpid");

  const renamed = await call(fake, (registry) =>
    registry.renameEnvironment({ environment: id, name: "Pi" }),
  );

  const taken = await call(fake, (registry) =>
    Effect.flip(registry.renameEnvironment({ environment: id, name: "default" })),
  );

  const missing = await call(fake, (registry) =>
    Effect.flip(registry.renameEnvironment({ environment: "0000beef", name: "Anything" })),
  );

  expect(renamed).toMatchObject({ id, name: "Pi" });
  expect(taken.message).toBe('Another environment is already named "default"');
  expect(missing).toBeInstanceOf(EnvironmentError);
  expect(missing.message).toBe('Environment "0000beef" does not exist');
});

it("deletes an Environment: every Workspace made from it, with its Sessions (archived too), then its record", async () => {
  const fake = fakeRegistries();
  const id = await makeEnvironment(fake, "Cloudpid");
  const elsewhere = await call(fake, (registry) => registry.createSession({}));
  const first = await call(fake, (registry) => registry.createSession({ environment: id }));
  const second = await call(fake, (registry) => registry.createSession({ environment: id }));

  const sharing = await call(fake, (registry) =>
    registry.createSession({ workspace: first.workspace }),
  );

  await call(fake, (registry) => registry.archiveSession({ id: sharing.id }));
  fake.calls.length = 0;

  await call(fake, (registry) => registry.deleteEnvironment({ environment: id }));

  // Newest Workspace first; in each, its Sessions newest first, then its object, then its record.
  expect(lifecycle(fake)).toEqual([
    `destroy:${second.id}`,
    `deleteSession:${second.id}`,
    `destroyWorkspace:ws:${second.workspace}`,
    `deleteWorkspace:${second.workspace}`,
    `destroy:${sharing.id}`,
    `deleteSession:${sharing.id}`,
    `destroy:${first.id}`,
    `deleteSession:${first.id}`,
    `destroyWorkspace:ws:${first.workspace}`,
    `deleteWorkspace:${first.workspace}`,
    `deleteEnvironment:${id}`,
  ]);
  expect(await call(fake, (registry) => registry.listSessions())).toEqual([elsewhere]);
  expect(Arr.map(await call(fake, (registry) => registry.listWorkspaces()), (w) => w.id)).toEqual([
    elsewhere.workspace,
  ]);
  expect(
    Arr.map(await call(fake, (registry) => registry.listEnvironments()), (item) => item.id),
  ).toEqual([DEFAULT_ENVIRONMENT]);
});

it("deletes an Environment with no Workspaces without waking an object", async () => {
  const fake = fakeRegistries();
  const id = await makeEnvironment(fake, "Empty");

  await call(fake, (registry) => registry.deleteEnvironment({ environment: id }));

  expect(lifecycle(fake)).toEqual([`deleteEnvironment:${id}`]);
});

it("refuses to delete the default Environment, and touches nothing", async () => {
  const fake = fakeRegistries();

  await call(fake, (registry) => registry.createSession({}));
  fake.calls.length = 0;

  const error = await call(fake, (registry) =>
    Effect.flip(registry.deleteEnvironment({ environment: DEFAULT_ENVIRONMENT })),
  );

  expect(error).toBeInstanceOf(EnvironmentError);
  expect(error.message).toBe("The default environment cannot be deleted");
  expect(fake.calls).toEqual([]);
});

it("refuses to delete an Environment the Registry does not list, and touches no object", async () => {
  const fake = fakeRegistries();

  const error = await call(fake, (registry) =>
    Effect.flip(registry.deleteEnvironment({ environment: "0000beef" })),
  );

  expect(error.message).toBe('Environment "0000beef" does not exist');
  expect(lifecycle(fake)).toEqual([]);
});

it("stops an Environment delete at a Session that cannot be wiped, keeping what is left listed", async () => {
  const fake = fakeRegistries();
  const id = await makeEnvironment(fake, "Cloudpid");
  const session = await call(fake, (registry) => registry.createSession({ environment: id }));

  fake.breakSession(session.id, "storage error");
  fake.calls.length = 0;

  const error = await call(fake, (registry) =>
    Effect.flip(registry.deleteEnvironment({ environment: id })),
  );

  expect(error).toBeInstanceOf(EnvironmentError);
  expect(error.message).toContain("storage error");
  expect(error.message).toContain("The environment and its remaining workspaces are kept.");
  expect(lifecycle(fake)).toEqual([`destroy:${session.id}`]);
  expect(fake.environments).toHaveLength(2);
  expect(fake.workspaces).toHaveLength(1);
});

it("removes a Workspace: every Session in it, archived ones too, then its object, then its record", async () => {
  const fake = fakeRegistries();
  const elsewhere = await call(fake, (registry) => registry.createSession({}));
  const first = await call(fake, (registry) => registry.createSession({}));

  const second = await call(fake, (registry) =>
    registry.createSession({ workspace: first.workspace }),
  );

  await call(fake, (registry) => registry.archiveSession({ id: first.id }));
  fake.calls.length = 0;

  await call(fake, (registry) => registry.removeWorkspace({ id: first.workspace }));

  expect(lifecycle(fake)).toEqual([
    `destroy:${second.id}`,
    `deleteSession:${second.id}`,
    `destroy:${first.id}`,
    `deleteSession:${first.id}`,
    `destroyWorkspace:ws:${first.workspace}`,
    `deleteWorkspace:${first.workspace}`,
  ]);
  expect(await call(fake, (registry) => registry.listSessions())).toEqual([elsewhere]);
  expect(Arr.map(await call(fake, (registry) => registry.listWorkspaces()), (w) => w.id)).toEqual([
    elsewhere.workspace,
  ]);
});

it("removes a Workspace that has no Sessions left", async () => {
  const fake = fakeRegistries();
  const session = await call(fake, (registry) => registry.createSession({}));

  await call(fake, (registry) => registry.deleteSession({ id: session.id }));
  fake.calls.length = 0;

  await call(fake, (registry) => registry.removeWorkspace({ id: session.workspace }));

  expect(lifecycle(fake)).toEqual([
    `destroyWorkspace:ws:${session.workspace}`,
    `deleteWorkspace:${session.workspace}`,
  ]);
  expect(fake.workspaces).toEqual([]);
});

it("deletes a Session started in a Workspace while it was removed, before its record goes", async () => {
  const fake = fakeRegistries();
  const first = await call(fake, (registry) => registry.createSession({}));

  fake.startDuringDestroy(() => ({ ...first, id: "late" }));
  fake.calls.length = 0;

  await call(fake, (registry) => registry.removeWorkspace({ id: first.workspace }));

  const object = `destroyWorkspace:ws:${first.workspace}`;
  const record = `deleteWorkspace:${first.workspace}`;

  expect(lifecycle(fake)).toEqual([
    `destroy:${first.id}`,
    `deleteSession:${first.id}`,
    object,
    record,
    "destroy:late",
    "deleteSession:late",
    object,
    record,
  ]);
  expect(fake.sessions).toEqual([]);
  expect(fake.workspaces).toEqual([]);
});

it("gives up on a Workspace Sessions keep starting in, keeping it listed", async () => {
  const fake = fakeRegistries();
  const first = await call(fake, (registry) => registry.createSession({}));
  let started = 0;

  fake.startDuringDestroy(() => ({ ...first, id: `late-${started++}` }), 10);

  const error = await call(fake, (registry) =>
    Effect.flip(registry.removeWorkspace({ id: first.workspace })),
  );

  expect(error).toBeInstanceOf(EnvironmentError);
  expect(error.message).toContain("kept starting");
  expect(fake.workspaces).toHaveLength(1);
});

it("stops a Workspace removal at a Session that cannot be wiped, before its files", async () => {
  const fake = fakeRegistries();
  const session = await call(fake, (registry) => registry.createSession({}));

  fake.breakSession(session.id, "storage error");
  fake.calls.length = 0;

  const error = await call(fake, (registry) =>
    Effect.flip(registry.removeWorkspace({ id: session.workspace })),
  );

  expect(error).toBeInstanceOf(EnvironmentError);
  expect(error.message).toContain("storage error");
  expect(error.message).toContain("The workspace and its remaining sessions are kept.");
  expect(lifecycle(fake)).toEqual([`destroy:${session.id}`]);
  expect(fake.sessions).toHaveLength(1);
  expect(fake.workspaces).toHaveLength(1);
});

it("keeps a Workspace record whose object could not be wiped, with its Sessions already gone", async () => {
  const fake = fakeRegistries();
  const session = await call(fake, (registry) => registry.createSession({}));

  fake.failWorkspace("storage error");

  const error = await call(fake, (registry) =>
    Effect.flip(registry.removeWorkspace({ id: session.workspace })),
  );

  expect(error).toBeInstanceOf(EnvironmentError);
  expect(error.message).toBe("Could not delete the workspace's files: storage error");
  expect(fake.sessions).toEqual([]);
  expect(fake.workspaces).toHaveLength(1);
});

it("refuses to remove or restart a Workspace the Registry does not list, and touches no object", async () => {
  const fake = fakeRegistries();

  const removal = await call(fake, (registry) =>
    Effect.flip(registry.removeWorkspace({ id: "deadbeef" })),
  );

  const restart = await call(fake, (registry) =>
    Effect.flip(registry.restartContainer({ workspace: "deadbeef" })),
  );

  expect(removal).toBeInstanceOf(EnvironmentError);
  expect(removal.message).toBe('No workspace "deadbeef"');
  expect(restart.message).toBe('No workspace "deadbeef"');
  expect(lifecycle(fake)).toEqual([]);
});

it("restarts a Workspace's Container by its object's name, keeping its Sessions", async () => {
  const fake = fakeRegistries();
  const session = await call(fake, (registry) => registry.createSession({}));

  fake.calls.length = 0;

  await call(fake, (registry) => registry.restartContainer({ workspace: session.workspace }));

  expect(lifecycle(fake)).toEqual([`restartContainer:ws:${session.workspace}`]);
  expect(await call(fake, (registry) => registry.listSessions())).toEqual([session]);
});

it("fails a Container restart the Workspace could not do with its message", async () => {
  const fake = fakeRegistries();
  const session = await call(fake, (registry) => registry.createSession({}));

  fake.failWorkspace("container is gone");

  const error = await call(fake, (registry) =>
    Effect.flip(registry.restartContainer({ workspace: session.workspace })),
  );

  expect(error).toBeInstanceOf(EnvironmentError);
  expect(error.message).toBe("Could not restart the Container: container is gone");
});

it("adds a Repo to an Environment from owner/repo, answering the directory it is cloned into", async () => {
  const fake = fakeRegistries();
  const environment = await makeEnvironment(fake, "Cloudpid");

  const name = await call(fake, (registry) =>
    registry.addRepo({ environment, source: "ian-pascoe/cloudpid" }),
  );

  const url = await call(fake, (registry) =>
    registry.addRepo({ environment, source: "https://example.com/team/lib.git" }),
  );

  expect(name).toBe("cloudpid");
  expect(url).toBe("lib");
  expect(fake.environments[0]?.repos).toEqual([
    { name: "cloudpid", url: "https://github.com/ian-pascoe/cloudpid.git" },
    { name: "lib", url: "https://example.com/team/lib.git" },
  ]);
});

it("adds a Repo under the directory name the owner gives it", async () => {
  const fake = fakeRegistries();

  const name = await call(fake, (registry) =>
    registry.addRepo({ environment: DEFAULT_ENVIRONMENT, source: "o/app", name: "frontend" }),
  );

  expect(name).toBe("frontend");
  expect(fake.environments[0]?.repos).toEqual([
    { name: "frontend", url: "https://github.com/o/app.git" },
  ]);
});

it("refuses a Repo whose directory name the Environment has, asking for another", async () => {
  const fake = fakeRegistries();

  await call(fake, (registry) =>
    registry.addRepo({ environment: DEFAULT_ENVIRONMENT, source: "o/app" }),
  );

  const error = await call(fake, (registry) =>
    Effect.flip(registry.addRepo({ environment: DEFAULT_ENVIRONMENT, source: "p/app" })),
  );

  expect(error).toBeInstanceOf(EnvironmentError);
  expect(error.message).toBe("The environment already has a repo in app: name this one");
  expect(fake.environments[0]?.repos).toHaveLength(1);

  // The owner's own name gets round it.
  await call(fake, (registry) =>
    registry.addRepo({ environment: DEFAULT_ENVIRONMENT, source: "p/app", name: "app-2" }),
  );
  expect(fake.environments[0]?.repos).toHaveLength(2);
});

it("refuses a source that is not a plain repo address before it reaches the Registry", async () => {
  const fake = fakeRegistries();

  for (const source of [
    "",
    "not a repo",
    "file:///etc/passwd",
    "ssh://git@github.com/o/r",
    "https://user:pw@github.com/o/r",
    "https://localhost/o/r",
    "--upload-pack=x",
  ]) {
    const error = await call(fake, (registry) =>
      Effect.flip(registry.addRepo({ environment: DEFAULT_ENVIRONMENT, source })),
    );

    expect(error, source).toBeInstanceOf(EnvironmentError);
  }

  expect(fake.calls).toEqual([]);
});

it("refuses a Repo for an Environment the Registry does not list", async () => {
  const error = await call(fakeRegistries(), (registry) =>
    Effect.flip(registry.addRepo({ environment: "0000beef", source: "o/app" })),
  );

  expect(error.message).toBe('Environment "0000beef" does not exist');
});

it("rejects a directory name that is a path or an option, before it reaches the Registry", async () => {
  for (const name of ["..", "../x", "a/b", "-x", ".git", "a b"]) {
    const { text, calls } = await callRaw("addRepo", {
      environment: DEFAULT_ENVIRONMENT,
      source: "o/app",
      name,
    });

    expect(text, name).toContain('"Failure"');
    expect(calls).toEqual([]);
  }

  const removal = await callRaw("removeRepo", { environment: DEFAULT_ENVIRONMENT, repo: "../x" });

  expect(removal.text).toContain('"Failure"');
  expect(removal.calls).toEqual([]);
});

it("removes a Repo from an Environment, keeping the others", async () => {
  const fake = fakeRegistries();

  await call(fake, (registry) =>
    registry.addRepo({ environment: DEFAULT_ENVIRONMENT, source: "o/app" }),
  );
  await call(fake, (registry) =>
    registry.addRepo({ environment: DEFAULT_ENVIRONMENT, source: "o/pi" }),
  );
  await call(fake, (registry) =>
    registry.removeRepo({ environment: DEFAULT_ENVIRONMENT, repo: "app" }),
  );

  expect(Arr.map(fake.environments[0]?.repos ?? [], (repo) => repo.name)).toEqual(["pi"]);
});

it("refuses to remove a Repo the Environment does not have, or of an Environment not listed", async () => {
  const fake = fakeRegistries();

  const absent = await call(fake, (registry) =>
    Effect.flip(registry.removeRepo({ environment: DEFAULT_ENVIRONMENT, repo: "ghost" })),
  );

  const missing = await call(fake, (registry) =>
    Effect.flip(registry.removeRepo({ environment: "0000beef", repo: "ghost" })),
  );

  expect(absent).toBeInstanceOf(EnvironmentError);
  expect(absent.message).toBe('The environment has no repo "ghost"');
  expect(missing.message).toBe('Environment "0000beef" does not exist');
});

it("reads an Environment's Container settings from the Registry", async () => {
  const fake = fakeRegistries();

  const state = await call(fake, (registry) =>
    registry.getEnvironmentSettings({ environment: DEFAULT_ENVIRONMENT }),
  );

  expect(state).toEqual({ settings: DEFAULT_CONTAINER_SETTINGS, overrides: {} });
  expect(fake.names).toEqual(["registry"]);
});

it("saves an Environment's Container overrides and answers the settings in force", async () => {
  const fake = fakeRegistries();

  const saved = await call(fake, (registry) =>
    registry.updateEnvironmentSettings({
      environment: DEFAULT_ENVIRONMENT,
      overrides: { idleMinutes: 30 },
    }),
  );

  const read = await call(fake, (registry) =>
    registry.getEnvironmentSettings({ environment: DEFAULT_ENVIRONMENT }),
  );

  expect(saved).toMatchObject({ settings: { idleMinutes: 30 }, overrides: { idleMinutes: 30 } });
  expect(read).toEqual(saved);
});

it("fails overrides the Registry rejects with its readable message, saving nothing", async () => {
  const fake = fakeRegistries();

  const error = await call(fake, (registry) =>
    Effect.flip(
      registry.updateEnvironmentSettings({ environment: DEFAULT_ENVIRONMENT, overrides: null }),
    ),
  );

  expect(error).toBeInstanceOf(EnvironmentError);
  expect(error.message).toBe("idleMinutes: Expected a number");
  expect(
    await call(fake, (registry) =>
      registry.getEnvironmentSettings({ environment: DEFAULT_ENVIRONMENT }),
    ),
  ).toMatchObject({ overrides: {} });
});

it("refuses the settings of an Environment the Registry does not list", async () => {
  const fake = fakeRegistries();

  for (const attempt of [
    (registry: Registry["Service"]) =>
      Effect.flip(registry.getEnvironmentSettings({ environment: "0000beef" })),
    (registry: Registry["Service"]) =>
      Effect.flip(registry.updateEnvironmentSettings({ environment: "0000beef", overrides: {} })),
  ]) {
    const error = await call(fake, attempt);

    expect(error).toBeInstanceOf(EnvironmentError);
    expect(error.message).toBe('Environment "0000beef" does not exist');
  }
});

it("lists Workspaces of every Environment, newest first", async () => {
  const fake = fakeRegistries();
  const environment = await makeEnvironment(fake, "Cloudpid");

  await call(fake, (registry) => registry.createSession({}));
  await call(fake, (registry) => registry.createSession({ environment }));

  expect(
    Arr.map(await call(fake, (registry) => registry.listWorkspaces()), (w) => w.environment),
  ).toEqual([environment, DEFAULT_ENVIRONMENT]);
});

it("starts the legacy cleanup behind a Session list, after the answer", async () => {
  const fake = fakeRegistries();
  const session = await call(fake, (registry) => registry.createSession({}));

  expect(await call(fake, (registry) => registry.listSessions())).toEqual([session]);
  // Handed to the background, not run before the answer.
  expect(fake.calls).not.toContain("legacy");

  await fake.runBackground();

  expect(fake.calls).toContain("legacy");
});

it("starts the legacy cleanup with no other call", async () => {
  const fake = fakeRegistries();

  await call(fake, (registry) => registry.listEnvironments());
  await call(fake, (registry) => registry.listWorkspaces());
  await fake.runBackground();

  expect(fake.calls).not.toContain("legacy");
});

/** Run `legacyCleanup` over the fake once, with the levels and messages it logged. */
const cleanup = async (fake: ReturnType<typeof fakeRegistries>) => {
  const logged: string[] = [];

  const collector = Logger.make((options) => {
    logged.push(`${options.logLevel}: ${String(Arr.ensure(options.message)[0])}`);
  });

  await Effect.runPromise(
    legacyCleanup(fake.registries, {
      sessions: fake.sessionObjects,
      workspaces: fake.workspaceObjects,
    }).pipe(Effect.provideService(Logger.CurrentLoggers, new Set([collector]))),
  );

  return logged;
};

it("wipes what is left from before Environments: Session objects and Machines' Workspace objects, forgetting each", async () => {
  const fake = fakeRegistries();

  fake.legacyObjects.push(
    { kind: "session", id: "old-1" },
    { kind: "machine", id: "cloudpid" },
    { kind: "session", id: "old-2" },
  );

  expect(await cleanup(fake)).toEqual([]);

  expect(fake.calls).toEqual([
    "takeLegacy",
    "destroy:old-1",
    "forgetLegacy:session:old-1",
    // A Machine's object is named by its slug alone, not `ws:<id>`.
    "destroyWorkspace:cloudpid",
    "forgetLegacy:machine:cloudpid",
    "destroy:old-2",
    "forgetLegacy:session:old-2",
  ]);
  expect(fake.legacyObjects).toEqual([]);
});

it("logs an object it could not wipe and keeps it, going on with the rest", async () => {
  const fake = fakeRegistries();

  fake.legacyObjects.push(
    { kind: "session", id: "stuck" },
    { kind: "session", id: "fine" },
    { kind: "machine", id: "default" },
  );
  fake.breakSession("stuck", "unreachable");

  const logged = await cleanup(fake);

  expect(logged).toEqual(["Warn: Could not wipe the legacy session stuck"]);
  expect(fake.legacyObjects).toEqual([{ kind: "session", id: "stuck" }]);
  expect(fake.calls).toContain("forgetLegacy:session:fine");
  expect(fake.calls).toContain("forgetLegacy:machine:default");
  expect(fake.calls).not.toContain("forgetLegacy:session:stuck");
});

it("keeps a Machine's object it could not wipe", async () => {
  const fake = fakeRegistries();

  fake.legacyObjects.push({ kind: "machine", id: "cloudpid" });
  fake.failWorkspace("storage error");

  const logged = await cleanup(fake);

  expect(logged).toEqual(["Warn: Could not wipe the legacy machine cloudpid"]);
  expect(fake.legacyObjects).toEqual([{ kind: "machine", id: "cloudpid" }]);
});

it("wipes a batch of ten at a time", async () => {
  const fake = fakeRegistries();

  fake.legacyObjects.push(
    ...Arr.makeBy(12, (index): LegacyObject => ({ kind: "session", id: `old-${index}` })),
  );

  await cleanup(fake);

  expect(fake.legacyObjects).toEqual([
    { kind: "session", id: "old-10" },
    { kind: "session", id: "old-11" },
  ]);
});

it("does nothing more in this isolate once a run found nothing left", async () => {
  const fake = fakeRegistries();

  const wipe = legacyCleanup(fake.registries, {
    sessions: fake.sessionObjects,
    workspaces: fake.workspaceObjects,
  });

  await Effect.runPromise(wipe);
  await Effect.runPromise(wipe);

  // The second run did not ask the Registry.
  expect(fake.calls).toEqual(["takeLegacy"]);

  fake.calls.length = 0;
  fake.legacyObjects.push({ kind: "session", id: "late" });
  await Effect.runPromise(wipe);

  expect(fake.calls).toEqual([]);
  expect(fake.legacyObjects).toHaveLength(1);
});

it("archives a Session after stopping everything it runs, and unarchives it", async () => {
  const fake = fakeRegistries();
  const session = await call(fake, (registry) => registry.createSession({}));

  const archived = await call(fake, (registry) => registry.archiveSession({ id: session.id }));

  expect(archived).toEqual({ ...session, archivedAt: 7 });
  expect(lifecycle(fake)).toEqual([`stop:${session.id}`, "archiveSession"]);

  const restored = await call(fake, (registry) => registry.unarchiveSession({ id: session.id }));

  expect(restored).toEqual(session);
  expect(await call(fake, (registry) => registry.listSessions())).toEqual([session]);
});

it("leaves a Session unarchived when it cannot be stopped", async () => {
  const fake = fakeRegistries();
  const session = await call(fake, (registry) => registry.createSession({}));

  fake.breakSession(session.id, "object unreachable");

  const error = await call(fake, (registry) =>
    Effect.flip(registry.archiveSession({ id: session.id })),
  );

  expect(error).toBeInstanceOf(SessionActionError);
  expect(error.message).toContain("object unreachable");
  expect(await call(fake, (registry) => registry.listSessions())).toEqual([session]);
});

it("archives, unarchives and deletes no Session the Registry does not know, and wakes no object", async () => {
  const fake = fakeRegistries();

  for (const attempt of [
    (registry: Registry["Service"]) => Effect.flip(registry.archiveSession({ id: "ghost" })),
    (registry: Registry["Service"]) => Effect.flip(registry.unarchiveSession({ id: "ghost" })),
    (registry: Registry["Service"]) => Effect.flip(registry.deleteSession({ id: "ghost" })),
  ]) {
    const error = await call(fake, attempt);

    expect(error).toBeInstanceOf(SessionNotFound);
    expect(error.message).toContain("ghost");
  }

  expect(Arr.filter(fake.calls, (name) => /^(stop|destroy):/.test(name))).toEqual([]);
});

it("deletes a Session: wipes its object, then forgets it", async () => {
  const fake = fakeRegistries();
  const kept = await call(fake, (registry) => registry.createSession({}));
  const doomed = await call(fake, (registry) => registry.createSession({}));

  await call(fake, (registry) => registry.deleteSession({ id: doomed.id }));

  expect(lifecycle(fake)).toEqual([`destroy:${doomed.id}`, `deleteSession:${doomed.id}`]);
  expect(await call(fake, (registry) => registry.listSessions())).toEqual([kept]);
});

it("keeps a Session listed when its object could not be wiped, to try again", async () => {
  const fake = fakeRegistries();
  const session = await call(fake, (registry) => registry.createSession({}));

  fake.breakSession(session.id, "storage error");

  const error = await call(fake, (registry) =>
    Effect.flip(registry.deleteSession({ id: session.id })),
  );

  expect(error).toBeInstanceOf(SessionActionError);
  expect(error.message).toContain("storage error");
  expect(await call(fake, (registry) => registry.listSessions())).toEqual([session]);
});
