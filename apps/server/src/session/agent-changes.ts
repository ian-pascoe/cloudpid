// The Agent changes and cloudpid reports of the Session's Run (`docs/architecture/agent-changes.md`;
// `docs/architecture/agent-capabilities.md` → cloudpid reports): each change the `environment` tools make, and each report
// `cloudpid_report` files, is kept in the Session's storage, so an eviction does not lose it, until the Run's end turns them
// into one Notification listing them (`runNotice`), besides the usual `finished` or `failed` one.
// @effect-diagnostics missingPipeableSignature:off -- `runNotice` is a plain function of two lists.
import type { RunReport } from "@cloudpid/extensions/cloudpid-report";
import type { RunChange } from "@cloudpid/extensions/environment";
import type { PushNotice } from "@cloudpid/extensions/notify";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import type { SettingsKv } from "./settings.ts";

/** The Agent changes made since the last Notification of them, oldest first, in the Session's key-value storage. */
const RUN_CHANGES_KEY = "run-agent-changes";

/** The cloudpid reports filed since the last Notification of them, oldest first. */
const RUN_REPORTS_KEY = "run-cloudpid-reports";

/** The longest title a report is told by in the Notification. */
const MAX_NOTICE_TITLE = 80;

/** What the Run made of one kind, kept in the Session's key-value storage. */
export type RunLog<A> = {
  /** Keep `item` until it is notified. */
  readonly record: (item: A) => Effect.Effect<void>;
  /** The items not notified yet, oldest first. */
  readonly pending: Effect.Effect<ReadonlyArray<A>>;
  /** Forget the oldest `count` items, once notified: those recorded meanwhile wait for the next Run's end. */
  readonly drop: (count: number) => Effect.Effect<void>;
};

/** The Run's Agent changes, kept in the Session's key-value storage. */
export type RunChanges = RunLog<RunChange>;

const runLog = <A>(kv: SettingsKv, key: string): RunLog<A> => {
  const read = () => kv.get<ReadonlyArray<A>>(key) ?? [];

  return {
    record: (item) => Effect.sync(() => kv.put(key, [...read(), item])),
    pending: Effect.sync(read),
    drop: (count) => Effect.sync(() => kv.put(key, Arr.drop(read(), count))),
  };
};

export const runChanges = (kv: SettingsKv): RunChanges => runLog(kv, RUN_CHANGES_KEY);

/** The Run's cloudpid reports, kept in the Session's key-value storage. */
export const runReports = (kv: SettingsKv): RunLog<RunReport> => runLog(kv, RUN_REPORTS_KEY);

/** `title` cut to `MAX_NOTICE_TITLE` characters, an ellipsis ending a cut one. */
const cutTitle = (title: string): string =>
  title.length <= MAX_NOTICE_TITLE ? title : `${title.slice(0, MAX_NOTICE_TITLE - 1)}…`;

/**
 * The Notification of a Run's Agent changes and cloudpid reports, one clause each when it has any: each change's tool,
 * Environment (none for a change to the Settings) and field, then each report's number and title, oldest first. A tap
 * opens the Session, whose transcript has each change's card and each report's call.
 */
export const runNotice = (
  changes: ReadonlyArray<RunChange>,
  reports: ReadonlyArray<RunReport>,
): PushNotice => {
  const changed =
    changes.length === 0
      ? []
      : [
          `${changes.length === 1 ? "1 Agent change" : `${changes.length} Agent changes`}: ${Arr.join(
            Arr.map(changes, ({ tool, environmentName, field }) =>
              environmentName === undefined
                ? `${tool} ${field}`
                : `${tool} ${JSON.stringify(environmentName)} ${field}`,
            ),
            "; ",
          )}`,
        ];

  const filed = Arr.map(
    reports,
    ({ number, title }) => `cloudpid report #${number} filed: ${cutTitle(title)}`,
  );

  return { kind: "notice", body: Arr.join([...changed, ...filed], "; ") };
};
