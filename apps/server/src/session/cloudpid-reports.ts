// The Session's `CloudpidReports` (`@cloudpid/extensions/cloudpid-report`; `docs/architecture/agent-capabilities.md` →
// cloudpid reports, ADR-0051): a `cloudpid_report` call handed to the Registry's `agentFileReport`, with the Session's id,
// this stage (`cloudpidReportStage`) and the Worker's version for cloudpid's footer. The Session never holds a GitHub token. A
// call that never answers, or an answer whose status this build does not know, reads as `unknown`: the report may have
// been filed. A Registry with no `agentFileReport`, one from before it during a deploy, reads as `failed`: nothing was
// posted (`docs/development/workers.md` → cloudpid reports' edge).
import type {
  CloudpidReportAnswer,
  CloudpidReportRequest,
} from "@cloudpid/extensions/cloudpid-report";
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import type { RegistryMethods } from "../registry/Registry.ts";

/** What workerd says of a call to a Registry with no `agentFileReport`: one from before it, during a deploy. */
const NO_SUCH_METHOD =
  /does not implement the method "agentFileReport"|agentFileReport is not a function/u;

/** Whether `cause` is that call, as a defect or as the RPC client's failure (`RpcCallError`, holding it as its `cause`). */
const missingMethod = (cause: Cause.Cause<unknown>): boolean => {
  const error = Cause.squash(cause);
  const inner = Predicate.hasProperty(error, "cause") ? error.cause : undefined;

  return Arr.some(
    [error, inner],
    (each) =>
      Predicate.hasProperty(each, "message") &&
      Predicate.isString(each.message) &&
      NO_SUCH_METHOD.test(each.message),
  );
};

/** The statuses this build reads; any other is `unknown`. */
const KNOWN: ReadonlySet<string> = new Set(["filed", "refused", "failed", "unknown"]);

/**
 * The stage a report's footer names: `local` under `alchemy dev` (`CLOUDPID_LOCAL_MODE`), a non-prod stage's label
 * (`CLOUDPID_STAGE_LABEL`: `pr-<n>`, a dev stage's), else `prod`, which has none.
 */
export const cloudpidReportStage = (stage: {
  readonly label: string | undefined;
  readonly local: boolean;
}): string => (stage.local ? "local" : (stage.label ?? "prod"));

export const sessionCloudpidReports = (options: {
  readonly registry: Pick<RegistryMethods, "agentFileReport">;
  /** The Session's id in the Registry; undefined when unknown, for a Session that then files nothing. */
  readonly session: string | undefined;
  readonly stage: string;
  /** The Worker version's id (`CF_VERSION_METADATA`); absent under `alchemy dev`. */
  readonly version: string | undefined;
}) => ({
  file: (request: CloudpidReportRequest): Effect.Effect<CloudpidReportAnswer> => {
    const { registry, session, stage, version } = options;

    if (session === undefined) {
      return Effect.succeed({
        status: "failed",
        message: "This Session is not one the Registry lists, so it files no report.",
      });
    }

    return registry
      .agentFileReport({ ...request, session, footer: { ...request.footer, stage, version } })
      .pipe(
        Effect.map((answer): CloudpidReportAnswer =>
          KNOWN.has(answer.status) ? answer : { status: "unknown" },
        ),
        Effect.catchCause((cause) =>
          missingMethod(cause)
            ? // Nothing was posted: the Registry has no way to post it yet.
              Effect.succeed<CloudpidReportAnswer>({
                status: "failed",
                message:
                  "cloudpid is being deployed, and its Registry can't file reports yet; nothing was filed.",
              })
            : Effect.logWarning("A cloudpid report's call to the Registry failed", cause).pipe(
                Effect.as<CloudpidReportAnswer>({ status: "unknown" }),
              ),
        ),
      );
  },
});
