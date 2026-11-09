// The `cloudpid-report` extension (`docs/architecture/agent-capabilities.md` → cloudpid reports, ADR-0051, GLOSSARY.md →
// cloudpid report): `cloudpid_report`, which files a public issue about cloudpid itself on its own GitHub repo. The
// Session refuses a title or body that holds a Secret it holds, a GitHub token, the GitHub App's key or a Secret
// Reference's placeholder, as the `environment_*` and `settings_*` tools refuse their values, and checks `tool` against
// the calling conversation's tools; the Registry, which posts as the GitHub App (`CloudpidReports`, which the Session
// provides over it), refuses names of the owner's Repos, counts the caps, adds cloudpid's footer and posts once per call.
// The model's alone (`callers: ["model"]`), safe to replay: a rerun is answered the same issue, or that it may have been
// filed, never posted again. Not an Agent change; the Session tells the Run's end of each report itself.
// @effect-diagnostics missingPipeableSignature:off
import { isMcpToolName } from "@cloudpid/config";
import {
  annotateToolSpan,
  callDurable,
  defineEffectTool,
  type ToolSpanAttributes,
  type ToolSpans,
} from "@cloudpid/effect-durable";
import {
  type Agent,
  defineExtension,
  type Extension,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { credentialCheck, DeployCredentials } from "./environment-change-parts.ts";
import { holdsPlaceholder } from "./secrets/references.ts";
import { Secrets } from "./secrets/store.ts";
import { agentOf, SubagentsDoc } from "./subagents/state.ts";
import { ROOT_AGENT } from "./subagents/ids.ts";

export const extensionName = "cloudpid-report";

/** The tool's name. */
export const CLOUDPID_REPORT_TOOL = "cloudpid_report";

/** The kinds of report: something cloudpid did wrong, friction that cost needless turns, a capability it lacks. */
export const CloudpidReportKind = Schema.Literals(["bug", "friction", "missing"]);

export type CloudpidReportKind = typeof CloudpidReportKind.Type;

/** The longest title. */
export const MAX_REPORT_TITLE = 120;

/** The shortest body. */
export const MIN_REPORT_BODY = 50;

/** The longest body. */
export const MAX_REPORT_BODY = 8_000;

/**
 * What the Registry refuses a report for, posting nothing: it names the owner's Repos (`names`, which the agent may
 * rewrite), the Session's or the day's cap is reached, the title was filed already in the Session, GitHub asked to wait,
 * or the `cloudpid-report` label is missing on the repo.
 */
export type CloudpidReportRefusal =
  | "names"
  | "session_cap"
  | "daily_cap"
  | "repeated"
  | "rate_limited"
  | "label_missing";

/**
 * The Registry's answer to a report (`agentFileReport`). A status a newer Registry adds reads as `unknown`: the report
 * may have been filed.
 */
export type CloudpidReportAnswer =
  /** Filed as issue `number`; `labelled` is false when it lacks the `cloudpid-report` label. */
  | {
      readonly status: "filed";
      readonly number: number;
      readonly url: string;
      readonly labelled: boolean;
    }
  | {
      readonly status: "refused";
      readonly code: CloudpidReportRefusal;
      readonly message: string;
    }
  /** Not filed; `warning` is set for what the owner must fix (the GitHub App not installed where it posts). */
  | { readonly status: "failed"; readonly message: string; readonly warning?: string | undefined }
  /** GitHub was asked to post and never answered, or an earlier attempt of this call did not finish. */
  | { readonly status: "unknown" };

/** What the Session hands the Registry of one call; the Session adds its stage and version to `footer`. */
export type CloudpidReportRequest = {
  readonly conversation: number;
  /** The call's task, which with the Session keys the claim: a rerun of the call finds it. */
  readonly task: number;
  readonly title: string;
  readonly body: string;
  readonly kind: CloudpidReportKind;
  readonly tool?: string | undefined;
  readonly footer: {
    /** `provider/model` of the calling conversation. */
    readonly model: string;
    readonly thinking: string;
    /** `root`, or the subagent's ID. */
    readonly agent: string;
  };
};

/** The Registry's reports, as the Session reaches them. A call that never answers is `unknown`. */
export class CloudpidReports extends Context.Service<
  CloudpidReports,
  {
    readonly file: (request: CloudpidReportRequest) => Effect.Effect<CloudpidReportAnswer>;
  }
>()("@cloudpid/extensions/cloudpid-report/CloudpidReports") {}

/** A report the tool refused, or that was not filed: its message is what the model sees. */
export class CloudpidReportError extends Schema.TaggedError<
  CloudpidReportError,
  { readonly brand: unique symbol }
>()("CloudpidReportError", { message: Schema.String }) {}

/** How every failure but a refusal the agent can fix by rewriting ends. */
export const NO_RETRY = "Don't retry in this Run; mention the problem in your final answer.";

const description = Arr.join(
  [
    "Report a problem with cloudpid itself, the harness you run in, as a **public** issue on its GitHub repo (ian-pascoe/cloudpid). Use it when one of cloudpid's tools, prompts, its Container or Workspace, or its docs failed you, behaved unlike its description, or lacked something the task needed, and that cost you real effort; or when the owner asks.",
    "Not for problems in the project you work on (even cloudpid's own code), in third-party services or MCP servers, or in your own work, and not as a summary of the Run.",
    "The issue is public: describe cloudpid's behaviour in general terms; leave out names of repos, files, people, companies or customers, the project's code and data, and Secrets. Text naming the owner's Repos is refused.",
    "File it once, when the problem happens, then carry on with the task. At most 3 per Session.",
  ],
  " ",
);

const Parameters = Schema.Struct({
  title: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_REPORT_TITLE),
  ).annotate({
    description: "One line saying what went wrong in cloudpid (at most 120 characters)",
  }),
  body: Schema.String.check(
    Schema.isMinLength(MIN_REPORT_BODY),
    Schema.isMaxLength(MAX_REPORT_BODY),
  ).annotate({
    description:
      "What you did, what cloudpid did, what you expected, and how to reproduce it; Markdown, 50–8,000 characters. cloudpid adds the stage, version and model itself.",
  }),
  kind: CloudpidReportKind.annotate({
    description:
      "bug: cloudpid did something wrong · friction: it worked but cost needless turns (unclear description, awkward parameters, misleading docs) · missing: a capability the task needed",
  }),
  tool: Schema.optionalKey(
    Schema.String.annotate({
      description: "The cloudpid tool it concerns, if any; not an MCP server's tool",
    }),
  ),
});

/** The span's outcome of a report (never its title or body). */
type Outcome =
  | "filed"
  | "refused_cap"
  | "refused_names"
  | "refused_secret"
  | "failed"
  | "unknown"
  | "unlabelled";

/** The agent the calling conversation is: `root` (any Session branch), or a subagent's ID. */
const agentOfCall = (api: ToolExecutionApi) =>
  callDurable("subagents", (context) => api.snapshot(SubagentsDoc, context)).pipe(
    Effect.map((state) =>
      state === undefined ? ROOT_AGENT : (agentOf(state, api.conversationId) ?? ROOT_AGENT),
    ),
    Effect.orElseSucceed(() => ROOT_AGENT),
  );

/** The span's outcome of a refusal. */
const refusalOutcome = (code: CloudpidReportRefusal): Outcome => {
  switch (code) {
    case "names":
      return "refused_names";
    case "session_cap":
    case "daily_cap":
    case "repeated":
      return "refused_cap";
    default:
      return "failed";
  }
};

/** The `cloudpid-report` extension: `cloudpid_report`, over the Session's `CloudpidReports`. */
export const CloudpidReportTools: Effect.Effect<
  Extension,
  never,
  CloudpidReports | Secrets | DeployCredentials | ToolSpans
> = Effect.gen(function* () {
  const reports = yield* CloudpidReports;
  const secrets = yield* Secrets;
  const holdsCredential = yield* credentialCheck;

  /** Whether `text` holds a Secret this Session holds (checked once they are fresh), a GitHub credential or a placeholder. */
  const holdsSecret = (text: string) =>
    holdsPlaceholder(text)
      ? Effect.succeed(true)
      : Effect.map(secrets.refresh, () => secrets.redact(text) !== text || holdsCredential(text));

  const tool = yield* defineEffectTool({
    name: CLOUDPID_REPORT_TOOL,
    description,
    parameters: Parameters,
    // A script cannot file a public issue: only the model, as with `context_rollover`.
    callers: ["model"],
    // A rerun finds the Registry's claim of this call: the same issue, or that it may have been filed.
    replay: "safe",
    execute: Effect.fnUntraced(function* ({ title, body, kind, tool: named }, api) {
      const annotate = (outcome: Outcome) =>
        annotateToolSpan(api.callId, {
          "cloudpid_report.kind": kind,
          "cloudpid_report.outcome": outcome,
        } satisfies ToolSpanAttributes);

      const fail = (outcome: Outcome | undefined, message: string) =>
        (outcome === undefined ? Effect.void : annotate(outcome)).pipe(
          Effect.andThen(CloudpidReportError.make({ message })),
        );

      const agent = yield* callDurable<Agent>("agent", (context) => api.agent(context));

      if (named !== undefined) {
        const has = Arr.some([...agent.tools, ...agent.deferred], ({ name }) => name === named);

        if (isMcpToolName(named)) {
          return yield* fail(
            undefined,
            `Nothing was filed: ${named} is an MCP server's tool, not cloudpid's. Report problems with an MCP server to its maker; file a cloudpid report only when cloudpid mishandles it, without \`tool\`.`,
          );
        }

        if (!has) {
          return yield* fail(
            undefined,
            `Nothing was filed: ${named} is not one of your tools. Name one of your tools, or leave \`tool\` out.`,
          );
        }
      }

      for (const [what, text] of [
        ["The title", title],
        ["The body", body],
      ] as const) {
        if (yield* holdsSecret(text)) {
          return yield* fail(
            "refused_secret",
            `Nothing was filed: ${what.toLowerCase()} holds the value of a Secret this Session holds, a Secret Reference, or a GitHub token or the GitHub App's key. The issue is public: describe the problem without it, and file again.`,
          );
        }
      }

      const answer = yield* reports.file({
        conversation: api.conversationId,
        task: api.taskId,
        title,
        body,
        kind,
        ...(named === undefined ? {} : { tool: named }),
        footer: {
          model:
            agent.model === undefined
              ? "unknown"
              : `${agent.model.provider}/${agent.model.modelId}`,
          thinking: agent.thinkingLevel,
          agent: yield* agentOfCall(api),
        },
      });

      switch (answer.status) {
        case "filed": {
          const filed = `Filed cloudpid report #${answer.number} (public): ${answer.url}`;

          if (!answer.labelled) {
            const warning = `cloudpid report #${answer.number} was filed, not labelled \`cloudpid-report\`: GitHub kept no label. The owner labels it by hand.`;

            api.diagnostic({ severity: "warn", message: warning });
          }

          yield* annotate(answer.labelled ? "filed" : "unlabelled");

          return {
            output: [
              {
                type: "text" as const,
                text: answer.labelled
                  ? filed
                  : `${filed}, not labelled \`cloudpid-report\`.`,
              },
            ],
            details: { number: answer.number, url: answer.url, title, kind },
          };
        }
        case "refused":
          return yield* fail(
            refusalOutcome(answer.code),
            answer.code === "names" ? answer.message : `${answer.message} ${NO_RETRY}`,
          );
        case "failed":
          if (answer.warning !== undefined) {
            api.diagnostic({ severity: "warn", message: answer.warning });
          }

          return yield* fail("failed", `Nothing was filed: ${answer.message} ${NO_RETRY}`);
        default:
          // `unknown`, and a status a newer Registry answers that this build does not know.
          return yield* fail(
            "unknown",
            `The cloudpid report may have been filed: GitHub was asked and did not answer. Don't file it again. ${NO_RETRY}`,
          );
      }
    }),
  });

  return defineExtension({ name: extensionName, tools: [tool] });
});
