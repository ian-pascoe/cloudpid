// What the Workspace's Containers have cost (`docs/spec.md` → Operations → Usage), for the Session's header.
//
// Cloudflare's usage analytics (`container-analytics.ts`) are the figures, when the deployment has a token for them:
// they count real CPU time, the micro VM and egress. They trail by minutes, so the time since what they cover is
// estimated from what the Workspace saw: every launch is a run, from the launch record's `launchedAt` until the
// Container is stopped (the idle stop, a restart, the Workspace's removal) or, when it went away on its own, until it
// was last seen running; memory and disk are priced for every second of a run, and CPU as every vCPU at full use while
// commands ran on it (the Workspace cannot see a Container's CPU). Without a token everything is estimated.
//
// Reported usage is kept in two parts: what is settled (old enough that no late data is expected), added to once and
// never asked again, and the fresh part since, asked again at each refresh. Runs and busy spans are kept as intervals
// only for as long as the estimate may need them (after the settled part), and as lifetime totals per size.
// @effect-diagnostics asyncFunction:off globalDate:off preferEffectArray:off
import {
  addUsageSums,
  type ContainerUsageSums,
  containerRates,
  currentInstanceName,
  INSTANCE_RESOURCES,
  INSTANCE_TYPES,
  type InstanceType,
  NO_USAGE_SUMS,
  RENAMED_INSTANCE_TYPES,
  type StoredInstanceType,
  usageSumsCost,
} from "@cloudpid/config";
import type { ContainerUsage } from "@cloudpid/protocol";
import * as Record from "effect/Record";
import type { AnalyticsWindow, ContainerAnalytics } from "./container-analytics.ts";

/** The run of the Container that runs now, until it is closed. */
type OpenRun<Size = InstanceType> = {
  readonly instance: Size;
  /** The launch record's `launchedAt`, which tells this launch from the next. */
  readonly launchedAt: number;
  /** Epoch milliseconds it is counted from. */
  readonly startedAt: number;
  /** When it was last seen running. */
  readonly seenAt: number;
};

/** Epoch milliseconds, `end` excluded, on a Container of size `instance`. */
type Span<Size = InstanceType> = {
  readonly instance: Size;
  readonly start: number;
  readonly end: number;
};

type Reported = {
  /** What the analytics reported from the ledger's start to `settledThrough`, asked once. */
  readonly settled: ContainerUsageSums;
  readonly settledThrough: number;
  /** The last answer for `settledThrough` to `through`. */
  readonly fresh?: { readonly sums: ContainerUsageSums; readonly through: number } | undefined;
};

export type ContainerUsageRecord<Size extends string = InstanceType> = {
  /** Milliseconds of closed runs, per size, since the ledger began. */
  readonly runMs: Partial<Record<Size, number>>;
  /** Milliseconds commands ran on closed runs, per size. */
  readonly busyMs: Partial<Record<Size, number>>;
  /** Closed runs and busy spans the estimate may still need. */
  readonly runs: ReadonlyArray<Span<Size>>;
  readonly busy: ReadonlyArray<Span<Size>>;
  readonly open?: OpenRun<Size> | undefined;
  /** The size of the last run, once one ended and none runs. */
  readonly last?: Size | undefined;
  /** When the first run the ledger saw started: where the analytics are asked from. */
  readonly since?: number | undefined;
  readonly reported?: Reported | undefined;
};

/** The record as storage holds it: one kept before the sizes were renamed may name an old one (`custom-2`). */
export type StoredUsageRecord = ContainerUsageRecord<StoredInstanceType>;

export type ContainerUsageDeps = {
  readonly load: () => StoredUsageRecord | undefined;
  readonly save: (record: ContainerUsageRecord) => void;
  /** Whether a Container runs now. */
  readonly running: () => boolean;
  /** The launch of the Container that runs (or ran last): its size and when it launched. */
  readonly launch: () => Promise<
    { readonly instance: InstanceType; readonly launchedAt: number } | undefined
  >;
  /** The latest the running Container goes on without another use (its idle stop), when known. */
  readonly until: () => Promise<number | null>;
  /** Cloudflare's analytics of this Workspace's Containers; undefined when the deployment has no token for them. */
  readonly analytics?:
    | ((windows: ReadonlyArray<AnalyticsWindow>) => ReturnType<ContainerAnalytics>)
    | undefined;
  readonly now: () => number;
  readonly warn: (message: string) => void;
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How often a run's last sighting alone is written: a Container that dies is counted up to at most this before. */
const SEEN_WRITE_MS = 30_000;

/** How often the analytics are asked, at most. */
export const REFRESH_MS = MINUTE;

/** How far behind now the analytics are asked to: data for the last minutes may not have arrived. */
export const REPORT_LAG_MS = 5 * MINUTE;

/** How old usage must be to be settled: asked once more and never again. */
export const SETTLE_AFTER_MS = HOUR;

/** The longest window asked at once. */
const MAX_WINDOW_MS = DAY;

/** How far back the analytics are asked: their retention is about a month. */
const MAX_HISTORY_MS = 30 * DAY;

/** Without analytics, how long runs and busy spans are kept as intervals (the lifetime totals are kept regardless). */
const LOCAL_KEEP_MS = HOUR;

/** The most intervals of each kind kept: the oldest go first. */
const MAX_SPANS = 1000;

const floorMinute = (at: number): number => Math.floor(at / MINUTE) * MINUTE;

/** The milliseconds of `span` after `from`. */
const after = (span: Span, from: number): number =>
  Math.max(0, span.end - Math.max(span.start, from));

const plus = (
  totals: Partial<Record<InstanceType, number>>,
  instance: InstanceType,
  ms: number,
): Partial<Record<InstanceType, number>> => ({
  ...totals,
  [instance]: (totals[instance] ?? 0) + ms,
});

/** Every name a size may be stored under: those of today, and the old names of renamed ones. */
const STORED_SIZES: ReadonlyArray<StoredInstanceType> = [
  ...INSTANCE_TYPES,
  ...Record.keys(RENAMED_INSTANCE_TYPES),
];

/** `totals` with each size under the name it has now, an old name's added to its new one's. */
const currentTotals = (
  totals: Partial<Record<StoredInstanceType, number>>,
): Partial<Record<InstanceType, number>> => {
  let current: Partial<Record<InstanceType, number>> = {};

  for (const size of STORED_SIZES) {
    const ms = totals[size];

    if (ms !== undefined) current = plus(current, currentInstanceName(size), ms);
  }

  return current;
};

const currentSpan = (span: Span<StoredInstanceType>): Span => ({
  ...span,
  instance: currentInstanceName(span.instance),
});

/**
 * The record `stored`, with every size under the name it has now (the resources are the same), so the runs of a size
 * since renamed are priced, and their time counted, as before.
 */
export const currentUsageRecord = (
  stored: StoredUsageRecord | undefined,
): ContainerUsageRecord | undefined =>
  stored === undefined
    ? undefined
    : {
        ...stored,
        runMs: currentTotals(stored.runMs),
        busyMs: currentTotals(stored.busyMs),
        runs: stored.runs.map(currentSpan),
        busy: stored.busy.map(currentSpan),
        open:
          stored.open === undefined
            ? undefined
            : { ...stored.open, instance: currentInstanceName(stored.open.instance) },
        last: stored.last === undefined ? undefined : currentInstanceName(stored.last),
      };

export class ContainerUsageLedger {
  readonly #deps: ContainerUsageDeps;
  #record: ContainerUsageRecord | undefined;
  /** When the busy span in progress began, if a command runs. */
  #busySince: number | undefined;
  #savedAt = 0;
  /** When the analytics were last asked, and whether a question is out. */
  #checkedAt = 0;
  #refreshing = false;
  #failing = false;
  /** One change at a time: each reads the launch record before it writes. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(deps: ContainerUsageDeps) {
    this.#deps = deps;
  }

  /** The Container was used: a launch since the last sighting opens a run. */
  seen(): Promise<void> {
    return this.#serial(() => this.#sync());
  }

  /** Commands began to run on the Container (`busy`), or the last one ended. */
  busy(busy: boolean): Promise<void> {
    return this.#serial(async () => {
      if (busy) {
        this.#busySince ??= this.#deps.now();

        return;
      }

      await this.#sync();

      const record = this.#current();
      const span = this.#busySpan(record, this.#deps.now());

      this.#busySince = undefined;

      if (span !== undefined) this.#write(this.#addBusy(record, span));
    });
  }

  /** The Container was stopped now: its run ends. */
  stopped(): Promise<void> {
    return this.#serial(async () => {
      const record = this.#current();

      if (record.open !== undefined) this.#write(this.#close(record, this.#deps.now()));
    });
  }

  /**
   * What the Workspace's Containers have cost so far; undefined when none has run. Asks the analytics again in the
   * background when they are due, so the next read has them.
   */
  read(): Promise<ContainerUsage | undefined> {
    return this.#serial(async () => {
      await this.#sync();

      const now = this.#deps.now();

      this.#refresh(now);

      const record = this.#current();
      const { open } = record;
      const instance = open?.instance ?? record.last;

      if (instance === undefined) return undefined;

      // `#sync` has closed the run of a Container that no longer runs; the open one is counted as if it ended now.
      const running = open !== undefined;
      const busy = running && this.#busySince !== undefined;
      const counted = open === undefined ? record : this.#close(record, now);

      const runSeconds =
        INSTANCE_TYPES.reduce((total, size) => total + (counted.runMs[size] ?? 0), 0) / 1000;

      const estimate = this.#estimate(counted);
      const { reported } = record;

      const sums =
        reported === undefined
          ? NO_USAGE_SUMS
          : addUsageSums(reported.settled, reported.fresh?.sums ?? NO_USAGE_SUMS);

      const cost = usageSumsCost(sums);

      return {
        instance,
        runSeconds,
        cpuSeconds: sums.cpuTimeSec + estimate.cpuSeconds,
        egressBytes: sums.txBytes,
        memory: cost.memory + estimate.memory,
        disk: cost.disk + estimate.disk,
        cpu: cost.cpu + estimate.cpu,
        egress: cost.egress,
        reportedThrough:
          reported === undefined ? null : (reported.fresh?.through ?? reported.settledThrough),
        asOf: now,
        running,
        busy,
        rates: running ? containerRates(instance) : { memory: 0, disk: 0, cpu: 0 },
        until: running && !busy ? await this.#deps.until() : null,
      };
    });
  }

  /**
   * What `record` (every run closed) costs past what the analytics reported: from the lifetime totals when they
   * reported nothing yet, else from the runs and busy spans after the time they cover.
   */
  #estimate(record: ContainerUsageRecord) {
    const { reported } = record;
    let memory = 0;
    let disk = 0;
    let cpu = 0;
    let cpuSeconds = 0;

    const add = (instance: InstanceType, runMs: number, busyMs: number) => {
      const rates = containerRates(instance);

      memory += (runMs / 1000) * rates.memory;
      disk += (runMs / 1000) * rates.disk;
      cpu += (busyMs / 1000) * rates.cpu;
      cpuSeconds += (busyMs / 1000) * INSTANCE_RESOURCES[instance].vcpu;
    };

    if (reported === undefined) {
      for (const size of INSTANCE_TYPES) {
        add(size, record.runMs[size] ?? 0, record.busyMs[size] ?? 0);
      }
    } else {
      const from = reported.fresh?.through ?? reported.settledThrough;

      for (const span of record.runs) add(span.instance, after(span, from), 0);

      for (const span of record.busy) add(span.instance, 0, after(span, from));
    }

    return { memory, disk, cpu, cpuSeconds };
  }

  /** Ask the analytics for what is due, unless they were asked within `REFRESH_MS` or a question is out. */
  #refresh(now: number): void {
    const { analytics } = this.#deps;
    const record = this.#current();

    if (
      analytics === undefined ||
      record.since === undefined ||
      this.#refreshing ||
      now - this.#checkedAt < REFRESH_MS
    ) {
      return;
    }

    const start =
      record.reported?.settledThrough ?? floorMinute(Math.max(record.since, now - MAX_HISTORY_MS));

    const settleTo = floorMinute(now - SETTLE_AFTER_MS);
    const freshTo = floorMinute(now - REPORT_LAG_MS);

    const settle =
      settleTo > start ? { from: start, to: Math.min(settleTo, start + MAX_WINDOW_MS) } : undefined;

    const freshFrom = settle?.to ?? start;

    // Far behind (catching up on days), only the settled part is asked; the estimate covers the rest meanwhile.
    const fresh =
      freshTo > freshFrom && freshTo - freshFrom <= MAX_WINDOW_MS
        ? { from: freshFrom, to: freshTo }
        : undefined;

    const windows = [settle, fresh].filter((window) => window !== undefined);

    if (windows.length === 0) return;

    this.#refreshing = true;
    this.#checkedAt = now;

    void analytics(windows)
      .then((answers) =>
        this.#serial(async () => {
          this.#failing = false;

          const current = this.#current();
          const kept = current.reported ?? { settled: NO_USAGE_SUMS, settledThrough: start };

          // Another refresh moved the settled part meanwhile: this answer is of the old one.
          if (kept.settledThrough !== start) return;

          let index = 0;
          let reported: Reported = kept;

          if (settle !== undefined) {
            reported = {
              settled: addUsageSums(kept.settled, answers[index++] ?? NO_USAGE_SUMS),
              settledThrough: settle.to,
            };
          }

          reported = {
            settled: reported.settled,
            settledThrough: reported.settledThrough,
            fresh:
              fresh === undefined
                ? undefined
                : { sums: answers[index] ?? NO_USAGE_SUMS, through: fresh.to },
          };

          this.#write({ ...current, reported });
        }),
      )
      .catch((cause: unknown) => {
        if (!this.#failing) {
          this.#deps.warn(
            `Container analytics could not be read; the Container's cost is estimated until they can: ${cause instanceof Error ? cause.message : String(cause)}`,
          );
        }

        this.#failing = true;
      })
      .finally(() => {
        this.#refreshing = false;
      });
  }

  #serial<A>(run: () => Promise<A>): Promise<A> {
    const next = this.#queue.then(run);

    this.#queue = next.catch(() => undefined);

    return next;
  }

  #current(): ContainerUsageRecord {
    this.#record ??= currentUsageRecord(this.#deps.load()) ?? {
      runMs: {},
      busyMs: {},
      runs: [],
      busy: [],
    };

    return this.#record;
  }

  /** Keep `record`, its intervals pruned to those the estimate may still need. */
  #write(record: ContainerUsageRecord): void {
    const now = this.#deps.now();

    const keepFrom =
      record.reported?.settledThrough ??
      (this.#deps.analytics === undefined ? now - LOCAL_KEEP_MS : (record.since ?? now));

    const prune = (spans: ReadonlyArray<Span>) =>
      spans.filter((span) => span.end > keepFrom).slice(-MAX_SPANS);

    const kept = { ...record, runs: prune(record.runs), busy: prune(record.busy) };

    this.#record = kept;
    this.#savedAt = now;
    this.#deps.save(kept);
  }

  /** The busy span in progress, cut to the open run and to `end`. */
  #busySpan(record: ContainerUsageRecord, end: number): Span | undefined {
    const { open } = record;

    if (this.#busySince === undefined || open === undefined) return undefined;

    const start = Math.max(this.#busySince, open.startedAt);

    return end > start ? { instance: open.instance, start, end } : undefined;
  }

  #addBusy(record: ContainerUsageRecord, span: Span): ContainerUsageRecord {
    return {
      ...record,
      busyMs: plus(record.busyMs, span.instance, span.end - span.start),
      busy: [...record.busy, span],
    };
  }

  /** `record` with its open run ended at `end`, and the busy span in progress counted up to it. */
  #close(record: ContainerUsageRecord, end: number): ContainerUsageRecord {
    const { open } = record;

    if (open === undefined) return record;

    const busy = this.#busySpan(record, end);
    const withBusy = busy === undefined ? record : this.#addBusy(record, busy);

    const run: Span = {
      instance: open.instance,
      start: open.startedAt,
      end: Math.max(end, open.startedAt),
    };

    return {
      ...withBusy,
      runMs: plus(withBusy.runMs, run.instance, run.end - run.start),
      runs: [...withBusy.runs, run],
      open: undefined,
      last: open.instance,
    };
  }

  /**
   * Bring the open run up to date with the Container: one that runs is seen now, a new launch ends the run before it
   * (at its last sighting) and opens its own, and a Container gone on its own ends its run at its last sighting.
   */
  async #sync(): Promise<void> {
    const now = this.#deps.now();
    const record = this.#current();
    const { open } = record;

    if (!this.#deps.running()) {
      if (open !== undefined) {
        this.#write(this.#close(record, open.seenAt));
        this.#busySince = undefined;
      }

      return;
    }

    const launch = await this.#deps.launch();

    if (open !== undefined && (launch === undefined || launch.launchedAt === open.launchedAt)) {
      const seen = { ...record, open: { ...open, seenAt: now } };

      if (now - this.#savedAt >= SEEN_WRITE_MS) this.#write(seen);
      else this.#record = seen;

      return;
    }

    const closed = open === undefined ? record : this.#close(record, open.seenAt);
    const launchedAt = launch?.launchedAt ?? now;
    // Never counted twice: a run starts after the one before it was last seen.
    const startedAt = Math.min(now, Math.max(launchedAt, open?.seenAt ?? launchedAt));

    this.#write({
      ...closed,
      since: closed.since ?? startedAt,
      open: {
        instance: launch?.instance ?? closed.last ?? "cpu-2",
        launchedAt,
        startedAt,
        seenAt: now,
      },
    });
  }
}
