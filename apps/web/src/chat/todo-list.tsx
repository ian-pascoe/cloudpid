// A conversation's Todo List: the Tasks the agent keeps, in the order of their IDs, with what each one's status is.

// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- browser code in a React app with no Effect runtime.

import type { TodoTask } from "@cloudpid/protocol";
import { CircleCheck, CircleDot, Circle } from "lucide-react";
import { cn } from "../lib/utils.ts";
import { todoProgressLabel } from "../session/todos.ts";

const STATUS = {
  pending: { Icon: Circle, label: "Pending", className: "text-muted-foreground" },
  active: { Icon: CircleDot, label: "In progress", className: "text-primary" },
  completed: { Icon: CircleCheck, label: "Done", className: "text-muted-foreground" },
} as const;

const TaskRow = ({ task }: { task: TodoTask }) => {
  const { Icon, label, className } = STATUS[task.status];

  return (
    <li className="flex items-start gap-2 py-1 text-sm">
      <Icon className={cn("mt-0.5 size-4 shrink-0", className)} aria-label={label} />
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            "wrap-break-word",
            task.status === "active" && "font-medium",
            task.status === "completed" && "text-muted-foreground line-through",
          )}
        >
          <span className="mr-1.5 font-mono text-xs text-muted-foreground">#{task.id}</span>
          {task.title}
        </p>
        {task.description !== undefined && (
          <p className="text-xs whitespace-pre-wrap text-muted-foreground">{task.description}</p>
        )}
      </div>
    </li>
  );
};

/** The Tasks of a Todo List, headed by how many are done; nothing for an empty list. */
export const TodoList = ({
  tasks,
  className,
}: {
  tasks: readonly TodoTask[];
  className?: string;
}) => {
  if (tasks.length === 0) return null;

  return (
    <section aria-label="Todo list" className={className}>
      <h4 className="flex items-baseline justify-between text-xs font-medium text-muted-foreground">
        <span>Todo</span>
        <span className="tabular-nums">{todoProgressLabel(tasks)}</span>
      </h4>
      <ul className="mt-1">
        {tasks.map((task) => (
          <TaskRow key={task.id} task={task} />
        ))}
      </ul>
    </section>
  );
};
