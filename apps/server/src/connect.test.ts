// @effect-diagnostics asyncFunction:off
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { expect, it } from "vitest";
import { connectSession } from "./connect.ts";

const known = "0190f0a8-1b2c-7d3e-8f40-123456789abc";

/** The Registry and Session namespaces as the Worker's bindings present them, recording what reached a Session. */
const fakes = () => {
  const forwarded: string[] = [];

  return {
    forwarded,
    // SAFETY: `connectSession` calls only `getByName`, and on its result only `getSession`.
    registries: {
      getByName: () => ({
        getSession: ({ id }: { id: string }) =>
          Effect.succeed(id === known ? { id, title: null, status: "idle" } : null),
      }),
    } as never,
    // SAFETY: `connectSession` calls only `getByName`, and on its result only `fetch`.
    sessions: {
      getByName: (id: string) => ({
        fetch: () =>
          Effect.sync(() => {
            forwarded.push(id);

            return HttpServerResponse.text("forwarded");
          }),
      }),
    } as never,
  };
};

const connect = async (sessionId: string) => {
  const fake = fakes();

  const request = HttpServerRequest.fromWeb(
    new Request(`http://worker.test/sessions/${sessionId}/socket`),
  );

  const response = await connectSession(fake.sessions, fake.registries, sessionId).pipe(
    Effect.provideService(HttpServerRequest.HttpServerRequest, request),
    Effect.runPromise,
  );

  return { status: response.status, forwarded: fake.forwarded };
};

it("forwards a socket of a Session the Registry knows to its Session DO", async () => {
  expect(await connect(known)).toEqual({ status: 200, forwarded: [known] });
});

it("answers 404 for a Session the Registry does not know, and creates no Session DO", async () => {
  expect(await connect("0190f0a8-1b2c-7d3e-8f40-000000000000")).toEqual({
    status: 404,
    forwarded: [],
  });
});
