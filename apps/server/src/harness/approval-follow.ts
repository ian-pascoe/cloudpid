// docs/architecture/mcp-endpoint.md → Environment and Settings tools → Approvals with no Session (ADR-0050; #685 D5, L5):
// what the caller does after an ask that answered `pending`. `approval_wait` waits for the owner's answer and applies an
// approved request no run is applying (`./approval-runner.ts`); `approval_withdraw` takes a request back while it waits.
// Both answer the request as `ApprovalState`, with why it was withdrawn in the words the Settings page uses too.
// @effect-diagnostics missingPipeableSignature:off
import {
  type AgentChangeVia,
  approvalApproved,
  approvalSettled,
  withdrawalReason,
} from "@cloudpid/protocol";
import { DEFAULT_APPROVAL_WAIT_S, MAX_APPROVAL_WAIT_S } from "@cloudpid/protocol/harness-tools";
import { type ApiResult, type ApprovalState, apiFailure, apiOk } from "@cloudpid/protocol/mcp-api";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";
import type * as Types from "effect/Types";
import { awaitsApply, MAX_APPROVAL_WAITS, type StoredApproval } from "../registry/approvals.ts";
import { isoTime } from "./approval-tools.ts";
import type { ApprovalRunner } from "./approval-runner.ts";
import type { ApprovalsRegistry } from "./services.ts";

/**
 * The most turns one wait takes: apply what is approved, wait for a change, apply what the change made approved, and read
 * what that apply left. A request that moves more often than that is answered as it stands.
 */
const MAX_WAIT_TURNS = 4;

/** Request `approval` as `approval_wait` and `approval_withdraw` answer it. */
export const approvalState = (approval: StoredApproval): ApprovalState => {
  const state: Types.Mutable<ApprovalState> = {
    approval_id: approval.id,
    tool: approval.tool,
    status: approval.status,
    finished: approvalSettled(approval.status),
    expires_at: isoTime(approval.expiresAt),
  };

  const reason =
    approval.withdrawal === null
      ? approval.reason
      : (withdrawalReason(approval.withdrawal) ?? approval.reason);

  if (reason !== null) state.reason = reason;

  if (approval.result !== null) {
    // SAFETY: a kept answer's structured value is JSON (`ChangeAnswer`).
    state.result = {
      text: approval.result.text,
      structured: approval.result.structured as Schema.Json,
    };
  }

  return state;
};

const notFound = (id: string) =>
  apiFailure(
    "not_found",
    `No request ${JSON.stringify(id)} is kept: it was never asked, or it ended more than 24 hours ago.`,
  );

/** What following a request needs: the Registry's Approvals, and the runner that applies an approved one. */
export type ApprovalFollowServices = {
  readonly registry: ApprovalsRegistry;
  readonly runner: ApprovalRunner;
};

/** The seconds a wait waits: `timeout_s` clamped to 0–`MAX_APPROVAL_WAIT_S`, `DEFAULT_APPROVAL_WAIT_S` when not given. */
export const waitSeconds = (timeout?: number): number =>
  timeout === undefined || !Number.isFinite(timeout)
    ? DEFAULT_APPROVAL_WAIT_S
    : Math.min(Math.max(timeout, 0), MAX_APPROVAL_WAIT_S);

/**
 * `approval_wait`: request `id`, read at once and returned when it is settled, or waited for until it changes or
 * `timeout_s` passes (0 reads once). An approved one no run is applying is applied by the wait, unless its apply is long
 * (the owner's Try again runs it). A wait cut short (a deploy) answers the request as read once after, `interrupted`. At
 * most `MAX_APPROVAL_WAITS` per caller (`auth`).
 */
export const approvalWait =
  ({ registry, runner }: ApprovalFollowServices) =>
  (
    request: { readonly approval_id: string; readonly timeout_s?: number | undefined },
    caller: AgentChangeVia,
  ): Effect.Effect<ApiResult<ApprovalState>> =>
    Effect.gen(function* () {
      const id = request.approval_id;
      const deadline = (yield* Clock.currentTimeMillis) + waitSeconds(request.timeout_s) * 1000;
      let current = yield* registry.approval({ id });

      for (let turn = 0; turn < MAX_WAIT_TURNS && current !== null; turn += 1) {
        const now = yield* Clock.currentTimeMillis;

        if (!current.long && awaitsApply(current, now)) {
          current = yield* runner.apply(id);
          continue;
        }

        if (approvalSettled(current.status) || now >= deadline) break;

        const waited = yield* registry
          .waitApproval({ id, seen: current.status, auth: caller.auth, deadline })
          .pipe(Effect.result);

        // Cut (a deploy): read once again, and say so.
        if (Result.isFailure(waited)) {
          const after = yield* registry.approval({ id });

          return after === null
            ? notFound(id)
            : apiOk({ ...approvalState(after), interrupted: true as const });
        }

        if (waited.success === null) return notFound(id);

        if (waited.success.status === "too_many_waits") {
          return apiFailure(
            "too_many_waits",
            `${MAX_APPROVAL_WAITS} of your approval_waits run already, as many as may at once: wait for one to end.`,
          );
        }

        current = waited.success.approval;
      }

      return current === null ? notFound(id) : apiOk(approvalState(current));
    }).pipe(
      Effect.catchCause(() =>
        Effect.succeed(
          apiFailure(
            "unavailable",
            "cloudpid could not read the request just now: try again shortly.",
          ),
        ),
      ),
    );

/**
 * `approval_withdraw`: request `id` taken back while it waits; one settled without the owner's Approval (withdrawn,
 * expired, declined) answered as it is; one the owner approved refused, whether its change is applied, being applied or
 * was not applied.
 */
export const approvalWithdraw =
  ({ registry }: Pick<ApprovalFollowServices, "registry">) =>
  (request: { readonly approval_id: string }): Effect.Effect<ApiResult<ApprovalState>> =>
    Effect.gen(function* () {
      const id = request.approval_id;
      const after = yield* registry.withdrawApproval({ id });

      if (after === null) return notFound(id);

      if (approvalApproved(after.status)) {
        return apiFailure(
          "invalid_argument",
          `The owner approved request ${id} already, so it can no longer be withdrawn: approval_wait says how its change went.`,
        );
      }

      return apiOk(approvalState(after));
    }).pipe(
      Effect.catchCause(() =>
        Effect.succeed(
          apiFailure(
            "unavailable",
            "cloudpid could not withdraw the request just now: try again shortly.",
          ),
        ),
      ),
    );
