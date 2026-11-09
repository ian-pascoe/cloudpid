// The Session's `CloudpidReports` over a fake Registry (`cloudpid-reports.ts`; `docs/architecture/agent-capabilities.md`
// → cloudpid reports): what it adds to a call (its Session, stage and version), and how an answer it cannot read, or no
// answer, reaches the tool.
// @effect-diagnostics asyncFunction:off -- vitest's tests are Promise-based.
import type { CloudpidReportRequest } from "@cloudpid/extensions/cloudpid-report";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import type { AgentReportInput } from "../registry/cloudpid-reports.ts";
import { reportStage, sessionCloudpidReports } from "./cloudpid-reports.ts";

const request: CloudpidReportRequest = {
  conversation: 1,
  task: 7,
  title: "bash ignores its timeout",
  body: "x".repeat(60),
  kind: "bug",
  footer: { model: "anthropic/claude-opus-4-5", thinking: "high", agent: "root" },
};

describe("the Session's cloudpid reports", () => {
  it("hand the Registry the call with the Session, its stage and its version", async () => {
    const asked: AgentReportInput[] = [];

    const reports = sessionCloudpidReports({
      registry: {
        agentFileReport: (input) =>
          Effect.sync(() => {
            asked.push(input);

            return { status: "filed", number: 1, url: "u", labelled: true } as const;
          }),
      },
      session: "s1",
      stage: "pr-731",
      version: "v-1",
    });

    expect(await Effect.runPromise(reports.file(request))).toMatchObject({ status: "filed" });
    expect(asked).toEqual([
      { ...request, session: "s1", footer: { ...request.footer, stage: "pr-731", version: "v-1" } },
    ]);
  });

  it.each<[string, () => Effect.Effect<never> | Effect.Effect<{ readonly status: string }>]>([
    ["a status it does not know", () => Effect.succeed({ status: "queued" })],
    ["a call that never answers", () => Effect.die(new Error("RPC failed"))],
  ])("read %s as a report that may have been filed", async (_, answer) => {
    const reports = sessionCloudpidReports({
      // SAFETY: a newer Registry's answer, or a failed call, which the type does not allow for.
      registry: { agentFileReport: answer as never },
      session: "s1",
      stage: "prod",
      version: undefined,
    });

    expect(await Effect.runPromise(reports.file(request))).toEqual({ status: "unknown" });
  });

  it("is refused for a Session the Registry does not name", async () => {
    const reports = sessionCloudpidReports({
      registry: { agentFileReport: () => Effect.die(new Error("not asked")) },
      session: undefined,
      stage: "prod",
      version: undefined,
    });

    expect(await Effect.runPromise(reports.file(request))).toMatchObject({ status: "failed" });
  });

  it.each<[string, Record<string, unknown>, string]>([
    ["prod, which has no stage label", {}, "prod"],
    ["a preview's label", { CLOUDPID_STAGE_LABEL: "pr-731" }, "pr-731"],
    ["local under alchemy dev", { CLOUDPID_STAGE_LABEL: "dev-ian", CLOUDPID_LOCAL_MODE: "true" }, "local"],
  ])("name the stage %s", (_, env, stage) => {
    expect(reportStage(env)).toBe(stage);
  });
});
