// The owner's view of one MCP task (`docs/architecture/mcp-server-requests.md` → MCP tasks, The owner's UI): the line of
// words from `mcp-task.ts` with Cancel while it goes on and, for a stdio server's task that went on in the background, the
// Container's warning and Keep the Container. It sits on the call card and in a Session details row. Both commands go over
// the socket; while it is not live they are off, and a task the Session refuses (it ended meanwhile) shows the Session's
// message under the line.
import type { McpTask } from "@cloudpid/protocol";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { exitFailure } from "../registry.ts";
import {
  cancelMcpTaskAtom,
  keepMcpContainerAtom,
  mcpTasksAtom,
  sessionStatusAtom,
} from "../session/atoms.ts";
import { useShownSessionId } from "./conversation.ts";
import { useNow } from "./mcp-elicitation-card.tsx";
import { isLive, STDIO_WARNING, taskLine, taskOfCall } from "./mcp-task.ts";

/** What a strip takes: the task, the time now, whether the commands are off, and each command (the Session's refusal, or null). */
type StripProps = {
  task: McpTask;
  now: number;
  disabled: boolean;
  onCancel: () => Promise<string | null>;
  onKeep: () => Promise<string | null>;
};

/** The strip for `task`: pure over its props, so a test draws it at a time of its own. */
export const McpTaskStripView = ({ task, now, disabled, onCancel, onKeep }: StripProps) => {
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const live = isLive(task);
  const cancelling = live && task.cancel !== undefined;
  const keeps = live && task.stdio === true && task.background;

  const run = (command: () => Promise<string | null>) => {
    setBusy(true);
    setRefusal(null);
    void command().then((refused) => {
      setBusy(false);
      setRefusal(refused);
    });
  };

  return (
    <div className="mt-2 text-xs first:mt-0" data-mcp-task={task.task}>
      <div className="flex flex-wrap items-center gap-2">
        <span role="status" className="min-w-0 break-words text-muted-foreground">
          {taskLine(task, now)}
        </span>
        {live && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-6 px-2 text-xs"
            disabled={disabled || busy || cancelling}
            onClick={() => {
              run(onCancel);
            }}
          >
            Cancel
          </Button>
        )}
        {keeps && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-6 px-2 text-xs"
            disabled={disabled || busy}
            onClick={() => {
              run(onKeep);
            }}
          >
            Keep the Container
          </Button>
        )}
      </div>
      {keeps && <p className="mt-1 text-muted-foreground">{STDIO_WARNING}</p>}
      {refusal !== null && (
        <p role="alert" className="mt-1 text-destructive">
          {refusal}
        </p>
      )}
    </div>
  );
};

/** The strip for `task` of the Session shown, with the clock ticking while it goes on. */
export const McpTaskStrip = ({ task }: { task: McpTask }) => {
  const sessionId = useShownSessionId();
  const disabled = useAtomValue(sessionStatusAtom(sessionId), (status) => status !== "live");
  const cancel = useAtomSet(cancelMcpTaskAtom(sessionId), { mode: "promiseExit" });
  const keep = useAtomSet(keepMcpContainerAtom(sessionId), { mode: "promiseExit" });
  const now = useNow(isLive(task) ? undefined : task.endedAt);

  return (
    <McpTaskStripView
      task={task}
      now={now}
      disabled={disabled}
      onCancel={() => cancel(task.task).then(exitFailure)}
      onKeep={() => keep(task.task).then(exitFailure)}
    />
  );
};

/**
 * What the card of an MCP tool's call says of the task it started, under the card: nothing for a call that started none.
 * The Session's list finds it by the call's id, so a call that is still running has its line (a running call has no
 * `details` yet), and a call that ended keeps it with how the task ended.
 */
export const McpTaskCall = ({ callId }: { callId: string }) => {
  const sessionId = useShownSessionId();
  const task = useAtomValue(mcpTasksAtom(sessionId), (tasks) => taskOfCall(tasks, callId));

  return task === undefined ? null : <McpTaskStrip task={task} />;
};
