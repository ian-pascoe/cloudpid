// @effect-diagnostics preferEffectArray:off -- JSX lists of Workspaces and Sessions are native arrays.

// The Workspaces section of the Settings page (docs/architecture/workspace.md → Environments from the UI): an Environment's Workspaces, or at
// Global every Environment's under its name, each with a new Session in it, a restart of its Container, and its
// removal behind a confirmation that names what goes with it. A Subagent Workspace names its subagent, and its removal
// deletes the subagent too.

import { GLOBAL_SCOPE, type SessionRecord, type WorkspaceRecord } from "@cloudpid/protocol";
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Arr from "effect/Array";
import * as Predicate from "effect/Predicate";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import { Bot, GitFork, Play, RotateCw, Trash2 } from "lucide-react";
import type { FormEvent } from "react";
import { Button } from "../components/ui/button.tsx";
import { Dialog, DialogActions, DialogProblem } from "../components/ui/dialog.tsx";
import {
  describeWorkspaceWork,
  type EnvironmentDialog,
  environmentDialogAtom,
  environmentsInOrderAtom,
  environmentsErrorAtom,
  removeWorkspaceAtom,
  removeWorkspaceTypedAtom,
  restartContainerAtom,
  startSessionAtom,
  subagentWorkspacesBelow,
  workspaceListAtom,
  workspaceWorkAtom,
} from "../environments-state.ts";
import { deleteConfirmed } from "../environments.ts";
import { InAppLink } from "../in-app-link.tsx";
import { failureOf, settledFailureOf } from "../registry.ts";
import { sessionPath, settingsPath } from "../router.ts";
import { SubagentWorkspaceLoss } from "../session-menu.tsx";
import { sessionListAtom, sessionsErrorAtom } from "../sessions.ts";
import { sessionTitle } from "../sidebar.tsx";
import { ConfirmField, Group, Pending, SettingsSection } from "./parts.tsx";

/** "1 session (1 archived)" for `sessions`, or null when there are none. */
export const sessionCount = (sessions: readonly SessionRecord[]): string | null => {
  if (sessions.length === 0) return null;

  const archived = sessions.filter((session) => session.archivedAt !== null).length;

  return `${sessions.length} ${sessions.length === 1 ? "session" : "sessions"}${
    archived > 0 ? ` (${archived} archived)` : ""
  }`;
};

/** Confirm restarting a Workspace's Container, after saying what it keeps and what it loses. */
const RestartContainerDialog = ({ id, workspace }: { id: string; workspace: WorkspaceRecord }) => {
  const [restarted, run] = useAtom(restartContainerAtom(id));
  const setDialog = useAtomSet(environmentDialogAtom(id));
  const busy = restarted.waiting;

  const submit = (event: FormEvent) => {
    event.preventDefault();

    if (busy) return;

    run(workspace.id);
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
        <li>Its files and sessions stay.</li>
        <li>Commands running in the Container stop.</li>
        <li>
          The next command starts a new Container from the environment's build when one is usable,
          else from the image, which installs the Toolchains again. The Setup Scripts run again.
          This can take a while.
        </li>
        <li>
          What only the Container held is gone: dependency directories such as node_modules, build
          output and caches.
        </li>
      </ul>
      {busy && (
        <p role="status" className="text-xs text-muted-foreground">
          Stopping the Container.
        </p>
      )}
      <DialogProblem problem={settledFailureOf(restarted)} />
      <DialogActions>
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => {
            setDialog(null);
          }}
        >
          Cancel
        </Button>
        <Button type="submit" variant="destructive" disabled={busy}>
          {busy ? "Restarting…" : "Restart container"}
        </Button>
      </DialogActions>
    </form>
  );
};

/** Confirm removing a Workspace by typing its branch, after saying what goes with it and what stays. */
const RemoveWorkspaceDialog = ({
  id,
  workspace,
  sessions,
}: {
  id: string;
  workspace: WorkspaceRecord;
  /** The Sessions in the Workspace, archived ones included. */
  sessions: readonly SessionRecord[];
}) => {
  const [typed, setTyped] = useAtom(removeWorkspaceTypedAtom(workspace.id));
  const [removed, run] = useAtom(removeWorkspaceAtom(id));
  const setDialog = useAtomSet(environmentDialogAtom(id));
  const busy = removed.waiting;
  const confirmed = deleteConfirmed(workspace.branch, typed);
  const count = sessionCount(sessions);

  const submit = (event: FormEvent) => {
    event.preventDefault();

    if (!confirmed || busy) return;

    run(workspace.id);
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
        <li>
          {count === null
            ? "It has no sessions."
            : `${count} in it, with their conversations and history. Running ones stop first.`}
        </li>
        <li>
          Its files and Container, including changes that were not committed and commits that were
          not pushed.
        </li>
      </ul>
      <p className="text-sm text-muted-foreground">
        What was pushed to <span className="font-mono">{workspace.branch}</span> stays on the
        remote.
      </p>
      <ConfirmField
        id={`remove-workspace-confirm-${workspace.id}`}
        expected={workspace.branch}
        typed={typed}
        busy={busy}
        onTyped={setTyped}
      />
      {busy && (
        <p role="status" className="text-xs text-muted-foreground">
          Deleting its sessions, then its files. This can take a little while.
        </p>
      )}
      <DialogProblem problem={settledFailureOf(removed)} />
      <DialogActions>
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => {
            setDialog(null);
          }}
        >
          Cancel
        </Button>
        <Button type="submit" variant="destructive" disabled={busy || !confirmed}>
          {busy ? "Removing…" : "Remove workspace"}
        </Button>
      </DialogActions>
    </form>
  );
};

/** What Workspace `id` holds that is not on the remote, read when the confirmation opens: what removing it loses. */
const UnpushedWork = ({ id }: { id: string }) => {
  const work = useAtomValue(workspaceWorkAtom(id));

  return AsyncResult.match(work, {
    onInitial: () => (
      <p role="status" className="text-xs text-muted-foreground">
        Reading what it has not pushed…
      </p>
    ),
    onFailure: () => (
      <p role="alert" className="text-sm text-destructive">
        What it has not pushed could not be read ({failureOf(work)}): it may hold work that is lost
        with it.
      </p>
    ),
    onSuccess: ({ value }) =>
      value.length === 0 ? (
        <p className="text-sm text-muted-foreground">Everything in it is committed and pushed.</p>
      ) : (
        <p role="alert" className="text-sm text-destructive">
          Not pushed, and lost with it: {describeWorkspaceWork(value)}.
        </p>
      ),
  });
};

/**
 * Confirm removing a Subagent Workspace by typing its branch: its subagent is deleted with it, as `subagent_delete`
 * does, after naming what it has not pushed.
 */
const RemoveSubagentWorkspaceDialog = ({
  id,
  workspace,
  agent,
  session,
}: {
  id: string;
  workspace: WorkspaceRecord;
  agent: string;
  /** The Session the subagent is in, when it is listed. */
  session: SessionRecord | undefined;
}) => {
  const [typed, setTyped] = useAtom(removeWorkspaceTypedAtom(workspace.id));
  const [removed, run] = useAtom(removeWorkspaceAtom(id));
  const setDialog = useAtomSet(environmentDialogAtom(id));
  const busy = removed.waiting;
  const confirmed = deleteConfirmed(workspace.branch, typed);

  // The Subagent Workspaces of the subagents below it, which go too: each that holds work not pushed is named.
  const below = subagentWorkspacesBelow(useAtomValue(workspaceListAtom), {
    session: workspace.subagent?.session ?? "",
    agent,
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();

    if (!confirmed || busy) return;

    run(workspace.id);
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
        <li>
          Subagent <span className="font-mono">{agent}</span>
          {session === undefined ? "" : ` of “${sessionTitle(session)}”`}, and every subagent below
          it: their work stops for good.
        </li>
        <li>Its files and Container, and those of the Subagent Workspaces below it.</li>
      </ul>
      <UnpushedWork id={workspace.id} />
      {below.length > 0 && (
        <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-destructive">
          {Arr.map(below, (each) => (
            <SubagentWorkspaceLoss key={each.id} workspace={each} />
          ))}
        </ul>
      )}
      <p className="text-sm text-muted-foreground">
        What was pushed to <span className="font-mono">{workspace.branch}</span> stays on the
        remote.
      </p>
      <ConfirmField
        id={`remove-workspace-confirm-${workspace.id}`}
        expected={workspace.branch}
        typed={typed}
        busy={busy}
        onTyped={setTyped}
      />
      <DialogProblem problem={settledFailureOf(removed)} />
      <DialogActions>
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => {
            setDialog(null);
          }}
        >
          Cancel
        </Button>
        <Button type="submit" variant="destructive" disabled={busy || !confirmed}>
          {busy ? "Removing…" : "Remove workspace"}
        </Button>
      </DialogActions>
    </form>
  );
};

/** The subagent a Subagent Workspace was made for, linking to its Session. */
const SubagentMark = ({
  agent,
  session,
}: {
  agent: string;
  session: SessionRecord | undefined;
}) => (
  <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
    <Bot className="size-3.5 shrink-0" aria-hidden />
    <span className="shrink-0">
      subagent <span className="font-mono">{agent}</span>
    </span>
    {session !== undefined && (
      <InAppLink
        href={sessionPath(session.id)}
        className="truncate underline-offset-2 hover:underline"
      >
        of {sessionTitle(session)}
      </InAppLink>
    )}
  </span>
);

/** A Workspace: its branch and how much is in it, with the actions on it. */
const WorkspaceRow = ({
  workspace,
  sessions,
  owner,
  starting,
  onStart,
  onRestart,
  onRemove,
}: {
  workspace: WorkspaceRecord;
  /** The Sessions in the Workspace, archived ones included. */
  sessions: readonly SessionRecord[];
  /** For a Subagent Workspace: the Session its subagent is in, when it is listed. */
  owner: SessionRecord | undefined;
  starting: boolean;
  onStart: () => void;
  onRestart: () => void;
  onRemove: () => void;
}) => {
  const repos = workspace.repos.length;
  const count = sessionCount(sessions);

  return (
    <li className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2">
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-2 text-sm">
          <GitFork className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate font-mono">{workspace.branch}</span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {repos} {repos === 1 ? "repo" : "repos"}
            {workspace.subagent === undefined ? ` · ${count ?? "no sessions"}` : ""}
          </span>
        </span>
        {workspace.subagent !== undefined && (
          <SubagentMark agent={workspace.subagent.agent} session={owner} />
        )}
      </span>
      <div className="flex items-center gap-1.5">
        {workspace.subagent === undefined && (
          <Button
            size="sm"
            variant="outline"
            disabled={starting}
            aria-label={`New session in the ${workspace.branch} workspace`}
            title={`New session in the ${workspace.branch} workspace`}
            onClick={onStart}
          >
            <Play />
            New session here
          </Button>
        )}
        <Button
          size="icon"
          variant="ghost"
          className="size-8"
          aria-label={`Restart the container of the ${workspace.branch} workspace`}
          title="Restart container"
          onClick={onRestart}
        >
          <RotateCw />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-8"
          aria-label={`Remove the ${workspace.branch} workspace`}
          title="Remove workspace"
          onClick={onRemove}
        >
          <Trash2 />
        </Button>
      </div>
    </li>
  );
};

/** Environment `id`'s Workspaces, with their actions and dialogs. */
const EnvironmentWorkspaces = ({
  id,
  sessions,
}: {
  id: string;
  /** Every Session made in the Environment, archived ones included. */
  sessions: readonly SessionRecord[];
}) => {
  // Starting a Session holds the buttons until it is registered and opened; a refusal shows until the next one.
  const [started, start] = useAtom(startSessionAtom(id));
  const workspaceList = useAtomValue(workspaceListAtom);
  const workspaces = (workspaceList ?? []).filter((workspace) => workspace.environment === id);
  const [dialog, setDialog] = useAtom(environmentDialogAtom(id));
  const restarted = useAtomValue(restartContainerAtom(id));
  const removed = useAtomValue(removeWorkspaceAtom(id));
  const forgetRestart = useAtomSet(restartContainerAtom(id));
  const forgetRemove = useAtomSet(removeWorkspaceAtom(id));
  const busy = restarted.waiting || removed.waiting;

  const restarting = Predicate.hasProperty(dialog, "restart")
    ? (workspaces.find((workspace) => workspace.id === dialog.restart) ?? null)
    : null;

  const removing = Predicate.hasProperty(dialog, "removeWorkspace")
    ? (workspaces.find((workspace) => workspace.id === dialog.removeWorkspace) ?? null)
    : null;

  const open = (next: EnvironmentDialog) => {
    // A failure of an earlier restart or removal shows no more once a dialog is opened again.
    forgetRestart(Atom.Reset);
    forgetRemove(Atom.Reset);
    setDialog(next);
  };

  const close = () => {
    setDialog(null);
  };

  return (
    <>
      {workspaces.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {workspaceList === null ? "Loading…" : "No workspaces yet. A new session makes one."}
        </p>
      ) : (
        <ul className="flex flex-col divide-y">
          {workspaces.map((workspace) => (
            <WorkspaceRow
              key={workspace.id}
              workspace={workspace}
              sessions={sessions.filter((session) => session.workspace === workspace.id)}
              owner={sessions.find((session) => session.id === workspace.subagent?.session)}
              starting={started.waiting}
              onStart={() => {
                start(workspace.id);
              }}
              onRestart={() => {
                open({ restart: workspace.id });
              }}
              onRemove={() => {
                open({ removeWorkspace: workspace.id });
              }}
            />
          ))}
        </ul>
      )}
      <DialogProblem problem={settledFailureOf(started)} />
      <Dialog
        open={restarting !== null}
        onClose={close}
        dismissible={!busy}
        title={`Restart the container of ${restarting?.branch ?? ""}?`}
      >
        {restarting !== null && <RestartContainerDialog id={id} workspace={restarting} />}
      </Dialog>
      <Dialog
        open={removing !== null}
        onClose={close}
        dismissible={!busy}
        title={`Remove the ${removing?.branch ?? ""} workspace?`}
        description="Uncommitted changes and unpushed commits are lost for good."
      >
        {removing !== null &&
          (removing.subagent === undefined ? (
            <RemoveWorkspaceDialog
              id={id}
              workspace={removing}
              sessions={sessions.filter((session) => session.workspace === removing.id)}
            />
          ) : (
            <RemoveSubagentWorkspaceDialog
              id={id}
              workspace={removing}
              agent={removing.subagent.agent}
              session={sessions.find((session) => session.id === removing.subagent?.session)}
            />
          ))}
      </Dialog>
    </>
  );
};

/** Global's Workspaces section: every Environment's, under its name. */
const AllWorkspaces = ({ sessions }: { sessions: readonly SessionRecord[] }) => {
  const environments = useAtomValue(environmentsInOrderAtom);
  const listError = useAtomValue(environmentsErrorAtom);

  if (environments === null) return <Pending problem={listError} />;

  return environments.map((environment) => (
    <Group key={environment.id} title={environment.name}>
      <EnvironmentWorkspaces
        id={environment.id}
        sessions={sessions.filter((session) => session.environment === environment.id)}
      />
      <InAppLink
        href={settingsPath(environment.id, "workspaces")}
        className="self-start text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
      >
        {environment.name}'s settings
      </InAppLink>
    </Group>
  ));
};

/** The Workspaces section at Scope `scope`. */
export const WorkspacesSection = ({ scope }: { scope: string }) => {
  const sessions = useAtomValue(sessionListAtom) ?? [];
  const sessionsError = useAtomValue(sessionsErrorAtom);

  return (
    <SettingsSection
      title="Workspaces"
      description="Each session works in a workspace: its own clones of the environment's repos on a branch of its own, and its own Container, so sessions working at once do not step on each other."
    >
      <DialogProblem problem={sessionsError} />
      {scope === GLOBAL_SCOPE ? (
        <AllWorkspaces sessions={sessions} />
      ) : (
        <Group>
          <EnvironmentWorkspaces
            id={scope}
            sessions={sessions.filter((session) => session.environment === scope)}
          />
        </Group>
      )}
    </SettingsSection>
  );
};
