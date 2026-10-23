// The `subagents` extension (`docs/spec.md` → Subagents): pi-minimal-subagents' six coordinator tools, rebuilt on
// pi-durable's background subagents (its example 23). Children are conversations of the same Harness, owned by
// background anchor tasks; each input to a child is a reporter task that hands its answer to a `subagent_wait` or
// reports it back as a follow-up; `subagent_wait` blocks on a durable task.
import { effectSection } from "@cloudpid/effect-durable";
import { defineExtension, type Extension } from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Record from "effect/Record";
import * as Effect from "effect/Effect";
import { currentOptions, type SubagentSettings } from "./subagents/options.ts";
import { Anchor, Reporter, WaitTask } from "./subagents/tasks.ts";
import { coordinatorTools } from "./subagents/tools.ts";

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
  EMPTY_STATE as EMPTY_SUBAGENTS_STATE,
  isRootConversation,
  SubagentsDoc,
  type SubagentsState,
} from "./subagents/state.ts";

export { isAgentConversation, type OwnerHarness, stopConversation } from "./subagents/owner.ts";

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
 * once it installs the extension again. Reads its options from `SubagentSettings` at each call.
 */
export const Subagents: Effect.Effect<Extension, never, SubagentSettings> = Effect.map(
  Effect.all([coordinatorTools, Roles]),
  ([tools, roles]) =>
    defineExtension({
      name: extensionName,
      tools,
      sections: [roles],
      tasks: [Anchor, Reporter, WaitTask],
    }),
);
