// @effect-diagnostics preferEffectArray:off -- JSX lists of changes and files are native arrays.

// The Agent changes of an Environment, or of Global (`docs/architecture/agent-changes.md`), as the Environments
// page lists those of its settings and the Skills page those of its Skills: each with its values before and after (a
// Skill's as its files' diffs), who made it and why, a revert while it is the agent's, and a dismissal. The Settings page
// lists its own changes with the same row.

import { type AgentChange, fieldSkill, type SessionRecord } from "@cloudpid/protocol";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { Check, Undo2 } from "lucide-react";
import { useAtom, useAtomValue } from "@effect/atom-react";
import { ChangeDiff } from "./change-diff.tsx";
import { Button } from "./components/ui/button.tsx";
import { DialogProblem } from "./components/ui/dialog.tsx";
import { cn } from "./lib/utils.ts";
import { changeDiff, skillFileDiffs } from "./line-diff.ts";
import { SessionLink } from "./sidebar.tsx";
import { failureOf, settledFailureOf } from "./registry.ts";
import {
  agentChangesAtom,
  dismissAgentChangeAtom,
  revertAgentChangeAtom,
} from "./environments-state.ts";
import { changeByline, changeFieldText, changeValueText, revertible } from "./environments.ts";
import { skillChangeFilesAtom, skillChangeKey } from "./skills-state.ts";

/** Whether an Agent change is a Skill's: the Skills page lists it, and the Environments page does not. */
export const isSkillChange = (change: AgentChange): boolean => fieldSkill(change.field) !== null;

/**
 * The files an Agent change of a Skill added, removed or changed, each as the lines that changed. The texts are asked
 * for when the row shows, since the change records only their hashes.
 */
const SkillChangeDiff = ({ environment, change }: { environment: string; change: number }) => {
  const loaded = useAtomValue(skillChangeFilesAtom(skillChangeKey(environment, change)));
  const loadError = failureOf(loaded);
  const files = loaded.pipe(AsyncResult.value, Option.map(skillFileDiffs), Option.getOrNull);

  if (files === null) {
    return <p className="text-xs text-muted-foreground">{loadError ?? "Loading the files…"}</p>;
  }

  if (files.length === 0) {
    return <p className="text-xs text-muted-foreground">No file changed.</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      {files.map((file) => (
        <div key={file.path} className="flex min-w-0 flex-col gap-0.5">
          <span className="font-mono text-xs break-all text-muted-foreground">
            {file.path}
            {file.status === "changed" ? "" : ` (${file.status})`}
          </span>
          <ChangeDiff rows={file.rows} />
        </div>
      ))}
    </div>
  );
};

/** A value before or after an Agent change, in full: a variable's can be long, so it scrolls. */
const ChangeValue = ({ label, value }: { label: string; value: AgentChange["before"] }) => (
  <div className="flex min-w-0 flex-col gap-0.5">
    <span className="text-xs text-muted-foreground">{label}</span>
    <pre
      className={cn(
        "max-h-40 overflow-auto rounded bg-muted px-2 py-1 font-mono text-xs break-all whitespace-pre-wrap",
        value === null && "text-muted-foreground italic",
      )}
    >
      {changeValueText(value)}
    </pre>
  </div>
);

/**
 * One Agent change: the setting, its values before and after, who made it and why, a revert while it is the agent's,
 * and a dismissal that takes it off the list and keeps what it changed.
 */
export const AgentChangeRow = ({
  change,
  session,
  reverting,
  onRevert,
  dismissing,
  onDismiss,
}: {
  change: AgentChange;
  /** The Session that made it, when it is still listed. */
  session: SessionRecord | undefined;
  reverting: boolean;
  onRevert: () => void;
  dismissing: boolean;
  onDismiss: () => void;
}) => {
  // A script or the Toolchains is long: it shows as the lines that changed. So does each file of a Skill.
  const diff = changeDiff(change.field, change.before, change.after);
  const skill = fieldSkill(change.field) !== null;

  return (
    <li className="flex flex-col gap-1.5 rounded-md border p-2">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="font-mono text-sm break-all">{changeFieldText(change.field)}</span>
          <span className="text-xs text-muted-foreground">
            {/* A change's time is read against the wall clock as the card renders. */}
            {/* @effect-diagnostics-next-line globalDate:off */}
            {changeByline(change, Date.now())}
            {change.actor === "agent" && change.session !== null && session === undefined
              ? ", in a session that is gone"
              : null}
          </span>
          {session !== undefined && (
            <SessionLink session={session} active={false} className="-ml-2 text-xs" />
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {revertible(change) ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={reverting}
              aria-label={`Revert change ${change.id}: ${changeFieldText(change.field)}`}
              onClick={onRevert}
            >
              <Undo2 aria-hidden />
              Revert
            </Button>
          ) : change.revertedBy !== null ? (
            <span className="text-xs text-muted-foreground">Reverted</span>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={dismissing}
            aria-label={`Dismiss change ${change.id}: ${changeFieldText(change.field)}`}
            title="Keep the change and take it off this list"
            onClick={onDismiss}
          >
            <Check aria-hidden />
            Dismiss
          </Button>
        </div>
      </div>
      {change.reason !== "" && <p className="text-sm break-words">{change.reason}</p>}
      {skill ? (
        <SkillChangeDiff environment={change.scope} change={change.id} />
      ) : diff === undefined ? (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <ChangeValue label="Before" value={change.before} />
          <ChangeValue label="After" value={change.after} />
        </div>
      ) : (
        <ChangeDiff rows={diff} />
      )}
    </li>
  );
};

/**
 * Environment `id`'s Agent changes that `only` keeps, newest first (`docs/architecture/agent-changes.md`), each with the Session that made it,
 * a revert and a dismissal. A revert the Registry refuses (its field has changed since) says why.
 */
export const AgentChangesSection = ({
  id,
  sessions,
  only,
  empty,
}: {
  id: string;
  /** Every Session made in the Environment, archived ones included. */
  sessions: readonly SessionRecord[];
  /** The changes the section lists: the Environments page lists those of its settings, the Skills page its Skills'. */
  only: (change: AgentChange) => boolean;
  /** What the section says while it lists none. */
  empty: string;
}) => {
  const loaded = useAtomValue(agentChangesAtom(id));
  const [reverted, revert] = useAtom(revertAgentChangeAtom(id));
  const [dismissed, dismiss] = useAtom(dismissAgentChangeAtom(id));
  const loadError = failureOf(loaded);

  const changes = loaded.pipe(
    AsyncResult.value,
    Option.map((all) => all.filter(only)),
    Option.getOrNull,
  );

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-medium text-muted-foreground">Agent changes</h3>
      {changes === null ? (
        <p className="text-xs text-muted-foreground">{loadError ?? "Loading…"}</p>
      ) : changes.length === 0 ? (
        <p className="text-xs text-muted-foreground">{empty}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {changes.map((change) => (
            <AgentChangeRow
              key={change.id}
              change={change}
              session={sessions.find((session) => session.id === change.session)}
              reverting={reverted.waiting}
              onRevert={() => {
                revert(change.id);
              }}
              dismissing={dismissed.waiting}
              onDismiss={() => {
                dismiss(change.id);
              }}
            />
          ))}
        </ul>
      )}
      <DialogProblem problem={settledFailureOf(reverted)} />
      <DialogProblem problem={settledFailureOf(dismissed)} />
    </div>
  );
};
