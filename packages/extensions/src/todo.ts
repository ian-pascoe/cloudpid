// The `todo` extension (`docs/spec.md` → Todo): pi-todo's `todo` tool, rebuilt on a conversation document. The list is
// a document, so it outlives a Handoff or a compaction, and a request that no longer shows the list gets it put back
// (`./todo/projection.ts`). Every conversation has its own list, a subagent's included.
import { defineExtension, section, type Extension } from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import { TODO_GUIDELINE, TodoProjection } from "./todo/projection.ts";
import { TodoTool } from "./todo/tool.ts";

export const extensionName = "todo";

export {
  EMPTY_TODO_STATE,
  type TodoState,
  TodoDoc,
  type TodoStatus,
  type TodoTask,
} from "./todo/doc.ts";

export { MAX_TASKS, TODO_ACTIONS } from "./todo/list.ts";

/** The one line pi-todo adds to the prompt's tools and its guideline, fixed text so it never moves the cache prefix. */
const Guideline = section("todo", (input) =>
  Arr.some(input.agent.tools, (tool) => tool.name === "todo") ? TODO_GUIDELINE : undefined,
);

/** The `todo` extension: the tool, its prompt guideline, and the hook that keeps the list in front of the model. */
export const Todo: Effect.Effect<Extension> = Effect.map(
  Effect.all([TodoTool, TodoProjection]),
  ([tool, projection]) =>
    defineExtension({
      name: extensionName,
      tools: [tool],
      hooks: [projection],
      sections: [Guideline],
    }),
);
