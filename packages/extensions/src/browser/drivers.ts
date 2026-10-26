// @effect-diagnostics missingPipeableSignature:off
// Who is driving the owner's Owner tabs (`docs/spec.md` → Browser → Browser Pane): while a `browser` run works in an
// Owner tab, the Session tells every client which Owner tab and which conversation (the root agent's, or a subagent's),
// so the Browser Pane can show that the agent is driving and the owner can tell their clicks from the agent's. Runs
// live in this instance only: an eviction cuts them off, and a new instance starts with none.
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** A run working in an Owner tab: the Owner tab, and the conversation whose run it is. */
export type OwnerTabDriver = { readonly ownerTabId: string; readonly conversationId: number };

export type OwnerTabDriversService = {
  /** The runs working in Owner tabs now, each Owner tab and conversation once, in the order they started. */
  readonly current: Effect.Effect<ReadonlyArray<OwnerTabDriver>>;
  /** Run `effect` as `driver`'s run in its Owner tab: listed, and told to the clients, from its start to its end. */
  readonly driving: (
    driver: OwnerTabDriver,
  ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
};

/** The Session's runs in Owner tabs. */
export class OwnerTabDrivers extends Context.Service<OwnerTabDrivers, OwnerTabDriversService>()(
  "@cloudpid/extensions/browser/drivers/OwnerTabDrivers",
) {}

export type OwnerTabDriversOptions = {
  /** Tell every client which runs work in Owner tabs; called whenever that changes. */
  readonly announce: (drivers: ReadonlyArray<OwnerTabDriver>) => Effect.Effect<void>;
};

export const makeOwnerTabDrivers = ({
  announce,
}: OwnerTabDriversOptions): OwnerTabDriversService => {
  /** Each run in an Owner tab, by a key of its own: two runs of one conversation in one Owner tab are two entries. */
  const runs = new Map<symbol, OwnerTabDriver>();

  const list = (): ReadonlyArray<OwnerTabDriver> => {
    const seen = new Set<string>();

    return Arr.filter([...runs.values()], ({ ownerTabId, conversationId }) => {
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

          runs.set(key, driver);

          return Effect.as(announce(list()), key);
        }),
        () => effect,
        (key) =>
          Effect.suspend(() => {
            runs.delete(key);

            return announce(list());
          }),
      ),
  };
};

/** The Session's `OwnerTabDrivers`, telling the clients through `announce`. */
export const ownerTabDriversLayer = (options: OwnerTabDriversOptions) =>
  Layer.sync(OwnerTabDrivers, () => makeOwnerTabDrivers(options));
