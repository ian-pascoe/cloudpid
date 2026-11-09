// @effect-diagnostics asyncFunction:off missedPipeableOpportunity:off globalDate:off
import { MAX_DELIVERY_BODY_BYTES } from "@cloudpid/protocol";
import { type BaseRuntimeContext, RuntimeContext } from "alchemy/RuntimeContext";
import { buildEventTelemetry } from "alchemy/TelemetryRuntime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as HttpEffect from "effect/http/HttpEffect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Predicate from "effect/Predicate";
import * as References from "effect/References";
import * as Scope from "effect/Scope";
import * as Tracer from "effect/Tracer";
import { describe, expect, it, vi } from "vitest";
import { type HookDeliver, hooksTelemetry, readBounded, serveHooks } from "./hooks-serve.ts";
import type { Delivery, DeliveryAnswer } from "./trigger/object.ts";
import { TriggerUnreachable } from "./trigger/object.ts";
import { guardedRoutes } from "./sign-in-routes.ts";

const id = "0190f0a8-1b2c-7d3e-8f40-123456789abc";
const token = "A".repeat(20) + "b_-" + "9".repeat(20);
const origin = "https://cloudpid-server-pr-444.ian-g-pascoe.workers.dev";

const text = (response: HttpServerResponse.HttpServerResponse): string =>
  Predicate.isTagged(response.body, "Uint8Array")
    ? new TextDecoder().decode(response.body.body)
    : "";

/** A POST whose body breaks off after the headers: the sender went away. */
const brokenBody = (): RequestInit =>
  // SAFETY: `duplex` is the option a request with a stream body needs; the DOM's `RequestInit` lacks it.
  ({
    method: "POST",
    body: new ReadableStream<Uint8Array>({
      pull: (controller) => controller.error(new Error("went away")),
    }),
    duplex: "half",
  }) as RequestInit;

describe("readBounded", () => {
  const streamOf = (...chunks: ReadonlyArray<string>) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));

          controller.close();
        },
      }),
    ).body;

  it("reads a body as received, whatever the chunks", async () => {
    const read = await readBounded(streamOf("ab", "", "cde"), 100);

    expect(new TextDecoder().decode(read.body)).toBe("abcde");
    expect(read.size).toBe(5);
  });

  it("reads none for a request with no body", async () => {
    expect(await readBounded(null, 100)).toEqual({ body: new Uint8Array(0), size: 0 });
  });

  it("stops at its bound, keeps nothing, and says the body was over it", async () => {
    const read = await readBounded(streamOf("abc", "def", "ghi"), 5);

    expect(read.body).toEqual(new Uint8Array(0));
    expect(read.size).toBe(6);
  });

  it("takes a body of exactly its bound", async () => {
    const read = await readBounded(streamOf("abc", "de"), 5);

    expect(read.body).toHaveLength(5);
    expect(read.size).toBe(5);
  });
});

describe("the /hooks router ahead of the guarded routes", () => {
  const guarded = vi.fn(() => Effect.succeed(HttpServerResponse.text("guarded")));
  const delivered: Array<{ readonly id: string; readonly delivery: Delivery }> = [];
  let answer: DeliveryAnswer | "unreachable" = { status: 200, outcome: "accepted" };

  const deliver = (target: string, delivery: Delivery) =>
    Effect.suspend(() => {
      delivered.push({ id: target, delivery });

      return answer === "unreachable"
        ? Effect.fail(TriggerUnreachable.make({ message: "no answer" }))
        : Effect.succeed(answer);
    });

  const run = (url: string, init?: RequestInit) =>
    Effect.runPromise(
      serveHooks(deliver)(Effect.suspend(guarded)).pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(new Request(url, init)),
        ),
      ),
    );

  const post = (path: string, body = "{}", headers: Record<string, string> = {}) =>
    run(`${origin}${path}`, { method: "POST", body, headers });

  it("hands a POST to the Trigger URL to its object with the headers the checks read, and answers its status", async () => {
    delivered.length = 0;
    guarded.mockClear();
    answer = { status: 200, outcome: "accepted" };

    const response = await post(`/hooks/${id}/${token}`, '{"a":1}', {
      "content-type": "application/json",
      "x-hub-signature-256": "sha256=ab",
      "x-github-event": "push",
      "x-github-delivery": "d-1",
      "webhook-id": "msg_1",
      "webhook-timestamp": "1700000000",
      "webhook-signature": "v1,xx",
      "x-other": "not passed",
    });

    expect(response.status).toBe(200);
    expect(text(response)).toBe("");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(guarded).not.toHaveBeenCalled();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.id).toBe(id);
    expect(delivered[0]?.delivery.token).toBe(token);
    expect(delivered[0]?.delivery.headers).toEqual({
      contentType: "application/json",
      signature: "sha256=ab",
      event: "push",
      delivery: "d-1",
      webhookId: "msg_1",
      webhookTimestamp: "1700000000",
      webhookSignature: "v1,xx",
    });
    expect(new TextDecoder().decode(delivered[0]?.delivery.body)).toBe('{"a":1}');
    expect(delivered[0]?.delivery.size).toBe(7);
  });

  it.each([
    [401, "unauthorized"],
    [404, "not_found"],
    [413, "too_large"],
    [415, "unsupported"],
  ] as const)("answers what its object answers: %s", async (status, outcome) => {
    answer = { status, outcome };

    const response = await post(`/hooks/${id}/${token}`);

    expect(response.status).toBe(status);
    expect(text(response)).toBe("");
  });

  it("answers 503 when its object does not answer, saying nothing of why", async () => {
    answer = "unreachable";

    const response = await post(`/hooks/${id}/${token}`);

    expect(response.status).toBe(503);
    expect(text(response)).toBe("");
  });

  it("reads no body over 25 MiB: it says the size from Content-Length and passes none", async () => {
    delivered.length = 0;
    answer = { status: 413, outcome: "too_large" };

    const response = await post(`/hooks/${id}/${token}`, "x", {
      "content-length": String(MAX_DELIVERY_BODY_BYTES + 5),
    });

    expect(response.status).toBe(413);
    expect(delivered[0]?.delivery.body).toEqual(new Uint8Array(0));
    expect(delivered[0]?.delivery.size).toBe(MAX_DELIVERY_BODY_BYTES + 5);
  });

  it("answers 400 when the body breaks off, asking nothing of the object", async () => {
    delivered.length = 0;

    const response = await run(`${origin}/hooks/${id}/${token}`, brokenBody());

    expect(response.status).toBe(400);
    expect(text(response)).toBe("");
    expect(delivered).toEqual([]);
  });

  it("answers any method but POST 405, asking nothing of the object", async () => {
    delivered.length = 0;

    for (const method of ["GET", "PUT", "DELETE"]) {
      const response = await run(`${origin}/hooks/${id}/${token}`, { method });

      expect(response.status).toBe(405);
      expect(response.headers["allow"]).toBe("POST");
    }

    expect(delivered).toEqual([]);
  });

  it.each([
    `/hooks/${id}/${token}/`,
    `/hooks/${id}/${token}/x`,
    `/Hooks/${id}/${token}`,
    `//hooks/${id}/${token}`,
    `/hooks/${id}`,
    `/hooks/`,
    `/hooks/${id}/short`,
    `/hooks/${id}%2f${token}`,
  ])("answers 404, with the object asked nothing, for %s", async (path) => {
    delivered.length = 0;
    guarded.mockClear();

    const response = await post(path);

    expect(response.status).toBe(404);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(delivered).toEqual([]);
    expect(guarded).not.toHaveBeenCalled();
  });

  it.each(["/hooks", "/", "/rpc", "/oauth/mcp/start"])(
    "hands %s to the guarded routes",
    async (path) => {
      guarded.mockClear();

      const response = await post(path);

      expect(response.status).toBe(200);
      expect(guarded).toHaveBeenCalledTimes(1);
    },
  );
});

describe("the composition the Worker serves with", () => {
  const inner = vi.fn(() => Effect.succeed(HttpServerResponse.text("inside")));
  let asked = 0;

  const deliver = () =>
    Effect.sync((): DeliveryAnswer => {
      asked++;

      return { status: 200, outcome: "accepted" };
    });

  const deployed = {
    audience: "a".repeat(64),
    localMode: false,
    keys: () => Promise.resolve(undefined),
  };

  const handlers = {
    clientDocument: Effect.succeed(HttpServerResponse.text("document")),
    callback: () => Effect.succeed(HttpServerResponse.text("callback")),
  };

  const run = (path: string, method = "POST") =>
    Effect.runPromise(
      guardedRoutes(
        deployed,
        handlers,
        serveHooks(deliver),
      )(Effect.suspend(inner)).pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(
            new Request(`${origin}${path}`, {
              method,
              body: method === "POST" ? "{}" : null,
              headers: { host: new URL(origin).host },
            }),
          ),
        ),
      ),
    );

  it("serves the Trigger URL with no Access assertion at all, ahead of the guard's 403", async () => {
    asked = 0;

    expect((await run(`/hooks/${id}/${token}`)).status).toBe(200);
    expect(asked).toBe(1);
    expect(inner).not.toHaveBeenCalled();
  });

  it("refuses every other form under /hooks with the router's 404, not the guard's 403", async () => {
    expect((await run(`/hooks/${id}/${token}/`)).status).toBe(404);
    expect((await run(`/HOOKS/${id}/${token}`)).status).toBe(404);
  });

  it("still gives the bare /hooks and every other path to the guard, which refuses a request with no assertion", async () => {
    for (const path of ["/hooks", "/", "/rpc"]) {
      expect((await run(path)).status).toBe(403);
    }

    expect(inner).not.toHaveBeenCalled();
  });

  it("is composed without a hooks wrapper as before: /hooks goes to the guard", async () => {
    const response = await Effect.runPromise(
      guardedRoutes(
        deployed,
        handlers,
      )(Effect.suspend(inner)).pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(
            new Request(`${origin}/hooks/${id}/${token}`, { method: "POST" }),
          ),
        ),
      ),
    );

    expect(response.status).toBe(403);
  });
});

describe("what its spans and logs record", () => {
  /**
   * A request to `path`, run as the Worker runs one: alchemy's init builds `hooksTelemetry` against the runtime context
   * when it is `registered`, its bridge builds what the context holds into the event's context (`buildEventTelemetry`),
   * and the fetch runs through Effect's own server middleware (`toHandled`). Answers every span the request made and
   * every log line, with its annotations, as text.
   */
  const observe = async (
    path: string,
    options: {
      readonly registered: boolean;
      readonly deliver?: HookDeliver;
      readonly init?: RequestInit;
    },
  ) => {
    const spans: Array<Tracer.NativeSpan> = [];
    const logs: Array<string> = [];

    const tracer = Tracer.make({
      span: (made) => {
        const span = new Tracer.NativeSpan(made);

        spans.push(span);

        return span;
      },
    });

    const logger = Logger.make((entry) => {
      logs.push(
        JSON.stringify([
          entry.message,
          String(entry.cause),
          entry.fiber.getRef(References.CurrentLogAnnotations),
        ]),
      );
    });

    // What the init registers lands on the runtime context, as `Telemetry.layer` finds it.
    // SAFETY: registering reads and writes only the context's `telemetry`; nothing else of it is touched.
    const runtime = {} as BaseRuntimeContext;
    const scope = await Effect.runPromise(Scope.make());

    if (options.registered) {
      await Effect.runPromise(
        Layer.buildWithScope(hooksTelemetry, scope).pipe(
          Effect.provideService(RuntimeContext, runtime),
        ),
      );
    }

    const telemetry = await Effect.runPromise(
      buildEventTelemetry(Context.empty(), scope, runtime.telemetry, Layer.empty),
    );

    const context = Context.add(
      Context.add(telemetry, Tracer.Tracer, tracer),
      Logger.CurrentLoggers,
      new Set([logger]),
    );

    const app = serveHooks(
      options.deliver ?? (() => Effect.succeed({ status: 200, outcome: "accepted" } as const)),
    )(Effect.succeed(HttpServerResponse.text("guarded")));

    // SAFETY: the context holds references only (the telemetry's, the tracer, the loggers): no service is required.
    const handler = HttpEffect.toWebHandlerWith<never, HttpServerRequest.HttpServerRequest>(
      context as Context.Context<never>,
    )(app);

    const response = await handler(
      new Request(`${origin}${path}`, options.init ?? { method: "POST", body: "{}" }),
    );

    await Effect.runPromise(Scope.close(scope, Exit.void));

    return { spans, logs, response };
  };

  const everything = (
    spans: ReadonlyArray<{ readonly name: string; readonly attributes: Map<string, unknown> }>,
  ) => JSON.stringify(Arr.map(spans, ({ name, attributes }) => [name, [...attributes]]));

  it("would hold the token in the server span's path, were hooksTelemetry not registered", async () => {
    // The control: without it, Effect's own span records the whole URL.
    const { spans } = await observe(`/hooks/${id}/${token}`, { registered: false });

    expect(everything(spans)).toContain(token);
  });

  it("holds neither the token nor the id, only the route template, once hooksTelemetry is registered", async () => {
    const { spans } = await observe(`/hooks/${id}/${token}`, { registered: true });

    expect(everything(spans)).not.toContain(token);
    expect(everything(spans)).not.toContain(id);
    expect(Arr.map(spans, ({ name }) => name)).toEqual(["hooks.delivery"]);
    expect(spans[0]?.attributes.get("http.route")).toBe("/hooks/:id/:token");
    expect(spans[0]?.attributes.get("http.response.status_code")).toBe(200);
  });

  it("holds none of a refused form's path either", async () => {
    const { spans } = await observe(`/hooks/${id}/${token}/x`, { registered: true });

    expect(everything(spans)).not.toContain(token);
  });

  it("leaves every other request its server span", async () => {
    const { spans } = await observe("/rpc", { registered: true });

    expect(spans.length).toBeGreaterThan(0);
    expect(everything(spans)).toContain("/rpc");
  });

  it("logs neither the token nor the id when its object does not answer or the body breaks off", async () => {
    const unreachable = await observe(`/hooks/${id}/${token}`, {
      registered: true,
      deliver: () => Effect.fail(TriggerUnreachable.make({ message: "no answer" })),
    });

    expect(unreachable.response.status).toBe(503);
    expect(unreachable.logs.length).toBeGreaterThan(0);

    const broken = await observe(`/hooks/${id}/${token}`, {
      registered: true,
      init: brokenBody(),
    });

    expect(broken.response.status).toBe(400);
    expect(broken.logs.length).toBeGreaterThan(0);

    for (const line of [...unreachable.logs, ...broken.logs]) {
      expect(line).not.toContain(token);
      expect(line).not.toContain(id);
      expect(line).not.toContain("/hooks/");
    }
  });
});
