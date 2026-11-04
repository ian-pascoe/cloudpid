// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off preferEffectRecord:off -- plain functions over the JSON of a few session entries.
// The extension state a Session import carries (`docs/architecture/mcp-endpoint.md` → Session import → Translation → Extension state): the
// three formats the owner's pi extensions write into a session file as `custom` entries, copied here as Effect Schemas
// and checked against cloudpid's own limits, since the Todo List and the Notes are documents that every client is sent.
//
// Pinned to `ian-pascoe/pi-extensions` at 1a9d7cc684b74ff08a367694623361ab315cbdcd (where each lives there):
//
// - `pi-todo-state`: `packages/pi-todo/src/todo-list.ts` (`TodoStateRecord`, and `parseTodoStateSnapshot` for the rules the
//   Schema cannot say), written by `packages/pi-todo/src/pi-todo-extension.ts` (`TODO_STATE_ENTRY_TYPE`). One whole list
//   per entry, so the last one is the list.
// - `pi-context-note`: `packages/pi-context-management/src/context-store.ts` (`NoteRecord`, `replayNotes`). One change to
//   one Note per entry (`content: null` deletes it); the Notes are the changes replayed in order. The record has no other
//   keys (`additionalProperties: false`).
// - `pi-context-handoff`: `packages/pi-context-management/src/context-window.ts` (`HandoffRecord`, `HANDOFF_ENTRY`). The
//   latest one is the Handoff.
//
// The fixtures (`import-pi-session.fixture.ts`) are shaped as real session files of the owner's, with their text replaced.
// A record that is none of these, an unknown `version`, one that fails its Schema or one over a limit is not taken: the
// import counts it as `custom:<type>` and goes on.
import {
  type ContextState,
  MAX_NOTE_CHARACTERS,
  MAX_NOTE_NAME,
  MAX_NOTES,
  type Note,
  NOTE_NAME,
} from "@cloudpid/extensions/context";
import {
  MAX_DESCRIPTION_CHARACTERS,
  MAX_TASKS,
  MAX_TITLE_CHARACTERS,
  type TodoState,
  type TodoTask,
  todoListFits,
} from "@cloudpid/extensions/todo";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** The `customType` of the Todo List's entries. */
export const PI_TODO_STATE = "pi-todo-state";

/** The `customType` of a Note's entries. */
export const PI_CONTEXT_NOTE = "pi-context-note";

/** The `customType` of the Handoff's entries. */
export const PI_CONTEXT_HANDOFF = "pi-context-handoff";

const positiveId = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

const nonEmpty = Schema.String.check(Schema.isMinLength(1));

/** pi-todo's `TodoStateRecord`: one whole Todo List. */
export const PiTodoState = Schema.Struct({
  nextId: positiveId,
  tasks: Schema.Array(
    Schema.Struct({
      id: positiveId,
      title: nonEmpty,
      description: Schema.optionalKey(nonEmpty),
      status: Schema.Literals(["pending", "active", "completed"]),
    }),
  ),
});

/** pi-context-management's `NoteRecord`: one change to one Note. */
export const PiContextNote = Schema.Struct({
  version: Schema.Literal(1),
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_NOTE_NAME)).check(
    Schema.isPattern(NOTE_NAME),
  ),
  content: Schema.NullOr(Schema.String.check(Schema.isMaxLength(MAX_NOTE_CHARACTERS))),
  sourceSession: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(128),
    Schema.isPattern(/^[A-Za-z0-9-]+$/),
  ),
});

/** pi-context-management's `HandoffRecord`: the Handoff the agent saved. */
export const PiContextHandoff = Schema.Struct({
  version: Schema.Literal(1),
  handoff: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_NOTE_CHARACTERS)),
});

const decodeTodo = Schema.decodeUnknownOption(PiTodoState);

// The note record allows no other key.
const decodeNote = Schema.decodeUnknownOption(PiContextNote, { onExcessProperty: "error" });

const decodeHandoff = Schema.decodeUnknownOption(PiContextHandoff);

/** What the pi extensions' entries of one session add up to, so far. */
export type PiState = {
  todo: ReadonlyArray<TodoTask> | undefined;
  nextId: number;
  /** In the order they were first written, as `ContextDoc` keeps them. */
  notes: Note[];
  handoff: string | undefined;
};

export const emptyPiState = (): PiState => ({
  todo: undefined,
  nextId: 1,
  notes: [],
  handoff: undefined,
});

/** Whether `tasks` and `nextId` are a list pi-todo would have written (`parseTodoStateSnapshot`) that cloudpid also accepts. */
const acceptable = (tasks: ReadonlyArray<TodoTask>, nextId: number): boolean => {
  let previous = 0;

  for (const task of tasks) {
    if (task.id <= previous) return false;

    if (task.title.trim() !== task.title || task.title.length > MAX_TITLE_CHARACTERS) return false;

    if (
      task.description !== undefined &&
      (task.description.trim() !== task.description ||
        task.description.length > MAX_DESCRIPTION_CHARACTERS)
    ) {
      return false;
    }

    previous = task.id;
  }

  return nextId > previous && tasks.length <= MAX_TASKS && todoListFits(tasks);
};

/**
 * Take one `custom` entry of `customType` and `data`, written at `timestamp` (milliseconds), into `state`. Answers false
 * when it is none of the three formats, or one that is not valid or not within cloudpid's limits: nothing is changed then.
 */
export const takePiEntry = (
  state: PiState,
  customType: string,
  data: Schema.Json | undefined,
  timestamp: number,
): boolean => {
  switch (customType) {
    case PI_TODO_STATE: {
      const list = decodeTodo(data);

      if (Option.isNone(list)) return false;

      const tasks: ReadonlyArray<TodoTask> = Arr.map(list.value.tasks, (task) =>
        task.description === undefined
          ? { id: task.id, title: task.title, status: task.status }
          : {
              id: task.id,
              title: task.title,
              description: task.description,
              status: task.status,
            },
      );

      if (!acceptable(tasks, list.value.nextId)) return false;

      state.todo = tasks;
      state.nextId = list.value.nextId;

      return true;
    }

    case PI_CONTEXT_NOTE: {
      const change = decodeNote(data);

      if (Option.isNone(change)) return false;

      const { name, content } = change.value;
      const at = state.notes.findIndex((note) => note.name === name);

      if (content === null) {
        if (at !== -1) state.notes.splice(at, 1);

        return true;
      }

      if (at === -1 && state.notes.length >= MAX_NOTES) return false;

      const note: Note = { name, content, updatedAt: timestamp };

      if (at === -1) state.notes.push(note);
      else state.notes[at] = note;

      return true;
    }

    case PI_CONTEXT_HANDOFF: {
      const saved = decodeHandoff(data);

      if (Option.isNone(saved)) return false;

      state.handoff = saved.value.handoff;

      return true;
    }

    default:
      return false;
  }
};

/**
 * The Todo List as a document `importFinish` takes: `rev` 0, which it moves to 1, so a request shows the list afresh.
 * None for an import that had no list, or an empty one (a cleared list is no list).
 */
export const todoOf = (state: PiState): TodoState | null =>
  state.todo === undefined || state.todo.length === 0
    ? null
    : { nextId: state.nextId, rev: 0, tasks: [...state.todo], shown: null, changedBy: [] };

/** The Notes and the Handoff as a document `importFinish` takes; none for an import that had neither. */
export const contextOf = (state: PiState): ContextState | null =>
  state.notes.length === 0 && state.handoff === undefined
    ? null
    : { notes: [...state.notes], handoff: state.handoff ?? null };
