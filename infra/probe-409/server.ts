// Throwaway probe for #409 (Verify MCP host ↔ engine RPC on a deployed stage). Not part of cloudpid; never merged.
//
// Stands in for `Server` (ADR-0038): an Effect Worker with two Effect Durable Objects, `Session` (a stub Session) and
// `Host` (a stub `McpHost`), binding the stand-in `McpWorker`'s `McpEngine` entrypoint one way (`ENGINE`). The Session
// calls the host through alchemy's Tag (`yield* Host`, `getByName(…)`) or through the raw namespace (`env.Host`); the
// host calls the engine through the raw service binding. Every hop records what it sees in its own storage.
//
// `/run?key=…&spec=<json>` runs a scenario in a Session object and answers its result; `/start` runs it detached;
// `/records?key=…&run=…&session=…&host=…` reads what the Session and host recorded.

import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { Engine } from "./engine-resource.ts";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const errorText = (error: unknown) =>
  error instanceof Error ? `${error.name}: ${error.message}` : JSON.stringify(error);

const workersModule = () => import("cloudflare:workers" as string) as Promise<any>;

/** The trace context this invocation runs under, and that of a custom span opened in it. */
const traceOf = async (label: string) => {
  const { tracing } = await workersModule();
  if (tracing === undefined) return { label, tracing: "absent" };
  const active = tracing.getActiveSpan?.();
  const custom = tracing.enterSpan(`probe.${label}`, (span: any) => ({
    isTraced: span.isTraced,
    ...span.spanContext(),
  }));
  return {
    label,
    active: active === undefined ? null : { isTraced: active.isTraced, ...active.spanContext() },
    custom,
  };
};

const memory = () => {
  try {
    return (globalThis as any).process?.memoryUsage?.() ?? "unavailable";
  } catch (error) {
    return errorText(error);
  }
};

/** A per-object event log in the object's own storage. */
const recorder = (storage: any, hop: string) => {
  let seq = 0;
  return {
    record: async (run: string, event: string, data: Record<string, unknown> = {}) => {
      seq++;
      try {
        await storage.put(`e:${run}:${Date.now()}:${String(seq).padStart(6, "0")}`, {
          t: Date.now(),
          hop,
          event,
          ...data,
        });
      } catch (error) {
        console.log(`record failed ${hop} ${run} ${event}: ${errorText(error)}`);
      }
    },
    list: async (run: string) => [...(await storage.list({ prefix: `e:${run}:` })).values()],
  };
};

/** The six-connection checks: completion times of slow fetches and RPC calls started together in one invocation. */
const connChecks = async (input: {
  readonly slowUrl: string;
  readonly ms: number;
  readonly rpc: Record<
    string,
    { slow: (ms: number) => Promise<unknown>; fast: () => Promise<unknown> }
  >;
}) => {
  const { slowUrl, ms } = input;
  const slowFetch = async (tag: string) => {
    const response = await fetch(`${slowUrl}?ms=${ms}&n=${tag}-${crypto.randomUUID()}`);
    await response.text();
  };
  const timed = async (label: string, work: () => Promise<unknown>, t0: number) => {
    try {
      await work();
      return { label, doneMs: Date.now() - t0 };
    } catch (error) {
      return { label, doneMs: Date.now() - t0, error: errorText(error) };
    }
  };
  const results: Record<string, unknown> = {};

  {
    const t0 = Date.now();
    results["fetch x7"] = await Promise.all(
      Array.from({ length: 7 }, (_, i) => timed(`fetch${i}`, () => slowFetch(`a${i}`), t0)),
    );
  }

  for (const [name, rpc] of Object.entries(input.rpc)) {
    {
      // Six slow RPC calls pending, then a slow fetch: does the fetch wait for an RPC call to finish?
      const t0 = Date.now();
      const calls = Array.from({ length: 6 }, (_, i) =>
        timed(`${name}${i}`, () => rpc.slow(ms), t0),
      );
      await sleep(100);
      const last = timed("fetch", () => slowFetch("b"), t0);
      results[`${name} x6 then fetch`] = await Promise.all([...calls, last]);
    }
    {
      // Six slow fetches waiting for headers, then a fast RPC call: does the call wait for a fetch's headers?
      const t0 = Date.now();
      const calls = Array.from({ length: 6 }, (_, i) =>
        timed(`fetch${i}`, () => slowFetch(`c${i}`), t0),
      );
      await sleep(100);
      const last = timed(`${name}-fast`, () => rpc.fast(), t0);
      results[`fetch x6 then ${name}`] = await Promise.all([...calls, last]);
    }
  }
  return results;
};

// ---------------------------------------------------------------------------------------------------------------------
// The host object
// ---------------------------------------------------------------------------------------------------------------------

type HostMethods = {
  readonly call: (request: any, hooks: any, options?: any) => Effect.Effect<any>;
  readonly big: (run: string, mib: number, mode: string) => Effect.Effect<any>;
  readonly sleep: (ms: number) => Effect.Effect<any>;
  readonly conn: (input: { ms: number }) => Effect.Effect<any>;
  readonly records: (run: string) => Effect.Effect<any>;
};

export class Host extends Cloudflare.DurableObject<Host, HostMethods>()("Host") {}

export const HostLive = Host.make(
  Effect.all({
    state: Cloudflare.DurableObjectState,
    worker: Cloudflare.WorkerEnvironment,
  }).pipe(
    Effect.map(({ state, worker }) =>
      Effect.gen(function* () {
        const env = worker as any;
        const raw = (state as any).raw;
        const log = recorder(raw.storage, "host");
        const instanceStarted = Date.now();

        return {
          call: (request: any, hooks: any, options: any = {}) =>
            Effect.promise(async () => {
              const run = request.run;
              const trace = await traceOf("host.call");
              await log.record(run, "call.start", {
                hooksType: typeof hooks,
                onProgressType: typeof hooks?.onProgress,
                untilAbortedType: typeof hooks?.untilAborted,
                trace,
              });
              if (typeof options.resetAfterMs === "number") {
                setTimeout(() => {
                  void log.record(run, "host.abort").then(() => raw.abort("probe: host reset"));
                }, options.resetAfterMs);
              }
              const t0 = Date.now();
              try {
                const result = await env.ENGINE.call(request, hooks);
                await log.record(run, "call.end", { ms: Date.now() - t0 });
                return { ok: true, result, hostTrace: trace };
              } catch (error) {
                await log.record(run, "call.error", {
                  ms: Date.now() - t0,
                  error: errorText(error),
                });
                return {
                  ok: false,
                  error: errorText(error),
                  ms: Date.now() - t0,
                  hostTrace: trace,
                };
              }
            }),

          // pass: return the engine's stream as it came; buffer: read it all first (the control); effect: hand alchemy
          // an Effect Stream over it, which alchemy pumps through this isolate into a new ReadableStream.
          big: (run: string, mib: number, mode: string) =>
            Effect.gen(function* () {
              const stream: ReadableStream<Uint8Array> = yield* Effect.promise(() =>
                env.ENGINE.big(run, mib),
              );
              yield* Effect.promise(() =>
                log.record(run, "big.got", {
                  mode,
                  isReadableStream: stream instanceof ReadableStream,
                  memory: memory(),
                }),
              );
              if (mode === "buffer" || mode === "hold") {
                const buffer = yield* Effect.promise(() => new Response(stream).arrayBuffer());
                if (mode === "hold") yield* Effect.promise(() => sleep(4000));
                yield* Effect.promise(() =>
                  log.record(run, "big.buffered", { bytes: buffer.byteLength, memory: memory() }),
                );
                return new Response(buffer).body;
              }
              if (mode === "effect") {
                return Stream.fromReadableStream({ evaluate: () => stream, onError: (e) => e });
              }
              return stream;
            }),

          sleep: (ms: number) =>
            Effect.promise(async () => {
              await sleep(ms);
              return { ms };
            }),

          conn: (input: { ms: number }) =>
            Effect.promise(async () =>
              connChecks({
                slowUrl: `${env.ENGINE_URL}/slow`,
                ms: input.ms,
                rpc: {
                  "service-rpc": {
                    slow: (ms) => env.ENGINE.sleep(ms),
                    fast: () => env.ENGINE.version(),
                  },
                  "service-fetch": {
                    slow: (ms) =>
                      env.ENGINE.fetch(
                        `https://engine/slow?ms=${ms}&n=${crypto.randomUUID()}`,
                      ).then((r: Response) => r.text()),
                    fast: () =>
                      env.ENGINE.fetch(`https://engine/slow?ms=0`).then((r: Response) => r.text()),
                  },
                  "do-rpc": {
                    slow: (ms) => env.Host.getByName(`sleeper-${crypto.randomUUID()}`).sleep(ms),
                    fast: () => env.Host.getByName(`sleeper-${crypto.randomUUID()}`).sleep(0),
                  },
                },
              }),
            ),

          records: (run: string) => Effect.promise(() => log.list(run)),
          whoami: () => Effect.sync(() => ({ hop: "host", version: env.VERSION, instanceStarted })),
        };
      }),
    ),
  ),
);

// ---------------------------------------------------------------------------------------------------------------------
// The stub Session
// ---------------------------------------------------------------------------------------------------------------------

type SessionMethods = {
  readonly run: (spec: any) => Effect.Effect<any>;
  readonly start: (spec: any) => Effect.Effect<any>;
  readonly records: (run: string) => Effect.Effect<any>;
};

export class Session extends Cloudflare.DurableObject<Session, SessionMethods>()("Session") {}

export const SessionLive = Session.make(
  Effect.all({
    state: Cloudflare.DurableObjectState,
    worker: Cloudflare.WorkerEnvironment,
    hosts: Host,
  }).pipe(
    Effect.map(({ state, worker, hosts }) =>
      Effect.gen(function* () {
        const env = worker as any;
        const raw = (state as any).raw;
        const log = recorder(raw.storage, "session");
        const instanceStarted = Date.now();

        /** Call a host method through alchemy's Tag (an Effect) or the raw namespace (a promise). */
        const host = (spec: any) => {
          const name = spec.host ?? "env-1";
          return {
            call: (request: any, hooks: any, options: any) =>
              spec.via === "raw"
                ? env.Host.getByName(name).call(request, hooks, options)
                : Effect.runPromise((hosts as any).getByName(name).call(request, hooks, options)),
            big: (run: string, mib: number, mode: string) =>
              spec.via === "raw"
                ? env.Host.getByName(name).big(run, mib, mode)
                : Effect.runPromise((hosts as any).getByName(name).big(run, mib, mode)),
            sleep: (ms: number) =>
              spec.via === "raw"
                ? env.Host.getByName(`sleeper-${crypto.randomUUID()}`).sleep(ms)
                : Effect.runPromise(
                    (hosts as any).getByName(`sleeper-${crypto.randomUUID()}`).sleep(ms),
                  ),
            conn: (input: any) =>
              spec.via === "raw"
                ? env.Host.getByName(name).conn(input)
                : Effect.runPromise((hosts as any).getByName(name).conn(input)),
          };
        };

        const callbacks = async (spec: any) => {
          const run = spec.run;
          const { RpcTarget } = await workersModule();
          const trace = await traceOf("session.call");
          let abort: (value: unknown) => void = () => {};
          const aborted = new Promise((resolve) => (abort = resolve));
          const progress: Array<{ i?: number; tick?: number; sent?: number; at: number }> = [];
          let inputAsked = 0;

          const fns = {
            onProgress: (p: any) => {
              progress.push({ ...p, at: Date.now() });
              return true;
            },
            onInput: async (question: unknown) => {
              inputAsked++;
              await log.record(run, "onInput", { question });
              await sleep(spec.answerDelayMs ?? 1000);
              return { answer: "yes" };
            },
            untilAborted: () => aborted,
          };
          class Hooks extends RpcTarget {
            onProgress(p: any) {
              return fns.onProgress(p);
            }
            onInput(q: unknown) {
              return fns.onInput(q);
            }
            untilAborted() {
              return fns.untilAborted();
            }
          }
          const hooks = spec.hooks === "target" ? new Hooks() : fns;

          if (typeof spec.abortAfterMs === "number") {
            setTimeout(() => {
              void log.record(run, "session.abort");
              abort({ reason: "session aborted" });
            }, spec.abortAfterMs);
          }
          if (typeof spec.resetSelfAfterMs === "number") {
            setTimeout(() => {
              void log.record(run, "session.reset").then(() => raw.abort("probe: session reset"));
            }, spec.resetSelfAfterMs);
          }

          await log.record(run, "call.start", { via: spec.via, hooks: spec.hooks, trace });
          const t0 = Date.now();
          let result: unknown;
          try {
            result = await host(spec).call(spec.request, hooks, spec.hostOptions ?? {});
          } catch (error) {
            result = { thrown: errorText(error) };
          }
          const ms = Date.now() - t0;
          // A progress report arrives in order if each one's index is above the last.
          const indices = progress.filter((p) => p.i !== undefined).map((p) => p.i!);
          const inOrder = indices.every((value, k) => k === 0 || value > indices[k - 1]!);
          const lag = progress.filter((p) => p.sent !== undefined).map((p) => p.at - p.sent!);
          const view = {
            ms,
            progressReceived: progress.length,
            inOrder,
            oneWayLagMs: lag.length === 0 ? null : { min: Math.min(...lag), max: Math.max(...lag) },
            inputAsked,
          };
          await log.record(run, "call.end", { result, view });
          return { sessionTrace: trace, view, result };
        };

        const big = async (spec: any) => {
          const run = spec.run;
          const t0 = Date.now();
          const one = async (k: number) => {
            const value = await host(spec).big(`${run}-${k}`, spec.mib ?? 16, spec.mode ?? "pass");
            let bytes = 0;
            let kind: string;
            if (value instanceof ReadableStream) {
              kind = "ReadableStream";
              const reader = value.getReader();
              for (;;) {
                const { done, value: chunk } = await reader.read();
                if (done) break;
                bytes += chunk.byteLength;
                if (spec.readDelayMs !== undefined) {
                  if (bytes % (1024 * 1024) === 0) void log.record(run, "big.consumed", { mib: bytes / (1024 * 1024) });
                  await sleep(spec.readDelayMs);
                }
              }
            } else if (Stream.isStream(value)) {
              kind = "EffectStream";
              await Effect.runPromise(
                Stream.runForEach(value as Stream.Stream<Uint8Array, unknown>, (chunk) =>
                  Effect.sync(() => {
                    bytes += chunk.byteLength;
                  }),
                ),
              );
            } else {
              kind = `other: ${JSON.stringify(value)?.slice(0, 300)}`;
            }
            return { k, kind, bytes, ms: Date.now() - t0 };
          };
          const settled = await Promise.allSettled(
            Array.from({ length: spec.concurrency ?? 1 }, (_, k) => one(k)),
          );
          return {
            ms: Date.now() - t0,
            memory: memory(),
            results: settled.map((s) =>
              s.status === "fulfilled" ? s.value : { error: errorText(s.reason) },
            ),
          };
        };

        const conn = async (spec: any) => {
          const fromHost =
            spec.where === "session" ? undefined : await host(spec).conn({ ms: spec.ms ?? 2000 });
          const fromSession =
            spec.where === "host"
              ? undefined
              : await connChecks({
                  slowUrl: `${env.ENGINE_URL}/slow`,
                  ms: spec.ms ?? 2000,
                  rpc: {
                    "do-rpc": {
                      slow: (ms) => env.Host.getByName(`sleeper-${crypto.randomUUID()}`).sleep(ms),
                      fast: () => env.Host.getByName(`sleeper-${crypto.randomUUID()}`).sleep(0),
                    },
                  },
                });
          return { fromHost, fromSession };
        };

        const run = async (spec: any) => {
          try {
            switch (spec.scenario) {
              case "callbacks":
                return await callbacks(spec);
              case "big":
                return await big(spec);
              case "conn":
                return await conn(spec);
              case "trace":
                return { session: await traceOf("session.trace") };
              default:
                return { error: `unknown scenario ${spec.scenario}` };
            }
          } catch (error) {
            return { error: errorText(error) };
          }
        };

        return {
          run: (spec: any) => Effect.promise(() => run(spec)),
          start: (spec: any) =>
            Effect.sync(() => {
              raw.waitUntil(run(spec));
              return { started: spec.run };
            }),
          records: (run: string) => Effect.promise(() => log.list(run)),
          whoami: () => Effect.sync(() => ({ hop: "session", version: env.VERSION, instanceStarted })),
        };
      }),
    ),
  ),
);

// ---------------------------------------------------------------------------------------------------------------------
// The Worker
// ---------------------------------------------------------------------------------------------------------------------

const engineBinding = Effect.gen(function* () {
  if (globalThis.__ALCHEMY_RUNTIME__ === true) return undefined;
  const engine = yield* Engine;
  return {
    ENGINE: Cloudflare.WorkerEntrypoint(engine, "McpEngine"),
    ENGINE_URL: engine.url.as<string>(),
  };
});

const props = Effect.gen(function* () {
  return {
    main: import.meta.url,
    compatibility: { date: "2026-08-31", flags: ["nodejs_compat"] },
    workersDev: true,
    observability: {
      enabled: true,
      logs: { enabled: true, invocationLogs: true },
      traces: { enabled: true },
    },
    env: {
      ...(yield* engineBinding),
      PROBE_KEY: yield* Config.String("PROBE_KEY"),
      // Changing it redeploys only this Worker (the Server-deploy check).
      VERSION: yield* Config.String("SERVER_VERSION").pipe(Config.withDefault("s1")),
    },
  };
});

export default class ProbeServer extends Cloudflare.Worker<ProbeServer>()(
  "ProbeServer",
  props,
  Effect.gen(function* () {
    const sessions = yield* Session;
    const hosts = yield* Host;
    const worker = (yield* Cloudflare.WorkerEnvironment) as any;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = new URL(request.url, "https://probe");
        const json = (value: unknown) =>
          HttpServerResponse.text(JSON.stringify(value, null, 2), {
            contentType: "application/json",
          });

        if (url.searchParams.get("key") !== worker.PROBE_KEY)
          return HttpServerResponse.text("no", { status: 403 });

        const spec = JSON.parse(url.searchParams.get("spec") ?? "{}");
        const session = (sessions as any).getByName(spec.session ?? spec.run ?? "s");

        if (url.pathname === "/run") {
          const fetchTrace = yield* Effect.promise(() => traceOf("worker.fetch"));
          const result = yield* Effect.orDie(session.run(spec) as Effect.Effect<unknown, unknown>);
          return json({ version: worker.VERSION, fetchTrace, result });
        }
        if (url.pathname === "/start") {
          return json(yield* Effect.orDie(session.start(spec) as Effect.Effect<unknown, unknown>));
        }
        if (url.pathname === "/whoami") {
          const sessionName = url.searchParams.get("session") ?? "s";
          const hostName = url.searchParams.get("host") ?? "env-1";
          return json({
            worker: worker.VERSION,
            session: yield* Effect.orDie((sessions as any).getByName(sessionName).whoami() as Effect.Effect<unknown, unknown>),
            host: yield* Effect.orDie((hosts as any).getByName(hostName).whoami() as Effect.Effect<unknown, unknown>),
          });
        }
        if (url.pathname === "/records") {
          const run = url.searchParams.get("run") ?? "";
          const sessionName = url.searchParams.get("session") ?? run;
          const hostName = url.searchParams.get("host") ?? "env-1";
          const fromSession = yield* Effect.orDie(
            (sessions as any).getByName(sessionName).records(run) as Effect.Effect<
              unknown,
              unknown
            >,
          );
          const fromHost = yield* Effect.orDie(
            (hosts as any).getByName(hostName).records(run) as Effect.Effect<unknown, unknown>,
          );
          return json({ session: fromSession, host: fromHost });
        }
        return json({ version: worker.VERSION });
      }),
    };
  }).pipe(
    // @effect-diagnostics-next-line strictEffectProvide:off
    Effect.provide(SessionLive.pipe(Layer.provideMerge(HostLive))),
  ),
) {}
