// A test Session DO on a Workspace whose scripts call an MCP tool (`docs/architecture/mcp-server-requests.md` → The
// waiting-question record: `codemode`): the `mcp` extension over a fake host, which answers the `ask` tool of the
// server `docs` as a Modern server does (its question kept for later: `InputRequired`, then the resume's result) or as
// a Legacy one does (its question asked live, and the call held open), as `mcpEra` says. A Modern server may ask a
// Sampling request in the same round (`mcpSampling`), which the Session runs on its models as the round resumes. What the
// fake was sent is counted in the object's storage, so the counts outlive an eviction.
// @effect-diagnostics asyncFunction:off preferEffectArray:off globalJsonInEffect:off
import type { Harness } from "@cloudpid/effect-durable";
import type { Approvals } from "@cloudpid/extensions/approvals";
import type { BrowserHandoffs, OwnerTabDrivers } from "@cloudpid/extensions/browser";
import type { CloudpidReportLog } from "@cloudpid/extensions/cloudpid-report";
import type { AgentChangeLog } from "@cloudpid/extensions/environment";
import {
  HostLost,
  type McpBuildServer,
  type McpHostClientService,
  mcpExtension,
  MCP_RESUME_FEATURE,
  MCP_SAMPLING_FEATURE,
  MCP_TASKS_FEATURE,
} from "@cloudpid/extensions/mcp";
import type { Secrets } from "@cloudpid/extensions/secrets";
import type { SettingsReload } from "@cloudpid/extensions/settings";
import {
  isJsonObject,
  McpHostCallFailed,
  McpHostCompleted,
  McpHostInputRequired,
  type McpInputRequest,
  Unsupported,
  McpHostTaskAck,
  McpHostTaskStarted,
  McpHostTaskState,
  type McpTaskSnapshot,
} from "@cloudpid/mcp/types";
import type {
  ElicitationContent,
  McpElicitationRequest,
  McpSamplingRequest,
} from "@cloudpid/protocol";
import type { Extension } from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";
import { TestCodemodeSession } from "./codemode.fixture.ts";

const ERA = "mcp-fake-era";
const CALLS = "mcp-fake-calls";
const RESUMES = "mcp-fake-resumes";
const SAMPLING = "mcp-fake-sampling";
const TASK_MODE = "mcp-fake-task";
const TASK_SENT = "mcp-fake-task-sent";

/** The task the fake server runs for `report`: it works until it is cancelled. */
const taskSnapshot = (status: "working" | "cancelled"): McpTaskSnapshot =>
  // SAFETY: only the statuses that carry no more than the common fields are made here.
  ({
    taskId: "srv-task-secret",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastUpdatedAt: "2026-01-01T00:00:00.000Z",
    ttlMs: 600_000,
    status,
    statusMessage: "Making the report",
  }) as McpTaskSnapshot;

/** The form the `ask` tool asks. */
const QUESTION: typeof McpInputRequest.Encoded = {
  key: "q1",
  kind: "elicitation",
  params: {
    message: "Who are you?",
    requestedSchema: {
      type: "object",
      properties: { name: { type: "string", title: "Your name" } },
      required: ["name"],
    },
  },
  mode: "deferrable",
};

/** The Sampling request a Modern round asks beside the form, when `mcpSampling` says it does. */
const SAMPLE: typeof McpInputRequest.Encoded = {
  key: "s1",
  kind: "sampling",
  params: {
    messages: [{ role: "user", content: { type: "text", text: "Greet them" } }],
    maxTokens: 100,
  },
  mode: "deferrable",
  era: "modern",
};

/** The `ResumeState` the fake hands out, which its resume expects back. */
const STATE = { v: 1, method: "tools/call", name: "ask", arguments: {}, round: 1 };

/** The server `docs`, discovered, with its one tool `ask`, which scripts call. */
const DOCS: McpBuildServer = {
  name: "docs",
  state: "connected",
  discoveredAt: 1,
  server: { exposure: "direct" },
  tools: [
    { name: "ask", inputSchema: { type: "object" } },
    { name: "report", inputSchema: { type: "object" }, execution: { taskSupport: "optional" } },
  ],
};

const text = (value: string) =>
  McpHostCompleted.make({
    result: { kind: "inline", value: { content: [{ type: "text", text: value }] } },
  });

export class TestMcpCodemodeSession extends TestCodemodeSession {
  /** The fake host: a Modern server's call ends its round when its question is deferred; a Legacy one's waits. */
  #host(): McpHostClientService {
    const { kv } = this.ctx.storage;
    const count = (key: string) => kv.put(key, (kv.get<number>(key) ?? 0) + 1);

    return {
      requestStart: () => Effect.die("The fake host is built from once"),
      servers: () => Effect.die("The fake host is built from once"),
      apply: () => Effect.die("The fake host takes no push"),
      request: (input, hooks) =>
        Effect.promise(async () => {
          if (kv.get<boolean>(TASK_MODE) === true && input.op !== "resume") {
            const sentSoFar = kv.get<Record<string, number>>(TASK_SENT) ?? {};

            kv.put(TASK_SENT, { ...sentSoFar, [input.op]: (sentSoFar[input.op] ?? 0) + 1 });

            if (input.op === "tools/call") {
              return input.ctx.allowTask === true
                ? McpHostTaskStarted.make({ task: taskSnapshot("working"), conn: "conn-docs" })
                : text("a plain result");
            }

            if (input.op === "tasks/cancel") {
              kv.put("mcp-fake-cancelled", true);

              return McpHostTaskAck.make({});
            }

            if (input.op === "tasks/get") {
              return McpHostTaskState.make({
                task: taskSnapshot(
                  kv.get<boolean>("mcp-fake-cancelled") === true ? "cancelled" : "working",
                ),
              });
            }
          }

          if (input.op === "resume") {
            count(RESUMES);
            kv.put("mcp-fake-answers", input.params.answers);

            const content = input.params.answers["q1"]?.["content"];
            const reply = input.params.answers["s1"]?.["content"];

            return text(
              `Hello ${JSON.stringify(isJsonObject(content) ? content["name"] : null)}${
                isJsonObject(reply) ? ` and ${JSON.stringify(reply["text"])}` : ""
              }`,
            );
          }

          count(CALLS);

          if (kv.get<string>(ERA) === "legacy") {
            void hooks.onInput?.({ ...QUESTION, mode: "live" }).catch(() => undefined);
            await hooks.untilAborted?.();

            return HostLost.make({ message: "The fake's call was stopped" });
          }

          const asks = kv.get<boolean>(SAMPLING) === true ? [QUESTION, SAMPLE] : [QUESTION];
          const answers = await Promise.all(asks.map(async (request) => hooks.onInput?.(request)));

          // As the core's round does: a refused request ends the call locally, a deferred one ends the round.
          const refused = answers.find((answer) => answer?.kind === "refused");

          if (refused?.kind === "refused") {
            return McpHostCallFailed.make({
              error: Unsupported.make({ message: refused.message }),
            });
          }

          return answers.some((answer) => answer?.kind === "defer")
            ? McpHostInputRequired.make({
                requests: asks,
                resume: { ...STATE, deferred: asks.map((request) => request.key) },
                conn: "conn-docs",
              })
            : text(`Answered ${JSON.stringify(answers[0])}`);
        }),
    };
  }

  protected override hostExtensions(): Effect.Effect<
    readonly Extension[],
    never,
    | Harness
    | Secrets
    | BrowserHandoffs
    | OwnerTabDrivers
    | AgentChangeLog
    | CloudpidReportLog
    | SettingsReload
    | Approvals
  > {
    const mcp = mcpExtension(
      {
        servers: [DOCS],
        offered: [],
        features: [
          "inventory",
          "call",
          MCP_RESUME_FEATURE,
          MCP_SAMPLING_FEATURE,
          MCP_TASKS_FEATURE,
        ],
      },
      this.#host(),
      { session: this.ctx.id.toString(), workspace: "ws:test" },
      {
        questions: this.mcpQuestionsService(),
        sampling: this.mcpSamplingService(),
        // The inline window is short, so a script's call detaches within a test's wait.
        tasks: {
          storage: this.ctx.storage.kv,
          timing: {
            windowMs: 300,
            pollMs: 50,
            unknownGraceMs: 300,
            backoffMs: 100,
            cancelGraceMs: 300,
          },
        },
      },
    );

    return Effect.map(super.hostExtensions(), (base) => [...base, mcp]);
  }

  /** Make the fake server run `report` as an MCP task that works until it is cancelled. */
  mcpTasks(): void {
    this.ctx.storage.kv.put(TASK_MODE, true);
  }

  /** How many `tools/call`, `tasks/get` and `tasks/cancel` the task-running fake was sent, by operation. */
  mcpTaskSent(): Record<string, number> {
    return this.ctx.storage.kv.get<Record<string, number>>(TASK_SENT) ?? {};
  }

  /** Make the fake answer as a Legacy server does from now on. */
  mcpLegacy(): void {
    this.ctx.storage.kv.put(ERA, "legacy");
  }

  /** Make the Modern fake ask a Sampling request beside its form from now on. */
  mcpSampling(): void {
    this.ctx.storage.kv.put(SAMPLING, true);
  }

  /** The Sampling requests waiting for the owner. */
  mcpSamplingPending(): Promise<ReadonlyArray<McpSamplingRequest>> {
    return Effect.runPromise(this.mcpQuestionsService().pendingSampling);
  }

  /** The owner's choice on Sampling request `id`. */
  mcpSamplingAnswer(id: string, choice: "allow_call" | "refuse"): Promise<void> {
    return Effect.runPromise(this.mcpQuestionsService().answerSampling(id, { choice }));
  }

  /** The questions waiting for the owner. */
  mcpPending(): Promise<ReadonlyArray<McpElicitationRequest>> {
    return Effect.runPromise(this.mcpQuestionsService().pending);
  }

  /** The owner's answer to question `id`. */
  mcpAnswer(id: string, content: ElicitationContent): Promise<void> {
    return Effect.runPromise(this.mcpQuestionsService().answer(id, { action: "accept", content }));
  }

  /** The settled records of the questions, newest last. */
  mcpRecords() {
    return Effect.runPromise(this.mcpQuestionsService().records);
  }

  /** The Sampling requests' records, oldest first. */
  mcpSamplingRecords() {
    return Effect.runPromise(this.mcpSamplingService().records);
  }

  /** How many `tools/call` and resumes the fake was sent, across instances, and the answers the resume carried. */
  mcpSent() {
    const { kv } = this.ctx.storage;

    return {
      calls: kv.get<number>(CALLS) ?? 0,
      resumes: kv.get<number>(RESUMES) ?? 0,
      answers: kv.get("mcp-fake-answers"),
    };
  }
}
