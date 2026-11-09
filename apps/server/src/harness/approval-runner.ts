// docs/architecture/mcp-endpoint.md → Environment and Settings tools → Approvals with no Session (ADR-0050 and its
// amendment; #685 L4, L18; #687 "how an approved apply uses the claim"): the apply of a request the owner approved, and the
// resume of those no run is applying. A run claims the request under a 60 s lease (`../registry/approvals.ts`), then reads
// its claim (`approval:<id>`, whose attempt is the request's own id) first: an answer kept finishes it; changes recorded
// with no answer (a write that committed before its run was cut) finish it with an answer the tool rebuilds from them
// (`./approval-tools.ts`); nothing runs the tool's `apply` against `expected` and the endpoint author. A write that made
// nothing looks the claim up once more, since a run that overlapped a lapsed lease may have committed under it. The claim
// is settled, then the request. A run cut anywhere leaves it approved, and the next (Try again, `approval_wait`, the
// owner's next visit: `resumeStale`) picks it up from the claim. A long apply (an Environment's delete, #688 C2) renews
// the lease after each step it reports, and stops when another run took it; `approval_wait` never runs one, and
// `resumeStale` runs at most one per request, since each shares the request's 30 s of `waitUntil`.
// @effect-diagnostics missingPipeableSignature:off cryptoRandomUUID:off -- a run's token is a plain UUID.
import { APPROVAL_REQUEST_PREFIX } from "@cloudpid/protocol/harness-tools";
import type { HarnessAnswer } from "@cloudpid/protocol/mcp-api";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import type { ApprovalEnd, StoredApproval } from "../registry/approvals.ts";
import type { ChangeClaim } from "../registry/change-requests.ts";
import type { UpkeepChange } from "../registry/upkeep.ts";
import type { AuthorSource } from "../session/change-author.ts";
import { type ApprovalTool, approvalTools, notKept } from "./approval-tools.ts";
import type { ApprovalsRegistry, EndpointWrites } from "./services.ts";

/** What applying needs: the Registry's Approvals and claims, the writes, the upkeep a claim-built answer runs again. */
export type ApprovalRunnerDeps = {
  readonly registry: ApprovalsRegistry;
  readonly writes: EndpointWrites;
  readonly upkeep: (changes: ReadonlyArray<UpkeepChange>) => Effect.Effect<void>;
  readonly background: (effect: Effect.Effect<void>) => Effect.Effect<void>;
  /** A run's lease token: a fresh UUID; a test names its own. */
  readonly newToken?: (() => string) | undefined;
};

/** The claim an approved request's write records: `approval:<id>`, its attempt the request's own id (L18). */
export const approvalClaim = (approval: StoredApproval): ChangeClaim => ({
  id: `${APPROVAL_REQUEST_PREFIX}${approval.id}`,
  tool: approval.tool,
  digest: approval.digest,
  attempt: approval.id,
});

/** The apply of approved requests, and the resume of those no run is applying. */
export const approvalRunner = ({
  registry,
  writes,
  upkeep,
  background,
  newToken = () => crypto.randomUUID(),
}: ApprovalRunnerDeps) => {
  // By the name a request keeps, which a later build may no longer apply.
  const tools: Readonly<Record<string, (source: AuthorSource) => ApprovalTool>> =
    approvalTools(writes);

  /**
   * Apply approved request `id` (see the module's rules), answering it as it stands after: settled, or still approved
   * when another run holds it, or when this one was cut (the next resumes it). Null for a request not kept.
   */
  const apply = (id: string): Effect.Effect<StoredApproval | null> =>
    Effect.gen(function* () {
      const token = newToken();
      const claimed = yield* registry.claimApproval({ id, token });

      if (claimed === null) return null;

      if (!claimed.leased) return claimed.approval;

      const approval = claimed.approval;
      const claim = approvalClaim(approval);

      /** Settle the request as ended with nothing changed, for this run's lease. */
      const end = (status: Exclude<ApprovalEnd, "finished">, reason: string) =>
        registry.finishApproval({ id, token, status, reason });

      /**
       * Finish the request with `answer`: when `settleClaim`, the claim gets it first, so a resume cut before the request
       * is settled finds the answer.
       */
      const finish = (answer: HarnessAnswer, settleClaim: boolean) =>
        (settleClaim
          ? registry
              .settleChangeRequest({ id: claim.id, attempt: claim.attempt, answer })
              .pipe(Effect.ignore)
          : Effect.void
        ).pipe(
          Effect.andThen(
            registry.finishApproval({ id, token, status: "finished", result: answer }),
          ),
        );

      /**
       * Finish from the claim, when a write committed under it: its kept answer, or one `tool` rebuilds from its changes,
       * with the upkeep that run may not have run run again (it is idempotent). None when nothing is claimed.
       */
      const finishFromClaim = (tool: ApprovalTool) =>
        Effect.gen(function* () {
          const found = yield* registry.changeRequest({ id: claim.id });

          if (found === null) return Option.none();

          // Answered: the run that made the change settled its claim and was cut before the request.
          if (found.answer !== null) {
            return Option.some(
              yield* registry.finishApproval({
                id,
                token,
                status: "finished",
                result: found.answer,
              }),
            );
          }

          // Claimed with no answer: the write committed and its run was cut. Its changes stand.
          const built = yield* tool
            .fromClaim(approval.args, approval.expected, found.changes)
            .pipe(Effect.orElseSucceed(() => notKept(approval.tool)));

          yield* background(upkeep(found.changes));

          return Option.some(yield* finish(built, true));
        });

      const toolOf = Record.get(tools, approval.tool);

      if (Option.isNone(toolOf)) {
        return yield* end(
          "refused",
          `cloudpid no longer applies ${approval.tool}, so nothing was changed.`,
        );
      }

      const tool = toolOf.value({ kind: "endpoint", via: approval.via, request: claim });
      const earlier = yield* finishFromClaim(tool);

      if (Option.isSome(earlier)) return earlier.value;

      // Between a long apply's steps the lease is renewed: one this run no longer holds stops it, leaving the rest to the
      // run that took it.
      const onStep = registry
        .claimApproval({ id, token })
        .pipe(
          Effect.flatMap((renewed) =>
            renewed?.leased === true
              ? Effect.void
              : Effect.die(new Error(`Another run holds approved request ${id} now`)),
          ),
        );

      const outcome = yield* tool
        .apply(
          approval.args,
          approval.expected,
          { tool: approval.tool, reason: approval.card.reason },
          { onStep },
        )
        .pipe(Effect.result);

      if (
        Result.isSuccess(outcome) &&
        outcome.success.status === "finished" &&
        outcome.success.wrote
      ) {
        return yield* finish(outcome.success.answer, true);
      }

      // A write that made nothing (changed since, refused, or the value there already) may have met the change a run
      // that overlapped a lapsed lease committed under the claim: that run's change is this request's.
      const overlapped = yield* finishFromClaim(tool);

      if (Option.isSome(overlapped)) return overlapped.value;

      // A refusal of the write (the Environment gone, an `expected` it cannot read): nothing was changed.
      if (Result.isFailure(outcome)) return yield* end("refused", outcome.failure.message);

      const ended = outcome.success;

      return ended.status === "finished"
        ? yield* finish(ended.answer, false)
        : yield* end(ended.status, ended.reason);
    }).pipe(
      // A run that failed for no reason it can say (a Registry call cut) leaves the request approved: its lease lapses,
      // and the next run picks it up from the claim.
      Effect.catchCause((cause) =>
        Effect.logWarning("Applying an approved request was cut; it is resumed later", cause).pipe(
          Effect.andThen(registry.approval({ id })),
          Effect.orElseSucceed(() => null),
        ),
      ),
    );

  /**
   * Resume the approved requests no run is applying (L4: behind the owner's `listApprovals` and `listSessions`), each in
   * `background`: every short one, and the oldest long one (an Environment's delete), at most one per request, since
   * each takes up to the request's 30 s of `waitUntil`. The next visit resumes the next.
   */
  const resumeStale: Effect.Effect<void> = Effect.suspend(() => registry.staleApprovals()).pipe(
    Effect.map((stale) => [
      ...Arr.filter(stale, (approval) => !approval.long),
      ...Arr.take(
        Arr.filter(stale, (approval) => approval.long),
        1,
      ),
    ]),
    Effect.flatMap((picked) =>
      Effect.forEach(picked, (approval) => background(apply(approval.id).pipe(Effect.asVoid)), {
        discard: true,
      }),
    ),
    Effect.catchCause((cause) => Effect.logWarning("Resuming approved requests failed", cause)),
  );

  return { apply, resumeStale };
};

export type ApprovalRunner = ReturnType<typeof approvalRunner>;
