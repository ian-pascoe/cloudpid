// @effect-diagnostics strictEffectProvide:off -- each test is its own entry point, run on a test clock.
// The patched alchemy retry around a new Worker's deployments read (patches/@alchemy.run__cloudflare@2.0.0-beta.84.patch,
// docs/development/dependencies.md): Cloudflare can answer `WorkerNotFound` (10007) for a script it registered moments
// ago, which failed the first Preview deploy of a new stage (#615).
import { retryScriptRegistration } from "@alchemy.run/cloudflare/Workers/WorkerProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it } from "vitest";

/** What distilled raises for Cloudflare's code 10007, and another failure of the same read. */
class WorkerNotFound extends Schema.TaggedError<
  WorkerNotFound,
  { readonly brand: unique symbol }
>()("WorkerNotFound", {}) {}

class CloudflareRateLimited extends Schema.TaggedError<
  CloudflareRateLimited,
  { readonly brand: unique symbol }
>()("CloudflareRateLimited", {}) {}

type Failure = WorkerNotFound | CloudflareRateLimited;

const notFound = WorkerNotFound.make({});
const rateLimited = CloudflareRateLimited.make({});

/** A deployments read that fails with `failure` on its first `failures` attempts, then succeeds. */
const flakyRead = (failures: number, failure: Failure) => {
  let attempts = 0;

  const read = Effect.suspend(() => {
    attempts += 1;

    return attempts <= failures ? Effect.fail(failure) : Effect.succeed("deployments");
  });

  return { read: retryScriptRegistration(read), attempts: () => attempts };
};

const onTestClock = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.provide(effect, TestClock.layer()));

describe("retryScriptRegistration", { timeout: 30_000 }, () => {
  it("waits out a registry lag of more than 90 seconds", () =>
    onTestClock(
      Effect.gen(function* () {
        // #610's Browsers Worker still answered 10007 about 93 s after its first upload.
        const { read, attempts } = flakyRead(25, notFound);
        const fiber = yield* Effect.forkChild(read);
        yield* TestClock.adjust("4 minutes");
        expect(yield* Fiber.await(fiber)).toStrictEqual(Exit.succeed("deployments"));
        expect(attempts()).toBe(26);
      }),
    ));

  it("gives up with WorkerNotFound after about three minutes", () =>
    onTestClock(
      Effect.gen(function* () {
        const { read, attempts } = flakyRead(Number.POSITIVE_INFINITY, notFound);
        const fiber = yield* Effect.forkChild(read);
        yield* TestClock.adjust("170 seconds");
        expect(fiber.pollUnsafe()).toBeUndefined();
        yield* TestClock.adjust("30 seconds");
        expect(yield* Fiber.await(fiber)).toStrictEqual(Exit.fail(notFound));
        expect(attempts()).toBe(41);
      }),
    ));

  it("does not retry any other failure", () =>
    onTestClock(
      Effect.gen(function* () {
        const { read, attempts } = flakyRead(1, rateLimited);
        expect(yield* Effect.exit(read)).toStrictEqual(Exit.fail(rateLimited));
        expect(attempts()).toBe(1);
      }),
    ));
});
