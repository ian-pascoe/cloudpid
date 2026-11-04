// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off globalDate:off -- pure rules over plain values.
// What cloudpid decides about an MCP task without doing anything (`docs/architecture/mcp-server-requests.md` → MCP tasks):
// the inline window, how often to poll, how long to back off, what each way a poll can fail comes to (the Failures
// table), and the words the agent reads. Pure, so each rule is tested over values, and the inline window and the
// follower decide alike.
import {
  MCP_TASK_TIMEOUT_MS,
  type McpHostRequestResult,
  type McpTaskSnapshot,
} from "@cloudpid/mcp/types";
import * as Match from "effect/Match";
import * as Predicate from "effect/Predicate";
import type * as Schema from "effect/Schema";
import type { HostLost } from "./client.ts";
import type { McpTaskRecord, McpTaskState } from "./task-state.ts";

/** The longest an agent's call waits for its MCP task: 10 minutes from the task's creation. */
export const MCP_TASK_WINDOW_MAX_MS = 10 * 60 * 1000;

/** A server's `timeout` when its entry has none, in seconds (`DEFAULT_MCP_TIMEOUT`). */
const DEFAULT_TIMEOUT_S = 60;

/** The inline window of a call to a server whose `timeout` is `timeout` (seconds): the smaller of it and 10 minutes. */
export const windowMsOf = (timeout: Schema.Json | undefined): number =>
  Math.min(
    (Predicate.isNumber(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_S) * 1000,
    MCP_TASK_WINDOW_MAX_MS,
  );

/** The server's `pollIntervalMs`, kept within 1 second and 5 minutes. */
export const clampPollMs = (ms: number): number => Math.min(Math.max(ms, 1000), 5 * 60 * 1000);

/** What the next poll's delay depends on. */
export type Cadence = {
  /** How old the task is. */
  readonly ageMs: number;
  /** The server's own `pollIntervalMs` from its last answer, if it gave one. */
  readonly pollIntervalMs?: number | undefined;
  /** Whether the call has returned and the follower polls. */
  readonly background: boolean;
  /** Whether every question the task waits on is the owner's: nothing the server does changes it soon. */
  readonly ownerOnly: boolean;
  /** A number in `[0, 1)` for the jitter, so the rule stays pure. */
  readonly jitter: number;
};

/**
 * How long to wait before the next `tasks/get`: the server's `pollIntervalMs` (clamped, read again from each answer);
 * without one 2 s until the task is a minute old, 5 s until 10 minutes, then 30 s. At least 5 s in the background, at
 * least 30 s while every question waits on the owner, and 0–10 % more, so a Session's tasks do not poll in step. (At most
 * 60 s for a stdio server comes with stdio tasks.)
 */
export const pollDelayMs = (cadence: Cadence): number => {
  let base =
    cadence.pollIntervalMs !== undefined
      ? clampPollMs(cadence.pollIntervalMs)
      : cadence.ageMs < 60_000
        ? 2000
        : cadence.ageMs < MCP_TASK_WINDOW_MAX_MS
          ? 5000
          : 30_000;

  if (cadence.background) base = Math.max(base, 5000);

  if (cadence.ownerOnly) base = Math.max(base, 30_000);

  return Math.round(base * (1 + 0.1 * cadence.jitter));
};

/** How long to wait after the first, second … failure in a row: 5 s, 15 s, 30 s, 1 min, 2 min, 5 min, then 10 min. */
const BACKOFF_MS: ReadonlyArray<number> = [5000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000];

/** The delay after `count` failures in a row (at least one). */
export const backoffMs = (count: number): number =>
  BACKOFF_MS[Math.min(Math.max(count, 1), BACKOFF_MS.length) - 1] ?? 600_000;

/** A task whose polls kept failing for this long is `unknown`: 24 hours. */
export const MCP_TASK_FAILURE_LIMIT_MS = 24 * 60 * 60 * 1000;

/** How long a `-32602` ("unknown task") is retried before the task is `unknown`: 2 minutes. */
export const MCP_TASK_UNKNOWN_GRACE_MS = 2 * 60 * 1000;

/** How long cloudpid follows a task before it stops (`tasks/cancel`, then `stopped`): 7 days from its creation. */
export const MCP_TASK_FOLLOW_MS = 7 * 24 * 60 * 60 * 1000;

/** How long an ignored `tasks/cancel` is waited for before cloudpid stops following: 2 minutes. */
export const MCP_TASK_CANCEL_GRACE_MS = 2 * 60 * 1000;

/** What a `tasks/cancel` may spend connecting before its request is sent: 15 seconds (an engine that is starting, a sign-in's token). */
export const MCP_TASK_CONNECT_MARGIN_MS = 15_000;

/**
 * How long a cancel marked `sending` is left to its sender before the follower sends it again: 75 seconds, which is
 * longer than any send of a call that is still alive: the request's bound (`MCP_TASK_TIMEOUT_MS`, 30 s), the wire's one
 * resend of a cut (another 30 s) and `MCP_TASK_CONNECT_MARGIN_MS`. A send in this instance's memory is never sent again
 * at all (`cancelAttempted`), and Stop all, Archive, Delete and the sweep do not wait for this age (`cancelDue`).
 */
export const MCP_TASK_CANCEL_SENDING_MS = 2 * MCP_TASK_TIMEOUT_MS + MCP_TASK_CONNECT_MARGIN_MS;

/**
 * How long Stop all, Archive and Delete wait for a server to take the `tasks/cancel` they send before the task's record
 * ends anyway: 2 seconds (`docs/architecture/mcp-server-requests.md` → MCP tasks, Lifecycle). The cancel is best effort
 * past it.
 */
export const MCP_TASK_STOP_CANCEL_MS = 2_000;

/** How long a result is kept after the task ended: 7 days. */
export const MCP_TASK_RESULT_KEPT_MS = 7 * 24 * 60 * 60 * 1000;

/** What a `tasks/*` poll came to, as the follower and the inline window decide on it. */
export type PollOutcome =
  /** The task as the server last reported it, and, once `completed`, its result. */
  | {
      readonly kind: "state";
      readonly snapshot: McpTaskSnapshot;
      readonly result: Extract<McpHostRequestResult, { readonly _tag: "TaskState" }>;
    }
  /** The poll did not get an answer that says: unreachable, cut, a deploy, a host that did not answer. */
  | { readonly kind: "retry"; readonly why: string }
  /** `-32602`: the server does not know the task, which a restart or a lag can look like for a moment. */
  | { readonly kind: "gone" }
  /** The server needs the owner signed in (a 401, a rejected token or a step-up). */
  | { readonly kind: "sign_in" }
  /** Another connection key; `identity` says whether it is the same server. */
  | { readonly kind: "changed"; readonly conn: string; readonly identity?: string | undefined }
  /** The server is switched off, hidden or removed. */
  | { readonly kind: "off" }
  /** The task cannot be followed any more: the era dropped, the extension went, `-32021`, or an answer of the wrong kind. */
  | { readonly kind: "unknown"; readonly reason: string };

/** What a failed `tasks/get` says, as a poll's outcome. */
const failedPoll = (
  error: Extract<McpHostRequestResult, { readonly _tag: "CallFailed" }>["error"],
) =>
  Match.value(error).pipe(
    Match.tag("NotFound", (found) =>
      found.code === -32602
        ? ({ kind: "gone" } as const)
        : ({ kind: "retry", why: "the server could not find it" } as const),
    ),
    Match.tag("SignInRequired", "StepUpRequired", () => ({ kind: "sign_in" }) as const),
    Match.tag(
      "Unsupported",
      (unsupported) => ({ kind: "unknown", reason: unsupported.message }) as const,
    ),
    Match.tag("ServerError", (server) =>
      server.code === -32021
        ? ({ kind: "unknown", reason: "the server no longer supports MCP tasks" } as const)
        : ({ kind: "retry", why: "the server answered with an error" } as const),
    ),
    Match.orElse(() => ({ kind: "retry", why: "the server could not be reached" }) as const),
  );

/** What `answer` of a `tasks/get` comes to. */
export const readPoll = (answer: McpHostRequestResult | HostLost): PollOutcome => {
  if (Predicate.isTagged(answer, "TaskState")) {
    return { kind: "state", snapshot: answer.task, result: answer };
  }

  if (Predicate.isTagged(answer, "CallFailed")) return failedPoll(answer.error);

  if (Predicate.isTagged(answer, "ServerChanged")) {
    return { kind: "changed", conn: answer.conn, identity: answer.identity };
  }

  if (Predicate.isTagged(answer, "NotAllowed") || Predicate.isTagged(answer, "UnknownServer")) {
    return { kind: "off" };
  }

  if (Predicate.isTagged(answer, "HostLost") || Predicate.isTagged(answer, "HostFailed")) {
    return { kind: "retry", why: "the MCP host could not be reached" };
  }

  // Any other answer is not what a `tasks/get` gets, from this host or an unknown one.
  return { kind: "retry", why: "the host answered something else" };
};

/** `text` with control and bidi-override characters taken out, cut to 1,000 characters: a status line the server wrote. */
export const statusLine = (text: string | undefined): string | undefined => {
  if (text === undefined) return undefined;

  // oxlint-disable-next-line eslint/no-control-regex -- SAFETY: Matching control characters is the purpose of this expression.
  const clean = text.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, " ").trim();

  return clean === "" ? undefined : clean.slice(0, 1000);
};

/** A duration for the agent: `45s`, `14m`, `2h 5m`. */
export const durationText = (ms: number): string => {
  const seconds = Math.max(0, Math.round(ms / 1000));

  if (seconds < 90) return `${seconds}s`;

  const minutes = Math.round(seconds / 60);

  if (minutes < 120) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);

  return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
};

/** A size for the header: `12 KB`, `3 MB`, `340 B`. */
export const sizeText = (bytes: number): string =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${Math.round(bytes / 1024)} KB`
      : `${Math.round(bytes / (1024 * 1024))} MB`;

/** What the model reads when a call detaches, after its window of `windowMs`. */
export const detachedText = (record: McpTaskRecord): string =>
  `${record.server}'s ${record.modelTool} runs as MCP task ${record.handle} and is still ${
    record.status === "input_required" ? "waiting for input" : "working"
  } after ${durationText(record.windowMs)}. It goes on in the background and you are told when it ends. ` +
  `mcp_task_wait waits for it now (task "${record.handle}"), mcp_task_cancel stops it, mcp_tasks lists your MCP tasks.`;

/** The header of the entry that tells the agent a task ended: cloudpid's words only, never the server's text. */
export const endedHeader = (record: McpTaskRecord, now: number): string => {
  const end = record.end;
  const status: McpTaskState = end?.status ?? record.status;
  const after = durationText((end?.at ?? now) - record.createdAt);

  const result =
    record.result === undefined
      ? ""
      : ` | result=${sizeText(record.result.bytes)}${
          record.result.images > 0
            ? `, ${record.result.images} image${record.result.images === 1 ? "" : "s"}`
            : ""
        }`;

  return `[MCP task ended | task=${record.handle} | server=${record.server} | tool=${record.modelTool} | status=${status} | after=${after}${result}]`;
};

/**
 * The entry's whole text: the header, and one line that says what to do. A task that cloudpid stopped following adds
 * cloudpid's reason; the server's own words (a `failed` task's error) are read through `mcp_task_wait`, never here.
 */
export const endedText = (record: McpTaskRecord, now: number, keptUntil: number): string => {
  const status = record.end?.status ?? record.status;
  const reason = status === "unknown" || status === "stopped" ? record.end?.reason : undefined;

  return `${endedHeader(record, now)}\nMCP task ${record.handle} ended${
    reason === undefined ? "" : ` (${reason})`
  }. Read its result with mcp_task_wait (task "${record.handle}"); it is kept until ${new Date(keptUntil).toISOString().slice(0, 10)}.`;
};
