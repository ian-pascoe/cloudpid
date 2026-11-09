// The Session's `CloudpidReports` (`@cloudpid/extensions/cloudpid-report`; `docs/architecture/agent-capabilities.md` →
// cloudpid reports, ADR-0051): a `cloudpid_report` call handed to the Registry's `agentFileReport`, with the Session's id,
// this stage (`reportStage`) and the Worker's version for cloudpid's footer. The Session never holds a GitHub token. A
// call that never answers, or an answer whose status this build does not know, reads as `unknown`: the report may have
// been filed.
import type {
  CloudpidReportAnswer,
  CloudpidReportRequest,
} from "@cloudpid/extensions/cloudpid-report";
import * as Effect from "effect/Effect";
import type { RegistryMethods } from "../registry/Registry.ts";

/** The statuses this build reads; any other is `unknown`. */
const KNOWN: ReadonlySet<string> = new Set(["filed", "refused", "failed", "unknown"]);

/**
 * The stage a report's footer names: `local` under `alchemy dev` (`CLOUDPID_LOCAL_MODE`), a non-prod stage's label
 * (`CLOUDPID_STAGE_LABEL`: `pr-<n>`, a dev stage's), else `prod`, which has none.
 */
export const reportStage = (stage: {
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
          Effect.logWarning("A cloudpid report's call to the Registry failed", cause).pipe(
            Effect.as<CloudpidReportAnswer>({ status: "unknown" }),
          ),
        ),
      );
  },
});
