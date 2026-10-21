// @effect-diagnostics preferEffectArray:off -- browser code in a React app with no Effect runtime.
// What the page says about a Todo List: how far along it is.
import type { TodoTask } from "@cloudpid/protocol";

export interface TodoProgress {
  readonly total: number;
  readonly completed: number;
  readonly active: number;
}

/** How many of `tasks` there are, are done, and are being worked on. */
export const todoProgress = (tasks: readonly TodoTask[]): TodoProgress => ({
  total: tasks.length,
  completed: tasks.filter((task) => task.status === "completed").length,
  active: tasks.filter((task) => task.status === "active").length,
});

/** "2 of 5 done", or nothing for an empty list. */
export const todoProgressLabel = (tasks: readonly TodoTask[]): string | undefined => {
  const { total, completed } = todoProgress(tasks);

  return total === 0 ? undefined : `${completed} of ${total} done`;
};
