// The pi-durable Harness as an Effect service (ADR-0003): a thin facade whose calls are `Effect.tryPromise` over the
// native Promise API. Each call gets the fiber's `ChordContext`, cancelled when the fiber is interrupted.
import * as Chord from "@earendil-works/chord/context";
import {
  type AgentChange,
  type Conversation,
  createRegistry,
  type Extension,
  Harness as PiHarness,
  type HarnessInspection,
  type HarnessOptions,
  type Storage,
} from "@earendil-works/pi-durable";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ChordContext } from "./chord.ts";

/** A pi-durable call failed. */
export class HarnessError extends Schema.TaggedError<
  HarnessError,
  { readonly brand: unique symbol }
>()("HarnessError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

/**
 * Call pi-durable Promise code `run` from a fiber, as `operation`. `run` gets the fiber's `ChordContext`, cancelled
 * when the fiber is interrupted; a rejection fails with a `HarnessError`.
 */
// @effect-diagnostics-next-line missingPipeableSignature:off -- the operation names the call, as `Effect.fn` does.
export const callDurable = <A>(
  operation: string,
  run: (context: Chord.Context) => Promise<A>,
): Effect.Effect<A, HarnessError> =>
  Effect.gen(function* () {
    const context = yield* ChordContext;

    return yield* Effect.tryPromise({
      try: (signal) => run(Chord.withAbortSignal(signal, context)),
      catch: (cause) => HarnessError.make({ operation, message: String(cause) }),
    });
  });

/** One open pi-durable Harness. */
export type HarnessService = {
  /** The native Harness, for code that stays Promise-based, such as tasks and commits. */
  readonly harness: PiHarness;
  /** Install `extension` in the Harness's registry, replacing an installed one with its name. */
  readonly install: (extension: Extension) => Effect.Effect<void>;
  /** The root conversation; `agent` applies when it is created. */
  readonly root: (agent: AgentChange) => Effect.Effect<Conversation, HarnessError>;
  /** Live tasks and unsettled submissions. */
  readonly inspect: Effect.Effect<HarnessInspection, HarnessError>;
  /** Start scheduling, continuing work an earlier instance left unfinished. */
  readonly resume: Effect.Effect<void>;
  /** Wait until no live non-background task is left. Cancelled with the fiber. */
  readonly waitForIdle: Effect.Effect<void, HarnessError>;
};

/** The open pi-durable Harness of this Durable Object. */
export class Harness extends Context.Service<Harness, HarnessService>()(
  "@cloudpid/effect-durable/Harness",
) {}

/**
 * Open a Harness on `storage` with an empty registry of its own; install extensions with `install` before `resume`, so
 * resumed work finds its tools.
 */
// @effect-diagnostics-next-line missingPipeableSignature:off -- as pi-durable's `Harness.open()`.
export const openHarness = (
  storage: Storage,
  options: Omit<HarnessOptions, "registry">,
): Effect.Effect<HarnessService, HarnessError> =>
  Effect.gen(function* () {
    const registry = createRegistry();

    const harness = yield* callDurable("open", (context) =>
      PiHarness.open(storage, { ...options, registry }, context),
    );

    return {
      harness,
      install: (extension) => Effect.sync(() => registry.install(extension)),
      root: (agent) => callDurable("root", (context) => harness.root(context, { agent })),
      inspect: callDurable("inspect", (context) => harness.inspect(context)),
      resume: Effect.sync(() => harness.resume()),
      waitForIdle: callDurable("waitForIdle", (context) => harness.waitForIdle(context)),
    } satisfies HarnessService;
  });
