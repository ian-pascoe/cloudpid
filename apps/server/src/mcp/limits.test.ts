// The host's load caps (`docs/architecture/mcp-connections.md` → The engine → Load caps): the engine queue of 5, with
// background work's share of 3 and calls served first, and the requests in flight per server and per host.
// @effect-diagnostics asyncFunction:off -- Vitest's tests are Promise-based.
import * as Arr from "effect/Array";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { describe, expect, it } from "vitest";
import {
  type EngineCallKind,
  MAX_IN_FLIGHT_PER_HOST,
  MAX_IN_FLIGHT_PER_SERVER,
  makeLoadCaps,
  type McpLoadCapsService,
} from "./limits.ts";

const run = <A>(body: (caps: McpLoadCapsService) => Effect.Effect<A>) =>
  Effect.runPromise(body(makeLoadCaps()));

/** Start one held engine call of `kind`, recording when it got its slot; `release` ends it. */
const held = (
  caps: McpLoadCapsService,
  kind: EngineCallKind,
  started: Array<string>,
  label: string,
) =>
  Effect.gen(function* () {
    const release = yield* Deferred.make<void>();

    const fiber = yield* Effect.forkChild(
      caps.engineCall(
        kind,
        Effect.sync(() => started.push(label)).pipe(Effect.andThen(Deferred.await(release))),
      ),
    );

    return { fiber, release: Deferred.succeed(release, undefined) };
  });

const settle = Effect.yieldNow.pipe(Effect.repeat({ times: 10 }));

describe("the engine queue", () => {
  it("runs at most 5 engine calls at once: a 6th waits for a slot", async () => {
    const started = await run((caps) =>
      Effect.gen(function* () {
        const started: Array<string> = [];

        const calls = yield* Effect.forEach([1, 2, 3, 4, 5, 6], (n) =>
          held(caps, "call", started, `call ${n}`),
        );

        yield* settle;
        const before = [...started];

        yield* calls[0]!.release;
        yield* settle;

        return { before, after: [...started] };
      }),
    );

    expect(started.before).toHaveLength(5);
    expect(started.after).toContain("call 6");
  });

  it("gives background work at most 3 slots, leaving the rest to calls", async () => {
    const seen = await run((caps) =>
      Effect.gen(function* () {
        const started: Array<string> = [];

        yield* Effect.forEach([1, 2, 3, 4, 5], (n) =>
          held(caps, "background", started, `background ${n}`),
        );
        yield* settle;
        const background = caps.engineCalls();

        yield* Effect.forEach([1, 2], (n) => held(caps, "call", started, `call ${n}`));
        yield* settle;

        return { background, after: caps.engineCalls(), started: [...started] };
      }),
    );

    expect(seen.background).toEqual({ call: 0, background: 3 });
    expect(seen.after).toEqual({ call: 2, background: 3 });
    expect(seen.started).toEqual([
      "background 1",
      "background 2",
      "background 3",
      "call 1",
      "call 2",
    ]);
  });

  it("serves a call queued behind background work first when a slot frees", async () => {
    const started = await run((caps) =>
      Effect.gen(function* () {
        const started: Array<string> = [];

        const calls = yield* Effect.forEach([1, 2, 3, 4, 5], (n) =>
          held(caps, "call", started, `call ${n}`),
        );

        yield* held(caps, "background", started, "background");
        yield* settle;
        yield* held(caps, "call", started, "late call");
        yield* settle;

        yield* calls[0]!.release;
        yield* settle;

        return [...started];
      }),
    );

    expect(started.slice(5)).toEqual(["late call"]);
  });

  it("gives a slot back when a waiter is interrupted", async () => {
    const counts = await run((caps) =>
      Effect.gen(function* () {
        const started: Array<string> = [];

        const calls = yield* Effect.forEach([1, 2, 3, 4, 5], (n) =>
          held(caps, "call", started, `call ${n}`),
        );

        const waiter = yield* held(caps, "call", started, "waiter");

        yield* settle;
        yield* Fiber.interrupt(waiter.fiber);
        yield* Effect.forEach(calls, (call) => call.release);
        yield* settle;

        return caps.engineCalls();
      }),
    );

    expect(counts).toEqual({ call: 0, background: 0 });
  });
});

describe("requests in flight", () => {
  it("holds at most 8 per server and 32 per host", async () => {
    const peaks = await run((caps) =>
      Effect.gen(function* () {
        const live = new Map<string, number>();
        const peak = new Map<string, number>();
        let hostLive = 0;
        let hostPeak = 0;
        const gate = yield* Deferred.make<void>();

        const one = (conn: string) =>
          caps.inFlight(
            conn,
            Effect.gen(function* () {
              live.set(conn, (live.get(conn) ?? 0) + 1);
              peak.set(conn, Math.max(peak.get(conn) ?? 0, live.get(conn) ?? 0));
              hostLive += 1;
              hostPeak = Math.max(hostPeak, hostLive);
              yield* Deferred.await(gate);
              live.set(conn, (live.get(conn) ?? 0) - 1);
              hostLive -= 1;
            }),
          );

        const conns = Array.from({ length: 6 }, (_, index) => `conn ${index}`);

        const fibers = yield* Effect.forEach(
          Arr.flatMap(conns, (conn) => Arr.replicate(conn, 10)),
          (conn) => Effect.forkChild(one(conn)),
        );

        yield* settle;
        const during = { server: Math.max(...peak.values()), host: hostPeak };

        yield* Deferred.succeed(gate, undefined);
        yield* Effect.forEach(fibers, Fiber.join, { discard: true });

        return during;
      }),
    );

    expect(peaks).toEqual({ server: MAX_IN_FLIGHT_PER_SERVER, host: MAX_IN_FLIGHT_PER_HOST });
  });
});
