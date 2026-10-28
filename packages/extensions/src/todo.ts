// The `todo` extension (`docs/architecture/agent-capabilities.md` → Todo): pi-todo's `todo` tool, rebuilt on a conversation document. The list is
// a document, so it outlives a Handoff or a compaction, and a request that no longer shows the list gets it put back
// (`./todo/projection.ts`). Every conversation has its own list, a subagent's included.
// @effect-diagnostics asyncFunction:off missingPipeableSignature:off -- `clearTodoList` is a plain function run inside a pi-durable commit, which is Promise code.
import {
  type ConversationId,
  defineExtension,
  section,
  type Extension,
  type Tx,
} from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import type { Harness } from "@cloudpid/effect-durable";
import { TODO_GUIDELINE, TodoResult, TodoWindow } from "./todo/projection.ts";
import { TodoTool } from "./todo/tool.ts";
import { TodoDoc } from "./todo/doc.ts";
import { applyTodo } from "./todo/list.ts";

export const extensionName = "todo";

export { TodoDoc, type TodoState, type TodoStatus, type TodoTask } from "./todo/doc.ts";

/**
 * Clear conversation `conversationId`'s Todo List in `tx`, as the tool's `clear` does: the IDs start again from 1. The
 * revision moves when the list changes, so watches of it are told and the model's next request shows the empty list.
 * Returns how many Tasks it held.
 */
export const clearTodoList = async (tx: Tx, conversationId: ConversationId): Promise<number> => {
  const state = await tx.doc(TodoDoc, conversationId);
  const list = { nextId: state.nextId, tasks: state.tasks };
  const outcome = applyTodo(list, { action: "clear" });

  if (outcome.ok && outcome.list !== list) {
    state.nextId = outcome.list.nextId;
    state.tasks = [];
    state.rev += 1;
  }

  return list.tasks.length;
};

/** The one line pi-todo adds to the prompt's tools and its guideline, fixed text so it never moves the cache prefix. */
const Guideline = section("todo", (input) =>
  Arr.some(input.agent.tools, (tool) => tool.name === "todo") ? TODO_GUIDELINE : undefined,
);

/** The `todo` extension: the tool, its prompt guideline, and the hook that keeps the list in front of the model. */
export const Todo: Effect.Effect<Extension, never, Harness> = Effect.map(
  Effect.all([TodoTool, TodoWindow, TodoResult]),
  ([tool, window, result]) =>
    defineExtension({
      name: extensionName,
      tools: [tool],
      hooks: [window, result],
      sections: [Guideline],
    }),
);
