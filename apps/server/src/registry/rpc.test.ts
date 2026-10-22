// @effect-diagnostics asyncFunction:off
import {
  DEFAULT_SETTINGS,
  DEFAULT_WORKSPACE_SETTINGS,
  SettingsError,
  type WorkspaceSettings,
} from "@cloudpid/config";
import {
  RegistryRpcs,
  RPC_PATH,
  SessionActionError,
  SessionNotFound,
  WorkspaceError,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as RpcClient from "effect/rpc/RpcClient";
import type { RpcClientError } from "effect/rpc/RpcClientError";
import type * as Schema from "effect/Schema";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import { expect, it } from "vitest";
import { isRegistryRpc } from "../routes.ts";
import { serveRegistryRpc, type SessionObjects } from "./rpc.ts";
import { SettingsUpdate } from "./settings.ts";
import type { Repos } from "../workspace/repos.ts";
import type { WorkspaceObjects } from "../workspace/lifecycle.ts";
import type { WorkspaceSettingsRemote } from "../workspace/settings.ts";
import type { SessionRecord, WorkspaceRecord } from "./store.ts";

/** The overrides the fake saved, as the fields of the settings they replace. */
// SAFETY: the tests only save overrides of the settings' own shape.
const asSettings = (overrides: Schema.Json) => overrides as Partial<WorkspaceSettings>;

/** An in-memory Registry behind `getByName`, as the Worker's binding presents it. */
const fakeRegistries = () => {
  const sessions: SessionRecord[] = [];
  const workspaces: WorkspaceRecord[] = [{ slug: "default", name: "default", createdAt: 0 }];
  const names: string[] = [];
  /** The endpoints of the Web Push subscriptions kept. */
  const pushes = new Set<string>();
  /** The Registry methods called, in order. */
  const calls: string[] = [];

  const registerWorkspace = (slug: string): WorkspaceRecord =>
    Option.getOrElse(
      Arr.findFirst(workspaces, (workspace) => workspace.slug === slug),
      () => {
        const record: WorkspaceRecord = { slug, name: slug, createdAt: 1 };

        workspaces.push(record);

        return record;
      },
    );

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

  /** The Sessions whose object fails every call, with the message it fails with. */
  const brokenSessions = new Map<string, string>();

  /** The objects behind the Sessions: what was asked of each, in `calls`. */
  const sessionObjects: SessionObjects = {
    stop: (id) =>
      Effect.suspend(() => {
        calls.push(`stop:${id}`);

        const broken = brokenSessions.get(id);

        // An object that throws, or cannot be reached, is a defect of the call.
        return broken === undefined ? Effect.void : Effect.die(new Error(broken));
      }),
    destroy: (id) =>
      Effect.suspend(() => {
        calls.push(`destroy:${id}`);

        const broken = brokenSessions.get(id);

        // An object that throws, or cannot be reached, is a defect of the call.
        return broken === undefined ? Effect.void : Effect.die(new Error(broken));
      }),
  };

  /** Runs once, the next time a Workspace's object is wiped: what happens meanwhile. */
  let duringDestroy: (() => void) | undefined;

  /** The objects behind the Workspaces. */
  const workspaceObjects: WorkspaceObjects = {
    destroy: (slug) => {
      calls.push(`destroyWorkspace:${slug}`);
      duringDestroy?.();
      duringDestroy = undefined;

      return Promise.resolve();
    },
    clear: (slug) => {
      calls.push(`clearWorkspace:${slug}`);
      duringDestroy?.();
      duringDestroy = undefined;
      held.delete(slug);

      return Promise.resolve();
    },
    restartContainer: (slug) => {
      calls.push(`restartContainer:${slug}`);

      return workspaceFails === undefined
        ? Promise.resolve()
        : Promise.reject(new Error(workspaceFails));
    },
  };

  /** Why the next Workspace object call fails, if it does. */
  let workspaceFails: string | undefined;

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
        registerWorkspace(workspace ?? "default");

        const record: SessionRecord = {
          id: `session-${sessions.length + 1}`,
          title: title ?? null,
          titleSource: title === undefined ? null : "owner",
          workspace: workspace ?? "default",
          repo: repo ?? null,
          status: "idle",
          createdAt: 1,
          updatedAt: 1,
          archivedAt: null,
        };

        sessions.unshift(record);

        return record;
      }),
    listSessions: () => Effect.sync(() => [...sessions]),
    getSession: ({ id }: { id: string }) =>
      Effect.sync(() => Option.getOrNull(Arr.findFirst(sessions, (session) => session.id === id))),
    archiveSession: ({ id }: { id: string }) => setArchived(id, 7, "archiveSession"),
    unarchiveSession: ({ id }: { id: string }) => setArchived(id, null, "unarchiveSession"),
    deleteSession: ({ id }: { id: string }) =>
      Effect.sync(() => {
        calls.push(`deleteSession:${id}`);

        return remove(sessions, (session) => session.id === id);
      }),
    renameSession: ({ id, title }: { id: string; title: string }) =>
      Effect.sync(() => {
        calls.push("renameSession");

        const found = Arr.findFirst(sessions, (session) => session.id === id);

        if (Option.isNone(found)) return null;

        const renamed: SessionRecord = { ...found.value, title, titleSource: "owner" };

        sessions.splice(sessions.indexOf(found.value), 1, renamed);

        return renamed;
      }),
    createWorkspace: ({ slug }: { slug: string }) =>
      Effect.sync(() => {
        calls.push("createWorkspace");

        return registerWorkspace(slug);
      }),
    listWorkspaces: () => Effect.sync(() => [...workspaces]),
    renameWorkspace: ({ slug, name }: { slug: string; name: string }) =>
      Effect.sync(() => {
        calls.push("renameWorkspace");

        const taken = Arr.some(
          workspaces,
          (other) => other.slug !== slug && other.name.toLowerCase() === name.toLowerCase(),
        );

        if (taken) return { status: "taken" as const };

        const renamed = replace(
          workspaces,
          (workspace) => workspace.slug === slug,
          (workspace): WorkspaceRecord => ({ ...workspace, name }),
        );

        return renamed === null
          ? { status: "missing" as const }
          : { status: "renamed" as const, workspace: renamed };
      }),
    deleteWorkspace: ({ slug }: { slug: string }) =>
      Effect.sync(() => {
        calls.push(`deleteWorkspace:${slug}`);

        if (Arr.some(sessions, (session) => session.workspace === slug)) return "in-use" as const;

        return remove(workspaces, (workspace) => workspace.slug === slug)
          ? ("deleted" as const)
          : ("missing" as const);
      }),
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
    remove: (slug, name) => {
      calls.push(`removeRepo:${slug}/${name}`);
      duringDestroy?.();
      duringDestroy = undefined;

      if (workspaceFails !== undefined) return Promise.reject(new Error(workspaceFails));

      held.set(
        slug,
        Arr.filter(held.get(slug) ?? [], (repo) => repo !== name),
      );

      return Promise.resolve();
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
    sessionObjects,
    workspaceObjects,
    breakSession: (id: string, message: string) => {
      brokenSessions.set(id, message);
    },
    /** Register `session` while the next Workspace object is wiped, as a client starting one then would. */
    startDuringDestroy: (session: SessionRecord) => {
      duringDestroy = () => {
        sessions.push(session);
      };
    },
    workspaceSettings,
    saved,
    clones,
    failClones: (message: string) => {
      cloneFails = message;
    },
    /** Fail the Workspace object's calls that can fail (the repo removal, the Container restart) with `message`. */
    failWorkspace: (message: string) => {
      workspaceFails = message;
    },
    held,
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
      repos: fake.repos,
      workspaceSettings: fake.workspaceSettings,
      sessions: fake.sessionObjects,
      workspaces: fake.workspaceObjects,
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

  expect(workspaces).toEqual([
    { slug: "default", name: "default", createdAt: 0 },
    { slug: "cloudpid", name: "cloudpid", createdAt: 1 },
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

  expect(state.settings).toEqual({ instance: "standard-4", idleMinutes: 5, ignore: [] });
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

/** A client of the endpoint, as `withClient` gives it. */
const call = <A, E>(
  fake: ReturnType<typeof fakeRegistries>,
  use: (registry: Registry["Service"]) => Effect.Effect<A, E>,
) => withClient(Effect.flatMap(Registry, use), fake);

/** The calls that reached a Session's or a Workspace's object, or forgot or archived one, in order. */
const lifecycle = (fake: ReturnType<typeof fakeRegistries>) =>
  Arr.filter(fake.calls, (name) =>
    /^(stop|destroy|destroyWorkspace|clearWorkspace|restartContainer|removeRepo|deleteSession|deleteWorkspace):|^(archive|unarchive)Session$/.test(
      name,
    ),
  );

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

it("renames a Workspace, keeping its slug, and refuses a name another Workspace has in any case", async () => {
  const fake = fakeRegistries();

  await call(fake, (registry) => registry.createWorkspace({ slug: "cloudpid" }));
  await call(fake, (registry) => registry.createWorkspace({ slug: "pi" }));

  const renamed = await call(fake, (registry) =>
    registry.renameWorkspace({ workspace: "cloudpid", name: "Pi on Cloudflare" }),
  );

  expect(renamed).toEqual({ slug: "cloudpid", name: "Pi on Cloudflare", createdAt: 1 });

  const taken = await call(fake, (registry) =>
    Effect.flip(registry.renameWorkspace({ workspace: "pi", name: "pi on cloudflare" })),
  );

  expect(taken).toBeInstanceOf(WorkspaceError);
  expect(taken.message).toContain("pi on cloudflare");

  const missing = await call(fake, (registry) =>
    Effect.flip(registry.renameWorkspace({ workspace: "ghost", name: "Anything" })),
  );

  expect(missing.message).toContain("ghost");
});

it("rejects a Workspace name that is blank or longer than 80 characters, before it reaches the Registry", async () => {
  for (const name of ["   ", "a".repeat(81)]) {
    const { text, calls } = await callRaw("renameWorkspace", { workspace: "default", name });

    expect(text).toContain('"Failure"');
    expect(calls).toEqual([]);
  }
});

it("deletes a Workspace: every Session bound to it, archived ones too, then its object, then its record", async () => {
  const fake = fakeRegistries();
  const elsewhere = await call(fake, (registry) => registry.createSession({}));
  const first = await call(fake, (registry) => registry.createSession({ workspace: "cloudpid" }));
  const second = await call(fake, (registry) => registry.createSession({ workspace: "cloudpid" }));

  await call(fake, (registry) => registry.archiveSession({ id: first.id }));
  fake.calls.length = 0;

  await call(fake, (registry) => registry.deleteWorkspace({ workspace: "cloudpid" }));

  expect(lifecycle(fake)).toEqual([
    `destroy:${second.id}`,
    `deleteSession:${second.id}`,
    `destroy:${first.id}`,
    `deleteSession:${first.id}`,
    "destroyWorkspace:cloudpid",
    "deleteWorkspace:cloudpid",
  ]);
  expect(await call(fake, (registry) => registry.listSessions())).toEqual([elsewhere]);
  expect(
    Arr.map(
      await call(fake, (registry) => registry.listWorkspaces()),
      (workspace) => workspace.slug,
    ),
  ).toEqual(["default"]);
});

it("deletes a Session started in a Workspace while it was being deleted, before its record goes", async () => {
  const fake = fakeRegistries();
  const first = await call(fake, (registry) => registry.createSession({ workspace: "cloudpid" }));

  fake.startDuringDestroy({ ...first, id: "late" });
  fake.calls.length = 0;

  await call(fake, (registry) => registry.deleteWorkspace({ workspace: "cloudpid" }));

  expect(lifecycle(fake)).toEqual([
    `destroy:${first.id}`,
    `deleteSession:${first.id}`,
    "destroyWorkspace:cloudpid",
    "deleteWorkspace:cloudpid",
    "destroy:late",
    "deleteSession:late",
    "destroyWorkspace:cloudpid",
    "deleteWorkspace:cloudpid",
  ]);
  expect(await call(fake, (registry) => registry.listSessions())).toEqual([]);
});

it("refuses to delete the default Workspace, and touches nothing", async () => {
  const fake = fakeRegistries();

  await call(fake, (registry) => registry.createSession({}));
  fake.calls.length = 0;

  const error = await call(fake, (registry) =>
    Effect.flip(registry.deleteWorkspace({ workspace: "default" })),
  );

  expect(error).toBeInstanceOf(WorkspaceError);
  expect(error.message).toContain("default");
  expect(lifecycle(fake)).toEqual([]);
});

it("refuses to delete a Workspace the Registry does not list, and touches no object", async () => {
  const fake = fakeRegistries();

  const error = await call(fake, (registry) =>
    Effect.flip(registry.deleteWorkspace({ workspace: "typo" })),
  );

  expect(error.message).toContain("typo");
  expect(lifecycle(fake)).toEqual([]);
});

it("stops a Workspace delete at a Session that cannot be wiped, keeping the Workspace listed", async () => {
  const fake = fakeRegistries();
  const session = await call(fake, (registry) => registry.createSession({ workspace: "cloudpid" }));

  fake.breakSession(session.id, "storage error");
  fake.calls.length = 0;

  const error = await call(fake, (registry) =>
    Effect.flip(registry.deleteWorkspace({ workspace: "cloudpid" })),
  );

  expect(error).toBeInstanceOf(WorkspaceError);
  expect(error.message).toContain("storage error");
  expect(lifecycle(fake)).toEqual([`destroy:${session.id}`]);
  expect(
    Arr.map(
      await call(fake, (registry) => registry.listWorkspaces()),
      (workspace) => workspace.slug,
    ),
  ).toContain("cloudpid");
});

it("resets a Workspace: every Session bound to it, archived ones too, then its object but its settings, keeping its record", async () => {
  const fake = fakeRegistries();
  const elsewhere = await call(fake, (registry) => registry.createSession({}));
  const first = await call(fake, (registry) => registry.createSession({ workspace: "cloudpid" }));

  const second = await call(fake, (registry) =>
    registry.createSession({ workspace: "cloudpid", repo: "pi" }),
  );

  await call(fake, (registry) => registry.archiveSession({ id: first.id }));
  fake.calls.length = 0;

  await call(fake, (registry) => registry.resetWorkspace({ workspace: "cloudpid" }));

  expect(lifecycle(fake)).toEqual([
    `destroy:${second.id}`,
    `deleteSession:${second.id}`,
    `destroy:${first.id}`,
    `deleteSession:${first.id}`,
    "clearWorkspace:cloudpid",
  ]);
  expect(await call(fake, (registry) => registry.listSessions())).toEqual([elsewhere]);
  expect(
    Arr.map(
      await call(fake, (registry) => registry.listWorkspaces()),
      (workspace) => workspace.slug,
    ),
  ).toEqual(["default", "cloudpid"]);
});

it("resets the default Workspace too", async () => {
  const fake = fakeRegistries();
  const session = await call(fake, (registry) => registry.createSession({}));

  fake.calls.length = 0;

  await call(fake, (registry) => registry.resetWorkspace({ workspace: "default" }));

  expect(lifecycle(fake)).toEqual([
    `destroy:${session.id}`,
    `deleteSession:${session.id}`,
    "clearWorkspace:default",
  ]);
});

it("deletes a Session started in a Workspace while it was reset, and wipes the files again", async () => {
  const fake = fakeRegistries();
  const first = await call(fake, (registry) => registry.createSession({ workspace: "cloudpid" }));

  fake.startDuringDestroy({ ...first, id: "late" });
  fake.calls.length = 0;

  await call(fake, (registry) => registry.resetWorkspace({ workspace: "cloudpid" }));

  expect(lifecycle(fake)).toEqual([
    `destroy:${first.id}`,
    `deleteSession:${first.id}`,
    "clearWorkspace:cloudpid",
    "destroy:late",
    "deleteSession:late",
    "clearWorkspace:cloudpid",
  ]);
});

it("stops a Workspace reset at a Session that cannot be wiped, before its files", async () => {
  const fake = fakeRegistries();
  const session = await call(fake, (registry) => registry.createSession({ workspace: "cloudpid" }));

  fake.breakSession(session.id, "storage error");
  fake.calls.length = 0;

  const error = await call(fake, (registry) =>
    Effect.flip(registry.resetWorkspace({ workspace: "cloudpid" })),
  );

  expect(error).toBeInstanceOf(WorkspaceError);
  expect(error.message).toContain("storage error");
  expect(lifecycle(fake)).toEqual([`destroy:${session.id}`]);
});

it("refuses to reset or restart a Workspace the Registry does not list, and touches no object", async () => {
  const fake = fakeRegistries();

  const reset = await call(fake, (registry) =>
    Effect.flip(registry.resetWorkspace({ workspace: "typo" })),
  );

  const restart = await call(fake, (registry) =>
    Effect.flip(registry.restartContainer({ workspace: "typo" })),
  );

  expect(reset.message).toContain("typo");
  expect(restart.message).toContain("typo");
  expect(lifecycle(fake)).toEqual([]);
});

it("restarts a Workspace's Container, keeping its Sessions", async () => {
  const fake = fakeRegistries();
  const session = await call(fake, (registry) => registry.createSession({ workspace: "cloudpid" }));

  fake.calls.length = 0;

  await call(fake, (registry) => registry.restartContainer({ workspace: "cloudpid" }));

  expect(lifecycle(fake)).toEqual(["restartContainer:cloudpid"]);
  expect(await call(fake, (registry) => registry.listSessions())).toEqual([session]);
});

it("fails a Container restart the Workspace could not do with its message", async () => {
  const fake = fakeRegistries();

  await call(fake, (registry) => registry.createWorkspace({ slug: "cloudpid" }));
  fake.failWorkspace("no Container");

  const error = await call(fake, (registry) =>
    Effect.flip(registry.restartContainer({ workspace: "cloudpid" })),
  );

  expect(error).toBeInstanceOf(WorkspaceError);
  expect(error.message).toBe("Could not restart the Container: no Container");
});

it("removes a repo: every Session bound to it, archived ones too, then its directory; other Sessions stay", async () => {
  const fake = fakeRegistries();
  const atRoot = await call(fake, (registry) => registry.createSession({ workspace: "cloudpid" }));

  const first = await call(fake, (registry) =>
    registry.createSession({ workspace: "cloudpid", repo: "pi" }),
  );

  const second = await call(fake, (registry) =>
    registry.createSession({ workspace: "cloudpid", repo: "pi" }),
  );

  await call(fake, (registry) => registry.archiveSession({ id: first.id }));
  fake.calls.length = 0;

  await call(fake, (registry) => registry.removeRepo({ workspace: "cloudpid", repo: "pi" }));

  expect(lifecycle(fake)).toEqual([
    `destroy:${second.id}`,
    `deleteSession:${second.id}`,
    `destroy:${first.id}`,
    `deleteSession:${first.id}`,
    "removeRepo:cloudpid/pi",
  ]);
  expect(await call(fake, (registry) => registry.listSessions())).toEqual([atRoot]);
  expect(await call(fake, (registry) => registry.listRepos({ workspace: "cloudpid" }))).toEqual([]);
});

it("deletes a Session started in a repo while it was removed, and removes the directory again", async () => {
  const fake = fakeRegistries();

  const first = await call(fake, (registry) =>
    registry.createSession({ workspace: "cloudpid", repo: "pi" }),
  );

  fake.startDuringDestroy({ ...first, id: "late" });
  fake.calls.length = 0;

  await call(fake, (registry) => registry.removeRepo({ workspace: "cloudpid", repo: "pi" }));

  expect(lifecycle(fake)).toEqual([
    `destroy:${first.id}`,
    `deleteSession:${first.id}`,
    "removeRepo:cloudpid/pi",
    "destroy:late",
    "deleteSession:late",
    "removeRepo:cloudpid/pi",
  ]);
});

it("removes a repo that is gone but still has Sessions bound to it", async () => {
  const fake = fakeRegistries();

  const session = await call(fake, (registry) =>
    registry.createSession({ workspace: "cloudpid", repo: "pi" }),
  );

  fake.held.set("cloudpid", []);
  fake.calls.length = 0;

  await call(fake, (registry) => registry.removeRepo({ workspace: "cloudpid", repo: "pi" }));

  expect(lifecycle(fake)).toEqual([
    `destroy:${session.id}`,
    `deleteSession:${session.id}`,
    "removeRepo:cloudpid/pi",
  ]);
});

it("refuses to remove a repo the Workspace neither holds nor has Sessions in, or of a Workspace it does not list", async () => {
  const fake = fakeRegistries();

  await call(fake, (registry) => registry.createWorkspace({ slug: "cloudpid" }));

  const missing = await call(fake, (registry) =>
    Effect.flip(registry.removeRepo({ workspace: "cloudpid", repo: "ghost" })),
  );

  const unlisted = await call(fake, (registry) =>
    Effect.flip(registry.removeRepo({ workspace: "typo", repo: "pi" })),
  );

  expect(missing.message).toBe('Workspace "cloudpid" has no repo "ghost"');
  expect(unlisted.message).toContain("typo");
  expect(lifecycle(fake)).toEqual([]);
});

it("rejects a repo to remove that is a path or an option, before it reaches the Workspace", async () => {
  for (const repo of ["..", "a/b", "-rf"]) {
    const { text, calls } = await callRaw("removeRepo", { workspace: "cloudpid", repo });

    expect(text).toContain('"Failure"');
    expect(calls).toEqual([]);
  }
});

it("fails a removal that did not finish with its message, keeping the repo", async () => {
  const fake = fakeRegistries();

  await call(fake, (registry) => registry.createWorkspace({ slug: "cloudpid" }));
  fake.failWorkspace("rm failed (exit 1): Permission denied");

  const error = await call(fake, (registry) =>
    Effect.flip(registry.removeRepo({ workspace: "cloudpid", repo: "pi" })),
  );

  expect(error).toBeInstanceOf(WorkspaceError);
  expect(error.message).toBe("Could not remove the repo: rm failed (exit 1): Permission denied");
  expect(await call(fake, (registry) => registry.listRepos({ workspace: "cloudpid" }))).toEqual([
    "pi",
  ]);
});
