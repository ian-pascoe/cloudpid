// @effect-diagnostics preferEffectArray:off -- JSX lists of cards, Repos, Workspaces and Sessions are native arrays.

import { INSTANCE_TYPES, type InstanceType } from "@cloudpid/config";
import {
  DEFAULT_ENVIRONMENT,
  MAX_ENVIRONMENT_NAME_LENGTH,
  MAX_REPO_NAME_LENGTH,
  MAX_SECRET_NAME_LENGTH,
  parseRepoSource,
  type EnvironmentRecord,
  type EnvironmentSecretRecord,
  type SessionRecord,
  type WorkspaceRecord,
} from "@cloudpid/protocol";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import {
  ArrowLeft,
  GitBranch,
  GitFork,
  KeyRound,
  Pencil,
  Play,
  RotateCw,
  Trash2,
} from "lucide-react";
import {
  useAtom,
  useAtomMount,
  useAtomRefresh,
  useAtomSet,
  useAtomValue,
} from "@effect/atom-react";
import type { FormEvent } from "react";
import { Button } from "./components/ui/button.tsx";
import { Dialog, DialogActions, DialogProblem } from "./components/ui/dialog.tsx";
import { Input } from "./components/ui/input.tsx";
import { Menu, MenuItem } from "./components/ui/menu.tsx";
import { NativeSelect } from "./components/ui/native-select.tsx";
import { navigate } from "./router.ts";
import { SessionLink } from "./sidebar.tsx";
import { failureOf, settledFailureOf } from "./registry.ts";
import { sessionListAtom, sessionsErrorAtom } from "./sessions.ts";
import {
  addRepoAtom,
  addRepoNameAtom,
  addRepoSourceAtom,
  createEnvironmentAtom,
  deleteEnvironmentAtom,
  deleteSecretAtom,
  deleteTypedAtom,
  environmentBuildAtom,
  environmentSecretsAtom,
  environmentSecretsErrorAtom,
  saveSecretAtom,
  setSecretBuildAtom,
  secretDialogAtom,
  secretDraftAtom,
  secretsInAtom,
  environmentDialogAtom,
  environmentDraftAtom,
  environmentListAtom,
  environmentSettingsAtom,
  environmentsErrorAtom,
  newEnvironmentNameAtom,
  rebuildEnvironmentAtom,
  removeRepoAtom,
  removeWorkspaceAtom,
  removeWorkspaceTypedAtom,
  restartContainerAtom,
  saveEnvironmentAtom,
  startSessionAtom,
  workspaceListAtom,
  type EnvironmentDialog,
} from "./environments-state.ts";
import {
  buildLine,
  deleteConfirmed,
  EVERY_ENVIRONMENT,
  inheritedSecrets,
  secretDraftProblems,
  secretDraftReady,
  secretVariable,
  environmentNameProblem,
  idleMinutesProblem,
  ignorePatternsFrom,
  ignoreProblem,
  instanceLabel,
  parseVariables,
  repoNameProblem,
  scriptFieldProblem,
  toolchainsFieldProblem,
  sourceProblem,
  variablesText,
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

/**
 * The form of a Secrets section: a name and a value, kept by the Registry, which never shows the value again. The
 * value's field hides what is typed where the browser can, and holds several lines, for a key file. A name the section
 * keeps already replaces that Secret's value.
 */
const SecretForm = ({ sectionKey }: { sectionKey: string }) => {
  const [draft, setDraft] = useAtom(secretDraftAtom(sectionKey));
  const [saved, save] = useAtom(saveSecretAtom(sectionKey));
  const kept = useAtomValue(secretsInAtom(sectionKey)) ?? [];
  const problems = secretDraftProblems(draft);
  const replacing = kept.some((record) => record.name === draft.name);
  const busy = saved.waiting;
  const error = settledFailureOf(saved);
  const nameId = `secret-name-${sectionKey}`;
  const valueId = `secret-value-${sectionKey}`;
  const buildId = `secret-build-${sectionKey}`;

  const submit = (event: FormEvent) => {
    event.preventDefault();

    if (!secretDraftReady(draft) || busy) return;

    save();
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <div className="flex flex-col gap-1.5">
        <label htmlFor={nameId} className="text-sm font-medium">
          {replacing ? "Replace a secret" : "Add a secret"}
        </label>
        <Input
          id={nameId}
          value={draft.name}
          maxLength={MAX_SECRET_NAME_LENGTH}
          onChange={(event) => {
            setDraft({ ...draft, name: event.target.value.toUpperCase() });
          }}
          placeholder="NAME"
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          data-1p-ignore
          disabled={busy}
          aria-invalid={problems.name !== null}
          className="font-mono"
        />
        {problems.name !== null && <p className="text-xs text-destructive">{problems.name}</p>}
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={valueId} className="sr-only">
          Value
        </label>
        <textarea
          id={valueId}
          rows={2}
          value={draft.value}
          placeholder="Value"
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          data-1p-ignore
          disabled={busy}
          onChange={(event) => {
            setDraft({ ...draft, value: event.target.value });
          }}
          aria-invalid={problems.value !== null}
          className={`${CODE_FIELD} [-webkit-text-security:disc]`}
        />
        {problems.value !== null && <p className="text-xs text-destructive">{problems.value}</p>}
      </div>
      <div className="flex items-center justify-between gap-2">
        {replacing ? (
          <p className="text-xs text-muted-foreground">
            Replaces the value kept under this name. Its build setting stays.
          </p>
        ) : (
          <label htmlFor={buildId} className="flex items-center gap-2 text-xs">
            <input
              id={buildId}
              type="checkbox"
              checked={draft.build}
              disabled={busy}
              onChange={(event) => {
                setDraft({ ...draft, build: event.target.checked });
              }}
            />
            Give it to the build's setup scripts too
          </label>
        )}
        <Button type="submit" variant="outline" disabled={busy || !secretDraftReady(draft)}>
          <KeyRound />
          {busy ? "Saving…" : replacing ? "Replace" : "Add"}
        </Button>
      </div>
      <DialogProblem problem={error} />
    </form>
  );
};

/** Confirm deleting Secret `name` of a Secrets section, after saying what stays where it was. */
const DeleteSecretDialog = ({ sectionKey, name }: { sectionKey: string; name: string }) => {
  const [deleted, remove] = useAtom(deleteSecretAtom(sectionKey));
  const setDialog = useAtomSet(secretDialogAtom(sectionKey));
  const busy = deleted.waiting;
  const problem = settledFailureOf(deleted);

  const submit = (event: FormEvent) => {
    event.preventDefault();

    if (busy) return;

    remove(name);
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <p className="text-sm">
        Sessions stop getting it within a minute, and the next build runs without it. What a command
        or a model already did with it stays as it is: revoke it where it was issued if it may have
        leaked.
      </p>
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
        <Button type="submit" variant="destructive" disabled={busy}>
          {busy ? "Deleting…" : "Delete secret"}
        </Button>
      </DialogActions>
    </form>
  );
};

/** A kept Secret in a Secrets section: its name, whether it reaches the Build, and its actions. */
const SecretRow = ({
  sectionKey,
  record,
  onReplace,
  onDelete,
}: {
  sectionKey: string;
  record: EnvironmentSecretRecord;
  onReplace: () => void;
  onDelete: () => void;
}) => {
  const [switched, setBuild] = useAtom(setSecretBuildAtom(sectionKey));
  const buildId = `secret-${sectionKey}-${record.name}-build`;

  return (
    <li className="flex items-center justify-between gap-2">
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-mono text-sm">{record.name}</span>
        <span className="truncate text-xs text-muted-foreground">
          {record.build
            ? `Sessions, and the build's setup scripts as $${secretVariable(record.name)}`
            : "Sessions only"}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-1">
        <label htmlFor={buildId} className="flex items-center gap-1.5 text-xs">
          <input
            id={buildId}
            type="checkbox"
            checked={record.build}
            disabled={switched.waiting}
            onChange={(event) => {
              setBuild({ name: record.name, build: event.target.checked });
            }}
          />
          Build
        </label>
        <Button type="button" size="sm" variant="ghost" onClick={onReplace}>
          Replace
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-8"
          aria-label={`Delete ${record.name}`}
          title={`Delete ${record.name}`}
          onClick={onDelete}
        >
          <Trash2 />
        </Button>
      </span>
    </li>
  );
};

/**
 * The Secrets kept in section `sectionKey` (an Environment's id, or `EVERY_ENVIRONMENT`), with the form that keeps
 * another. An Environment's section names the Secrets it gets from every Environment, and which of its own win.
 */
const SecretsSection = ({
  sectionKey,
  title,
  empty,
}: {
  sectionKey: string;
  title: string;
  empty: string;
}) => {
  const kept = useAtomValue(secretsInAtom(sectionKey));
  const all = useAtomValue(environmentSecretsAtom).pipe(AsyncResult.value, Option.getOrNull);
  const loadError = useAtomValue(environmentSecretsErrorAtom);
  const [draft, setDraft] = useAtom(secretDraftAtom(sectionKey));
  const [deleting, setDeleting] = useAtom(secretDialogAtom(sectionKey));
  const deleted = useAtomValue(deleteSecretAtom(sectionKey));
  const forgetDelete = useAtomSet(deleteSecretAtom(sectionKey));
  const switched = useAtomValue(setSecretBuildAtom(sectionKey));

  const inherited =
    sectionKey === EVERY_ENVIRONMENT || all === null ? [] : inheritedSecrets(all, sectionKey);

  const switchError = settledFailureOf(switched);

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      {kept === null ? (
        loadError === null && <p className="text-xs text-muted-foreground">Loading…</p>
      ) : kept.length === 0 ? (
        <p className="text-xs text-muted-foreground">{empty}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {kept.map((record) => (
            <SecretRow
              key={record.name}
              sectionKey={sectionKey}
              record={record}
              onReplace={() => {
                setDraft({ ...draft, name: record.name, value: "" });
              }}
              onDelete={() => {
                forgetDelete(Atom.Reset);
                setDeleting(record.name);
              }}
            />
          ))}
        </ul>
      )}
      {inherited.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Also from every environment:{" "}
          <span className="font-mono">{inherited.map((record) => record.name).join(", ")}</span>
        </p>
      )}
      <DialogProblem problem={loadError} />
      <DialogProblem problem={switchError} />
      <SecretForm sectionKey={sectionKey} />
      <Dialog
        open={deleting !== null}
        onClose={() => {
          setDeleting(null);
        }}
        dismissible={!deleted.waiting}
        title={`Delete ${deleting ?? ""}?`}
      >
        {deleting !== null && <DeleteSecretDialog sectionKey={sectionKey} name={deleting} />}
      </Dialog>
    </div>
  );
};

/** The look of the Edit dialog's monospace text areas. */
const CODE_FIELD =
  "min-w-0 rounded-md border border-input bg-background px-2.5 py-2 font-mono text-sm focus-visible:outline-2 focus-visible:outline-ring";

/** A monospace text area of the Edit dialog, with what it is for under it, or its problem instead. */
const CodeField = ({
  id,
  label,
  value,
  rows,
  placeholder,
  problem,
  hint,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  rows: number;
  placeholder: string;
  problem: string | null;
  hint: string;
  onChange: (value: string) => void;
}) => (
  <div className="flex flex-col gap-1.5">
    <label htmlFor={id} className="text-sm font-medium">
      {label}
    </label>
    <textarea
      id={id}
      rows={rows}
      value={value}
      placeholder={placeholder}
      spellCheck={false}
      autoComplete="off"
      data-1p-ignore
      onChange={(event) => {
        onChange(event.target.value);
      }}
      aria-invalid={problem !== null}
      className={CODE_FIELD}
    />
    {problem === null ? (
      <p className="text-xs text-muted-foreground">{hint}</p>
    ) : (
      <p className="text-xs text-destructive">{problem}</p>
    )}
  </div>
);

/** The Toolchains, variables and scripts of the Edit dialog, as typed, and what each change sets. */
type StartupDraft = {
  readonly toolchains: string;
  readonly variables: string;
  readonly setupScript: string;
  readonly startScript: string;
};

/**
 * The Edit dialog's fields for what every Container start gets: the Environment's Toolchains (a mise.toml), variables,
 * and its Setup and Start Scripts.
 */
const StartupFields = ({
  id,
  draft,
  variablesProblem,
  onChange,
}: {
  id: string;
  draft: StartupDraft;
  variablesProblem: string | null;
  onChange: (change: Partial<StartupDraft>) => void;
}) => (
  <fieldset className="flex min-w-0 flex-col gap-3">
    <legend className="mb-2 text-xs font-medium text-muted-foreground">
      Toolchains, variables and scripts
    </legend>
    <CodeField
      id={`toolchains-${id}`}
      label="Toolchains (mise.toml)"
      rows={5}
      value={draft.toolchains}
      placeholder={'[tools]\nnode = "24.22.1"\npnpm = "12.15.0"\npython = "3.14.9"'}
      problem={toolchainsFieldProblem(draft.toolchains)}
      hint="Written as /workspace/mise.toml where a Workspace has none, or still has the copy written last; a Workspace's own edits to the file stay. Empty: the image's base Toolchains (git, gh, Node, pnpm, Python, uv). A Build installs them."
      onChange={(toolchains) => {
        onChange({ toolchains });
      }}
    />
    <CodeField
      id={`variables-${id}`}
      label="Variables (NAME=value, one per line)"
      rows={3}
      value={draft.variables}
      placeholder={"NODE_ENV=development\nDATABASE_URL=postgres://localhost/app"}
      problem={variablesProblem}
      hint="Every command, Setup Script and Start Script gets them. They are plain: the agent can read them, so keep a secret value in the Secrets section of the Environment's card instead."
      onChange={(variables) => {
        onChange({ variables });
      }}
    />
    <CodeField
      id={`setup-${id}`}
      label="Setup Script (bash)"
      rows={4}
      value={draft.setupScript}
      placeholder="sudo apt-get install -y postgresql-client"
      problem={scriptFieldProblem(draft.setupScript)}
      hint="Runs in /workspace before the repos' .cloudpid/setup.sh, to install what the Workspace needs. It runs again only when it changes, or after it failed."
      onChange={(setupScript) => {
        onChange({ setupScript });
      }}
    />
    <CodeField
      id={`start-${id}`}
      label="Start Script (bash)"
      rows={4}
      value={draft.startScript}
      placeholder={"setsid nohup docker compose up >/tmp/compose.log 2>&1 &"}
      problem={scriptFieldProblem(draft.startScript)}
      hint="Runs in /workspace at every Container start, before the repos' .cloudpid/start.sh, and is stopped after 5 minutes. A service it starts must detach (setsid nohup cmd >/tmp/cmd.log 2>&1 &), or the script does not end."
      onChange={(startScript) => {
        onChange({ startScript });
      }}
    />
    <p className="text-xs text-muted-foreground">
      These apply the next time a Workspace's Container starts. Commands wait for the scripts; one
      that fails is reported to the first command and does not stop the others.
    </p>
  </fieldset>
);

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
        className={CODE_FIELD}
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

/**
 * Edit an Environment: its name, and its Container's size, idle time, extra paths, Toolchains, variables and scripts.
 * Its id never changes.
 */
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
  const { name, instance, idle, ignore, variables, setupScript, startScript, toolchains } = draft;

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
  const idleProblem = saved === undefined ? null : idleMinutesProblem(idle ?? "");
  const pathsProblem = ignore === undefined ? null : ignoreProblem(ignore);
  const renamed = name.trim() !== environment.name;
  const patterns = ignore === undefined ? [] : ignorePatternsFrom(ignore);
  const parsedVariables = parseVariables(variables ?? "");
  const variablesProblem = Result.isFailure(parsedVariables) ? parsedVariables.failure : null;
  const typedVariables = Result.getOrElse(parsedVariables, () => ({}));

  const scriptsProblem =
    scriptFieldProblem(setupScript ?? "") ??
    scriptFieldProblem(startScript ?? "") ??
    toolchainsFieldProblem(toolchains ?? "");

  const settingsChanged =
    saved !== undefined &&
    instance !== undefined &&
    (instance !== saved.instance ||
      idle !== String(saved.idleMinutes) ||
      patterns.join("\n") !== saved.ignore.join("\n") ||
      variablesText(typedVariables) !== variablesText(saved.variables) ||
      (setupScript ?? saved.setupScript) !== saved.setupScript ||
      (startScript ?? saved.startScript) !== saved.startScript ||
      (toolchains ?? saved.toolchains) !== saved.toolchains);

  const invalid =
    nameProblem !== null ||
    idleProblem !== null ||
    pathsProblem !== null ||
    variablesProblem !== null ||
    scriptsProblem !== null;

  const submit = (event: FormEvent) => {
    event.preventDefault();

    if (invalid || saving) return;

    save({
      name: renamed ? name.trim() : undefined,
      settings:
        settingsChanged && instance !== undefined
          ? {
              instance,
              idleMinutes: Number(idle),
              ignore: patterns,
              variables: typedVariables,
              setupScript: setupScript ?? saved.setupScript,
              startScript: startScript ?? saved.startScript,
              toolchains: toolchains ?? saved.toolchains,
            }
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
        <>
          <ContainerFields
            id={id}
            instance={instance}
            idle={idle ?? ""}
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
          <StartupFields
            id={id}
            draft={{
              toolchains: toolchains ?? "",
              variables: variables ?? "",
              setupScript: setupScript ?? "",
              startScript: startScript ?? "",
            }}
            variablesProblem={variablesProblem}
            onChange={(change) => {
              setDraft((current) => ({ ...current, ...change }));
            }}
          />
        </>
      ) : loadError === null ? (
        <p className="text-sm text-muted-foreground">Loading the Container's settings…</p>
      ) : (
        <div className="flex items-center gap-3">
          <DialogProblem problem={loadError} />
          <Button type="button" variant="outline" size="sm" onClick={retry}>
            Try again
          </Button>
        </div>
      )}
      <DialogProblem problem={problem} />
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

/** Environment `id`'s Build: where it stands, and a button to make it again now. */
const BuildStatus = ({ id }: { id: string }) => {
  const build = useAtomValue(environmentBuildAtom(id));
  const [rebuilt, rebuild] = useAtom(rebuildEnvironmentAtom(id));
  const error = settledFailureOf(rebuilt);

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-medium text-muted-foreground">Build</h3>
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 text-xs break-words whitespace-pre-wrap text-muted-foreground">
          {/* A Build's times are read against the wall clock as the card renders. */}
          {/* @effect-diagnostics-next-line globalDate:off */}
          {build === null ? "Loading…" : buildLine(build, Date.now())}
        </p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={rebuilt.waiting || build?.status === "building"}
          onClick={() => {
            rebuild();
          }}
        >
          <RotateCw aria-hidden />
          Rebuild
        </Button>
      </div>
      <DialogProblem problem={error} />
    </div>
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
}: {
  environment: EnvironmentRecord;
  /** The names of the other Environments, which this one cannot take. */
  otherNames: readonly string[];
  /** Every Session made in the Environment, archived ones included. */
  sessions: readonly SessionRecord[];
}) => {
  const { id } = environment;
  // Starting a Session holds the card's buttons until it is registered and opened; a refusal shows until the next one.
  const [started, start] = useAtom(startSessionAtom(id));
  const starting = started.waiting;
  const workspaceList = useAtomValue(workspaceListAtom);
  const workspaces = (workspaceList ?? []).filter((workspace) => workspace.environment === id);
  const removeRepo = useAtomSet(removeRepoAtom(id));
  const removedRepo = useAtomValue(removeRepoAtom(id));
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

  // A removal's failure shows until the next one starts; an add's shows in its form.
  const reposError = settledFailureOf(removedRepo);

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
      <DialogProblem problem={reposError} />
      <SecretsSection sectionKey={id} title="Secrets" empty="None kept for this environment." />
      <BuildStatus id={id} />
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
  const error = failureOf(createdEnvironment) ?? listError;

  return (
    // `relative` makes the scroller the containing block of the `sr-only` labels in the forms: without it they are
    // placed against the document at their spot in the long list, which makes the document itself scrollable under
    // the app, and a scroll that runs past a modal's end then moves the whole app up, leaving a blank strip below.
    <div className="relative min-h-0 flex-1 overflow-y-auto">
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
        <section
          aria-label="Secrets for every environment"
          className="flex flex-col gap-2 rounded-lg border p-4"
        >
          <p className="text-xs text-muted-foreground">
            A secret kept here or on an environment is used by reference in that environment's
            sessions, as one the agent asked for is, but never expires. Its value is not shown
            again, and is taken out of command output and of what the model is sent. An
            environment's own secret of the same name wins.
          </p>
          <SecretsSection
            sectionKey={EVERY_ENVIRONMENT}
            title="Secrets for every environment"
            empty="None kept for every environment."
          />
        </section>
        <DialogProblem problem={error ?? sessionsError} />
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
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
