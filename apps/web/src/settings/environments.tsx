// @effect-diagnostics preferEffectArray:off -- JSX lists of Environments and Repos are native arrays.

// The Environments section at Global, and the Environment section at an Environment, of the Settings page
// (docs/architecture/workspace.md → Environments from the UI; GLOSSARY.md → Environment). Global's lists the Environments, each linking to its own
// settings, and makes a new one. An Environment's holds its name (saved like any section), its Repos, and its deletion
// behind a confirmation that names everything that goes with it.

import {
  DEFAULT_ENVIRONMENT,
  type EnvironmentRecord,
  GLOBAL_SCOPE,
  MAX_ENVIRONMENT_NAME_LENGTH,
  MAX_REPO_NAME_LENGTH,
  parseRepoSource,
  type SessionRecord,
  type WorkspaceRecord,
} from "@cloudpid/protocol";
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import * as Result from "effect/Result";
import { ChevronRight, GitBranch, Trash2 } from "lucide-react";
import { type FormEvent, useEffect } from "react";
import { Button } from "../components/ui/button.tsx";
import { Dialog, DialogActions, DialogProblem } from "../components/ui/dialog.tsx";
import { Input } from "../components/ui/input.tsx";
import {
  addRepoAtom,
  addRepoNameAtom,
  addRepoSourceAtom,
  createEnvironmentAtom,
  deleteEnvironmentAtom,
  deleteTypedAtom,
  environmentDialogAtom,
  environmentListAtom,
  environmentsErrorAtom,
  newEnvironmentNameAtom,
  removeRepoAtom,
  workspaceListAtom,
} from "../environments-state.ts";
import {
  deleteConfirmed,
  environmentNameProblem,
  repoNameProblem,
  sourceProblem,
} from "../environments.ts";
import { InAppLink } from "../in-app-link.tsx";
import { failureOf, settledFailureOf } from "../registry.ts";
import { navigate, settingsPath } from "../router.ts";
import { sessionListAtom } from "../sessions.ts";
import { environmentNameForm } from "./forms.ts";
import { ConfirmField, Field, Group, SectionFormView, SettingsSection } from "./parts.tsx";
import { sessionCount } from "./workspaces.tsx";

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
      <DialogProblem problem={failureOf(created)} />
    </form>
  );
};

/** An Environment in Global's list: its name and Repos, linking to its own settings. */
const EnvironmentRow = ({
  environment,
  workspaces,
}: {
  environment: EnvironmentRecord;
  workspaces: number;
}) => (
  <li>
    <InAppLink
      href={settingsPath(environment.id, "environments")}
      className="-mx-2 flex items-center gap-3 rounded-md px-2 py-2.5 transition-colors hover:bg-accent"
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm font-medium">{environment.name}</span>
        <span className="truncate text-xs text-muted-foreground">
          {environment.repos.length === 0 ? (
            "No repos"
          ) : (
            <span className="font-mono">
              {environment.repos.map((repo) => repo.name).join(", ")}
            </span>
          )}
          {` · ${workspaces} ${workspaces === 1 ? "workspace" : "workspaces"}`}
        </span>
      </span>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
    </InAppLink>
  </li>
);

/** Global's Environments section: every Environment, and the form that makes another. */
export const EnvironmentListSection = () => {
  const environments = useAtomValue(environmentListAtom);
  const listError = useAtomValue(environmentsErrorAtom);
  const workspaces = useAtomValue(workspaceListAtom) ?? [];

  return (
    <SettingsSection
      title="Environments"
      description="An environment is a set of repos and the settings of the Container they run in. Each session works in a workspace made from one."
    >
      <Group>
        <NewEnvironmentForm names={(environments ?? []).map((known) => known.name)} />
      </Group>
      <Group>
        <DialogProblem problem={listError} />
        {environments === null ? (
          listError === null && <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <ul className="flex flex-col divide-y">
            {environments.map((environment) => (
              <EnvironmentRow
                key={environment.id}
                environment={environment}
                workspaces={
                  workspaces.filter((workspace) => workspace.environment === environment.id).length
                }
              />
            ))}
          </ul>
        )}
      </Group>
    </SettingsSection>
  );
};

/**
 * The form that adds a Repo to an Environment: it records the Repo, and a Workspace made later clones it, into the
 * directory typed or else the repo's own name. Why the add was refused (a directory the Environment has already, to
 * name another) shows under it.
 */
const AddRepoForm = ({ id }: { id: string }) => {
  const [source, setSource] = useAtom(addRepoSourceAtom(id));
  const [name, setName] = useAtom(addRepoNameAtom(id));
  const [added, add] = useAtom(addRepoAtom(id));
  const adding = added.waiting;
  const problem = source.trim() === "" ? null : sourceProblem(source);
  const nameProblem = repoNameProblem(name);
  const ownName = Result.getOrUndefined(parseRepoSource(source))?.name;
  const inputId = `add-repo-${id}`;
  const nameId = `add-repo-name-${id}`;
  const ready = source.trim() !== "" && problem === null && nameProblem === null;

  const submit = (event: FormEvent) => {
    event.preventDefault();

    if (!ready || adding) return;

    add({ source, name });
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-1.5">
      <label htmlFor={inputId} className="text-sm font-medium">
        Add a repo
      </label>
      <div className="flex flex-wrap gap-2">
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
          className="min-w-48 flex-1 font-mono"
        />
        <label htmlFor={nameId} className="sr-only">
          Directory (optional)
        </label>
        <Input
          id={nameId}
          value={name}
          maxLength={MAX_REPO_NAME_LENGTH}
          onChange={(event) => {
            setName(event.target.value);
          }}
          placeholder={ownName ?? "directory"}
          title="The directory below /workspace it is cloned into; empty for the repo's own name"
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          data-1p-ignore
          disabled={adding}
          aria-invalid={nameProblem !== null}
          className="w-36 font-mono"
        />
        <Button type="submit" variant="outline" disabled={adding || !ready}>
          <GitBranch />
          {adding ? "Adding…" : "Add"}
        </Button>
      </div>
      {problem !== null && <p className="text-xs text-destructive">{problem}</p>}
      {nameProblem !== null && <p className="text-xs text-destructive">Directory: {nameProblem}</p>}
      <DialogProblem problem={settledFailureOf(added)} />
      <p className="text-xs text-muted-foreground">
        Nothing is cloned now. Workspaces made after this clone it into /workspace/
        {name.trim() === "" ? (ownName ?? "<repo>") : name.trim()}; name the directory to add two
        repos of the same name.
      </p>
    </form>
  );
};

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
        <li>Its repos, Container settings, secrets and build.</li>
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
      <DialogProblem problem={settledFailureOf(deleted)} />
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

/** The Delete group: what deleting the Environment does, and the confirmation. The default Environment has none. */
const DeleteGroup = ({ environment }: { environment: EnvironmentRecord }) => {
  const { id } = environment;
  const [dialog, setDialog] = useAtom(environmentDialogAtom(id));
  const deleted = useAtomValue(deleteEnvironmentAtom(id));
  const forgetDelete = useAtomSet(deleteEnvironmentAtom(id));

  const sessions = (useAtomValue(sessionListAtom) ?? []).filter(
    (session) => session.environment === id,
  );

  const workspaces = (useAtomValue(workspaceListAtom) ?? []).filter(
    (workspace) => workspace.environment === id,
  );

  // Once it is deleted, its settings are gone: the page goes to the list of Environments.
  const done = AsyncResult.isSuccess(deleted);

  useEffect(() => {
    if (done) navigate(settingsPath(GLOBAL_SCOPE, "environments"));
  }, [done]);

  return (
    <Group
      title="Delete"
      description="Deletes its workspaces with their files and Containers, its sessions, repos, Container settings, secrets and build, for good."
    >
      <Button
        type="button"
        variant="destructive"
        className="self-start"
        onClick={() => {
          forgetDelete(Atom.Reset);
          setDialog("delete");
        }}
      >
        <Trash2 aria-hidden />
        Delete environment…
      </Button>
      <Dialog
        open={dialog === "delete"}
        onClose={() => {
          setDialog(null);
        }}
        dismissible={!deleted.waiting}
        title={`Delete the ${environment.name} environment?`}
        description="Everything below is deleted for good."
      >
        <DeleteEnvironmentDialog
          environment={environment}
          workspaces={workspaces}
          sessions={sessions}
        />
      </Dialog>
    </Group>
  );
};

/** An Environment's Environment section: its name, Repos, Build, and deletion. */
export const EnvironmentSection = ({ environment }: { environment: EnvironmentRecord }) => {
  const { id } = environment;
  const environments = useAtomValue(environmentListAtom) ?? [];
  const [removedRepo, removeRepo] = useAtom(removeRepoAtom(id));

  const otherNames = environments.filter((other) => other.id !== id).map((other) => other.name);

  return (
    <SettingsSection
      title={environment.name}
      description="This environment's name, and the repos each of its workspaces clones."
    >
      <SectionFormView
        form={environmentNameForm}
        scope={id}
        invalid={(fields) => environmentNameProblem(fields.name, otherNames) !== null}
      >
        {(fields, set) => (
          <Group title="Name">
            <Field
              label="Name"
              htmlFor={`name-${id}`}
              problem={environmentNameProblem(fields.name, otherNames)}
              hint={
                <>
                  Its id, <span className="font-mono">{id}</span>, never changes.
                </>
              }
            >
              <Input
                id={`name-${id}`}
                value={fields.name}
                maxLength={MAX_ENVIRONMENT_NAME_LENGTH}
                autoComplete="off"
                data-1p-ignore
                aria-invalid={environmentNameProblem(fields.name, otherNames) !== null}
                onChange={(event) => {
                  set({ name: event.target.value });
                }}
                className="sm:max-w-80"
              />
            </Field>
          </Group>
        )}
      </SectionFormView>
      <Group title="Repos" className="first:border-t first:pt-6">
        {environment.repos.length === 0 ? (
          <p className="text-sm text-muted-foreground">No repos yet. Add one below.</p>
        ) : (
          <ul className="flex flex-col divide-y">
            {environment.repos.map((repo) => (
              <li key={repo.name} className="flex items-center justify-between gap-2 py-1.5">
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
        <DialogProblem problem={settledFailureOf(removedRepo)} />
        <AddRepoForm id={id} />
      </Group>
      {id !== DEFAULT_ENVIRONMENT && <DeleteGroup environment={environment} />}
    </SettingsSection>
  );
};
