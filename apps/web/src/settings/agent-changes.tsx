// @effect-diagnostics preferEffectArray:off -- JSX lists of changes are native arrays.

// The Agent changes section of the Settings page (docs/architecture/agent-changes.md): every change the agent made at
// the Scope, newest first, Skills' included. An Environment's are its own (its Container settings, Secrets' and
// variables' names, Skills); Global's are the Settings' (`listSettingsChanges`) and those kept Global
// (`listAgentChanges` of `*`: the variables, Secrets and Skills kept Global), merged by time. Each has its revert, while
// it is the agent's, and its dismissal; a refused one says why.

import type { AgentChange, SessionRecord } from "@cloudpid/protocol";
import { GLOBAL_SCOPE } from "@cloudpid/protocol";
import { useAtom, useAtomValue } from "@effect/atom-react";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { AgentChangeRow } from "../agent-change-list.tsx";
import { DialogProblem } from "../components/ui/dialog.tsx";
import {
  agentChangesAtom,
  dismissAgentChangeAtom,
  revertAgentChangeAtom,
} from "../environments-state.ts";
import { failureOf, settledFailureOf } from "../registry.ts";
import { sessionListAtom } from "../sessions.ts";
import {
  dismissSettingsChangeAtom,
  revertSettingsChangeAtom,
  settingsChangesAtom,
} from "../settings.ts";
import { Group, Pending, SettingsSection } from "./parts.tsx";

/** Where a listed change is kept: the Settings', or the Scope's own. */
type Source = "settings" | "scope";

interface Listed {
  readonly source: Source;
  readonly change: AgentChange;
}

const newestFirst = Order.mapInput(Order.flip(Order.Number), (listed: Listed) => listed.change.at);

/** The changes `loaded` holds, from `source`; null until they answer. */
const listedOf = (
  loaded: AsyncResult.AsyncResult<ReadonlyArray<AgentChange>, unknown>,
  source: Source,
): ReadonlyArray<Listed> | null =>
  loaded.pipe(
    AsyncResult.value,
    Option.map(Arr.map((change): Listed => ({ source, change }))),
    Option.getOrNull,
  );

/** The list, with the revert and the dismissal of each change, by where it is kept. */
const ChangeList = ({
  scope,
  listed,
  sessions,
}: {
  scope: string;
  listed: ReadonlyArray<Listed>;
  sessions: readonly SessionRecord[];
}) => {
  const [reverted, revert] = useAtom(revertAgentChangeAtom(scope));
  const [dismissed, dismiss] = useAtom(dismissAgentChangeAtom(scope));
  const [settingsReverted, revertSetting] = useAtom(revertSettingsChangeAtom);
  const [settingsDismissed, dismissSetting] = useAtom(dismissSettingsChangeAtom);

  const problem =
    settledFailureOf(reverted) ??
    settledFailureOf(dismissed) ??
    settledFailureOf(settingsReverted) ??
    settledFailureOf(settingsDismissed);

  return (
    <>
      {listed.length === 0 ? (
        <p className="text-sm text-muted-foreground">The agent has changed nothing here.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {listed.map(({ source, change }) => (
            <AgentChangeRow
              key={`${source}:${change.id}`}
              change={change}
              session={sessions.find((session) => session.id === change.session)}
              reverting={source === "settings" ? settingsReverted.waiting : reverted.waiting}
              onRevert={() => {
                if (source === "settings") revertSetting(change.id);
                else revert(change.id);
              }}
              dismissing={source === "settings" ? settingsDismissed.waiting : dismissed.waiting}
              onDismiss={() => {
                if (source === "settings") dismissSetting(change.id);
                else dismiss(change.id);
              }}
            />
          ))}
        </ul>
      )}
      <DialogProblem problem={problem} />
    </>
  );
};

/** Global's changes: the Settings' and those kept Global, merged. */
const GlobalChanges = ({ sessions }: { sessions: readonly SessionRecord[] }) => {
  const settings = useAtomValue(settingsChangesAtom);
  const kept = useAtomValue(agentChangesAtom(GLOBAL_SCOPE));
  const fromSettings = listedOf(settings, "settings");
  const fromScope = listedOf(kept, "scope");

  if (fromSettings === null || fromScope === null) {
    return <Pending problem={failureOf(settings) ?? failureOf(kept)} />;
  }

  return (
    <ChangeList
      scope={GLOBAL_SCOPE}
      listed={Arr.sort([...fromSettings, ...fromScope], newestFirst)}
      sessions={sessions}
    />
  );
};

/** Environment `scope`'s changes. */
const EnvironmentChanges = ({
  scope,
  sessions,
}: {
  scope: string;
  sessions: readonly SessionRecord[];
}) => {
  const loaded = useAtomValue(agentChangesAtom(scope));
  const listed = listedOf(loaded, "scope");

  if (listed === null) {
    return <Pending problem={failureOf(loaded)} />;
  }

  return <ChangeList scope={scope} listed={Arr.sort(listed, newestFirst)} sessions={sessions} />;
};

/** The Agent changes section at Scope `scope`. */
export const AgentChangesSettingsSection = ({ scope }: { scope: string }) => {
  const sessions = useAtomValue(sessionListAtom) ?? [];

  return (
    <SettingsSection
      title="Agent changes"
      description="What the agent changed here when you asked it to, newest first. Reverting one writes its old value back, unless it has changed since. Dismissing one keeps it and takes it off this list."
    >
      <Group>
        {scope === GLOBAL_SCOPE ? (
          <GlobalChanges sessions={sessions} />
        ) : (
          <EnvironmentChanges
            scope={scope}
            sessions={sessions.filter((session) => session.environment === scope)}
          />
        )}
      </Group>
    </SettingsSection>
  );
};
