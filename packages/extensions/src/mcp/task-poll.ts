// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- pure rules over plain values.
// One `tasks/get` of an MCP task and what the Failures table makes of its answer (`docs/architecture/
// mcp-server-requests.md` → MCP tasks, Failures): the inline window and the follower both poll, so they decide alike. A
// decision is a plain value computed from a record as read, applied to the record in the commit that stores it, so the
// record is written only when a task's status or message changed, a failure was counted or it ended.
import type {
  McpHostRequestContext,
  McpHostRequestResult,
  McpHostTaskCancel,
  McpHostTaskGet,
} from "@cloudpid/mcp/types";
import * as Predicate from "effect/Predicate";
import type { HostLost } from "./client.ts";
import {
  MCP_TASK_FAILURE_LIMIT_MS,
  MCP_TASK_GRACE_MS,
  backoffMs,
  type PollOutcome,
  statusLine,
} from "./task-policy.ts";
import type { McpTaskBy, McpTaskEnd, McpTaskRecord, McpTaskState } from "./task-state.ts";

/** The `tasks/get` of `record`: the task, its tool (a result is checked against it) and the connection it was started on. */
export const taskGet = (record: McpTaskRecord, ctx: McpHostRequestContext): McpHostTaskGet => ({
  op: "tasks/get",
  server: record.server,
  params: { taskId: record.taskId, tool: record.tool, conn: record.conn },
  ctx,
});

/** The `tasks/cancel` of `record`; the host allows it for a server switched off since. */
export const taskCancel = (
  record: McpTaskRecord,
  ctx: McpHostRequestContext,
): McpHostTaskCancel => ({
  op: "tasks/cancel",
  server: record.server,
  params: { taskId: record.taskId, tool: record.tool, conn: record.conn },
  ctx,
});

/** Whether a `tasks/cancel` took: the server acknowledged it, or has no such task any more. */
export const cancelTook = (answer: McpHostRequestResult | HostLost): boolean =>
  Predicate.isTagged(answer, "TaskAck") ||
  (Predicate.isTagged(answer, "CallFailed") &&
    Predicate.isTagged(answer.error, "NotFound") &&
    answer.error.code === -32602);

/**
 * The times a decision uses, which a test shortens (`McpTasksOptions.timing`); the defaults are the spec's.
 */
export type McpTaskLimits = {
  readonly graceMs?: number;
  readonly failureMs?: number;
  readonly backoffMs?: number;
};

/** The fields of a record a poll changes. */
export type Patch = {
  status?: McpTaskState;
  statusMessage?: string;
  lastPolledAt?: number;
  polls?: number;
  ttlMs?: number | null;
  pollIntervalMs?: number;
  conn?: string;
  repinned?: boolean;
};

/** What a poll decided: the changes to the record, and whether the task ended or the follower should look again. */
export type Decision = {
  /** The fields to write. */
  readonly patch: Patch;
  readonly failures: McpTaskRecord["failures"];
  /** Whether the task's status or message differs from what the record held, or it ended: the record is written. */
  readonly changed: boolean;
  /** The task ended: how. */
  readonly end?: Omit<McpTaskEnd, "at">;
  /** The server is switched off or gone: send it `tasks/cancel` before the end is written. */
  readonly cancel?: boolean;
  /** After a failure: how long to wait before the next poll, overriding the cadence. */
  readonly retryInMs?: number;
  /** The poll did not get an answer from the server and says why, for the follower's log. */
  readonly why?: string;
};

const NO_FAILURES: McpTaskRecord["failures"] = { count: 0 };

/** The task as a poll found it, applied. */
const stateDecision = (
  record: McpTaskRecord,
  outcome: Extract<PollOutcome, { readonly kind: "state" }>,
  now: number,
): Decision => {
  const { snapshot } = outcome;
  const message = statusLine(snapshot.statusMessage);
  const patch: Patch = { lastPolledAt: now, polls: record.polls + 1, ttlMs: snapshot.ttlMs };

  if (snapshot.pollIntervalMs !== undefined) patch.pollIntervalMs = snapshot.pollIntervalMs;

  if (message !== undefined) patch.statusMessage = message;

  const moved = snapshot.status !== record.status || message !== record.statusMessage;

  const ended = (status: McpTaskState, by: McpTaskBy, extra?: Partial<McpTaskEnd>): Decision => ({
    patch,
    failures: NO_FAILURES,
    changed: true,
    end: { status, by, ...extra },
  });

  switch (snapshot.status) {
    case "completed":
      return ended("completed", "server");
    case "failed": {
      const reason = statusLine(snapshot.error.message);
      const extra: Partial<McpTaskEnd> = { code: snapshot.error.code };

      if (reason !== undefined) extra.reason = reason;

      return ended("failed", "server", extra);
    }

    case "cancelled":
      // Ours when cloudpid asked for it: the owner's, the agent's, Stop's.
      return ended("cancelled", record.cancel?.by ?? "server");
    default:
      return {
        patch: { ...patch, status: snapshot.status },
        failures: NO_FAILURES,
        changed: moved,
      };
  }
};

/**
 * What `outcome` of a `tasks/get` of `record` comes to, at `now` (ms): the task as the server reports it; a failure
 * counted and retried after a backoff (`unknown` after 24 hours of them); a `-32602` retried for 2 minutes, then `unknown`;
 * a server whose identity changed `stopped`, nothing sent; a re-pin to a new connection key when only its headers or
 * OAuth changed; a switched-off server cancelled; and the failures that cannot be followed `unknown`.
 */
export const decide = (
  record: McpTaskRecord,
  outcome: PollOutcome,
  now: number,
  limits: McpTaskLimits = {},
): Decision => {
  switch (outcome.kind) {
    case "state":
      return stateDecision(record, outcome, now);
    case "retry": {
      const since = record.failures.since ?? now;
      const count = record.failures.count + 1;
      const failures = { ...record.failures, count, since };

      if (now - since >= (limits.failureMs ?? MCP_TASK_FAILURE_LIMIT_MS)) {
        return {
          patch: { lastPolledAt: now },
          failures,
          changed: true,
          end: {
            status: "unknown",
            by: "cloudpid",
            reason: "the server could not be reached for 24 hours",
          },
        };
      }

      return {
        patch: { lastPolledAt: now },
        failures,
        changed: record.failures.count === 0,
        retryInMs: limits.backoffMs ?? backoffMs(count),
        why: outcome.why,
      };
    }

    case "gone": {
      const unknownSince = record.failures.unknownSince ?? now;
      const failures = { ...record.failures, unknownSince };

      if (record.repinned === true || now - unknownSince >= (limits.graceMs ?? MCP_TASK_GRACE_MS)) {
        return {
          patch: { lastPolledAt: now },
          failures,
          changed: true,
          end: { status: "unknown", by: "cloudpid", reason: "the server no longer knows it" },
        };
      }

      return {
        patch: { lastPolledAt: now },
        failures,
        changed: record.failures.unknownSince === undefined,
        retryInMs: limits.backoffMs ?? backoffMs(1),
        why: "the server does not know the task yet",
      };
    }

    case "sign_in":
      // After a re-pin the sign-in is no longer the one the task began with.
      if (record.repinned === true) {
        return {
          patch: { lastPolledAt: now },
          failures: record.failures,
          changed: true,
          end: {
            status: "unknown",
            by: "cloudpid",
            reason: "the server rejected the sign-in it was following under",
          },
        };
      }

      return decide(
        record,
        { kind: "retry", why: "the server needs the owner signed in" },
        now,
        limits,
      );
    case "changed": {
      // Another server under the same name: not ours to follow, and nothing is sent to it.
      if (record.identity === undefined || outcome.identity !== record.identity) {
        return {
          patch: { lastPolledAt: now },
          failures: record.failures,
          changed: true,
          end: {
            status: "stopped",
            by: "cloudpid",
            reason: "the server's definition changed to another server",
          },
        };
      }

      // The same server with other headers or OAuth: followed on its new connection, polled again at once.
      return {
        patch: { conn: outcome.conn, repinned: true },
        failures: NO_FAILURES,
        changed: true,
        retryInMs: 0,
        why: "the server's connection changed",
      };
    }

    case "off":
      return {
        patch: { lastPolledAt: now },
        failures: record.failures,
        changed: true,
        cancel: true,
        end: { status: "cancelled", by: "owner", reason: "the server was switched off" },
      };
    default:
      return {
        patch: { lastPolledAt: now },
        failures: record.failures,
        changed: true,
        end: { status: "unknown", by: "cloudpid", reason: outcome.reason },
      };
  }
};

/** Apply a decision to `record`, in the commit that stores it. */
export const applyDecision = (record: McpTaskRecord, decision: Decision): void => {
  const { patch } = decision;

  if (patch.status !== undefined) record.status = patch.status;

  if (patch.statusMessage !== undefined) record.statusMessage = patch.statusMessage;

  if (patch.lastPolledAt !== undefined) record.lastPolledAt = patch.lastPolledAt;

  if (patch.polls !== undefined) record.polls = patch.polls;

  if (patch.ttlMs !== undefined) record.ttlMs = patch.ttlMs;

  if (patch.pollIntervalMs !== undefined) record.pollIntervalMs = patch.pollIntervalMs;

  if (patch.conn !== undefined) record.conn = patch.conn;

  if (patch.repinned !== undefined) record.repinned = patch.repinned;

  record.failures = { ...decision.failures };
};
