// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- plain functions over the Todo List's JSON, kept as pi-todo's (`todo-list.ts`).
// The Todo List's rules (`docs/spec.md` → Todo): what each action of the `todo` tool does to a list, without storage or
// the model's context. Every action is a pure function from the list to the next one or to a failure, so a batch that
// has one bad entry changes nothing.
import { type TodoStatus, type TodoTask } from "./doc.ts";

/** The actions of the `todo` tool. */
export const TODO_ACTIONS = ["list", "add", "update", "remove", "clear"] as const;

export type TodoAction = (typeof TODO_ACTIONS)[number];

/** The most Tasks one list holds; it is a Durable Object document that every watching client is sent whole. */
export const MAX_TASKS = 200;

/** The longest Task title, and the longest description, in characters. */
export const MAX_TITLE_CHARACTERS = 300;

export const MAX_DESCRIPTION_CHARACTERS = 2_000;

/**
 * The longest a list may be as the model reads it, in characters and in lines. A result shows the whole list and
 * pi-durable keeps at most 50 KB and 2,000 lines of a result, so a longer list could be cut off in the very result that
 * says it shows the list.
 */
export const MAX_LIST_CHARACTERS = 20_000;

export const MAX_LIST_LINES = 500;

/** The list as the actions see it: the Tasks in ID order and the ID the next one gets. */
export type TodoList = {
  readonly nextId: number;
  readonly tasks: ReadonlyArray<TodoTask>;
};

/** One Task to create in a batch `add`. */
export type TodoDraft = { readonly title: string; readonly description?: string | undefined };

/** One change in a batch `update`. */
export type TodoChange = {
  readonly id: number;
  readonly title?: string | undefined;
  readonly description?: string | null | undefined;
  readonly status?: TodoStatus | undefined;
};

/** What the `todo` tool is asked to do, as its parameters carry it. */
export type TodoInput = {
  readonly action: TodoAction;
  readonly id?: number | undefined;
  readonly title?: string | undefined;
  readonly description?: string | null | undefined;
  readonly tasks?: ReadonlyArray<TodoDraft> | undefined;
  readonly updates?: ReadonlyArray<TodoChange> | undefined;
  readonly status?: TodoStatus | undefined;
};

/**
 * What a call returns to a program, besides the text the model reads. `tasks` is the list for `list`, the Tasks created
 * for a batch `add`, and the Tasks changed for a batch `update`; `task` is the one Task a single `add` or `update`
 * made; `remove` returns the ID it removed and `clear` the count it cleared.
 */
export type TodoOutput =
  | { readonly action: "list" | "add" | "update"; readonly tasks: TodoTask[] }
  | { readonly action: "add" | "update"; readonly task: TodoTask }
  | { readonly action: "remove"; readonly id: number }
  | { readonly action: "clear"; readonly cleared: number };

export type TodoOutcome =
  | {
      readonly ok: true;
      readonly list: TodoList;
      /** The first line of the model's text: what the call did. */
      readonly message: string;
      readonly output: TodoOutput;
    }
  | { readonly ok: false; readonly message: string };

export const EMPTY_LIST: TodoList = { nextId: 1, tasks: [] };

const failure = (action: TodoAction, message: string): TodoOutcome => ({
  ok: false,
  message: `Todo ${action} failed: ${message}`,
});

const isOutcome = <T extends object>(value: T | TodoOutcome): value is TodoOutcome => "ok" in value;

const isId = (value: number): boolean => Number.isSafeInteger(value) && value >= 1;

/** "1 Task", "3 Tasks". */
export const taskCount = (count: number): string => `${count} ${count === 1 ? "Task" : "Tasks"}`;

const MARKERS = { pending: "[ ]", active: "[>]", completed: "[x]" } as const;

/** `[ ]`, `[>]`, `[x]`: the mark of a status in the model's text. */
export const statusMarker = (status: TodoStatus): "[ ]" | "[>]" | "[x]" => MARKERS[status];

const indent = (description: string): string => "    " + description.replaceAll("\n", "\n    ");

/** The Tasks in ID order, as the model reads them. */
export const formatTasks = (tasks: ReadonlyArray<TodoTask>): string =>
  tasks.length === 0
    ? "Todo List is empty"
    : tasks
        .map((task) => {
          const description = task.description === undefined ? "" : `\n${indent(task.description)}`;

          return `${statusMarker(task.status)} #${task.id} ${task.title}${description}`;
        })
        .join("\n");

const newTask = (
  id: number,
  title: string,
  description: string | undefined,
  status: TodoStatus,
): TodoTask =>
  description === undefined || description === ""
    ? { id, title, status }
    : { id, title, description, status };

type Draft = { readonly title: string; readonly description: string | undefined };

/** A Task to add, trimmed and checked; `field` prefixes the field's name in a failure (`tasks[1].`). */
const checkDraft = (
  action: TodoAction,
  title: string | undefined,
  description: string | null | undefined,
  field: string,
): Draft | TodoOutcome => {
  const trimmed = title?.trim() ?? "";

  if (trimmed === "") return failure(action, `${field}title must not be empty`);

  if (trimmed.length > MAX_TITLE_CHARACTERS) {
    return failure(action, `${field}title is over ${MAX_TITLE_CHARACTERS} characters`);
  }

  const text = description?.trim();

  if (description !== undefined && description !== null && text === "") {
    return failure(action, `${field}description must not be empty`);
  }

  if (text !== undefined && text.length > MAX_DESCRIPTION_CHARACTERS) {
    return failure(action, `${field}description is over ${MAX_DESCRIPTION_CHARACTERS} characters`);
  }

  return { title: trimmed, description: text };
};

const addOne = (list: TodoList, input: TodoInput): TodoOutcome => {
  const draft = checkDraft("add", input.title, input.description, "");

  if (isOutcome(draft)) return draft;

  if (list.tasks.length >= MAX_TASKS) {
    return failure("add", `the list holds ${taskCount(MAX_TASKS)}; remove some first`);
  }

  const task = newTask(list.nextId, draft.title, draft.description, input.status ?? "pending");

  return {
    ok: true,
    list: { nextId: list.nextId + 1, tasks: [...list.tasks, task] },
    message: `Added Task #${task.id}`,
    output: { action: "add", task },
  };
};

/** Every draft is checked before any Task is created, so a batch is all-or-nothing. */
const addMany = (
  list: TodoList,
  input: TodoInput,
  tasks: ReadonlyArray<TodoDraft>,
): TodoOutcome => {
  if (input.title !== undefined || (input.description ?? undefined) !== undefined) {
    return failure("add", "provide either title or tasks, not both");
  }

  if (tasks.length === 0) return failure("add", "tasks must not be empty");

  const drafts: Draft[] = [];

  for (const [index, task] of tasks.entries()) {
    const draft = checkDraft("add", task.title, task.description, `tasks[${index}].`);

    if (isOutcome(draft)) return draft;

    drafts.push(draft);
  }

  if (list.tasks.length + drafts.length > MAX_TASKS) {
    return failure(
      "add",
      `the list holds ${taskCount(list.tasks.length)} and takes at most ${MAX_TASKS}; remove some first`,
    );
  }

  const status = input.status ?? "pending";

  const added = drafts.map((draft, index) =>
    newTask(list.nextId + index, draft.title, draft.description, status),
  );

  return {
    ok: true,
    list: { nextId: list.nextId + added.length, tasks: [...list.tasks, ...added] },
    message: `Added ${taskCount(added.length)}`,
    output: { action: "add", tasks: added },
  };
};

/** Replaces each changed Task where it is, keeping the order and the next ID. */
const replace = (list: TodoList, changed: ReadonlyArray<TodoTask>): TodoList => {
  const byId = new Map(changed.map((task) => [task.id, task]));

  return { nextId: list.nextId, tasks: list.tasks.map((task) => byId.get(task.id) ?? task) };
};

/** One change applied to a Task; `path` (`updates[1]`) says which entry of a batch a failure is about. */
const change = (
  task: TodoTask,
  edit: Pick<TodoChange, "title" | "description" | "status">,
  path: string | undefined,
): TodoTask | TodoOutcome => {
  const field = path === undefined ? "" : `${path}.`;

  if (edit.title === undefined && edit.description === undefined && edit.status === undefined) {
    return failure(
      "update",
      path === undefined
        ? "provide a title, description, or status"
        : `${path} must provide a title, description, or status`,
    );
  }

  const title = edit.title === undefined ? task.title : edit.title.trim();

  if (title === "") return failure("update", `${field}title must not be empty`);

  if (title.length > MAX_TITLE_CHARACTERS) {
    return failure("update", `${field}title is over ${MAX_TITLE_CHARACTERS} characters`);
  }

  // `null` removes the description.
  const description = edit.description === undefined ? task.description : edit.description?.trim();

  if (edit.description !== undefined && edit.description !== null && description === "") {
    return failure("update", `${field}description must not be empty`);
  }

  if (description !== undefined && description.length > MAX_DESCRIPTION_CHARACTERS) {
    return failure(
      "update",
      `${field}description is over ${MAX_DESCRIPTION_CHARACTERS} characters`,
    );
  }

  return newTask(task.id, title, description, edit.status ?? task.status);
};

/** Every change is checked before any Task changes, so a batch is all-or-nothing. */
const updateMany = (
  list: TodoList,
  input: TodoInput,
  updates: ReadonlyArray<TodoChange>,
): TodoOutcome => {
  if (
    input.id !== undefined ||
    input.title !== undefined ||
    (input.description ?? undefined) !== undefined ||
    input.status !== undefined
  ) {
    return failure("update", "provide either id and fields or updates, not both");
  }

  if (updates.length === 0) return failure("update", "updates must not be empty");

  const seen = new Map<number, number>();
  const changed: TodoTask[] = [];

  for (const [index, edit] of updates.entries()) {
    const path = `updates[${index}]`;

    if (!isId(edit.id)) return failure("update", `${path}.id must be a positive safe integer`);

    const first = seen.get(edit.id);

    if (first !== undefined) {
      return failure("update", `${path}.id #${edit.id} duplicates updates[${first}].id`);
    }

    seen.set(edit.id, index);

    const task = list.tasks.find((candidate) => candidate.id === edit.id);

    if (task === undefined) return failure("update", `${path}.id #${edit.id} was not found`);

    const result = change(task, edit, path);

    if (isOutcome(result)) return result;

    changed.push(result);
  }

  return {
    ok: true,
    list: replace(list, changed),
    message: `Updated ${taskCount(changed.length)}`,
    output: { action: "update", tasks: changed },
  };
};

/** Apply one call of the `todo` tool to `list`, other than the size of the result. */
const applyAction = (list: TodoList, input: TodoInput): TodoOutcome => {
  switch (input.action) {
    case "list":
      return {
        ok: true,
        list,
        message: "Todo List",
        output: { action: "list", tasks: [...list.tasks] },
      };

    case "add":
      return input.tasks === undefined ? addOne(list, input) : addMany(list, input, input.tasks);

    case "update":
    case "remove": {
      const action = input.action;

      if (action === "update" && input.updates !== undefined) {
        return updateMany(list, input, input.updates);
      }

      if (input.id === undefined) return failure(action, "id is required");

      if (!isId(input.id)) return failure(action, "id must be a positive safe integer");

      const id = input.id;
      const task = list.tasks.find((candidate) => candidate.id === id);

      if (task === undefined) return failure(action, `Task #${id} was not found`);

      if (action === "remove") {
        return {
          ok: true,
          list: {
            nextId: list.nextId,
            tasks: list.tasks.filter((candidate) => candidate !== task),
          },
          message: `Removed Task #${id}`,
          output: { action: "remove", id },
        };
      }

      const changed = change(task, input, undefined);

      if (isOutcome(changed)) return changed;

      return {
        ok: true,
        list: replace(list, [changed]),
        message: `Updated Task #${id}`,
        output: { action: "update", task: changed },
      };
    }

    case "clear": {
      const cleared = list.tasks.length;

      return {
        ok: true,
        // The IDs start again from 1.
        list: cleared > 0 || list.nextId !== 1 ? EMPTY_LIST : list,
        message: `Cleared ${taskCount(cleared)}`,
        output: { action: "clear", cleared },
      };
    }
  }
};

/** Whether the list fits in what the model reads of a result. */
const fits = (tasks: ReadonlyArray<TodoTask>): boolean => {
  const text = formatTasks(tasks);

  return text.length <= MAX_LIST_CHARACTERS && text.split("\n").length <= MAX_LIST_LINES;
};

/** Apply one call of the `todo` tool to `list`. */
export const applyTodo = (list: TodoList, input: TodoInput): TodoOutcome => {
  const outcome = applyAction(list, input);

  if (outcome.ok && outcome.list !== list && !fits(outcome.list.tasks)) {
    return failure(
      input.action,
      `the list would be over ${MAX_LIST_CHARACTERS} characters or ${MAX_LIST_LINES} lines; shorten descriptions or remove Tasks`,
    );
  }

  return outcome;
};
