// @effect-diagnostics asyncFunction:off preferEffectArray:off -- browser code in a React app with no Effect runtime: native arrays, promises, timers, Date and fetch are the platform here.

import {
  INSTANCE_DESCRIPTIONS,
  INSTANCE_TYPES,
  type InstanceType,
  type WorkspaceSettings,
} from "@cloudpid/config";
import {
  DEFAULT_WORKSPACE,
  MAX_WORKSPACE_NAME_LENGTH,
  type SessionRecord,
  type WorkspaceRecord,
  type WorkspaceSettingsState,
} from "@cloudpid/protocol";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { ArrowLeft, GitBranch, Pencil, Play, Trash2 } from "lucide-react";
import { useAtom, useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { useEffect, useState, type FormEvent } from "react";
import { Button } from "./components/ui/button.tsx";
import { Dialog, DialogActions } from "./components/ui/dialog.tsx";
import { Input } from "./components/ui/input.tsx";
import { Menu, MenuItem } from "./components/ui/menu.tsx";
import { NativeSelect } from "./components/ui/native-select.tsx";
import { navigate } from "./router.ts";
import { SessionLink } from "./sidebar.tsx";
import { exitFailure, failureOf, settledFailureOf } from "./registry.ts";
import { useSessionActions } from "./session-actions.ts";
import { sessionListAtom, sessionsErrorAtom } from "./sessions.ts";
import {
  cloneRepoAtom,
  createWorkspaceAtom,
  deleteWorkspaceAtom,
  renameWorkspaceAtom,
  reposAtom,
  updateWorkspaceSettingsAtom,
  workspaceListAtom,
  workspaceSettingsAtom,
  workspacesErrorAtom,
} from "./workspaces-state.ts";
import {
  deleteConfirmed,
  idleMinutesProblem,
  slugProblem,
  sourceProblem,
  workspaceNameProblem,
} from "./workspaces.ts";

interface Repos {
  /** The directories of the repos the Workspace holds; null until the first answer. */
  readonly repos: readonly string[] | null;
  /** Why the repos could not be listed, or why a clone failed (git's message). */
  readonly error: string | null;
  /** A clone is running. It can take a minute: the Container starts, and the repo is downloaded. */
  readonly cloning: boolean;
  /** Clone `source` into the Workspace and list its repos again; resolves to the directory it went to, or undefined. */
  readonly clone: (source: string) => Promise<string | undefined>;
}

/** The repos of Workspace `slug`, listed once and again after each clone. */
const useRepos = (slug: string): Repos => {
  const listed = useAtomValue(reposAtom(slug));
  const [cloned, cloneRepo] = useAtom(cloneRepoAtom(slug), { mode: "promiseExit" });

  return {
    repos: listed.pipe(AsyncResult.value, Option.getOrNull),
    // A clone's failure shows until the next clone starts.
    error: settledFailureOf(cloned) ?? failureOf(listed),
    cloning: cloned.waiting,
    clone: (source) =>
      cloneRepo(source).then((exit) => (Exit.isSuccess(exit) ? exit.value : undefined)),
  };
};

interface WorkspaceSettingsStore {
  /** The Workspace's settings in force; null until the first answer. */
  readonly state: WorkspaceSettingsState | null;
  /** Why the settings could not load, or why `save` was refused: the Workspace's own message. */
  readonly error: string | null;
  readonly saving: boolean;
  /** Save `settings` as overrides of the defaults; resolves to whether the Workspace accepted them. */
  readonly save: (settings: WorkspaceSettings) => Promise<boolean>;
  /** Ask for the settings again, after a failure to load them (one call to a cold Durable Object can fail). */
  readonly retry: () => void;
}

/** The Container size and idle time of Workspace `slug`, which apply at its next Container launch. */
const useWorkspaceSettings = (slug: string): WorkspaceSettingsStore => {
  const loaded = useAtomValue(workspaceSettingsAtom(slug));
  const [saved, update] = useAtom(updateWorkspaceSettingsAtom(slug), { mode: "promiseExit" });
  const retry = useAtomRefresh(workspaceSettingsAtom(slug));

  return {
    state: loaded.pipe(AsyncResult.value, Option.getOrNull),
    // A refused save shows until the next save answers; a failed load until it is asked for again.
    error: failureOf(saved) ?? settledFailureOf(loaded),
    saving: saved.waiting,
    save: (settings) => update(settings).then(Exit.isSuccess),
    retry,
  };
};

const NewWorkspaceForm = ({ onCreate }: { onCreate: (slug: string) => Promise<boolean> }) => {
  const [slug, setSlug] = useState("");
  const [busy, setBusy] = useState(false);
  const problem = slug === "" ? null : slugProblem(slug);

  const submit = async (event: FormEvent) => {
    event.preventDefault();

    if (slug === "" || problem !== null) return;

    setBusy(true);

    if (await onCreate(slug)) setSlug("");

    setBusy(false);
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-1.5">
      <label htmlFor="new-workspace" className="text-sm font-medium">
        New workspace
      </label>
      <div className="flex gap-2">
        <Input
          id="new-workspace"
          value={slug}
          onChange={(event) => {
            setSlug(event.target.value);
          }}
          placeholder="cloudpid"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          aria-invalid={problem !== null}
          className="flex-1 font-mono"
        />
        <Button type="submit" disabled={busy || slug === "" || problem !== null}>
          Create
        </Button>
      </div>
      {problem !== null && <p className="text-xs text-destructive">{problem}</p>}
    </form>
  );
};

const CloneForm = ({ slug, repos }: { slug: string; repos: Repos }) => {
  const [source, setSource] = useState("");
  const problem = source.trim() === "" ? null : sourceProblem(source);
  const id = `clone-${slug}`;

  const submit = async (event: FormEvent) => {
    event.preventDefault();

    if (source.trim() === "" || problem !== null || repos.cloning) return;

    if ((await repos.clone(source)) !== undefined) setSource("");
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        Clone a repo
      </label>
      <div className="flex gap-2">
        <Input
          id={id}
          value={source}
          onChange={(event) => {
            setSource(event.target.value);
          }}
          placeholder="owner/repo or https://github.com/owner/repo"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          disabled={repos.cloning}
          aria-invalid={problem !== null}
          className="flex-1 font-mono"
        />
        <Button
          type="submit"
          variant="outline"
          disabled={repos.cloning || source.trim() === "" || problem !== null}
        >
          <GitBranch />
          {repos.cloning ? "Cloning…" : "Clone"}
        </Button>
      </div>
      {problem !== null && <p className="text-xs text-destructive">{problem}</p>}
      {repos.cloning && (
        <p role="status" className="text-xs text-muted-foreground">
          Cloning into /workspace. The first command of a Workspace starts its Container, which
          takes a little while.
        </p>
      )}
    </form>
  );
};

/** The Container fields of the Edit dialog: size and idle time, saved together with the name. */
const ContainerFields = ({
  slug,
  instance,
  idle,
  idleProblem,
  onInstance,
  onIdle,
}: {
  slug: string;
  instance: InstanceType;
  idle: string;
  idleProblem: string | null;
  onInstance: (instance: InstanceType) => void;
  onIdle: (idle: string) => void;
}) => (
  <fieldset className="flex min-w-0 flex-col gap-3">
    <legend className="mb-2 text-xs font-medium text-muted-foreground">Container</legend>
    <div className="flex flex-col gap-1.5">
      <label htmlFor={`instance-${slug}`} className="text-sm font-medium">
        Size
      </label>
      <NativeSelect
        id={`instance-${slug}`}
        value={instance}
        onChange={(event) => {
          const picked = INSTANCE_TYPES.find((type) => type === event.target.value);

          if (picked !== undefined) onInstance(picked);
        }}
      >
        {INSTANCE_TYPES.map((type) => (
          <option key={type} value={type}>
            {type}: {INSTANCE_DESCRIPTIONS[type]}
          </option>
        ))}
      </NativeSelect>
    </div>
    <div className="flex flex-col gap-1.5">
      <label htmlFor={`idle-${slug}`} className="text-sm font-medium">
        Stop after (minutes without a command)
      </label>
      <Input
        id={`idle-${slug}`}
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
    <p className="text-xs text-muted-foreground">
      Size and idle time apply the next time the Container starts: a running one keeps what it
      started with. A saved disk larger than a smaller size's disk cannot be restored there, and the
      Container then starts from scratch.
    </p>
  </fieldset>
);

/** A dialog's form is saving: the card holds it, so the dialog stays open until the request answers. */
type DialogBusy = { busy: boolean; setBusy: (busy: boolean) => void };

/** Edit a Workspace: its name, and its Container's size and idle time. Its slug never changes. */
const EditWorkspaceDialog = ({
  workspace,
  otherNames,
  container,
  onRename,
  onClose,
  busy,
  setBusy,
}: {
  workspace: WorkspaceRecord;
  otherNames: readonly string[];
  container: WorkspaceSettingsStore;
  onRename: (name: string) => Promise<string | null>;
  onClose: () => void;
} & DialogBusy) => {
  const saved = container.state?.settings;
  const [name, setName] = useState(workspace.name);
  const [instance, setInstance] = useState<InstanceType | undefined>(saved?.instance);
  const [idle, setIdle] = useState(saved === undefined ? "" : String(saved.idleMinutes));
  const [problem, setProblem] = useState<string | null>(null);

  // The settings may answer after the dialog opened.
  useEffect(() => {
    if (saved === undefined) return;

    setInstance((current) => current ?? saved.instance);
    setIdle((current) => (current === "" ? String(saved.idleMinutes) : current));
  }, [saved]);

  const nameProblem = workspaceNameProblem(name, otherNames);
  const idleProblem = saved === undefined ? null : idleMinutesProblem(idle);
  const renamed = name.trim() !== workspace.name;

  const resized =
    saved !== undefined &&
    instance !== undefined &&
    (instance !== saved.instance || idle !== String(saved.idleMinutes));

  const submit = async (event: FormEvent) => {
    event.preventDefault();

    if (nameProblem !== null || idleProblem !== null || busy) return;

    setBusy(true);
    setProblem(null);

    const failure = renamed ? await onRename(name.trim()) : null;

    const settingsSaved =
      failure === null && resized && instance !== undefined
        ? await container.save({ instance, idleMinutes: Number(idle) })
        : true;

    setBusy(false);

    if (failure !== null) setProblem(failure);
    else if (settingsSaved) onClose();
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`name-${workspace.slug}`} className="text-sm font-medium">
          Name
        </label>
        <Input
          id={`name-${workspace.slug}`}
          value={name}
          maxLength={MAX_WORKSPACE_NAME_LENGTH}
          onChange={(event) => {
            setName(event.target.value);
          }}
          autoComplete="off"
          data-1p-ignore
          aria-invalid={nameProblem !== null}
        />
        {nameProblem === null ? (
          <p className="text-xs text-muted-foreground">
            Its slug, <span className="font-mono">{workspace.slug}</span>, stays the same.
          </p>
        ) : (
          <p className="text-xs text-destructive">{nameProblem}</p>
        )}
      </div>
      {saved !== undefined && instance !== undefined ? (
        <ContainerFields
          slug={workspace.slug}
          instance={instance}
          idle={idle}
          idleProblem={idleProblem}
          onInstance={setInstance}
          onIdle={setIdle}
        />
      ) : container.error === null ? (
        <p className="text-sm text-muted-foreground">Loading the Container's settings…</p>
      ) : (
        <div className="flex items-center gap-3">
          <p role="alert" className="text-sm whitespace-pre-wrap text-destructive">
            {container.error}
          </p>
          <Button type="button" variant="outline" size="sm" onClick={container.retry}>
            Try again
          </Button>
        </div>
      )}
      {(problem ?? (saved === undefined ? null : container.error)) !== null && (
        <p role="alert" className="text-sm whitespace-pre-wrap text-destructive">
          {problem ?? container.error}
        </p>
      )}
      <DialogActions>
        <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={busy || nameProblem !== null || idleProblem !== null || !(renamed || resized)}
        >
          {busy ? "Saving…" : "Save"}
        </Button>
      </DialogActions>
    </form>
  );
};

/** Confirm deleting a Workspace by typing its slug, after saying everything that goes with it. */
const DeleteWorkspaceDialog = ({
  workspace,
  sessions,
  onDelete,
  onClose,
  busy,
  setBusy,
}: {
  workspace: WorkspaceRecord;
  sessions: readonly SessionRecord[];
  onDelete: () => Promise<string | null>;
  onClose: () => void;
} & DialogBusy) => {
  const [typed, setTyped] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const archived = sessions.filter((session) => session.archivedAt !== null).length;
  const confirmed = deleteConfirmed(workspace.slug, typed);

  const submit = async (event: FormEvent) => {
    event.preventDefault();

    if (!confirmed || busy) return;

    setBusy(true);
    setProblem(null);

    const failure = await onDelete();

    setBusy(false);

    if (failure === null) onClose();
    else setProblem(failure);
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
      <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
        <li>
          {sessions.length === 0
            ? "It has no sessions."
            : `${sessions.length} ${sessions.length === 1 ? "session" : "sessions"}${
                archived > 0 ? ` (${archived} archived)` : ""
              }, with their conversations and history. Running ones stop first.`}
        </li>
        <li>Every repo and file in it, including work that was not pushed.</li>
        <li>Its Container, and its Container settings.</li>
      </ul>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`confirm-${workspace.slug}`} className="text-sm">
          Type <span className="font-mono font-medium">{workspace.slug}</span> to confirm
        </label>
        <Input
          id={`confirm-${workspace.slug}`}
          value={typed}
          onChange={(event) => {
            setTyped(event.target.value);
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
      {busy && (
        <p role="status" className="text-xs text-muted-foreground">
          Deleting its sessions, then its files. This can take a little while.
        </p>
      )}
      {problem !== null && (
        <p role="alert" className="text-sm whitespace-pre-wrap text-destructive">
          {problem}
        </p>
      )}
      <DialogActions>
        <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="destructive" disabled={busy || !confirmed}>
          {busy ? "Deleting…" : "Delete workspace"}
        </Button>
      </DialogActions>
    </form>
  );
};

const WorkspaceCard = ({
  workspace,
  otherNames,
  sessions,
  starting,
  onStart,
  onRename,
  onDelete,
}: {
  workspace: WorkspaceRecord;
  /** The names of the other Workspaces, which this one cannot take. */
  otherNames: readonly string[];
  /** Every Session bound to the Workspace, archived ones included. */
  sessions: readonly SessionRecord[];
  starting: boolean;
  onStart: (workspace: string, repo?: string) => void;
  onRename: (name: string) => Promise<string | null>;
  onDelete: () => Promise<string | null>;
}) => {
  const { slug } = workspace;
  const repos = useRepos(slug);
  const container = useWorkspaceSettings(slug);
  const [dialog, setDialog] = useState<"edit" | "delete" | null>(null);
  const [busy, setBusy] = useState(false);
  const shown = sessions.filter((session) => session.archivedAt === null);

  const close = () => {
    setDialog(null);
  };

  return (
    <section aria-label={workspace.name} className="flex flex-col gap-4 rounded-lg border p-4">
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
          <h2 className="truncate text-sm font-semibold">{workspace.name}</h2>
          {workspace.name !== slug && (
            <span className="truncate font-mono text-xs text-muted-foreground">{slug}</span>
          )}
        </div>
        <Menu label={`Actions for the ${workspace.name} workspace`} className="-mt-1.5 -mr-1.5">
          <MenuItem
            onSelect={() => {
              setDialog("edit");
            }}
          >
            <Pencil aria-hidden />
            Edit…
          </MenuItem>
          {slug !== DEFAULT_WORKSPACE && (
            <MenuItem
              destructive
              onSelect={() => {
                setDialog("delete");
              }}
            >
              <Trash2 aria-hidden />
              Delete…
            </MenuItem>
          )}
        </Menu>
      </div>
      <div className="flex flex-col gap-2">
        <h3 className="text-xs font-medium text-muted-foreground">Start a session in</h3>
        <ul className="flex flex-col gap-1.5">
          <li className="flex items-center justify-between gap-2">
            <span className="font-mono text-sm text-muted-foreground">/workspace</span>
            <Button
              size="sm"
              variant="outline"
              disabled={starting}
              onClick={() => {
                onStart(slug);
              }}
            >
              <Play />
              Start
            </Button>
          </li>
          {(repos.repos ?? []).map((repo) => (
            <li key={repo} className="flex items-center justify-between gap-2">
              <span className="truncate font-mono text-sm">/workspace/{repo}</span>
              <Button
                size="sm"
                variant="outline"
                disabled={starting}
                onClick={() => {
                  onStart(slug, repo);
                }}
              >
                <Play />
                Start
              </Button>
            </li>
          ))}
        </ul>
        {repos.repos === null && repos.error === null && (
          <p className="text-xs text-muted-foreground">Looking for repos…</p>
        )}
        {repos.repos?.length === 0 && (
          <p className="text-xs text-muted-foreground">No repos yet. Clone one below.</p>
        )}
      </div>
      <CloneForm slug={slug} repos={repos} />
      {repos.error !== null && (
        <p role="alert" className="text-sm whitespace-pre-wrap text-destructive">
          {repos.error}
        </p>
      )}
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
        title={`Edit ${workspace.name}`}
      >
        <EditWorkspaceDialog
          workspace={workspace}
          otherNames={otherNames}
          container={container}
          onRename={onRename}
          onClose={close}
          busy={busy}
          setBusy={setBusy}
        />
      </Dialog>
      <Dialog
        open={dialog === "delete"}
        onClose={close}
        dismissible={!busy}
        title={`Delete the ${workspace.name} workspace?`}
        description="Everything below is deleted for good. Its saved Container disk expires on its own within 30 days."
      >
        <DeleteWorkspaceDialog
          workspace={workspace}
          sessions={sessions}
          onDelete={onDelete}
          onClose={close}
          busy={busy}
          setBusy={setBusy}
        />
      </Dialog>
    </section>
  );
};

/** The Workspaces page: create a Workspace, clone repos into it, and start Sessions in a repo or at its root. */
export const WorkspacesPage = () => {
  const sessions = useAtomValue(sessionListAtom);
  const sessionsError = useAtomValue(sessionsErrorAtom);
  const workspaces = useAtomValue(workspaceListAtom);
  const listError = useAtomValue(workspacesErrorAtom);
  const createWorkspace = useAtomSet(createWorkspaceAtom, { mode: "promiseExit" });
  const renameWorkspace = useAtomSet(renameWorkspaceAtom, { mode: "promiseExit" });
  const deleteWorkspace = useAtomSet(deleteWorkspaceAtom, { mode: "promiseExit" });
  const { create: createSession } = useSessionActions();
  const [createError, setCreateError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const error = createError ?? listError;

  const create = async (slug: string) => {
    const failure = exitFailure(await createWorkspace(slug));

    setCreateError(failure);

    return failure === null;
  };

  const start = async (workspace: string, repo?: string) => {
    setStarting(true);

    await createSession(repo === undefined ? { workspace } : { workspace, repo });

    setStarting(false);
  };

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
          <h1 className="text-lg font-semibold">Workspaces</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          A workspace holds the files of one or more repos, shared by every session that works in
          it. A session started in a repo has its directory as the working directory.
        </p>
        <NewWorkspaceForm onCreate={create} />
        {(error ?? sessionsError) !== null && (
          <p role="alert" className="text-sm whitespace-pre-wrap text-destructive">
            {error ?? sessionsError}
          </p>
        )}
        {workspaces === null ? (
          error === null && <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="flex flex-col gap-4">
            {workspaces.map((workspace) => (
              <WorkspaceCard
                key={workspace.slug}
                workspace={workspace}
                otherNames={workspaces
                  .filter((other) => other.slug !== workspace.slug)
                  .map((other) => other.name)}
                sessions={(sessions ?? []).filter(
                  (session) => session.workspace === workspace.slug,
                )}
                starting={starting}
                onStart={(slug, repo) => void start(slug, repo)}
                onRename={async (name) =>
                  exitFailure(await renameWorkspace({ workspace: workspace.slug, name }))
                }
                onDelete={async () => exitFailure(await deleteWorkspace(workspace.slug))}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
