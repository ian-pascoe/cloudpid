// The Agent changes of the Session's Run (`docs/spec.md` → Agent changes): each change the `environment` tools make is
// kept in the Session's storage, so an eviction does not lose it, until the Run's end turns them into one
// Notification listing them (`agentChangesNotice`), besides the usual `finished` or `failed` one.
import type { RunChange } from "@cloudpid/extensions/environment";
import type { PushNotice } from "@cloudpid/extensions/notify";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import type { SettingsKv } from "./settings.ts";

/** The Agent changes made since the last Notification of them, oldest first, in the Session's key-value storage. */
const RUN_CHANGES_KEY = "run-agent-changes";

/** The Run's Agent changes, kept in the Session's key-value storage. */
export type RunChanges = {
  /** Keep `change` until it is notified. */
  readonly record: (change: RunChange) => Effect.Effect<void>;
  /** The changes not notified yet, oldest first. */
  readonly pending: Effect.Effect<ReadonlyArray<RunChange>>;
  /** Forget the oldest `count` changes, once notified: those recorded meanwhile wait for the next Run's end. */
  readonly drop: (count: number) => Effect.Effect<void>;
};

export const runChanges = (kv: SettingsKv): RunChanges => {
  const read = () => kv.get<ReadonlyArray<RunChange>>(RUN_CHANGES_KEY) ?? [];

  return {
    record: (change) => Effect.sync(() => kv.put(RUN_CHANGES_KEY, [...read(), change])),
    pending: Effect.sync(read),
    drop: (count) => Effect.sync(() => kv.put(RUN_CHANGES_KEY, Arr.drop(read(), count))),
  };
};

/**
 * The Notification of a Run's Agent changes: each one's tool, Environment and field, oldest first. A tap opens the
 * Session, whose transcript has each change's card.
 */
export const agentChangesNotice = (changes: ReadonlyArray<RunChange>): PushNotice => ({
  kind: "notice",
  body: `${changes.length === 1 ? "1 Agent change" : `${changes.length} Agent changes`}: ${Arr.join(
    Arr.map(
      changes,
      ({ tool, environmentName, field }) => `${tool} ${JSON.stringify(environmentName)} ${field}`,
    ),
    "; ",
  )}`,
});
