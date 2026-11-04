// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off asyncFunction:off globalDate:off -- conversions of plain values.
// What an MCP task's end is to the agent, and where the result is kept (`docs/architecture/mcp-server-requests.md` → MCP
// tasks, Results): the follower converts a task's end into the result the model reads, once, and stores it in a pool of
// 16 MiB per Session for 7 days after the end, the oldest dropped when full; `mcp_task_wait` reads it back as often as it
// is kept. A completed task takes the ordinary MCP result path (`./result.ts`), so text, images, a Result Spill and
// `isError` are as a synchronous call's; every other end is cloudpid's own words, with `details.error` saying which. The
// server's `taskId` is in no word here: only the handle.
import {
  type McpEngineValue,
  type McpHostTaskState,
  type McpStructuredOutput,
  MiB,
} from "@cloudpid/mcp/types";
import type { JsonValue } from "@earendil-works/chord";
import type { ToolExecutionResult } from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type { Mutable } from "effect/Types";
import type { McpDetails } from "./details.ts";
import { type McpResultContext, failedWith, resultFor, streamFailure } from "./result.ts";
import { readStreamed } from "./stream.ts";
import type { Spill } from "./spill.ts";
import { durationText, MCP_TASK_RESULT_KEPT_MS } from "./task-policy.ts";
import { type McpTaskBy, type McpTaskRecord, type McpTaskResultNote } from "./task-state.ts";

/** The Durable Object's synchronous key-value storage, as the pool uses it. */
export type McpTaskStorage = {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
  delete(key: string): boolean;
};

/** The most the pool holds of a Session's results: 16 MiB. */
export const MCP_TASK_POOL_BYTES = 16 * MiB;

/** The characters of one stored chunk: a Durable Object's key-value value is kept well under its limit. */
const CHUNK_CHARS = 256 * 1024;

const INDEX_KEY = "mcp-task:pool";

type PoolEntry = {
  readonly handle: string;
  readonly bytes: number;
  readonly chunks: number;
  readonly at: number;
};

const chunkKey = (handle: string, n: number) => `mcp-task:r:${handle}:${n}`;

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));

/** A result as the model reads it, as the pool keeps it. */
export type StoredResult = ToolExecutionResult<JsonValue>;

/** The Session's pool of task results. */
export type McpResultPool = {
  /** Keep `result` of `handle`; what it is, or `undefined` when it is too large to keep. */
  readonly put: (
    handle: string,
    result: StoredResult,
    now: number,
  ) => McpTaskResultNote | undefined;
  /** The result kept for `handle`, unless it expired, was dropped for room, or never was kept. */
  readonly get: (handle: string, now: number) => StoredResult | undefined;
  /** Drop the result kept for `handle`, if any: Stop all, Archive and delete drop what a conversation held. */
  readonly drop: (handle: string) => void;
  /** When the result of `handle` is kept until. */
  readonly keptUntil: (handle: string) => number | undefined;
};

export const resultPool = (storage: McpTaskStorage): McpResultPool => {
  const index = (): ReadonlyArray<PoolEntry> =>
    storage.get<ReadonlyArray<PoolEntry>>(INDEX_KEY) ?? [];

  const remove = (entry: PoolEntry) => {
    for (let n = 0; n < entry.chunks; n += 1) storage.delete(chunkKey(entry.handle, n));
  };

  /** The entries still kept at `now`; the rest are deleted. */
  const live = (now: number): ReadonlyArray<PoolEntry> => {
    const all = index();
    const kept = Arr.filter(all, (entry) => entry.at + MCP_TASK_RESULT_KEPT_MS > now);

    if (kept.length < all.length) {
      for (const entry of all) if (!kept.includes(entry)) remove(entry);

      storage.put(INDEX_KEY, kept);
    }

    return kept;
  };

  return {
    put: (handle, result, now) => {
      const text = JSON.stringify(result);
      const bytes = new TextEncoder().encode(text).length;

      if (bytes > MCP_TASK_POOL_BYTES) return undefined;

      let entries = Arr.filter(live(now), (entry) => entry.handle !== handle);
      let total = Arr.reduce(entries, bytes, (sum, entry) => sum + entry.bytes);

      // The oldest go until it fits.
      while (total > MCP_TASK_POOL_BYTES && entries.length > 0) {
        const [oldest, ...rest] = entries;

        if (oldest !== undefined) {
          remove(oldest);
          total -= oldest.bytes;
        }

        entries = rest;
      }

      const chunks = Math.max(1, Math.ceil(text.length / CHUNK_CHARS));

      for (let n = 0; n < chunks; n += 1) {
        storage.put(chunkKey(handle, n), text.slice(n * CHUNK_CHARS, (n + 1) * CHUNK_CHARS));
      }

      storage.put(INDEX_KEY, [...entries, { handle, bytes, chunks, at: now }]);

      const images = Arr.filter(
        result.output ?? [],
        (block) => Predicate.hasProperty(block, "type") && block.type === "image",
      ).length;

      return { key: chunkKey(handle, 0), bytes, images };
    },
    get: (handle, now) => {
      const entry = Arr.findFirst(live(now), (each) => each.handle === handle);

      if (Option.isNone(entry)) return undefined;

      let text = "";

      for (let n = 0; n < entry.value.chunks; n += 1) {
        const part = storage.get<string>(chunkKey(handle, n));

        if (part === undefined) return undefined;

        text += part;
      }

      const parsed = decodeJson(text);

      // SAFETY: what `put` stored, a `ToolExecutionResult` serialized as JSON.
      return Option.isSome(parsed) ? (parsed.value as StoredResult) : undefined;
    },
    drop: (handle) => {
      const all = index();
      const kept = Arr.filter(all, (entry) => entry.handle !== handle);

      for (const entry of all) if (entry.handle === handle) remove(entry);

      if (kept.length < all.length) storage.put(INDEX_KEY, kept);
    },
    keptUntil: (handle) => {
      const entry = Arr.findFirst(index(), (each) => each.handle === handle);

      return Option.isSome(entry) ? entry.value.at + MCP_TASK_RESULT_KEPT_MS : undefined;
    },
  };
};

/** What `details` of a task's result says of it. */
export const taskDetails = (
  record: McpTaskRecord,
  base: McpDetails,
  background: boolean,
): McpDetails => {
  const mcpTask: Mutable<NonNullable<McpDetails["mcp_task"]>> = {
    task: record.handle,
    status: record.end?.status ?? record.status,
    after_ms: (record.end?.at ?? record.createdAt) - record.createdAt,
  };

  if (background) mcpTask.background = true;

  return { ...base, mcp_task: mcpTask };
};

/** Who a cancelled task was cancelled by, in words. */
const cancelledBy = (by: McpTaskBy | undefined): string =>
  Match.value(by).pipe(
    Match.when("owner", () => "by the owner"),
    Match.when("stop", () => "by the owner"),
    Match.when("agent", () => "at your request"),
    Match.orElse(() => "by the server"),
  );

/** The result a task that did not complete gives the agent: cloudpid's words, with `details.error` saying which. */
export const endedResult = (
  record: McpTaskRecord,
  background: boolean,
  details?: McpDetails,
): StoredResult => {
  const end = record.end;
  const status = end?.status ?? record.status;
  const who = `${record.server}'s MCP task ${record.handle} (${record.modelTool})`;
  const after = durationText((end?.at ?? record.createdAt) - record.createdAt);

  const base = taskDetails(
    record,
    details ?? { server: record.server, tool: record.tool },
    background,
  );

  switch (status) {
    case "failed":
      return failedWith(
        `${who} failed after ${after}${end?.reason === undefined ? "" : `: ${end.reason}`}${
          end?.code === undefined ? "" : ` (code ${end.code})`
        }.`,
        { ...base, error: "mcp_task_failed" },
      );

    case "cancelled": {
      const by = cancelledBy(end?.by);

      return failedWith(
        `${who} was cancelled ${by} after ${after}.${end?.reason === undefined ? "" : ` (${end.reason})`}`,
        { ...base, error: "mcp_task_cancelled" },
      );
    }

    case "stopped":
      return failedWith(
        `cloudpid stopped following ${who} after ${after}${end?.reason === undefined ? "" : `: ${end.reason}`}. It may still be running on the server.`,
        { ...base, error: "mcp_task_stopped" },
      );

    default:
      return failedWith(
        `The outcome of ${who} is unknown after ${after}${end?.reason === undefined ? "" : `: ${end.reason}`}. It may or may not have finished.`,
        { ...base, error: "mcp_task_unknown" },
      );
  }
};

/**
 * The value of a completed task's result: inline as it came, or read from the engine's stream, which can fail like any
 * large result; those ends are the call's own (`streamFailure`).
 */
const valueOf = async (
  result: McpEngineValue,
  base: McpDetails,
  signal: AbortSignal | undefined,
  use: (value: Schema.Json) => Promise<StoredResult>,
): Promise<StoredResult> => {
  if (result.kind === "inline") return use(result.value);

  const limits = signal === undefined ? { idleMs: 30_000 } : { signal, idleMs: 30_000 };

  return readStreamed(result.body, result.bytes, limits, async (streamed) => {
    if (streamed.kind === "value") return use(streamed.value);

    return streamed.kind === "aborted"
      ? failedWith("The MCP task's result could not be read: it was stopped", base)
      : streamFailure(streamed.kind, base, "tool");
  });
};

/**
 * The result of a completed task: the server's `CallToolResult` through the ordinary path, plus `details.mcp_task`. An
 * answer that holds none is an error result of cloudpid's.
 */
export const completedResult = async (
  record: McpTaskRecord,
  state: Pick<McpHostTaskState, "result" | "structuredOutput">,
  call: { readonly spill: Spill; readonly signal?: AbortSignal | undefined },
  background: boolean,
  details?: McpDetails,
): Promise<StoredResult> => {
  const base = taskDetails(
    record,
    details ?? { server: record.server, tool: record.tool },
    background,
  );

  if (state.result === undefined) {
    return failedWith(`${record.server}'s MCP task ${record.handle} completed without a result.`, {
      ...base,
      error: "mcp_task_unknown",
    });
  }

  const context: McpResultContext = { kind: "model", details: base, spill: call.spill };
  const structured: McpStructuredOutput | undefined = state.structuredOutput;

  return valueOf(state.result, base, call.signal, (value) => resultFor(value, structured, context));
};
