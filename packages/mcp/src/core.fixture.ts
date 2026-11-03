/**
 * What every core test hands `connect`: a target, the call contexts, in-memory row stores and the deps around an
 * injected `fetch`.
 */
// @effect-diagnostics missingPipeableSignature:off
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type { Complete, McpDeps, McpTarget, Outcome, RowStore, TaskStarted } from "./index.ts";
import { expect } from "vitest";
import type { McpCallContext, McpError } from "./types.ts";

export const TARGET: McpTarget = { url: "https://mcp.example.test/mcp" };

export const HOST: McpCallContext = { origin: "host" };

export const AGENT: McpCallContext = { origin: "agent", conversation: "conversation-1" };

export const OWNER: McpCallContext = { origin: "owner", conversation: "conversation-1" };

/** `outcome`, which a test expects to have completed (no MCP task). */
export const completed = <A>(outcome: Outcome<A>): Complete<A> => {
  if (outcome.kind !== "complete") {
    throw new Error(`Expected a completed outcome, got ${outcome.kind}`);
  }

  return outcome;
};

/** `outcome`, which a test expects to have started an MCP task. */
export const started = <A>(outcome: Outcome<A>): TaskStarted => {
  if (outcome.kind !== "task") throw new Error(`Expected an MCP task, got ${outcome.kind}`);

  return outcome;
};

/** What `effect` came to: `{ value }`, or `{ failed }` with its error, as `failedWith` matches. */
export const settled = <A>(effect: Effect.Effect<A, McpError>) =>
  effect.pipe(
    Effect.map((value) => ({ value })),
    Effect.catch((error) => Effect.succeed({ failed: error })),
  );

/** A row store over one in-memory cell, with the row it holds now. */
export const memoryStore = (initial?: Schema.Json) => {
  let row = initial;

  const store: RowStore = {
    get: Effect.sync(() => row),
    set: (next) =>
      Effect.sync(() => {
        row = next;
      }),
    drop: Effect.sync(() => {
      row = undefined;
    }),
  };

  return { store, current: () => row };
};

/** Deps that reach the server through `fetch`, with fresh in-memory row stores unless given. */
export const testDeps = (
  fetch: typeof globalThis.fetch,
  overrides?: Partial<McpDeps>,
): McpDeps => ({
  fetch,
  eras: memoryStore().store,
  sessions: memoryStore().store,
  capabilities: () => ({}),
  clientInfo: { name: "cloudpid", version: "test" },
  ...overrides,
});

/**
 * The real clock, except that a sleep of up to 10 s (the core's retry delays) passes at once and is recorded, in
 * milliseconds. Longer sleeps (timeouts) run on the real clock.
 */
export const recordingClock = () => {
  const real = Effect.runSync(Clock.clockWith(Effect.succeed));
  const slept: Array<number> = [];

  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: () => real.currentTimeMillisUnsafe(),
    currentTimeMillis: real.currentTimeMillis,
    currentTimeNanosUnsafe: () => real.currentTimeNanosUnsafe(),
    currentTimeNanos: real.currentTimeNanos,
    monotonicTimeNanosUnsafe: () => real.monotonicTimeNanosUnsafe(),
    monotonicTimeNanos: real.monotonicTimeNanos,
    sleep: (duration) =>
      Duration.toMillis(duration) > 10_000
        ? real.sleep(duration)
        : Effect.sync(() => {
            slept.push(Duration.toMillis(duration));
          }),
  };

  return { clock, slept };
};

/** Runs a test program in a scope of its own, so its connections close when it ends, on `clock` if given. */
export const run = <A, E>(program: Effect.Effect<A, E, Scope.Scope>, clock?: Clock.Clock) =>
  program.pipe(
    Effect.scoped,
    clock === undefined ? (scoped) => scoped : Effect.provideService(Clock.Clock, clock),
    Effect.runPromise,
  );

/** What a test expects of an outcome `{ failed }` whose error is of class `error`, with `fields` among its own. */
export const failedWith = (
  error: abstract new (...args: never) => McpError,
  fields: Readonly<Record<string, Schema.Json>> = {},
) => ({ failed: expect.objectContaining({ ...fields, constructor: error }) });
