import type { TriggerDefinition } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import { Pause, Play, X } from "lucide-react";
import { triggerSourceWords } from "../triggers.ts";

/**
 * The Session triggers of the Session (`docs/architecture/triggers.md` → The owner's UI): each one's name and Schedule,
 * "Paused" while it is, a button that pauses or resumes it and a ✕ that removes it. The owner's changes take effect at
 * once, with no confirmation; one that fails says why beneath them. Nothing when the Session has none and nothing failed.
 */
export const SessionTriggers = ({
  triggers,
  problem,
  onPause,
  onRemove,
}: {
  readonly triggers: ReadonlyArray<TriggerDefinition>;
  /** Why the last pause, resume or removal failed (`TriggerUnscheduled` included), or null. */
  readonly problem: string | null;
  readonly onPause: (trigger: TriggerDefinition) => void;
  readonly onRemove: (trigger: TriggerDefinition) => void;
}) => {
  if (triggers.length === 0 && problem === null) return null;

  return (
    <section aria-label="Triggers">
      <h4 className="text-xs font-medium text-muted-foreground">Triggers</h4>
      <ul className="mt-1 text-sm">
        {Arr.map(triggers, (trigger) => (
          <li key={trigger.id} className="flex items-center justify-between gap-2">
            <span className="min-w-0 break-words">
              <span className="font-medium">{trigger.name}</span>
              {trigger.paused && <span className="text-xs text-muted-foreground"> (Paused)</span>}
              <br />
              <span className="font-mono text-xs text-muted-foreground">
                {triggerSourceWords(trigger)}
              </span>
            </span>
            <span className="flex shrink-0 items-center">
              <button
                type="button"
                aria-label={`${trigger.paused ? "Resume" : "Pause"} ${trigger.name}`}
                title={trigger.paused ? "Resume" : "Pause"}
                onClick={() => {
                  onPause(trigger);
                }}
                className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground [&_svg]:size-3.5"
              >
                {trigger.paused ? <Play aria-hidden /> : <Pause aria-hidden />}
              </button>
              <button
                type="button"
                aria-label={`Remove ${trigger.name}`}
                title="Remove the trigger, with its fire log"
                onClick={() => {
                  onRemove(trigger);
                }}
                className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground [&_svg]:size-3.5"
              >
                <X aria-hidden />
              </button>
            </span>
          </li>
        ))}
      </ul>
      {problem !== null && (
        <p role="alert" className="mt-1 text-xs text-destructive">
          {problem}
        </p>
      )}
    </section>
  );
};
