// @effect-diagnostics missingPipeableSignature:off -- plain functions over the Todo document's JSON.
// A conversation's Todo List as a conversation document (`docs/spec.md` → Todo). Documents are not part of the
// transcript, so a Handoff or a compaction leaves the list as it is; the projection (`./projection.ts`) puts it back
// in front of the model. Every conversation, a subagent's included, has a list of its own, and a fork starts with the
// list its source has then.
import { defineDoc } from "@earendil-works/pi-durable";

/** A Task's state: unconstrained, so several Tasks may be active at once. */
export type TodoStatus = "pending" | "active" | "completed";

export const TODO_STATUSES = ["pending", "active", "completed"] as const;

export type TodoTask = {
  /** Positive and never reused while the list lives: `clear` is what starts the IDs again. */
  id: number;
  title: string;
  description?: string;
  status: TodoStatus;
};

/** The list as the head of a Context Window shows it (`./projection.ts`), kept so that every request of the window sends the same text. */
export type ShownList = {
  /** The window it is for: the timestamp of the window's first message, which a Handoff or compaction gives it once. */
  window: number;
  /** The revision of the list it shows. */
  rev: number;
  text: string;
};

export type TodoState = {
  /** The ID the next Task gets. */
  nextId: number;
  /** Counts the changes to the list, so a request can tell whether the last result the model saw is current. */
  rev: number;
  /** In ID order. */
  tasks: TodoTask[];
  /** The list the current Context Window's head shows, if it needed one. */
  shown: ShownList | null;
  /** The calls whose nested `todo` calls changed the list, latest last: their results then show the list (`./projection.ts`). */
  changedBy: string[];
};

/** How many of those calls the document remembers. */
export const MAX_CHANGED_BY = 16;

export const TodoDoc = defineDoc<TodoState>({
  kind: "cloudpid.todo",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ nextId: 1, rev: 0, tasks: [], shown: null, changedBy: [] }),
  checkpointWhen: () => false,
});

/** The state as read outside a commit: the initial one until the first change. */
export const EMPTY_TODO_STATE: TodoState = TodoDoc.definition.initial();
