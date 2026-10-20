import { expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { newSessionId } from "./ids.ts";

const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

it("mints UUIDv7 session ids that begin with the millisecond time", () =>
  Effect.gen(function* () {
    // 0x019a2b3c4d5e ms since the epoch.
    yield* TestClock.setTime(0x019a2b3c4d5e);

    const id = yield* newSessionId;

    expect(id).toMatch(V7);
    expect(id.startsWith("019a2b3c-4d5e-7")).toBe(true);
    // @effect-diagnostics-next-line strictEffectProvide:off
  }).pipe(Effect.provide(TestClock.layer()), Effect.runPromise));

it("mints a different id each time, later ones sorting later", () =>
  Effect.gen(function* () {
    const first = yield* newSessionId;

    yield* TestClock.adjust(1);

    const second = yield* newSessionId;

    expect(second).not.toBe(first);
    expect(second > first).toBe(true);
    // @effect-diagnostics-next-line strictEffectProvide:off
  }).pipe(Effect.provide(TestClock.layer()), Effect.runPromise));
