// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- plain functions over values.
// The record of each Sampling request, kept in the Session's storage and outside History (`docs/architecture/
// mcp-server-requests.md` → Sampling requests, Records; #387 D6, X8): what was asked and answered, redacted of the
// Session's Secrets before it is written. It never enters any model's context. A record is at most 256 KiB, and the
// Session keeps 16 MiB of them: past it the least recently written are reduced to stubs (their status, Role, model,
// tokens and cost stay; the messages, tools and reply go).
import type * as Schema from "effect/Schema";
import type { McpQuestionStorage } from "./question-records.ts";

/** The most bytes one record holds. */
export const SAMPLING_RECORD_BYTES = 256 * 1024;

/** The most bytes of full records the Session keeps; the least recently written become stubs past it. */
export const SAMPLING_RECORDS_BYTES = 16 * 1024 * 1024;

/** The longest one text of a record's messages or reply: a record is never context, so it keeps the start. */
export const SAMPLING_RECORD_TEXT = 16 * 1024;

const INDEX_KEY = "mcp-sampling:index";

const recordKey = (id: string) => `mcp-sampling:r:${id}`;

/** How a request ended. */
export type McpSamplingStatus =
  /** Answered with the model's reply. */
  | "answered"
  /** Turned down: by the owner, the Spend limit, the call's cap, or a request that cannot be served. */
  | "refused"
  /** The model failed, or the sample ran out of time. */
  | "failed"
  /** Not settled yet. */
  | "running";

/** What a record keeps of one Sampling request. A field the request did not have is absent. */
export type McpSamplingRecord = {
  readonly id: string;
  readonly server: string;
  readonly tool: string;
  readonly origin: "agent";
  readonly conversationId: number;
  readonly callId: string;
  /** The request's number within its call, from 1. */
  readonly sequence: number;
  readonly status: McpSamplingStatus;
  /** Why it was refused or failed, in cloudpid's words. */
  readonly reason?: string;
  readonly role?: string;
  readonly model?: string;
  readonly hints?: ReadonlyArray<string>;
  readonly priorities?: {
    readonly cost?: number;
    readonly speed?: number;
    readonly intelligence?: number;
  };
  readonly systemPrompt?: string;
  /** The messages the request added to the call's earlier ones: all of them for its first request. */
  readonly messages?: ReadonlyArray<Schema.Json>;
  /** How many of the call's earlier messages `messages` leaves out. */
  readonly messagesFrom?: number;
  readonly tools?: ReadonlyArray<string>;
  readonly toolChoice?: string;
  readonly reply?: Schema.Json;
  readonly stopReason?: string;
  readonly tokens?: number;
  readonly cost?: number;
  /** Who decided: `definition` (its `sampling` is `allow`) or `cloudpid` (a refusal of its own rules). */
  readonly by: "definition" | "cloudpid";
  readonly notes: ReadonlyArray<string>;
  readonly askedAt: number;
  readonly settledAt?: number;
  /** True once the record was reduced to a stub. */
  readonly stub?: boolean;
};

type IndexEntry = {
  readonly id: string;
  readonly bytes: number;
  readonly at: number;
  readonly stub: boolean;
};

/** `text` cut to `max` characters, with an ellipsis. */
export const cutText = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;

const bytesOf = (text: string): number => new TextEncoder().encode(text).byteLength;

/** `record` without what makes it large. */
const stubOf = (record: McpSamplingRecord): McpSamplingRecord => {
  const { systemPrompt: _s, messages: _m, tools: _t, reply: _r, ...rest } = record;

  return { ...rest, stub: true };
};

export type McpSamplingRecords = {
  /** Keep `record` (written again as it settles); false when the storage cannot take it. */
  readonly put: (record: McpSamplingRecord, now: number) => boolean;
  readonly list: () => ReadonlyArray<McpSamplingRecord>;
  readonly get: (id: string) => McpSamplingRecord | undefined;
};

/** The records over the Session's storage. */
export const samplingRecords = (storage: McpQuestionStorage): McpSamplingRecords => {
  const index = (): ReadonlyArray<IndexEntry> => storage.get<IndexEntry[]>(INDEX_KEY) ?? [];

  const put: McpSamplingRecords["put"] = (record, now) => {
    try {
      const whole = JSON.stringify(record);
      const kept = bytesOf(whole) > SAMPLING_RECORD_BYTES ? stubOf(record) : record;
      const bytes = bytesOf(JSON.stringify(kept));

      const others = index().filter((entry) => entry.id !== record.id);

      const next: Array<IndexEntry> = [
        ...others,
        { id: record.id, bytes, at: now, stub: kept.stub === true },
      ];

      // Past the Session's bound the least recently written become stubs (the record just written never does).
      let total = next.reduce((sum, entry) => (entry.stub ? sum : sum + entry.bytes), 0);

      for (const entry of [...next].sort((left, right) => left.at - right.at)) {
        if (total <= SAMPLING_RECORDS_BYTES) break;

        if (entry.stub) continue;

        const held = storage.get<McpSamplingRecord>(recordKey(entry.id));

        if (held !== undefined && entry.id !== record.id) {
          const small = stubOf(held);
          const smallBytes = bytesOf(JSON.stringify(small));

          storage.put(recordKey(entry.id), small);
          next[next.findIndex((each) => each.id === entry.id)] = {
            id: entry.id,
            bytes: smallBytes,
            at: entry.at,
            stub: true,
          };
          total -= entry.bytes;
        }
      }

      storage.put(recordKey(record.id), kept);
      storage.put(INDEX_KEY, next);

      return true;
    } catch {
      return false;
    }
  };

  return {
    put,
    get: (id) => storage.get<McpSamplingRecord>(recordKey(id)),
    list: () =>
      index().flatMap((entry) => {
        const held = storage.get<McpSamplingRecord>(recordKey(entry.id));

        return held === undefined ? [] : [held];
      }),
  };
};
