// @effect-diagnostics asyncFunction:off
import { RegistryRpcs, RPC_PATH } from "@cloudpid/protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as RpcClient from "effect/rpc/RpcClient";
import type { RpcClientError } from "effect/rpc/RpcClientError";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import { expect, it } from "vitest";
import { isRegistryRpc } from "../routes.ts";
import { serveRegistryRpc } from "./rpc.ts";
import type { SessionRecord, WorkspaceRecord } from "./store.ts";

/** An in-memory Registry behind `getByName`, as the Worker's binding presents it. */
const fakeRegistries = () => {
  const sessions: SessionRecord[] = [];
  const workspaces: WorkspaceRecord[] = [];
  const names: string[] = [];
  /** The Registry methods called, in order. */
  const calls: string[] = [];

  const registry = {
    createSession: ({ title }: { title?: string | undefined }) =>
      Effect.sync(() => {
        calls.push("createSession");

        const record: SessionRecord = {
          id: `session-${sessions.length + 1}`,
          title: title ?? null,
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
const callRaw = async (tag: string, payload: Readonly<Record<string, string>>) => {
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
