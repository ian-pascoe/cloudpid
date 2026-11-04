// @effect-diagnostics asyncFunction:off missingPipeableSignature:off globalDate:off -- the gate sits in pi-ai's Promise streams, and its failure carries pi-ai's own request timestamp.
// What a Session has spent and the limit on it (`docs/architecture/overview.md` → Settings, `docs/architecture/operations.md` → Usage). pi-durable keeps a ledger of
// each conversation's spend (`pi.usage`) and sums the Session's; the title call, which has no conversation, is kept in the
// Session's own storage. The limit is enforced at the model seam, as the secret scrubbing and the image limit are: a
// request over the limit never reaches the proxy and ends as an error the Harness already knows how to end a run with.
import { aroundRequests, failedStream, type ModelRequest } from "@cloudpid/telemetry";
import type { ContainerUsage, ContextUsage, SessionUsage } from "@cloudpid/protocol";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import {
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai/utils/event-stream";
import type { UsageState } from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import type { Mutable } from "effect/Types";
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

/**
 * Where the usage of the Session's own model calls is kept (the title call, a branch summary): they belong to no
 * conversation, so no ledger of pi-durable's holds them. The key is from when only the title call was kept there.
 */
const UNLEDGERED_USAGE_KEY = "title-usage";

/** What the Session's own model calls have cost so far. */
export const unledgeredTotals = (kv: SettingsKv): Totals =>
  kv.get<Totals>(UNLEDGERED_USAGE_KEY) ?? NO_TOTALS;

/** Add one of the Session's own model calls' usage to what the Session keeps. */
export const recordUnledgeredUsage = (kv: SettingsKv, usage: Spend): void =>
  kv.put(UNLEDGERED_USAGE_KEY, addTotals(unledgeredTotals(kv), usage));

/**
 * Where the Sampling requests' usage is kept: an MCP server's requests run on the Session's models but belong to no
 * conversation's ledger, so they are counted here, by the conversation whose call carried the request and the server that
 * made it (`docs/architecture/mcp-server-requests.md` → Sampling requests, Usage).
 */
const SAMPLING_USAGE_KEY = "mcp-sampling-usage";

/** What one conversation's calls of one server cost in Sampling requests. */
export type SamplingEntry = Totals & {
  readonly conversationId: number;
  readonly server: string;
  /** The requests made, answered or not once they reached a model. */
  readonly requests: number;
};

/** What the Sampling requests have cost the Session, and how many reached a model. */
export type SamplingTotals = Totals & { readonly requests: number };

/** The Sampling usage kept, by conversation and server. */
export const samplingEntries = (kv: SettingsKv): ReadonlyArray<SamplingEntry> =>
  kv.get<ReadonlyArray<SamplingEntry>>(SAMPLING_USAGE_KEY) ?? [];

/** The Sampling usage of the whole Session. */
export const samplingTotals = (kv: SettingsKv): SamplingTotals =>
  Arr.reduce(
    samplingEntries(kv),
    { ...NO_TOTALS, requests: 0 },
    (total: SamplingTotals, entry): SamplingTotals => ({
      ...plusTotals(total, entry),
      requests: total.requests + entry.requests,
    }),
  );

/** Add one Sampling request's usage to what `server`'s calls in `conversationId` have cost. */
export const recordSamplingUsage = (
  kv: SettingsKv,
  who: { readonly conversationId: number; readonly server: string },
  usage: Spend,
): void => {
  const entries = samplingEntries(kv);

  const held = Arr.findFirst(
    entries,
    (each) => each.conversationId === who.conversationId && each.server === who.server,
  ).pipe(Option.getOrUndefined);

  const next: SamplingEntry = {
    ...addTotals(held ?? NO_TOTALS, usage),
    conversationId: who.conversationId,
    server: who.server,
    requests: (held?.requests ?? 0) + 1,
  };

  kv.put(SAMPLING_USAGE_KEY, [...Arr.filter(entries, (each) => each !== held), next]);
};

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

/** What the Session has spent: every conversation's ledger summed, the title calls' and the Sampling requests'. */
export const sessionTotals = async (ledger: Ledger, kv: SettingsKv): Promise<Totals> =>
  plusTotals(
    plusTotals(totalsOf(await ledger.usage(BACKGROUND_CONTEXT)), unledgeredTotals(kv)),
    samplingTotals(kv),
  );

/**
 * What a client is shown: the totals, the limit in force, what the Workspace's Containers cost and how full the active
 * branch's Context Window is, each when known.
 */
export const usageMessage = (
  totals: Totals,
  limit: number | null,
  container: ContainerUsage | null = null,
  context: ContextUsage | null = null,
  sampling: SamplingTotals | null = null,
): SessionUsage => {
  const message: Mutable<SessionUsage> = { ...totals, limit };

  if (container !== null) message.container = container;

  if (context !== null) message.context = context;

  if (sampling !== null && sampling.requests > 0) message.sampling = sampling;

  return message;
};

/** Whether `spent` has reached `limit`. */
export const isOverLimit = (spent: number, limit: number): boolean => spent >= limit;

/** Cents, or the first digit of an amount under a cent, so a small limit does not read as zero. */
const dollars = (amount: number): string =>
  `${amount > 0 && amount < 0.01 ? amount.toPrecision(1) : amount.toFixed(2)} US dollars`;

/** Why a Sampling request is refused at the limit, in a clause: the owner reads it on the call. */
export const spendReason = (spent: number, limit: number): string =>
  `it has spent ${dollars(spent)} of its ${dollars(limit)} limit`;

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
  /**
   * Told why `spent` failed, when it did and the request went through. Every gated request reads the ledgers of all
   * the Session's conversations, which is cheap until a Session has very many subagents.
   */
  readonly failed?: (reason: string) => void;
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
      .catch((error) => {
        gate.failed?.(String(error));

        return undefined;
      })
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

/**
 * The gate over the Session's spend: its `limit`, and what is spent read from `ledger` (the open Harness, absent until it
 * is: a request made before that is not held) and the Session's own storage. One gate holds the Harness's requests and a
 * Sampling request alike.
 */
export const ledgerGate = (input: {
  readonly limit: () => number | null;
  readonly ledger: () => Ledger | undefined;
  readonly kv: SettingsKv;
  readonly failed?: ((reason: string) => void) | undefined;
}): SpendGate => {
  const gate: Mutable<SpendGate> = {
    limit: input.limit,
    spent: async () => {
      const ledger = input.ledger();

      return ledger === undefined ? undefined : (await sessionTotals(ledger, input.kv)).cost;
    },
  };

  if (input.failed !== undefined) gate.failed = input.failed;

  return gate;
};
