// @effect-diagnostics missingPipeableSignature:off
// Who is driving the owner's Owner tabs (`docs/architecture/browser.md` → Browser Pane): while a `browser` call works in an
// Owner tab, the Session tells every client which Owner tab and which conversation (the root agent's, or a subagent's),
// so the Browser Pane can show that the agent is driving and the owner can tell their clicks from the agent's. The calls
// live in this instance only: an eviction cuts them off, and a new instance starts with none.
import type { OwnerTabDriver } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export type { OwnerTabDriver } from "@cloudpid/protocol";

/**
 * The `browser` calls working in Owner tabs, as the Session keeps them: which there are now, and a way to run a call as
 * one of them, told to the clients while it works.
 */
export type OwnerTabDriversService = {
  /** The calls working in Owner tabs now, each Owner tab and conversation once, in the order they started. */
  readonly current: Effect.Effect<ReadonlyArray<OwnerTabDriver>>;
  /** Run `effect` as `driver`'s call in its Owner tab: listed, and told to the clients, from its start to its end. */
  readonly driving: (
    driver: OwnerTabDriver,
  ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
};

/** The Session's `browser` calls in Owner tabs. */
export class OwnerTabDrivers extends Context.Service<OwnerTabDrivers, OwnerTabDriversService>()(
  "@cloudpid/extensions/browser/drivers/OwnerTabDrivers",
) {}

export type OwnerTabDriversOptions = {
  /** Tell every client which calls work in Owner tabs; called whenever that changes. */
  readonly announce: (drivers: ReadonlyArray<OwnerTabDriver>) => Effect.Effect<void>;
};

/**
 * The calls in Owner tabs, kept in memory: each call that `driving` wraps is listed from its start to its end, and
 * `announce` is told the list (each Owner tab and conversation once) every time a call starts or ends.
 */
export const makeOwnerTabDrivers = ({
  announce,
}: OwnerTabDriversOptions): OwnerTabDriversService => {
  /** Each call in an Owner tab, by a key of its own: two calls of one conversation in one Owner tab are two entries. */
  const calls = new Map<symbol, OwnerTabDriver>();

  const list = (): ReadonlyArray<OwnerTabDriver> => {
    const seen = new Set<string>();

    return Arr.filter([...calls.values()], ({ ownerTabId, conversationId }) => {
      const key = `${conversationId}:${ownerTabId}`;

      if (seen.has(key)) return false;

      seen.add(key);

      return true;
    });
  };

  return {
    current: Effect.sync(list),
    driving: (driver) => (effect) =>
      Effect.acquireUseRelease(
        Effect.suspend(() => {
          const key = Symbol(driver.ownerTabId);

          calls.set(key, driver);

          return Effect.as(announce(list()), key);
        }),
        () => effect,
        (key) =>
          Effect.suspend(() => {
            calls.delete(key);

            return announce(list());
          }),
      ),
  };
};

/** The Session's `OwnerTabDrivers`, telling the clients through `announce`. */
export const ownerTabDriversLayer = (options: OwnerTabDriversOptions) =>
  Layer.sync(OwnerTabDrivers, () => makeOwnerTabDrivers(options));
