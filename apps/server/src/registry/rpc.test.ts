// @effect-diagnostics asyncFunction:off
import { RegistryRpcs, RPC_PATH } from "@cloudpid/protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as RpcClient from "effect/rpc/RpcClient";
import type { RpcClientError } from "effect/rpc/RpcClientError";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import { expect, it } from "vitest";
import { serveRegistryRpc } from "./rpc.ts";
import type { SessionRecord, WorkspaceRecord } from "./store.ts";

/** An in-memory Registry behind `getByName`, as the Worker's binding presents it. */
const fakeRegistries = () => {
  const sessions: SessionRecord[] = [];
  const workspaces: WorkspaceRecord[] = [];
  const names: string[] = [];

  const registry = {
    createSession: ({ title }: { title?: string | undefined }) =>
      Effect.sync(() => {
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
        const record: WorkspaceRecord = { slug, createdAt: 1 };

        workspaces.push(record);

        return record;
      }),
    listWorkspaces: () => Effect.sync(() => [...workspaces]),
  };

  return {
    names,
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

/** Run `program` with a client of `RegistryRpcs` whose requests the main Worker's endpoint answers in memory. */
const withClient = <A, E>(
  program: Effect.Effect<A, E, Registry>,
  fake = fakeRegistries(),
): Promise<A> => {
  const serve = (input: RequestInfo | URL, init?: RequestInit) =>
    serveRegistryRpc(fake.registries).pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(new Request(input, init)),
      ),
      Effect.map(HttpServerResponse.toWeb),
      Effect.runPromise,
    );

  const client = Layer.effect(Registry, RpcClient.make(RegistryRpcs)).pipe(
    Layer.provide(RpcClient.layerProtocolHttp({ url: `http://worker.test${RPC_PATH}` })),
    Layer.provide(RpcSerialization.layerJson),
    Layer.provide(FetchHttpClient.layer),
    // SAFETY: the client calls `fetch` with a URL and an init only, which `serve` takes.
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, serve as typeof fetch)),
  );

  // The test is the client's entry point.
  // @effect-diagnostics-next-line strictEffectProvide:off
  return Effect.runPromise(program.pipe(Effect.provide(client)));
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

it("rejects a title that is blank or longer than 200 characters", async () => {
  const create = (title: string) =>
    withClient(
      Effect.gen(function* () {
        return yield* (yield* Registry).createSession({ title });
      }).pipe(Effect.exit),
    );

  expect(Exit.isFailure(await create("   "))).toBe(true);
  expect(Exit.isSuccess(await create("a".repeat(200)))).toBe(true);
  expect(Exit.isFailure(await create("a".repeat(201)))).toBe(true);
});

it("creates and lists Workspaces, and rejects a slug that is not lowercase letters, digits and dashes", async () => {
  const result = await withClient(
    Effect.gen(function* () {
      const registry = yield* Registry;
      const bad = yield* Effect.exit(registry.createWorkspace({ slug: "Not A Slug" }));

      yield* registry.createWorkspace({ slug: "cloudpid" });

      return { bad, workspaces: yield* registry.listWorkspaces() };
    }),
  );

  expect(Exit.isFailure(result.bad)).toBe(true);
  expect(result.workspaces).toEqual([{ slug: "cloudpid", createdAt: 1 }]);
});
