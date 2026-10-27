// The summary of a Session's subagents it keeps in the Registry (ADR-0024, `docs/spec.md` → Client and protocol →
// Registry), so the Session list shows them without waking each Session DO: what the task graph's panel shows of each
// agent, less its conversation and model. The Session DO writes it when the list changes, at most once an interval with
// the last state always written, and at each start. A write that fails is logged and left due: the host's heartbeat
// writes it again (`retry`, `settle`), as it reports the Session's status again.
// @effect-diagnostics asyncFunction:off globalDate:off globalTimers:off missingPipeableSignature:off
import type { GraphAgent, SessionAgent } from "@cloudpid/protocol";
import * as Arr from "effect/Array";

/** The shortest time between two writes of the summary. */
export const AGENTS_REPORT_INTERVAL_MS = 2_000;

/** What the Registry keeps of the task graph's `agents`, in their order (parents before their children). */
export const sessionAgentsOf = (agents: ReadonlyArray<GraphAgent>): SessionAgent[] =>
  Arr.map(agents, ({ id, parent, role, status, branch }): SessionAgent => {
    const kept: SessionAgent = { id, parent, role, status };

    return branch === undefined ? kept : { ...kept, branch };
  });

export type AgentsReportOptions = {
  /** The summary as the Session stands now. */
  readonly read: () => Promise<ReadonlyArray<SessionAgent>>;
  /** Write it to the Registry; rejects when the write failed or took too long. */
  readonly write: (agents: ReadonlyArray<SessionAgent>) => Promise<void>;
  /** Defaults to `AGENTS_REPORT_INTERVAL_MS`. */
  readonly intervalMs?: number | undefined;
  readonly warn: (message: string, cause: unknown) => void;
  /** The time in milliseconds; defaults to `Date.now`. */
  readonly now?: () => number;
};

/** The Session's subagents as the Registry has them, and the writes that keep them so. In memory, per instance. */
export class AgentsReport {
  readonly #options: AgentsReportOptions;
  /** What the Registry holds, as JSON, as far as this instance knows: unknown at first, so a new instance writes. */
  #reported: string | undefined;
  /** Whether the agents may differ from what was last written: at first, after a change, and after a failed write. */
  #due = true;
  /** Whether the last write failed: it waits for `retry` or `settle` rather than a timer of its own. */
  #failed = false;
  #lastAt = Number.NEGATIVE_INFINITY;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running: Promise<boolean> | undefined;
  #stopped = false;

  constructor(options: AgentsReportOptions) {
    this.#options = options;
  }

  /** The agents may have changed: write them within the interval. */
  changed(): void {
    this.#due = true;
    this.#failed = false;
    this.#schedule();
  }

  /** Write again what a failed write left due, within the interval; nothing when nothing is due. */
  retry(): void {
    if (!this.#due) return;

    this.#failed = false;
    this.#schedule();
  }

  /**
   * Read the agents now and write them if they differ from what the Registry was last given, without waiting for the
   * interval, and say whether the Registry has them as they were then read. It reads whether or not a change was
   * noticed: the task graph's watch tells of one asynchronously, so a stop can settle before it did. Never rejects.
   */
  async settle(): Promise<boolean> {
    while (this.#running !== undefined) await this.#running;

    if (this.#stopped) return false;

    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }

    return this.#start();
  }

  /** Write nothing more: the Harness is closing. */
  stop(): void {
    this.#stopped = true;

    if (this.#timer !== undefined) clearTimeout(this.#timer);

    this.#timer = undefined;
  }

  #schedule(): void {
    if (this.#stopped || this.#timer !== undefined || this.#running !== undefined) return;

    const interval = this.#options.intervalMs ?? AGENTS_REPORT_INTERVAL_MS;
    const wait = Math.max(0, this.#lastAt + interval - (this.#options.now ?? Date.now)());

    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#start();
    }, wait);
  }

  #start(): Promise<boolean> {
    const running = this.#write().finally(() => {
      this.#running = undefined;

      // A change during the write is written after it; a failure waits to be retried.
      if (this.#due && !this.#failed) this.#schedule();
    });

    this.#running = running;

    return running;
  }

  async #write(): Promise<boolean> {
    this.#due = false;
    this.#lastAt = (this.#options.now ?? Date.now)();

    try {
      const agents = await this.#options.read();
      const text = JSON.stringify(agents);

      if (text === this.#reported) return true;

      await this.#options.write(agents);
      this.#reported = text;

      return true;
    } catch (cause) {
      this.#options.warn("Reporting the Session's subagents to the Registry failed", cause);
      // The Registry may have applied it before failing, so what it holds is unknown again.
      this.#reported = undefined;
      this.#due = true;
      this.#failed = true;

      return false;
    }
  }
}
