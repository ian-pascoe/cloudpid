// docs/architecture/mcp-endpoint.md → Environment and Settings tools → Approvals with no Session (ADR-0050; #685 D5, L2,
// L5; #688 C3): the ask of a change that waits for the owner's Approval over `/mcp`, which no Session holds. The tool's
// `prepare` (`./approval-tools.ts`) reads the target and refuses what the tool would refuse; a target that has the value
// already answers `unchanged`, asking nothing. Otherwise the Registry keeps the request (`../registry/approvals.ts`:
// checking every text of the arguments against the kept Secrets, deduping, superseding, capping), the owner is pushed a
// Notification for a new one, and the call answers `pending` with the request's id and its card's `url` (and what `prepare`
// noted the request leaves out: a Skill change at Global's Skills left out, and what its card could not show), settling
// the caller's `request_id` with that answer before it is sent.
// @effect-diagnostics missingPipeableSignature:off globalJsonInEffect:off -- an id quoted in a sentence.
import { type AgentChangeVia, approvalPath } from "@cloudpid/protocol";
import type { ApprovalToolName } from "@cloudpid/protocol/harness-tools";
import { type ApiResult, apiFailure, apiOk, type HarnessAnswer } from "@cloudpid/protocol/mcp-api";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as Types from "effect/Types";
import { expiresAtIso, type StoredApproval } from "../registry/approvals.ts";
import type { ChangeClaim } from "../registry/change-requests.ts";
import { healingRefusal } from "../registry/via-secrets.ts";
import { approvalTools, type CoreError, type ScopeRef } from "./approval-tools.ts";
import type { ApprovalsRegistry, EndpointWrites } from "./services.ts";

/** An asking tool's endpoint input as decoded: JSON, with the caller's `request_id` among its keys. */
type AskArgs = { readonly request_id?: string | undefined };

/** An ask as the dispatcher hands it over: the tool, its decoded input, who asks, and its digests. */
export type ApprovalAskCall = {
  readonly tool: ApprovalToolName;
  /** The endpoint input as decoded, `request_id` included. */
  readonly args: AskArgs;
  readonly caller: AgentChangeVia;
  readonly requestId: string | undefined;
  /** The `request_id` digest (`requestDigest`): the tool and every argument but the id. */
  readonly requestDigest: string;
  /** The dedupe digest: the same hash, `reason` left out too, so the same change asked for another reason is one request. */
  readonly digest: string;
  /** A fresh attempt for the `request_id` claim. */
  readonly attempt: string;
  /**
   * The call made as the tool's own change, for the tools that ask only when they widen: run when `prepare` finds the change
   * narrows (`immediate`), or finds a repeat of a call that made it already. None for a tool that always asks.
   */
  readonly narrowing?: Effect.Effect<ApiResult<HarnessAnswer>> | undefined;
};

/** What the asking part needs: the Registry's Approvals and claims, the writes the cores read through, and `background`. */
export type ApprovalAskServices = {
  readonly registry: ApprovalsRegistry;
  readonly writes: EndpointWrites;
  readonly background: (effect: Effect.Effect<void>) => Effect.Effect<void>;
  readonly origin?: string | undefined;
};

/** The arguments a request keeps: the input as decoded, without the caller's `request_id`. */
const keptArgs = (args: AskArgs): Schema.Json =>
  // SAFETY: `args` is an endpoint input as its schema decoded it: JSON.
  Record.remove(args as Readonly<Record<string, Schema.Json>>, "request_id");

/** The url of request `approval`'s card: at `origin` when known. */
const cardUrl = (approval: StoredApproval, origin: string | undefined): string =>
  `${origin ?? ""}${approvalPath(approval.scope, approval.section, approval.id)}`;

/**
 * The `pending` answer of an ask: the request made (`fresh`), or the one that waits already, with what `prepare` noted of what
 * the request leaves out (`note`), when anything.
 */
const pendingAnswer = (
  approval: StoredApproval,
  fresh: boolean,
  scope: ScopeRef,
  origin: string | undefined,
  note: string | undefined,
): HarnessAnswer => {
  const url = cardUrl(approval, origin);
  const what = `${approval.card.change}, ${approval.card.target}`;
  const expires = expiresAtIso(approval);
  const noted = note === undefined || note === "" ? "" : `\n${note}`;

  return {
    text: `${
      fresh
        ? `Asked the owner to approve: ${what}. Nothing is changed until they approve it in cloudpid at ${url}; the request (approval_id ${approval.id}) expires ${expires} if they do not answer.`
        : `A request for this change waits for the owner already (approval_id ${approval.id}): nothing was asked again. ${what}; they answer it in cloudpid at ${url}, and it expires ${expires}.`
    }${noted}`,
    structured: {
      status: "pending",
      approval_id: approval.id,
      url,
      expires_at: expires,
      scope,
    },
  };
};

/** What an `unchanged` core answer reads of its structured value: the Scope and the fields that have the value. */
const UnchangedKeys = Schema.Struct({
  scope: Schema.optionalKey(Schema.Struct({ id: Schema.String, name: Schema.String })),
  unchanged: Schema.String.pipe(Schema.Array, Schema.optionalKey),
});

/** The `unchanged` answer of an ask: the core's words, and what the endpoint's output keeps of its value. */
const unchangedAnswer = (
  unchanged: { readonly text: string; readonly structured: unknown },
  scope: ScopeRef,
): HarnessAnswer => {
  const keys = Option.getOrElse(
    Schema.decodeUnknownOption(UnchangedKeys)(unchanged.structured),
    () => ({}),
  );

  const structured: Types.Mutable<Record<string, Schema.Json>> = {
    status: "unchanged",
    scope: "scope" in keys && keys.scope !== undefined ? keys.scope : scope,
  };

  if ("unchanged" in keys && keys.unchanged !== undefined) structured["unchanged"] = keys.unchanged;

  return { text: unchanged.text, structured };
};

/** The failure of an ask that could not be finished: nothing is known to be asked. */
const notAsked = apiFailure(
  "unavailable",
  "cloudpid could not ask the owner just now: try again shortly (with the same request_id, a retry answers the request if it was made).",
);

/** A core's refusal of an ask: its code, or `invalid_argument` for one that is only words (the core refused the call). */
const askRefused = (error: CoreError): ApiResult<never> =>
  apiFailure(error.code ?? "invalid_argument", error.message);

/**
 * The asking part over `services`: `prepare`, then the Registry's request, the push of a new one, and the settle of the
 * caller's `request_id` with the `pending` answer, before it is sent. A repeat of a `request_id` the earlier call settled
 * answers what it answered; one it claimed and did not settle asks again, which answers its request. The Registry's
 * refusal of a check that heals (the kept Secrets changed while it was made) is `unavailable`, which a retry may pass.
 */
export const askApproval = (services: ApprovalAskServices) => {
  const tools = approvalTools(services.writes);

  return (call: ApprovalAskCall): Effect.Effect<ApiResult<HarnessAnswer>> =>
    Effect.gen(function* () {
      const { tool, args, caller, requestId } = call;
      const found = tools[tool]({ kind: "endpoint", via: caller });

      const earlier =
        requestId === undefined ? null : yield* services.registry.changeRequest({ id: requestId });

      if (requestId !== undefined && earlier !== null) {
        if (earlier.tool !== tool || earlier.digest !== call.requestDigest) {
          return apiFailure(
            "invalid_argument",
            `The request_id ${JSON.stringify(requestId)} was used by an earlier call with other arguments: use a new request_id for a new change.`,
          );
        }

        if (earlier.answer !== null) return apiOk(earlier.answer);

        // A repeat of a narrowing call that made its change and was cut before its answer: the tool's own change answers it
        // from the recorded changes, before `prepare` reads a state the change has altered (L17).
        if (call.narrowing !== undefined && earlier.changes.length > 0)
          return yield* call.narrowing;
      }

      const kept = keptArgs(args);
      const prepared = yield* found.prepare(kept).pipe(Effect.result);

      if (Result.isFailure(prepared)) return askRefused(prepared.failure);

      const { card, expected, unchanged, immediate, scope, section, note } = prepared.success;

      // A repeat of a call that asked asks again (its request is answered); otherwise a target set already asks nothing.
      if (unchanged !== undefined && earlier === null) {
        return apiOk(unchangedAnswer(unchanged, scope));
      }

      // A change that narrows what an MCP server reaches asks nobody: the tool's own core makes it at once. A repeat whose earlier
      // call claimed the `request_id` without an answer or changes is not that: the earlier call may have asked (its settle cut)
      // before the state flipped to narrowing, so it reaches `requestApproval`, which answers the request it made.
      if (call.narrowing !== undefined && immediate === true && earlier === null) {
        return yield* call.narrowing;
      }

      const claim: ChangeClaim | undefined =
        requestId === undefined
          ? undefined
          : { id: requestId, tool, digest: call.requestDigest, attempt: call.attempt };

      const asked = yield* services.registry.requestApproval({
        tool,
        scope: scope.id,
        section,
        args: kept,
        card,
        expected,
        digest: call.digest,
        long: found.long,
        via: caller,
        request: claim,
      });

      switch (asked.status) {
        case "refused":
          return apiFailure(
            healingRefusal(asked.message) ? "unavailable" : "invalid_argument",
            asked.message,
          );
        case "too_many":
          return apiFailure(
            "too_many_approvals",
            `${asked.limit} of your requests wait for the owner or are being applied, as many as may: follow them with approval_wait, or take one back with approval_withdraw, then ask again.`,
          );
        case "asked": {
          const answer = pendingAnswer(asked.approval, asked.fresh, scope, services.origin, note);

          if (asked.fresh) {
            yield* services.background(
              services.registry.notifyApproval({ id: asked.approval.id }).pipe(Effect.asVoid),
            );
          }

          if (claim !== undefined) {
            yield* services.registry
              .settleChangeRequest({ id: claim.id, attempt: claim.attempt, answer })
              .pipe(Effect.ignore);
          }

          return apiOk(answer);
        }
      }
    }).pipe(Effect.catchCause(() => Effect.succeed(notAsked)));
};
