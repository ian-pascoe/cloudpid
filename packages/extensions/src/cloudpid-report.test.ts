// `cloudpid_report` (`docs/architecture/agent-capabilities.md` → cloudpid reports, ADR-0051), over a fake
// `CloudpidReports`: the Session-side refusals before the Registry is asked, the `tool` check, the footer it hands over,
// how each answer reads, who may call it, and that it is offered by default.
// @effect-diagnostics asyncFunction:off preferEffectRecord:off
import { DEFAULT_OFFERED_TOOLS } from "@cloudpid/config";
import { makeToolSpans, type ToolSpanAttributes, ToolSpans } from "@cloudpid/effect-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  type ConversationId,
  ROOT_CONVERSATION_ID,
  type ToolExecutionApi,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import { describe, expect, it } from "vitest";
import {
  CLOUDPID_REPORT_TOOL,
  type CloudpidReportAnswer,
  CloudpidReportLog,
  type CloudpidReportRequest,
  CloudpidReports,
  CloudpidReportTools,
  type FiledCloudpidReport,
  NO_RETRY,
} from "./cloudpid-report.ts";
import { DeployCredentials } from "./environment-change-parts.ts";
import { secretReference } from "./secrets/references.ts";
import { Redactions } from "./secrets/redaction.ts";
import { Secrets, type SecretsService } from "./secrets/store.ts";
import { isOffered } from "./tool-search.ts";

const APP_KEY = "MIIEowIBAAKCAQEAappkeybody";

const heldSecrets = (values: Readonly<Record<string, string>>): SecretsService => {
  const redactions = new Redactions();

  for (const [name, value] of Record.toEntries(values)) redactions.hold(name, value);

  const used: Pick<SecretsService, "refresh" | "redact"> = {
    refresh: Effect.void,
    redact: (value) => redactions.redact(value),
  };

  // SAFETY: the tool uses only `refresh` and `redact`.
  return used as SecretsService;
};

const FILED: CloudpidReportAnswer = {
  status: "filed",
  number: 123,
  url: "https://github.com/ian-pascoe/cloudpid/issues/123",
  labelled: true,
};

/** A fake Registry that answers `answer` and records each request, and the reports kept for the Run's end. */
const toolOver = async (answer: CloudpidReportAnswer = FILED) => {
  const asked: CloudpidReportRequest[] = [];
  const logged: FiledCloudpidReport[] = [];
  const spans = makeToolSpans();
  /** What the calls added to their spans, as a traced Session's wrap lists call `call-7`'s. */
  const annotated: ToolSpanAttributes[] = [];

  spans.list("call-7", (attributes) => annotated.push(attributes));

  const extension = await Effect.runPromise(
    CloudpidReportTools.pipe(
      Effect.provideService(CloudpidReports, {
        file: (request) =>
          Effect.sync(() => {
            asked.push(request);

            return answer;
          }),
      }),
      Effect.provideService(CloudpidReportLog, {
        record: (report) =>
          Effect.sync(() => {
            logged.push(report);
          }),
      }),
      Effect.provideService(Secrets, heldSecrets({ API_KEY: "sk-held-value-123" })),
      Effect.provideService(DeployCredentials, { values: [APP_KEY] }),
      Effect.provideService(ToolSpans, spans),
    ),
  );

  const tool = Arr.findFirst(extension.tools ?? [], ({ name }) => name === CLOUDPID_REPORT_TOOL);

  if (Option.isNone(tool)) throw new Error("no cloudpid_report");

  /** The outcome the last call put on its span. */
  const outcome = () => annotated.at(-1)?.["cloudpid_report.outcome"];

  return { tool: tool.value, asked, logged, extension, outcome };
};

// SAFETY: a subagent's conversation ID for the test, which the tool only tells apart from the root's.
const CHILD = 42 as ConversationId;

/** An API that keeps the diagnostics a call emits. */
const diagnosing = () => {
  const diagnostics: Array<Parameters<ToolExecutionApi["diagnostic"]>[0]> = [];

  const api: ToolExecutionApi = {
    ...apiOf(),
    diagnostic: (diagnostic) => {
      diagnostics.push(diagnostic);
    },
  };

  return { api, diagnostics };
};

/** The calling conversation: its tools (offered and deferred), and whether it is a subagent's. */
const apiOf = (
  options: {
    readonly offered?: ReadonlyArray<string>;
    readonly deferred?: ReadonlyArray<string>;
    readonly child?: boolean;
  } = {},
): ToolExecutionApi => {
  const {
    offered = ["read", "bash", CLOUDPID_REPORT_TOOL],
    deferred = [],
    child = false,
  } = options;

  const named = (names: ReadonlyArray<string>) => Arr.map(names, (name) => ({ name }));

  return Object.assign(Object.create(null), {
    conversationId: child ? CHILD : ROOT_CONVERSATION_ID,
    taskId: 7,
    callId: "call-7",
    agent: async () => ({
      model: { provider: "anthropic", modelId: "claude-opus-4-5" },
      thinkingLevel: "high",
      extensions: [],
      sections: [],
      callable: [],
      tools: named(offered),
      deferred: named(deferred),
    }),
    snapshot: async () =>
      child
        ? {
            agents: {},
            conversations: { [String(CHILD)]: "agent-1" },
            tombstones: [],
            nextIndex: {},
            waiters: {},
          }
        : undefined,
  });
};

type Args = {
  readonly title?: string;
  readonly body?: string;
  readonly kind?: string;
  readonly tool?: string;
};

const BODY =
  "I ran bash with a timeout of 30 s and the call never returned; the description says it ends the command at the timeout.";

const valid: Args = { title: "bash ignores its timeout", body: BODY, kind: "bug" };

const run = (tool: ToolRegistration, args: Args, api: ToolExecutionApi = apiOf()) =>
  // SAFETY: the arguments are the tool's JSON parameters, or deliberately not, to see them refused.
  tool.execute(args as never, api, BACKGROUND_CONTEXT);

const text = (result: Awaited<ReturnType<ToolRegistration["execute"]>>): string =>
  Arr.join(
    Arr.map(result.output ?? [], (block) => (block.type === "text" ? block.text : "")),
    "",
  );

describe("cloudpid_report", () => {
  it("is the model's alone, safe to replay, and offered by default without being always offered", async () => {
    const { tool, extension } = await toolOver();

    expect(extension.name).toBe("cloudpid-report");
    expect(tool).toMatchObject({ callers: ["model"], replay: "safe" });
    expect(isOffered({ offered: DEFAULT_OFFERED_TOOLS }, CLOUDPID_REPORT_TOOL)).toBe(true);
    expect(isOffered({ offered: [] }, CLOUDPID_REPORT_TOOL)).toBe(false);
  });

  it("files the report with cloudpid's footer, says where it is, and keeps it for the Run's end", async () => {
    const { tool, asked, logged, outcome } = await toolOver();

    const result = await run(tool, { ...valid, tool: "bash" }, apiOf({ child: true }));

    expect(asked).toEqual([
      {
        conversation: 42,
        task: 7,
        title: "bash ignores its timeout",
        body: BODY,
        kind: "bug",
        tool: "bash",
        footer: { model: "anthropic/claude-opus-4-5", thinking: "high", agent: "agent-1" },
      },
    ]);
    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain("#123");
    expect(text(result)).toContain("https://github.com/ian-pascoe/cloudpid/issues/123");
    expect(outcome()).toBe("filed");
    expect(result.details).toEqual({
      number: 123,
      url: "https://github.com/ian-pascoe/cloudpid/issues/123",
      title: "bash ignores its timeout",
      kind: "bug",
    });
    expect(logged).toEqual([{ number: 123, title: "bash ignores its timeout" }]);
  });

  it("names the root conversation's agent root, and takes a deferred tool or cloudpid's own MCP tools", async () => {
    const { tool, asked } = await toolOver();

    await run(tool, { ...valid, tool: "web_fetch" }, apiOf({ deferred: ["web_fetch"] }));
    await run(tool, { ...valid, tool: "mcp_tasks" }, apiOf({ deferred: ["mcp_tasks"] }));

    expect(Arr.map(asked, ({ tool, footer }) => [tool, footer.agent])).toEqual([
      ["web_fetch", "root"],
      ["mcp_tasks", "root"],
    ]);
  });

  it.each<[string, Args, ReturnType<typeof apiOf>]>([
    ["a tool the conversation does not have", { ...valid, tool: "browser" }, apiOf()],
    [
      "an MCP server's tool, even one the conversation has",
      { ...valid, tool: "mcp__github__create_issue" },
      apiOf({ deferred: ["mcp__github__create_issue"] }),
    ],
    ["a held Secret in the body", { ...valid, body: `${BODY} sk-held-value-123` }, apiOf()],
    [
      "a GitHub token in the title",
      { ...valid, title: "ghp_0123456789abcdefghijABCDEFGHIJ012345 leaked" },
      apiOf(),
    ],
    [
      // A stateless installation token (`ghs_<app id>_<JWT>`), the shape the App's tokens have now.
      "an installation token in the body",
      {
        ...valid,
        body: `${BODY} ghs_1234567_eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJnaXRodWIifQ.${"aB3-_x9Q".repeat(50)}`,
      },
      apiOf(),
    ],
    ["the GitHub App's key", { ...valid, body: `${BODY} ${APP_KEY}` }, apiOf()],
    ["a Secret Reference", { ...valid, body: `${BODY} ${secretReference("API_KEY")}` }, apiOf()],
    ["a body under 50 characters", { ...valid, body: "too short" }, apiOf()],
    ["a title over 120 characters", { ...valid, title: "x".repeat(121) }, apiOf()],
    ["a kind it does not know", { ...valid, kind: "idea" }, apiOf()],
  ])("refuses %s before asking the Registry", async (_, args, api) => {
    const { tool, asked } = await toolOver();

    const result = await run(tool, args, api);

    expect(result.isError).toBe(true);
    expect(asked).toEqual([]);
  });

  it.each<[string, CloudpidReportAnswer, string, boolean]>([
    [
      "a refusal for the owner's Repos, which the agent may rewrite",
      { status: "refused", code: "names", message: "names /workspace/acme" },
      "refused_names",
      false,
    ],
    [
      "the Session's cap reached",
      { status: "refused", code: "session_cap", message: "3 already" },
      "refused_cap",
      true,
    ],
    [
      "the day's cap reached",
      { status: "refused", code: "daily_cap", message: "10 today" },
      "refused_cap",
      true,
    ],
    [
      "a title filed already",
      { status: "refused", code: "repeated", message: "filed already" },
      "refused_cap",
      true,
    ],
    [
      "GitHub's rate limit",
      { status: "refused", code: "rate_limited", message: "until 12:01" },
      "failed",
      true,
    ],
    [
      "the label missing",
      { status: "refused", code: "label_missing", message: "no label" },
      "failed",
      true,
    ],
    ["a failure", { status: "failed", message: "GitHub answered 503" }, "failed", true],
  ])("fails on %s", async (_, answer, spanOutcome, final) => {
    const { tool, logged, outcome } = await toolOver(answer);

    const result = await run(tool, valid);

    expect(result.isError).toBe(true);
    expect(outcome()).toBe(spanOutcome);
    // The no-retry line is the contract: it tells the model not to call again in this Run.
    expect(text(result).endsWith(NO_RETRY)).toBe(final);
    expect(logged).toEqual([]);
  });

  it("says a call with no answer may have been filed, and not to file it again", async () => {
    const { tool, outcome } = await toolOver({ status: "unknown" });

    const result = await run(tool, valid);

    expect(result.isError).toBe(true);
    expect(outcome()).toBe("unknown");
    // These words are the contract: a report that may be on GitHub must not be filed again.
    expect(text(result)).toMatch(/may have been filed/);
    expect(text(result).endsWith(NO_RETRY)).toBe(true);
  });

  it("warns when the report was filed without its label, and still succeeds", async () => {
    const { tool, outcome } = await toolOver({
      status: "filed",
      number: 123,
      url: "https://github.com/ian-pascoe/cloudpid/issues/123",
      labelled: false,
    });

    const { api, diagnostics } = diagnosing();

    const result = await run(tool, valid, api);

    expect(result.isError).toBeUndefined();
    expect(result.details).toMatchObject({ number: 123 });
    expect(outcome()).toBe("unlabelled");
    expect(diagnostics).toMatchObject([{ severity: "warn" }]);
  });

  it("warns as it fails when the GitHub App is not installed where it posts", async () => {
    const { tool } = await toolOver({
      status: "failed",
      message: "The GitHub App is not installed on ian-pascoe",
      warning: "The GitHub App is not installed on ian-pascoe",
    });

    const { api, diagnostics } = diagnosing();

    const result = await run(tool, valid, api);

    expect(result.isError).toBe(true);
    expect(diagnostics).toMatchObject([{ severity: "warn" }]);
  });
});
