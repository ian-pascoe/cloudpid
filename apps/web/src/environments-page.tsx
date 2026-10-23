// @effect-diagnostics preferEffectArray:off -- JSX lists of cards, Repos, Workspaces and Sessions are native arrays.

import { INSTANCE_TYPES, type InstanceType } from "@cloudpid/config";
import {
  DEFAULT_ENVIRONMENT,
  MAX_ENVIRONMENT_NAME_LENGTH,
  type EnvironmentRecord,
  type SessionRecord,
  type WorkspaceRecord,
} from "@cloudpid/protocol";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import { ArrowLeft, GitBranch, GitFork, Pencil, Play, RotateCw, Trash2 } from "lucide-react";
import {
  useAtom,
  useAtomMount,
  useAtomRefresh,
  useAtomSet,
  useAtomValue,
} from "@effect/atom-react";
import type { FormEvent } from "react";
import { Button } from "./components/ui/button.tsx";
import { Dialog, DialogActions } from "./components/ui/dialog.tsx";
import { Input } from "./components/ui/input.tsx";
import { Menu, MenuItem } from "./components/ui/menu.tsx";
import { NativeSelect } from "./components/ui/native-select.tsx";
import { callOf } from "./calls.ts";
import { navigate } from "./router.ts";
import { SessionLink } from "./sidebar.tsx";
import { failureOf, settledFailureOf } from "./registry.ts";
import { createSessionAtom, sessionListAtom, sessionsErrorAtom } from "./sessions.ts";
import {
  addRepoAtom,
  addRepoSourceAtom,
  createEnvironmentAtom,
  deleteEnvironmentAtom,
  deleteTypedAtom,
  environmentDialogAtom,
  environmentDraftAtom,
  environmentListAtom,
  environmentSettingsAtom,
  environmentsErrorAtom,
  newEnvironmentNameAtom,
  removeRepoAtom,
  removeWorkspaceAtom,
  removeWorkspaceTypedAtom,
  restartContainerAtom,
  saveEnvironmentAtom,
  workspaceListAtom,
  type EnvironmentDialog,
} from "./environments-state.ts";
import {
  deleteConfirmed,
  environmentNameProblem,
  idleMinutesProblem,
  ignorePatternsFrom,
  ignoreProblem,
  instanceLabel,
  sourceProblem,
} from "./environments.ts";

const NewEnvironmentForm = ({ names }: { names: readonly string[] }) => {
  const [name, setName] = useAtom(newEnvironmentNameAtom);
  const [created, create] = useAtom(createEnvironmentAtom);
  const problem = name.trim() === "" ? null : environmentNameProblem(name, names);

  const submit = (event: FormEvent) => {
    event.preventDefault();

    if (name.trim() === "" || problem !== null) return;

    create(name.trim());
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-1.5">
      <label htmlFor="new-environment" className="text-sm font-medium">
        New environment
      </label>
      <div className="flex gap-2">
        <Input
          id="new-environment"
          value={name}
          maxLength={MAX_ENVIRONMENT_NAME_LENGTH}
          onChange={(event) => {
            setName(event.target.value);
          }}
          placeholder="Work"
          autoComplete="off"
          data-1p-ignore
          aria-invalid={problem !== null}
          className="flex-1"
        />
        <Button type="submit" disabled={created.waiting || name.trim() === "" || problem !== null}>
          Create
        </Button>
      </div>
      {problem !== null && <p className="text-xs text-destructive">{problem}</p>}
    </form>
  );
};

/** The form that adds a Repo to an Environment: it records the Repo, and a Workspace made later clones it. */
const AddRepoForm = ({ id }: { id: string }) => {
  const [source, setSource] = useAtom(addRepoSourceAtom(id));
  const [added, add] = useAtom(addRepoAtom(id));
  const adding = added.waiting;
  const problem = source.trim() === "" ? null : sourceProblem(source);
  const inputId = `add-repo-${id}`;

  const submit = (event: FormEvent) => {
    event.preventDefault();

    if (source.trim() === "" || problem !== null || adding) return;

    add(source);
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-1.5">
      <label htmlFor={inputId} className="text-sm font-medium">
        Add a repo
      </label>
      <div className="flex gap-2">
        <Input
          id={inputId}
          value={source}
          onChange={(event) => {
            setSource(event.target.value);
          }}
          placeholder="owner/repo or https://github.com/owner/repo"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          disabled={adding}
          aria-invalid={problem !== null}
          className="flex-1 font-mono"
        />
        <Button
          type="submit"
          variant="outline"
          disabled={adding || source.trim() === "" || problem !== null}
        >
          <GitBranch />
          {adding ? "Adding…" : "Add"}
        </Button>
      </div>
      {problem !== null && <p className="text-xs text-destructive">{problem}</p>}
      <p className="text-xs text-muted-foreground">
        Nothing is cloned now. Workspaces made after this clone it.
      </p>
    </form>
  );
};

/** The Container fields of the Edit dialog: size, idle time and extra paths, saved together with the name. */
const ContainerFields = ({
  id,
  instance,
  idle,
  idleProblem,
  paths,
  pathsProblem,
  onInstance,
  onIdle,
  onPaths,
}: {
  id: string;
  instance: InstanceType;
  idle: string;
  idleProblem: string | null;
  paths: string;
  pathsProblem: string | null;
  onInstance: (instance: InstanceType) => void;
  onIdle: (idle: string) => void;
  onPaths: (paths: string) => void;
}) => (
  <fieldset className="flex min-w-0 flex-col gap-3">
    <legend className="mb-2 text-xs font-medium text-muted-foreground">Container</legend>
    <div className="flex flex-col gap-1.5">
      <label htmlFor={`instance-${id}`} className="text-sm font-medium">
        Size
      </label>
      <NativeSelect
        id={`instance-${id}`}
        value={instance}
        onChange={(event) => {
          const picked = INSTANCE_TYPES.find((type) => type === event.target.value);

          if (picked !== undefined) onInstance(picked);
        }}
      >
        {INSTANCE_TYPES.map((type) => (
          <option key={type} value={type}>
            {instanceLabel(type)}
          </option>
        ))}
      </NativeSelect>
    </div>
    <div className="flex flex-col gap-1.5">
      <label htmlFor={`idle-${id}`} className="text-sm font-medium">
        Stop after (minutes without a command)
      </label>
      <Input
        id={`idle-${id}`}
        type="number"
        inputMode="numeric"
        min={1}
        value={idle}
        onChange={(event) => {
          onIdle(event.target.value);
        }}
        aria-invalid={idleProblem !== null}
      />
      {idleProblem !== null && <p className="text-xs text-destructive">{idleProblem}</p>}
    </div>
    <div className="flex flex-col gap-1.5">
      <label htmlFor={`paths-${id}`} className="text-sm font-medium">
        More Container-only paths (one per line)
      </label>
      <textarea
        id={`paths-${id}`}
        rows={3}
        value={paths}
        placeholder={"/data\n**/.gradle-cache"}
        spellCheck={false}
        onChange={(event) => {
          onPaths(event.target.value);
        }}
        aria-invalid={pathsProblem !== null}
        className="min-w-0 rounded-md border border-input bg-background px-2.5 py-2 font-mono text-sm focus-visible:outline-2 focus-visible:outline-ring"
      />
      {pathsProblem === null ? (
        <p className="text-xs text-muted-foreground">
          Kept on the Container, out of the Workspace, like node_modules. Start with / (from
          /workspace) or **/ (at any depth); a line starting with ! keeps a path synced. What a
          Workspace already holds there stays until it is deleted.
        </p>
      ) : (
        <p className="text-xs text-destructive">{pathsProblem}</p>
      )}
    </div>
    <p className="text-xs text-muted-foreground">
      These apply the next time a Workspace's Container starts: a running one keeps what it started
      with. A saved disk larger than a smaller size's disk cannot be restored there, and one saved
      with other paths is not restored; the Container then starts from scratch.
    </p>
  </fieldset>
);

/** Edit an Environment: its name, and its Container's size, idle time and extra paths. Its id never changes. */
const EditEnvironmentDialog = ({
  environment,
  otherNames,
}: {
  environment: EnvironmentRecord;
  otherNames: readonly string[];
}) => {
  const { id } = environment;
  const loaded = useAtomValue(environmentSettingsAtom(id));
  // Ask for the settings again, after a failure to load them.
  const retry = useAtomRefresh(environmentSettingsAtom(id));
  const [draft, setDraft] = useAtom(environmentDraftAtom(id));
  const [edited, save] = useAtom(saveEnvironmentAtom(id));
  const setDialog = useAtomSet(environmentDialogAtom(id));
  const { name, instance, idle, ignore } = draft;

  const saved = loaded.pipe(
    AsyncResult.value,
    Option.map((state) => state.settings),
    Option.getOrUndefined,
  );

  const saving = edited.waiting;
  // A refused save shows until the next save starts; a failed load until it is asked for again.
  const loadError = settledFailureOf(loaded);
  const saveError = settledFailureOf(edited);
  const nameProblem = environmentNameProblem(name, otherNames);
  const idleProblem = saved === undefined ? null : idleMinutesProblem(idle);
  const pathsProblem = ignore === undefined ? null : ignoreProblem(ignore);
  const renamed = name.trim() !== environment.name;
  const patterns = ignore === undefined ? [] : ignorePatternsFrom(ignore);

  const settingsChanged =
    saved !== undefined &&
    instance !== undefined &&
    (instance !== saved.instance ||
      idle !== String(saved.idleMinutes) ||
      patterns.join("\n") !== saved.ignore.join("\n"));

  const invalid = nameProblem !== null || idleProblem !== null || pathsProblem !== null;

  const submit = (event: FormEvent) => {
    event.preventDefault();

    if (invalid || saving) return;

    save({
      name: renamed ? name.trim() : undefined,
      settings:
        settingsChanged && instance !== undefined
          ? { instance, idleMinutes: Number(idle), ignore: patterns }
          : undefined,
    });
  };

  const problem = saveError ?? (saved === undefined ? null : loadError);

  return (
    <form onSubmit={submit} className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`name-${id}`} className="text-sm font-medium">
          Name
        </label>
        <Input
          id={`name-${id}`}
          value={name}
          maxLength={MAX_ENVIRONMENT_NAME_LENGTH}
          onChange={(event) => {
            setDraft((current) => ({ ...current, name: event.target.value }));
          }}
          autoComplete="off"
          data-1p-ignore
          aria-invalid={nameProblem !== null}
        />
        {nameProblem !== null && <p className="text-xs text-destructive">{nameProblem}</p>}
      </div>
      {saved !== undefined && instance !== undefined ? (
        <ContainerFields
          id={id}
          instance={instance}
          idle={idle}
          idleProblem={idleProblem}
          paths={ignore ?? ""}
          pathsProblem={pathsProblem}
          onPaths={(typed) => {
            setDraft((current) => ({ ...current, ignore: typed }));
          }}
          onInstance={(picked) => {
            setDraft((current) => ({ ...current, instance: picked }));
          }}
          onIdle={(typed) => {
            setDraft((current) => ({ ...current, idle: typed }));
          }}
        />
      ) : loadError === null ? (
        <p className="text-sm text-muted-foreground">Loading the Container's settings…</p>
      ) : (
        <div className="flex items-center gap-3">
          <p role="alert" className="text-sm whitespace-pre-wrap text-destructive">
            {loadError}
          </p>
          <Button type="button" variant="outline" size="sm" onClick={retry}>
            Try again
          </Button>
        </div>
      )}
      {problem !== null && (
        <p role="alert" className="text-sm whitespace-pre-wrap text-destructive">
          {problem}
        </p>
      )}
      <DialogActions>
        <Button
          type="button"
          variant="outline"
          disabled={saving}
          onClick={() => {
            setDialog(null);
          }}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={saving || invalid || !(renamed || settingsChanged)}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </DialogActions>
    </form>
  );
};

/** "1 session (1 archived)" for `sessions`, or null when there are none. */
const sessionCount = (sessions: readonly SessionRecord[]): string | null => {
  if (sessions.length === 0) return null;

  const archived = sessions.filter((session) => session.archivedAt !== null).length;

  return `${sessions.length} ${sessions.length === 1 ? "session" : "sessions"}${
    archived > 0 ? ` (${archived} archived)` : ""
  }`;
};

/** The field that asks for `expected` to be typed before a destructive dialog's button works. */
const ConfirmField = ({
  id,
  expected,
  typed,
  busy,
  onTyped,
}: {
  id: string;
  expected: string;
  typed: string;
  busy: boolean;
  onTyped: (typed: string) => void;
}) => (
  <div className="flex flex-col gap-1.5">
    <label htmlFor={id} className="text-sm">
      Type <span className="font-mono font-medium">{expected}</span> to confirm
    </label>
    <Input
      id={id}
      value={typed}
      onChange={(event) => {
        onTyped(event.target.value);
      }}
      autoCapitalize="none"
      autoCorrect="off"
      autoComplete="off"
      data-1p-ignore
      spellCheck={false}
      disabled={busy}
      className="font-mono"
    />
  </div>
);

/** The failure of a dialog's action, shown until the action starts again. */
const DialogProblem = ({ problem }: { problem: string | null }) =>
  problem === null ? null : (
    <p role="alert" className="text-sm whitespace-pre-wrap text-destructive">
      {problem}
    </p>
  );

/** Confirm deleting an Environment by typing its name, after saying everything that goes with it. */
const DeleteEnvironmentDialog = ({
  environment,
  workspaces,
  sessions,
}: {
  environment: EnvironmentRecord;
  workspaces: readonly WorkspaceRecord[];
  sessions: readonly SessionRecord[];
}) => {
  const { id, name } = environment;
  const [typed, setTyped] = useAtom(deleteTypedAtom(id));
  const [deleted, remove] = useAtom(deleteEnvironmentAtom(id));
  const setDialog = useAtomSet(environmentDialogAtom(id));
  const busy = deleted.waiting;
  const problem = settledFailureOf(deleted);
  const confirmed = deleteConfirmed(name, typed);
  const count = sessionCount(sessions);

  const submit = (event: FormEvent) => {
    event.preventDefault();

    if (!confirmed || busy) return;

    remove();
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
        <li>
          {workspaces.length === 0
            ? "It has no workspaces."
            : `${workspaces.length} ${workspaces.length === 1 ? "workspace" : "workspaces"}, with their files and Containers, including changes that were not committed or pushed.`}
        </li>
        <li>
          {count === null
            ? "It has no sessions."
            : `${count}, with their conversations and history. Running ones stop first.`}
        </li>
        <li>Its repos and Container settings.</li>
      </ul>
      <ConfirmField
        id={`confirm-${id}`}
        expected={name}
        typed={typed}
        busy={busy}
        onTyped={setTyped}
      />
      {busy && (
        <p role="status" className="text-xs text-muted-foreground">
          Removing its workspaces, one by one. This can take a little while.
        </p>
      )}
      <DialogProblem problem={problem} />
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
          {busy ? "Deleting…" : "Delete environment"}
        </Button>
      </DialogActions>
    </form>
  );
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
          The next command starts a new Container from the image and installs the Toolchains again,
          which takes a while.
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

/** A Workspace in an Environment's card: its branch and how much is in it, with the actions on it. */
const WorkspaceRow = ({
  workspace,
  sessions,
  starting,
  onStart,
  onRestart,
  onRemove,
}: {
  workspace: WorkspaceRecord;
  /** The Sessions in the Workspace, archived ones included. */
  sessions: readonly SessionRecord[];
  starting: boolean;
  onStart: () => void;
  onRestart: () => void;
  onRemove: () => void;
}) => {
  const repos = workspace.repos.length;
  const count = sessionCount(sessions);

  return (
    <li className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
      <span className="flex min-w-0 items-center gap-2 text-sm">
        <GitFork className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="truncate font-mono">{workspace.branch}</span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {repos} {repos === 1 ? "repo" : "repos"} · {count ?? "no sessions"}
        </span>
      </span>
      <div className="flex items-center gap-1.5">
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

const EnvironmentCard = ({
  environment,
  otherNames,
  sessions,
  starting,
  onStart,
}: {
  environment: EnvironmentRecord;
  /** The names of the other Environments, which this one cannot take. */
  otherNames: readonly string[];
  /** Every Session made in the Environment, archived ones included. */
  sessions: readonly SessionRecord[];
  starting: boolean;
  onStart: (workspace: string) => void;
}) => {
  const { id } = environment;
  const workspaceList = useAtomValue(workspaceListAtom);
  const workspaces = (workspaceList ?? []).filter((workspace) => workspace.environment === id);
  const removeRepo = useAtomSet(removeRepoAtom(id));
  const removedRepo = useAtomValue(removeRepoAtom(id));
  const added = useAtomValue(addRepoAtom(id));
  // The Container's settings are asked for with the card, so the Edit dialog has them when it opens.
  useAtomMount(environmentSettingsAtom(id));
  const [dialog, setDialog] = useAtom(environmentDialogAtom(id));
  const edited = useAtomValue(saveEnvironmentAtom(id));
  const deleted = useAtomValue(deleteEnvironmentAtom(id));
  const restarted = useAtomValue(restartContainerAtom(id));
  const removed = useAtomValue(removeWorkspaceAtom(id));
  const forgetEdit = useAtomSet(saveEnvironmentAtom(id));
  const forgetDelete = useAtomSet(deleteEnvironmentAtom(id));
  const forgetRestart = useAtomSet(restartContainerAtom(id));
  const forgetRemove = useAtomSet(removeWorkspaceAtom(id));
  const shown = sessions.filter((session) => session.archivedAt === null);

  // A dialog's form is saving: the card holds it, so the dialog stays open until the request answers.
  const busy = edited.waiting || deleted.waiting || restarted.waiting || removed.waiting;

  const restarting = Predicate.hasProperty(dialog, "restart")
    ? (workspaces.find((workspace) => workspace.id === dialog.restart) ?? null)
    : null;

  const removing = Predicate.hasProperty(dialog, "removeWorkspace")
    ? (workspaces.find((workspace) => workspace.id === dialog.removeWorkspace) ?? null)
    : null;

  // An add's or a removal's failure shows until the next one starts.
  const reposError = settledFailureOf(added) ?? settledFailureOf(removedRepo);

  const open = (next: EnvironmentDialog) => {
    // A failure of an earlier save, delete, restart or removal shows no more once a dialog is opened again.
    forgetEdit(Atom.Reset);
    forgetDelete(Atom.Reset);
    forgetRestart(Atom.Reset);
    forgetRemove(Atom.Reset);
    setDialog(next);
  };

  const close = () => {
    setDialog(null);
  };

  return (
    <section aria-label={environment.name} className="flex flex-col gap-4 rounded-lg border p-4">
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
          <h2 className="truncate text-sm font-semibold">{environment.name}</h2>
        </div>
        <Menu label={`Actions for the ${environment.name} environment`} className="-mt-1.5 -mr-1.5">
          <MenuItem
            onSelect={() => {
              open("edit");
            }}
          >
            <Pencil aria-hidden />
            Edit…
          </MenuItem>
          {id !== DEFAULT_ENVIRONMENT && (
            <MenuItem
              destructive
              onSelect={() => {
                open("delete");
              }}
            >
              <Trash2 aria-hidden />
              Delete…
            </MenuItem>
          )}
        </Menu>
      </div>
      <div className="flex flex-col gap-2">
        <h3 className="text-xs font-medium text-muted-foreground">Repos</h3>
        {environment.repos.length === 0 ? (
          <p className="text-xs text-muted-foreground">No repos yet. Add one below.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {environment.repos.map((repo) => (
              <li key={repo.name} className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 flex-col">
                  <span className="truncate font-mono text-sm">{repo.name}</span>
                  <span className="truncate font-mono text-xs text-muted-foreground">
                    {repo.url}
                  </span>
                </span>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-8"
                  aria-label={`Remove ${repo.name}`}
                  title={`Remove ${repo.name}`}
                  disabled={removedRepo.waiting}
                  onClick={() => {
                    removeRepo(repo.name);
                  }}
                >
                  <Trash2 />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <AddRepoForm id={id} />
      {reposError !== null && (
        <p role="alert" className="text-sm whitespace-pre-wrap text-destructive">
          {reposError}
        </p>
      )}
      <div className="flex flex-col gap-2">
        <h3 className="text-xs font-medium text-muted-foreground">Workspaces</h3>
        {workspaces.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {workspaceList === null ? "Loading…" : "No workspaces yet. A new session makes one."}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {workspaces.map((workspace) => (
              <WorkspaceRow
                key={workspace.id}
                workspace={workspace}
                sessions={sessions.filter((session) => session.workspace === workspace.id)}
                starting={starting}
                onStart={() => {
                  onStart(workspace.id);
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
      </div>
      {shown.length > 0 && (
        <div className="flex flex-col gap-1">
          <h3 className="text-xs font-medium text-muted-foreground">Sessions</h3>
          <ul className="flex flex-col gap-0.5">
            {shown.map((session) => (
              <li key={session.id}>
                <SessionLink session={session} active={false} />
              </li>
            ))}
          </ul>
        </div>
      )}
      <Dialog
        open={dialog === "edit"}
        onClose={close}
        dismissible={!busy}
        title={`Edit ${environment.name}`}
      >
        <EditEnvironmentDialog environment={environment} otherNames={otherNames} />
      </Dialog>
      <Dialog
        open={dialog === "delete"}
        onClose={close}
        dismissible={!busy}
        title={`Delete the ${environment.name} environment?`}
        description="Everything below is deleted for good."
      >
        <DeleteEnvironmentDialog
          environment={environment}
          workspaces={workspaces}
          sessions={sessions}
        />
      </Dialog>
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
        {removing !== null && (
          <RemoveWorkspaceDialog
            id={id}
            workspace={removing}
            sessions={sessions.filter((session) => session.workspace === removing.id)}
          />
        )}
      </Dialog>
    </section>
  );
};

/** The Environments page: make an Environment, add Repos to it, and manage its Workspaces and Sessions. */
export const EnvironmentsPage = () => {
  const sessions = useAtomValue(sessionListAtom);
  const sessionsError = useAtomValue(sessionsErrorAtom);
  const environments = useAtomValue(environmentListAtom);
  const listError = useAtomValue(environmentsErrorAtom);
  const createdEnvironment = useAtomValue(createEnvironmentAtom);
  const createSession = useAtomSet(createSessionAtom);
  // Starting a Session holds every button until the new Session is registered and opened.
  const starting = useAtomValue(createSessionAtom).waiting;
  const error = failureOf(createdEnvironment) ?? listError;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              navigate("/");
            }}
            aria-label="Back to sessions"
            className="-ml-2 rounded-md p-2 hover:bg-accent md:hidden"
          >
            <ArrowLeft className="size-4" />
          </button>
          <h1 className="text-lg font-semibold">Environments</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          An environment is a set of repos and the settings of the container they run in. Each
          session works in a workspace made from one: its own clones of the repos on a branch of its
          own, and its own container, so sessions working at once do not step on each other.
        </p>
        <NewEnvironmentForm names={(environments ?? []).map((known) => known.name)} />
        {(error ?? sessionsError) !== null && (
          <p role="alert" className="text-sm whitespace-pre-wrap text-destructive">
            {error ?? sessionsError}
          </p>
        )}
        {environments === null ? (
          error === null && <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="flex flex-col gap-4">
            {environments.map((environment) => (
              <EnvironmentCard
                key={environment.id}
                environment={environment}
                otherNames={environments
                  .filter((other) => other.id !== environment.id)
                  .map((other) => other.name)}
                sessions={(sessions ?? []).filter(
                  (session) => session.environment === environment.id,
                )}
                starting={starting}
                onStart={(workspace) => {
                  createSession(callOf({ environment: environment.id, workspace }));
                }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
