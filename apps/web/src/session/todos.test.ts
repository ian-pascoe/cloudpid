// @effect-diagnostics preferEffectArray:off -- test code over native arrays.
import type { TodoTask } from "@cloudpid/protocol";
import { describe, expect, it } from "vitest";
import { todoProgress, todoProgressLabel } from "./todos.ts";

const task = (id: number, status: TodoTask["status"]): TodoTask => ({
  id,
  title: `Task ${id}`,
  status,
});

describe("a Todo List's progress", () => {
  it("counts the Tasks, the finished ones and the ones being worked on", () => {
    expect(
      todoProgress([
        task(1, "completed"),
        task(2, "active"),
        task(3, "active"),
        task(4, "pending"),
      ]),
    ).toEqual({ total: 4, completed: 1, active: 2 });
    expect(todoProgress([])).toEqual({ total: 0, completed: 0, active: 0 });
  });

  it("reads as how many are done, and says nothing of an empty list", () => {
    expect(todoProgressLabel([task(1, "completed"), task(2, "pending")])).toBe("1 of 2 done");
    expect(todoProgressLabel([])).toBeUndefined();
  });
});
