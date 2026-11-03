// A test Session DO on a Workspace whose scripts call an MCP tool (`docs/architecture/mcp-server-requests.md` → The
// waiting-question record: `codemode`): the `mcp` extension over a fake host, which answers the `ask` tool of the
// server `docs` as a Modern server does (its question kept for later: `InputRequired`, then the resume's result) or as
// a Legacy one does (its question asked live, and the call held open), as `mcpEra` says. What the fake was sent is
// counted in the object's storage, so the counts outlive an eviction.
// @effect-diagnostics asyncFunction:off preferEffectArray:off preferSchemaOverJson:off
import type { Harness } from "@cloudpid/effect-durable";
import type { Approvals } from "@cloudpid/extensions/approvals";
import type { BrowserHandoffs, OwnerTabDrivers } from "@cloudpid/extensions/browser";
import type { AgentChangeLog } from "@cloudpid/extensions/environment";
import {
  HostLost,
  type McpBuildServer,
  type McpHostClientService,
  mcpExtension,
  MCP_RESUME_FEATURE,
} from "@cloudpid/extensions/mcp";
import type { Secrets } from "@cloudpid/extensions/secrets";
import type { SettingsReload } from "@cloudpid/extensions/settings";
import {
  isJsonObject,
  McpHostCompleted,
  McpHostInputRequired,
  type McpInputRequest,
} from "@cloudpid/mcp/types";
import type { ElicitationContent, McpElicitationRequest } from "@cloudpid/protocol";
import type { Extension } from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";
import { TestCodemodeSession } from "./codemode.fixture.ts";

const ERA = "mcp-fake-era";
const CALLS = "mcp-fake-calls";
const RESUMES = "mcp-fake-resumes";

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

/** The `ResumeState` the fake hands out, which its resume expects back. */
const STATE = { v: 1, method: "tools/call", name: "ask", arguments: {}, round: 1 };

/** The server `docs`, discovered, with its one tool `ask`, which scripts call. */
const DOCS: McpBuildServer = {
  name: "docs",
  state: "connected",
  discoveredAt: 1,
  server: { exposure: "direct" },
  tools: [{ name: "ask", inputSchema: { type: "object" } }],
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
          if (input.op === "resume") {
            count(RESUMES);
            kv.put("mcp-fake-answers", input.params.answers);

            const content = input.params.answers["q1"]?.["content"];

            return text(`Hello ${JSON.stringify(isJsonObject(content) ? content["name"] : null)}`);
          }

          count(CALLS);

          if (kv.get<string>(ERA) === "legacy") {
            void hooks.onInput?.({ ...QUESTION, mode: "live" }).catch(() => undefined);
            await hooks.untilAborted?.();

            return HostLost.make({ message: "The fake's call was stopped" });
          }

          const answer = await hooks.onInput?.(QUESTION);

          return answer?.kind === "defer"
            ? McpHostInputRequired.make({ requests: [QUESTION], resume: STATE, conn: "conn-docs" })
            : text(`Answered ${JSON.stringify(answer)}`);
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
    | SettingsReload
    | Approvals
  > {
    const mcp = mcpExtension(
      { servers: [DOCS], offered: [], features: ["inventory", "call", MCP_RESUME_FEATURE] },
      this.#host(),
      { session: this.ctx.id.toString(), workspace: "ws:test" },
      { questions: this.mcpQuestionsService() },
    );

    return Effect.map(super.hostExtensions(), (base) => [...base, mcp]);
  }

  /** Make the fake answer as a Legacy server does from now on. */
  mcpLegacy(): void {
    this.ctx.storage.kv.put(ERA, "legacy");
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
