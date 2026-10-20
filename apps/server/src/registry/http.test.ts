// @effect-diagnostics asyncFunction:off
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Schema from "effect/Schema";
import { expect, it } from "vitest";
import { registryRoute, serveRegistry } from "./http.ts";
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

const request = (method: string, path: string, body?: string) => {
  const init: RequestInit = { method };

  if (body !== undefined) init.body = body;

  return HttpServerRequest.fromWeb(new Request(`http://worker.test${path}`, init));
};

const serve = async (method: string, path: string, body?: string, fake = fakeRegistries()) => {
  const req = request(method, path, body);
  const route = registryRoute(req);

  if (route === undefined) throw new Error("not a registry route");

  const response = await serveRegistry(fake.registries, route).pipe(
    Effect.provideService(HttpServerRequest.HttpServerRequest, req),
    Effect.runPromise,
  );

  const web = HttpServerResponse.toWeb(response);
  const json: unknown = await web.json();

  return { status: web.status, json, names: fake.names };
};

it("only claims the registry's own routes", () => {
  expect(registryRoute(request("POST", "/sessions"))).toBe("createSession");
  expect(registryRoute(request("GET", "/sessions"))).toBe("listSessions");
  expect(registryRoute(request("POST", "/workspaces"))).toBe("createWorkspace");
  expect(registryRoute(request("GET", "/workspaces"))).toBe("listWorkspaces");
  expect(registryRoute(request("POST", "/sessions/abc/prompt"))).toBeUndefined();
  expect(registryRoute(request("DELETE", "/sessions"))).toBeUndefined();
  expect(registryRoute(request("GET", "/"))).toBeUndefined();
});

it("creates a Session in the singleton Registry and answers 201 with its record", async () => {
  const { status, json, names } = await serve(
    "POST",
    "/sessions",
    JSON.stringify({ title: "Fix the build" }),
  );

  expect(status).toBe(201);
  expect(json).toMatchObject({ id: "session-1", title: "Fix the build", status: "idle" });
  expect(names).toEqual(["registry"]);
});

it("lists a created Session by the id the create answered with", async () => {
  const fake = fakeRegistries();
  const created = await serve("POST", "/sessions", "{}", fake);

  const { id } = await Effect.runPromise(
    Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }))(created.json),
  );

  expect((await serve("GET", "/sessions", undefined, fake)).json).toMatchObject({
    sessions: [{ id, title: null, status: "idle" }],
  });
});

it("rejects a Session body that is not JSON", async () => {
  expect((await serve("POST", "/sessions", "not json")).status).toBe(400);
});

it("trims a title, and rejects one that is blank or longer than 200 characters", async () => {
  const create = (title: string) => serve("POST", "/sessions", JSON.stringify({ title }));

  expect((await create("  Fix the build \n")).json).toMatchObject({ title: "Fix the build" });
  expect((await create("")).status).toBe(400);
  expect((await create("   ")).status).toBe(400);
  expect((await create("a".repeat(200))).status).toBe(201);
  expect((await create("a".repeat(201))).status).toBe(400);
  expect((await create(` ${"a".repeat(200)} `)).status).toBe(201);
});

it("rejects a Workspace slug that is not lowercase letters, digits and dashes", async () => {
  const bad = await serve("POST", "/workspaces", JSON.stringify({ slug: "Not A Slug" }));
  const good = await serve("POST", "/workspaces", JSON.stringify({ slug: "cloudpid" }));

  expect(bad.status).toBe(400);
  expect(good.json).toEqual({ slug: "cloudpid", createdAt: 1 });
});

it("lists nothing before anything is created", async () => {
  expect((await serve("GET", "/sessions")).json).toEqual({ sessions: [] });
  expect((await serve("GET", "/workspaces")).json).toEqual({ workspaces: [] });
});
