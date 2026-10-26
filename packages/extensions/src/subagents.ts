// The `subagents` extension (`docs/spec.md` → Subagents): pi-minimal-subagents' six coordinator tools, rebuilt on
// pi-durable's background subagents (its example 23). Children are conversations of the same Harness, owned by
// background anchor tasks; each input to a child is a reporter task that hands its answer to a `subagent_wait` or
// reports it back as a follow-up; `subagent_wait` blocks on a durable task.
import { effectSection } from "@cloudpid/effect-durable";
import { defineExtension, type Extension } from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Record from "effect/Record";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { currentOptions, type SubagentSettings } from "./subagents/options.ts";
import { Anchor, reporterWith, SubagentReporter, WaitTask } from "./subagents/tasks.ts";
import { coordinatorTools } from "./subagents/tools.ts";
import { handBackLine, SubagentWorkspaces } from "./subagents/workspaces.ts";

export const extensionName = "subagents";

export {
  DEFAULT_MAX_SUBAGENT_DEPTH,
  DEFAULT_TOOLSETS,
  defaultSubagentSettings,
  type SubagentOptions,
  type SubagentRole,
  SubagentSettings,
  subagentOptions,
  type Toolsets,
} from "./subagents/options.ts";

export {
  type AgentRecord,
  type AgentWorkspace,
  conversationWorkspace,
  EMPTY_STATE as EMPTY_SUBAGENTS_STATE,
  isSessionBranch,
  SubagentsDoc,
  type SubagentsState,
  workspaceOf,
} from "./subagents/state.ts";

export {
  DEFAULT_MAX_SUBAGENT_WORKSPACES,
  describeWork,
  type RepoWorkState,
  type SubagentWorkspaceHost,
  type SubagentWorkspaceMade,
  type SubagentWorkspaceRequest,
  SubagentWorkspaces,
  unpushedWork,
  unsettledClone,
} from "./subagents/workspaces.ts";

export {
  deleteAgent,
  isAgentConversation,
  type OwnerDeleteHarness,
  type OwnerDeletion,
  type OwnerHarness,
  stopConversation,
} from "./subagents/owner.ts";

export { AGENT_INPUT_KIND } from "./subagents/tasks.ts";

export { COORDINATOR_TOOLS } from "./subagents/toolsets.ts";

/** The model roles, for an agent that may spawn: the role list of pi-minimal-subagents' prompt guidelines. */
const Roles = effectSection("subagent_roles", (input) =>
  Effect.map(currentOptions, (options) => {
    const roles = Record.toEntries(options.roles);

    if (roles.length === 0 || !Arr.some(input.agent.tools, (tool) => tool.name === "subagent")) {
      return undefined;
    }

    return Arr.join(
      [
        "Model roles you may name with subagent's `role`:",
        ...Arr.map(
          roles,
          ([name, role]) =>
            `- ${name} (${role.model.provider}/${role.model.modelId}): ${role.hint}`,
        ),
      ],
      "\n",
    );
  }),
);

/**
 * The `subagents` extension. Its task definitions come with it, so a restarted Session resumes pending turns and waits
 * once it installs the extension again. Reads its options from `SubagentSettings` at each call. Makes, reads and removes
 * Subagent Workspaces through `SubagentWorkspaces` when the host provides it; without it, `workspace: "new"` is refused.
 */
export const Subagents: Effect.Effect<Extension, never, SubagentSettings> = Effect.gen(
  function* () {
    const workspaces = yield* Effect.serviceOption(SubagentWorkspaces);

    // A turn of an agent with a Workspace of its own ends with its branch and what it has not pushed.
    const reporter = reporterWith((agent) =>
      Option.isNone(workspaces) || agent.workspace === undefined
        ? Promise.resolve(undefined)
        : handBackLine(workspaces.value, agent.workspace),
    );

    const [tools, roles] = yield* Effect.all([coordinatorTools, Roles]).pipe(
      Effect.provideService(SubagentReporter, reporter),
    );

    return defineExtension({
      name: extensionName,
      tools,
      sections: [roles],
      tasks: [Anchor, reporter, WaitTask],
    });
  },
);
