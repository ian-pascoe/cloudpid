// @effect-diagnostics asyncFunction:off missingPipeableSignature:off globalDate:off -- the gate sits in pi-ai's Promise streams, and its failure carries pi-ai's own request timestamp.
// What a Session has spent and the limit on it (`docs/spec.md` → Settings, Operations → Usage). pi-durable keeps a ledger of
// each conversation's spend (`pi.usage`) and sums the Session's; the title call, which has no conversation, is kept in the
// Session's own storage. The limit is enforced at the model seam, as the secret scrubbing and the image limit are: a
// request over the limit never reaches the proxy and ends as an error the Harness already knows how to end a run with.
import { aroundRequests, failedStream, type ModelRequest } from "@cloudpid/telemetry";
import type { SessionUsage } from "@cloudpid/protocol";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import {
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai/utils/event-stream";
import type { UsageState } from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Record from "effect/Record";
import type { SettingsKv } from "./settings.ts";

/** Token counts and cost (US dollars) added up. */
export type Totals = {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly totalTokens: number;
  readonly cost: number;
};

export const NO_TOTALS: Totals = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: 0,
};

/** What pi-ai's `Usage` and pi-durable's ledger entries hold of it, which is all the Session adds up. */
type Spend = {
  readonly input?: number | undefined;
  readonly output?: number | undefined;
  readonly cacheRead?: number | undefined;
  readonly cacheWrite?: number | undefined;
  readonly totalTokens?: number | undefined;
  readonly cost?: { readonly total?: number | undefined } | undefined;
};

const finite = (value: number | undefined): number =>
  value !== undefined && Number.isFinite(value) ? value : 0;

/** `left` and `right` added. */
export const addTotals = (left: Totals, right: Spend): Totals => ({
  input: left.input + finite(right.input),
  output: left.output + finite(right.output),
  cacheRead: left.cacheRead + finite(right.cacheRead),
  cacheWrite: left.cacheWrite + finite(right.cacheWrite),
  totalTokens: left.totalTokens + finite(right.totalTokens),
  cost: left.cost + finite(right.cost?.total),
});

/** Everything the Session's ledger holds: the models' requests and the tools' own (a subagent's summaries, say). */
export const totalsOf = (state: UsageState): Totals =>
  Arr.reduce(
    [...Record.values(state.models), ...Record.values(state.tools)],
    NO_TOTALS,
    (total, spend: Spend) => addTotals(total, spend),
  );

/** Where the title calls' usage is kept: they belong to no conversation, so no ledger of pi-durable's holds them. */
const TITLE_USAGE_KEY = "title-usage";

/** What the title calls have cost so far. */
export const titleTotals = (kv: SettingsKv): Totals => kv.get<Totals>(TITLE_USAGE_KEY) ?? NO_TOTALS;

/** Add one title call's usage to what the Session keeps. */
export const recordTitleUsage = (kv: SettingsKv, usage: Spend): void =>
  kv.put(TITLE_USAGE_KEY, addTotals(titleTotals(kv), usage));

/** `left` and `right` added. */
export const plusTotals = (left: Totals, right: Totals): Totals => ({
  input: left.input + right.input,
  output: left.output + right.output,
  cacheRead: left.cacheRead + right.cacheRead,
  cacheWrite: left.cacheWrite + right.cacheWrite,
  totalTokens: left.totalTokens + right.totalTokens,
  cost: left.cost + right.cost,
});

/** What of the Harness the Session reads its spend from. */
export type Ledger = { readonly usage: (context: Context) => Promise<UsageState> };

/** What the Session has spent: every conversation's ledger summed, and the title calls'. */
export const sessionTotals = async (ledger: Ledger, kv: SettingsKv): Promise<Totals> =>
  plusTotals(totalsOf(await ledger.usage(BACKGROUND_CONTEXT)), titleTotals(kv));

/** What a client is shown: the totals and the limit in force. */
export const usageMessage = (totals: Totals, limit: number | null): SessionUsage => ({
  ...totals,
  limit,
});

/** Whether `spent` has reached `limit`. */
export const isOverLimit = (spent: number, limit: number): boolean => spent >= limit;

const dollars = (amount: number): string => `${amount.toFixed(2)} US dollars`;

/**
 * What a refused request ends with, and so what the owner reads (in the assistant message and in the push of the failed
 * Run). "Out of budget" is pi-ai's own marker of a limit that retrying will not lift, so a request that carries it is
 * never retried; digits and words that mark a transient failure (a status code, "timeout") are kept out of it.
 */
export const spendMessage = (spent: number, limit: number): string =>
  `This Session is out of budget: it has spent ${dollars(spent)} of its ${dollars(limit)} limit. Raise or clear the spend limit in the settings to go on.`;

export type SpendGate = {
  /** The spend limit in force, in US dollars; `null` for none. Read at each request. */
  readonly limit: () => number | null;
  /**
   * What the Session has spent. Undefined when it cannot be read: the request is let through, because a failed read
   * must not stop the owner's work.
   */
  readonly spent: () => Promise<number | undefined>;
};

/**
 * `models` with every request refused once the Session has spent its limit. A request is checked when it is made, so
 * those under way when the limit is crossed finish, and a Session overshoots by what they cost; a request refused
 * costs nothing, and ends as an `error` message that the Harness ends the Run with (compaction and summaries included,
 * as they go through the same models). With no limit, requests pass untouched.
 */
export const limitingModels = (models: Models, gate: SpendGate): Models =>
  aroundRequests(models, ({ model }: ModelRequest, start): AssistantMessageEventStream => {
    const limit = gate.limit();

    if (limit === null) return start();

    const stream = createAssistantMessageEventStream();

    gate
      .spent()
      .catch(() => undefined)
      .then(async (spent) => {
        if (spent !== undefined && isOverLimit(spent, limit)) {
          const refused = failedStream(model, spendMessage(spent, limit), Date.now());

          for await (const event of refused) stream.push(event);

          stream.end(await refused.result());

          return;
        }

        const inner = start();

        for await (const event of inner) stream.push(event);

        stream.end(await inner.result());
      })
      .catch((cause) => {
        const failed = failedStream(
          model,
          cause instanceof Error ? cause.message : String(cause),
          Date.now(),
        );

        void (async () => {
          for await (const event of failed) stream.push(event);

          stream.end(await failed.result());
        })();
      });

    return stream;
  });
