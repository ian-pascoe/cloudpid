// The notices of the held stops of a Session's Workspace (docs/architecture/container.md → Idle stop): a Container
// kept past the hold cap without owner or agent activity is stopped by its Workspace DO, which cannot reach the Sessions
// (the Workspaces Worker has no binding to them). So each Session asks for the stops after the last it showed when a
// client connects and before it admits input, and shows each as a notice: a display-only entry with a `notice` title,
// which the transcript shows and the model never sees, written once per stop (its request ID).
// @effect-diagnostics asyncFunction:off
import type { SubmissionDraft } from "@earendil-works/pi-durable";

/** A held stop as the Workspace DO keeps it (`IdleStop`'s `HeldStop`). */
export type HeldStopRecord = {
  readonly at: number;
  readonly lastActivity: number;
  readonly holds: number;
};

/** The entry kind of a held stop's notice. */
export const HELD_STOP_KIND = "cloudpid.container-held-stop";

/** Where the Session keeps the time of the last held stop it showed, in its key-value storage. */
const SEEN_KEY = "container-held-stops-seen";

/** The notice's title: why the Container stopped. */
const noticeTitle = (stop: HeldStopRecord): string =>
  `Container stopped: held for ${Math.round((stop.at - stop.lastActivity) / 60_000)} minutes without owner or agent activity`;

/** The display-only write of `stop`'s notice, once per stop. */
export const heldStopEntry = (stop: HeldStopRecord) =>
  ({
    type: "write",
    requestId: `container-held-stop:${stop.at}`,
    entry: {
      kind: HELD_STOP_KIND,
      data: { notice: noticeTitle(stop), at: stop.at, holds: stop.holds },
    },
  }) satisfies SubmissionDraft;

export type NoticeHeldStopsDeps = {
  readonly kv: {
    get<T>(key: string): T | undefined;
    put<T>(key: string, value: T): void;
  };
  readonly now: number;
  /** The held stops of the Session's Workspace after `after`, oldest first. */
  readonly read: (after: number) => Promise<ReadonlyArray<HeldStopRecord>>;
  /** Write a notice to the Session's active branch. */
  readonly write: (draft: ReturnType<typeof heldStopEntry>) => Promise<void>;
};

/**
 * Show the held stops after the last one shown. The first check only marks where the Session starts, so a stop from
 * before it is not shown. Each stop is marked shown once its notice is written: one that fails is asked for again.
 */
export const noticeHeldStops = async ({ kv, now, read, write }: NoticeHeldStopsDeps) => {
  const seen = kv.get<number>(SEEN_KEY);

  if (seen === undefined) {
    kv.put(SEEN_KEY, now);

    return;
  }

  for (const stop of await read(seen)) {
    await write(heldStopEntry(stop));
    kv.put(SEEN_KEY, stop.at);
  }
};
