// @effect-diagnostics preferEffectArray:off -- JSX lists of cards, Repos, Workspaces and Sessions are native arrays.

import { INSTANCE_TYPES, instanceLimitProblem, type InstanceType } from "@cloudpid/config";
import {
  type AgentChange,
  DEFAULT_ENVIRONMENT,
  MAX_ENVIRONMENT_NAME_LENGTH,
  MAX_REPO_NAME_LENGTH,
  MAX_SECRET_NAME_LENGTH,
  parseRepoSource,
  type SkillInstall,
  skillSourceText,
  skillSourceUrl,
  type EnvironmentRecord,
  type EnvironmentSecretRecord,
  fieldSkill,
  type SessionRecord,
  type WorkspaceRecord,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import {
  ArrowLeft,
  Bot,
  Check,
  Download,
  GitBranch,
  GitFork,
  KeyRound,
  Pencil,
  Play,
  RotateCw,
  Search,
  Trash2,
  Undo2,
} from "lucide-react";
import {
  useAtom,
  useAtomMount,
  useAtomRefresh,
  useAtomSet,
  useAtomValue,
} from "@effect/atom-react";
import { type FormEvent, useState } from "react";
import { ChangeDiff } from "./change-diff.tsx";
import { Button } from "./components/ui/button.tsx";
import { Dialog, DialogActions, DialogProblem } from "./components/ui/dialog.tsx";
import { Input } from "./components/ui/input.tsx";
import { Menu, MenuItem } from "./components/ui/menu.tsx";
import { NativeSelect } from "./components/ui/native-select.tsx";
import { cn } from "./lib/utils.ts";
import { relativeTime } from "./format.ts";
import { changeDiff, skillFileDiffs } from "./line-diff.ts";
import { navigate, sessionPath } from "./router.ts";
import { SubagentWorkspaceLoss } from "./session-menu.tsx";
import { SessionLink, sessionTitle } from "./sidebar.tsx";
import { failureOf, settledFailureOf } from "./registry.ts";
import { sessionListAtom, sessionsErrorAtom } from "./sessions.ts";
import {
  addRepoAtom,
  addRepoNameAtom,
  agentChangesAtom,
  dismissAgentChangeAtom,
  revertAgentChangeAtom,
  addRepoSourceAtom,
  createEnvironmentAtom,
  deleteEnvironmentAtom,
  deleteSecretAtom,
  deleteTypedAtom,
  environmentBuildAtom,
  environmentSecretsAtom,
  environmentSecretsErrorAtom,
  environmentSkillsAtom,
  installSkillsAtom,
  removeSkillAtom,
  searchSkillsAtom,
  skillSearchQueryAtom,
  skillSourceAtom,
  skillChangeFilesAtom,
  skillChangeKey,
  skillDialogAtom,
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
  everyEnvironmentSettingsAtom,
  everyEnvironmentSettingsErrorAtom,
  everyVariablesAtom,
  everyVariablesDraftAtom,
  saveEveryVariablesAtom,
  newEnvironmentNameAtom,
  rebuildEnvironmentAtom,
  removeRepoAtom,
  removeWorkspaceAtom,
  removeWorkspaceTypedAtom,
  restartContainerAtom,
  saveEnvironmentAtom,
  startSessionAtom,
  describeWorkspaceWork,
  subagentWorkspacesBelow,
  workspaceListAtom,
  workspaceWorkAtom,
  type EnvironmentDialog,
} from "./environments-state.ts";
import {
  buildLine,
  changeByline,
  changeFieldText,
  changeValueText,
  revertible,
  deleteConfirmed,
  EVERY_ENVIRONMENT,
  inheritedSecrets,
  inheritedSkills,
  type InheritedVariables,
  inheritedVariables,
  secretDraftProblems,
  secretDraftReady,
  secretVariable,
  environmentNameProblem,
  idleMinutesProblem,
  installOutcomeLines,
  ignorePatternsFrom,
  ignoreProblem,
  instanceLabel,
  sizeLimitLabel,
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
 * The names of Environment `id`'s own variables, then those it gets from every Environment, as `SecretsSection` names
 * the Secrets it gets: the values are in the Edit dialog.
 */
const VariablesSummary = ({ id }: { id: string }) => {
  const loaded = useAtomValue(environmentSettingsAtom(id));
  const every = useAtomValue(everyVariablesAtom);

  const own = loaded.pipe(
    AsyncResult.value,
    Option.map((state) => state.settings.variables),
  );

  const loadError = settledFailureOf(loaded);

  if (Option.isNone(own)) {
    return loadError === null ? null : <DialogProblem problem={loadError} />;
  }

  const { inherited } = inheritedVariables(own.value, every);
  const names = Record.keys(own.value).toSorted();

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-medium text-muted-foreground">Variables</h3>
      {names.length === 0 ? (
        <p className="text-xs text-muted-foreground">None set for this environment.</p>
      ) : (
        <p className="font-mono text-xs">{names.join(", ")}</p>
      )}
      {inherited.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Also from every environment: <span className="font-mono">{inherited.join(", ")}</span>
        </p>
      )}
    </div>
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

/**
 * The variables kept for every Environment, a `NAME=value` line each, with the form that saves them. They are plain, as
 * an Environment's own are: an Environment's own variable of the same name wins.
 */
const EveryVariablesSection = () => {
  const loaded = useAtomValue(everyEnvironmentSettingsAtom);
  const loadError = useAtomValue(everyEnvironmentSettingsErrorAtom);
  const saved = useAtomValue(everyVariablesAtom);
  const [draft, setDraft] = useAtom(everyVariablesDraftAtom);
  const [kept, save] = useAtom(saveEveryVariablesAtom);
  // Until the variables in force are known, `saved` is empty and a save would wipe them.
  const ready = loaded.pipe(AsyncResult.value, Option.isSome);
  const text = draft ?? variablesText(saved);
  const parsed = parseVariables(text);
  const problem = Result.isFailure(parsed) ? parsed.failure : null;
  const typed = Result.getOrElse(parsed, () => ({}));
  const changed = variablesText(typed) !== variablesText(saved);
  const saving = kept.waiting;

  const submit = (event: FormEvent) => {
    event.preventDefault();

    if (!ready || problem !== null || saving || !changed) return;

    save(typed);
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <CodeField
        id="variables-every-environment"
        label="Variables for every environment (NAME=value, one per line)"
        rows={3}
        value={text}
        placeholder={"NODE_ENV=development\nCI=1"}
        problem={problem}
        hint="Every command, Setup Script and Start Script of every environment gets them, at its next container start. They are plain: the agent can read them, so keep a secret value as a secret instead. An environment's own variable of the same name wins."
        onChange={setDraft}
      />
      <div className="flex items-center justify-end gap-2">
        {!ready && loadError === null && <p className="text-xs text-muted-foreground">Loading…</p>}
        <Button
          type="submit"
          variant="outline"
          disabled={saving || !ready || problem !== null || !changed}
        >
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
      <DialogProblem problem={loadError} />
      <DialogProblem problem={settledFailureOf(kept)} />
    </form>
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
  inherited,
  onChange,
}: {
  id: string;
  draft: StartupDraft;
  variablesProblem: string | null;
  /** The variables kept for every Environment that this one gets, and those of its own that override one. */
  inherited: InheritedVariables;
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
    {inherited.inherited.length > 0 && (
      <p className="text-xs text-muted-foreground">
        Also from every environment:{" "}
        <span className="font-mono">{inherited.inherited.join(", ")}</span>
      </p>
    )}
    {inherited.overridden.length > 0 && (
      <p className="text-xs text-muted-foreground">
        Overriding the one for every environment:{" "}
        <span className="font-mono">{inherited.overridden.join(", ")}</span>
      </p>
    )}
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

/** A list of the sizes, by `label`, as `INSTANCE_TYPES` orders them. */
const SizeSelect = ({
  id,
  value,
  label,
  onPick,
  invalid = false,
}: {
  id: string;
  value: InstanceType;
  label: (type: InstanceType) => string;
  onPick: (type: InstanceType) => void;
  invalid?: boolean;
}) => (
  <NativeSelect
    id={id}
    value={value}
    aria-invalid={invalid}
    onChange={(event) => {
      const picked = INSTANCE_TYPES.find((type) => type === event.target.value);

      if (picked !== undefined) onPick(picked);
    }}
  >
    {INSTANCE_TYPES.map((type) => (
      <option key={type} value={type}>
        {label(type)}
      </option>
    ))}
  </NativeSelect>
);

/** The Container fields of the Edit dialog: size, size limit, idle time and extra paths, saved together with the name. */
const ContainerFields = ({
  id,
  instance,
  maxInstance,
  limitProblem,
  idle,
  idleProblem,
  paths,
  pathsProblem,
  onInstance,
  onMaxInstance,
  onIdle,
  onPaths,
}: {
  id: string;
  instance: InstanceType;
  maxInstance: InstanceType;
  limitProblem: string | null;
  idle: string;
  idleProblem: string | null;
  paths: string;
  pathsProblem: string | null;
  onInstance: (instance: InstanceType) => void;
  onMaxInstance: (maxInstance: InstanceType) => void;
  onIdle: (idle: string) => void;
  onPaths: (paths: string) => void;
}) => (
  <fieldset className="flex min-w-0 flex-col gap-3">
    <legend className="mb-2 text-xs font-medium text-muted-foreground">Container</legend>
    <div className="flex flex-col gap-1.5">
      <label htmlFor={`instance-${id}`} className="text-sm font-medium">
        Size
      </label>
      <SizeSelect
        id={`instance-${id}`}
        value={instance}
        label={instanceLabel}
        onPick={onInstance}
      />
    </div>
    <div className="flex flex-col gap-1.5">
      <label htmlFor={`max-instance-${id}`} className="text-sm font-medium">
        Size limit
      </label>
      <SizeSelect
        id={`max-instance-${id}`}
        value={maxInstance}
        label={sizeLimitLabel}
        onPick={onMaxInstance}
        invalid={limitProblem !== null}
      />
      {limitProblem === null ? (
        <p className="text-xs text-muted-foreground">
          The largest the size may be, and the largest the agent may restart a Workspace's Container
          at (container_resize) until it is stopped for being idle. Sizes are ordered by memory,
          then vCPU. The agent cannot raise it without you.
        </p>
      ) : (
        <p className="text-xs text-destructive">{limitProblem}</p>
      )}
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

  const {
    name,
    instance,
    maxInstance,
    idle,
    ignore,
    variables,
    setupScript,
    startScript,
    toolchains,
  } = draft;

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

  const limitProblem =
    instance === undefined || maxInstance === undefined
      ? null
      : (instanceLimitProblem({ instance, maxInstance }) ?? null);

  const renamed = name.trim() !== environment.name;
  const patterns = ignore === undefined ? [] : ignorePatternsFrom(ignore);
  const everyVariables = useAtomValue(everyVariablesAtom);
  const parsedVariables = parseVariables(variables ?? "", everyVariables);
  const variablesProblem = Result.isFailure(parsedVariables) ? parsedVariables.failure : null;
  const typedVariables = Result.getOrElse(parsedVariables, () => ({}));

  const scriptsProblem =
    scriptFieldProblem(setupScript ?? "") ??
    scriptFieldProblem(startScript ?? "") ??
    toolchainsFieldProblem(toolchains ?? "");

  const settingsChanged =
    saved !== undefined &&
    instance !== undefined &&
    maxInstance !== undefined &&
    (instance !== saved.instance ||
      maxInstance !== saved.maxInstance ||
      idle !== String(saved.idleMinutes) ||
      patterns.join("\n") !== saved.ignore.join("\n") ||
      variablesText(typedVariables) !== variablesText(saved.variables) ||
      (setupScript ?? saved.setupScript) !== saved.setupScript ||
      (startScript ?? saved.startScript) !== saved.startScript ||
      (toolchains ?? saved.toolchains) !== saved.toolchains);

  const invalid =
    nameProblem !== null ||
    idleProblem !== null ||
    limitProblem !== null ||
    pathsProblem !== null ||
    variablesProblem !== null ||
    scriptsProblem !== null;

  const submit = (event: FormEvent) => {
    event.preventDefault();

    if (invalid || saving) return;

    save({
      name: renamed ? name.trim() : undefined,
      settings:
        settingsChanged && instance !== undefined && maxInstance !== undefined
          ? {
              instance,
              maxInstance,
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
      {saved !== undefined && instance !== undefined && maxInstance !== undefined ? (
        <>
          <ContainerFields
            id={id}
            instance={instance}
            maxInstance={maxInstance}
            limitProblem={limitProblem}
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
            onMaxInstance={(picked) => {
              setDraft((current) => ({ ...current, maxInstance: picked }));
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
            inherited={inheritedVariables(typedVariables, everyVariables)}
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

/**
 * Confirm removing Skill `name` from Environment `id` (or `EVERY_ENVIRONMENT`: the Skills kept for every Environment),
 * after saying what follows. It is the owner's own change, so it waits for no Approval.
 */
const RemoveSkillDialog = ({ id, name }: { id: string; name: string }) => {
  const [removed, remove] = useAtom(removeSkillAtom(id));
  const setDialog = useAtomSet(skillDialogAtom(id));
  const busy = removed.waiting;

  const submit = (event: FormEvent) => {
    event.preventDefault();

    if (busy) return;

    remove(name);
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      {id === EVERY_ENVIRONMENT ? (
        <p className="text-sm">
          Every environment's workspaces stop serving it at their next readying, except those of an
          environment that keeps its own skill of the same name. Where none does, the bundle's skill
          of the same name is served again. Sessions already running keep it in their skills list
          until their next context window.
        </p>
      ) : (
        <p className="text-sm">
          Its workspaces stop serving it at their next readying, and the skill of the same name kept
          for every environment is served again, else the bundle's. Sessions already running keep it
          in their skills list until their next context window.
        </p>
      )}
      <p className="text-sm">
        This cannot be undone: your removal is not an agent change, so it has no revert, and a later
        revert of the agent's save of this skill is refused. To get it back, ask the agent to save
        it again.
      </p>
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
        <Button type="submit" variant="destructive" disabled={busy}>
          {busy ? "Removing…" : "Remove skill"}
        </Button>
      </DialogActions>
    </form>
  );
};

/** What an install came to, below the form: the Skills it kept, each pinned to the commit; or the Skills to tick. */
const InstallAnswer = ({
  id,
  answer,
  source,
  installing,
}: {
  id: string;
  answer: SkillInstall;
  source: string;
  installing: boolean;
}) => {
  const [ticked, setTicked] = useState<ReadonlyArray<string>>([]);
  // The same setter installs the ticked Skills and, reset, closes the list.
  const install = useAtomSet(installSkillsAtom(id));

  if (answer.status === "installed") {
    return (
      <div className="flex flex-col gap-1 text-xs" role="status">
        <p className="text-muted-foreground">
          From{" "}
          {skillSourceText({ repo: answer.repo, path: "", ref: answer.ref, commit: answer.commit })}
          :
        </p>
        <ul className="flex flex-col gap-0.5">
          {installOutcomeLines(answer.skills).map((line) => (
            <li key={line} className="font-mono break-words">
              {line}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  const { available } = answer;

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">
        {answer.repo} holds {available.length} skills. Tick the ones to install.
      </p>
      <ul className="flex max-h-80 flex-col gap-1 overflow-y-auto" aria-label="Skills in the repo">
        {available.map((skill) => (
          <li key={skill.name}>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={ticked.includes(skill.name)}
                disabled={installing}
                onChange={(event) => {
                  setTicked((now) =>
                    event.target.checked
                      ? [...now, skill.name]
                      : now.filter((name) => name !== skill.name),
                  );
                }}
              />
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-mono">{skill.name}</span>
                <span className="line-clamp-2 text-xs break-words text-muted-foreground">
                  {skill.description}
                </span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={installing || ticked.length === 0}
          onClick={() => {
            install({ source, skills: ticked });
          }}
        >
          <Download />
          {installing ? "Installing…" : `Install ${ticked.length} selected`}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={installing}
          onClick={() => {
            install(Atom.Reset);
          }}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
};

/** The skills.sh results for a search, each with the Skill's installs and an Add that installs that Skill. */
const SkillSearchResults = ({ id, installing }: { id: string; installing: boolean }) => {
  const searched = useAtomValue(searchSkillsAtom(id));
  const install = useAtomSet(installSkillsAtom(id));
  const found = searched.pipe(AsyncResult.value, Option.getOrNull);
  const problem = settledFailureOf(searched);

  if (problem !== null) return <DialogProblem problem={problem} />;

  if (found === null) return searched.waiting ? <p className="text-xs">Searching…</p> : null;

  if (found.length === 0) return <p className="text-xs text-muted-foreground">Nothing found.</p>;

  return (
    <ul className="flex flex-col gap-1" aria-label="skills.sh results">
      {found.map((result) => (
        <li key={result.id} className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-mono text-sm">{result.name}</span>
            <span className="truncate font-mono text-xs text-muted-foreground">
              {result.source} · {result.installs.toLocaleString("en-US")} installs
            </span>
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={installing}
            aria-label={`Add ${result.name} from ${result.source}`}
            onClick={() => {
              install({ source: result.source, skills: [result.skillId] });
            }}
          >
            Add
          </Button>
        </li>
      ))}
    </ul>
  );
};

/**
 * The form that adds Skills to Environment `id` from GitHub, on the owner's word: a source (`owner/repo`,
 * `owner/repo@skill` or a GitHub URL), or a search of skills.sh. A source that holds several Skills lists them to tick.
 * The Registry fetches it as the GitHub App, pinned to a commit.
 */
const AddSkillsForm = ({ id }: { id: string }) => {
  const [source, setSource] = useAtom(skillSourceAtom(id));
  const [query, setQuery] = useAtom(skillSearchQueryAtom(id));
  const [answered, install] = useAtom(installSkillsAtom(id));
  const [searched, search] = useAtom(searchSkillsAtom(id));
  const answer = answered.pipe(AsyncResult.value, Option.getOrNull);
  const installing = answered.waiting;
  const picking = answer !== null && answer.status === "listed";
  const inputId = `add-skills-${id}`;
  const searchId = `search-skills-${id}`;

  const submit = (event: FormEvent) => {
    event.preventDefault();

    if (source.trim() === "" || installing || picking) return;

    install({ source });
  };

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();

    if (query.trim().length < 2 || searched.waiting) return;

    search(query);
  };

  return (
    <div className="flex flex-col gap-2">
      <form onSubmit={submit} className="flex flex-col gap-1.5">
        <label htmlFor={inputId} className="text-xs font-medium text-muted-foreground">
          Add skills from GitHub
        </label>
        <div className="flex flex-wrap gap-2">
          <Input
            id={inputId}
            value={source}
            onChange={(event) => {
              setSource(event.target.value);
            }}
            placeholder="owner/repo, owner/repo@skill or a GitHub URL"
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            data-1p-ignore
            disabled={installing || picking}
            className="min-w-48 flex-1 font-mono"
          />
          <Button
            type="submit"
            variant="outline"
            disabled={installing || picking || source.trim() === ""}
          >
            <Download />
            {installing && !picking ? "Adding…" : "Add"}
          </Button>
        </div>
      </form>
      <DialogProblem problem={settledFailureOf(answered)} />
      {answer !== null && (
        <InstallAnswer id={id} answer={answer} source={source} installing={installing} />
      )}
      <form onSubmit={submitSearch} className="flex flex-col gap-1.5">
        <label htmlFor={searchId} className="sr-only">
          Search skills.sh
        </label>
        <div className="flex flex-wrap gap-2">
          <Input
            id={searchId}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
            placeholder="Search skills.sh"
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            data-1p-ignore
            className="min-w-48 flex-1"
          />
          <Button
            type="submit"
            variant="outline"
            disabled={searched.waiting || query.trim().length < 2}
          >
            <Search />
            {searched.waiting ? "Searching…" : "Search"}
          </Button>
        </div>
      </form>
      <SkillSearchResults id={id} installing={installing} />
    </div>
  );
};

/**
 * The Skills Environment `id` keeps (ADR-0026), or `EVERY_ENVIRONMENT` those kept for every Environment: each one's
 * name, description and when it was saved, with its Skill source when it was installed from GitHub, and a removal
 * behind a confirmation. The agent saves them (those for every Environment only with your Approval) and installs them
 * for an Environment, and so does the owner's form; every Workspace of the Environment serves them read-only. An
 * Environment's section names the Skills it gets from every Environment, and which of its own win.
 */
const SkillsSection = ({ id }: { id: string }) => {
  const loaded = useAtomValue(environmentSkillsAtom(id));
  const everywhere = id === EVERY_ENVIRONMENT;
  const every = useAtomValue(environmentSkillsAtom(EVERY_ENVIRONMENT));
  const [removing, setRemoving] = useAtom(skillDialogAtom(id));
  const removed = useAtomValue(removeSkillAtom(id));
  const forgetRemove = useAtomSet(removeSkillAtom(id));
  const skills = loaded.pipe(AsyncResult.value, Option.getOrNull);
  const loadError = failureOf(loaded);

  const { inherited, overridden } =
    everywhere || skills === null
      ? { inherited: [], overridden: [] }
      : inheritedSkills(
          skills,
          every.pipe(
            AsyncResult.value,
            Option.getOrElse(() => []),
          ),
        );

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-medium text-muted-foreground">
        {everywhere ? "Skills for every environment" : "Skills"}
      </h3>
      {skills === null ? (
        <p className="text-xs text-muted-foreground">{loadError ?? "Loading…"}</p>
      ) : skills.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {everywhere
            ? "None kept for every environment. The agent saves one with environment_skill_save and the id *, and you approve it in its session."
            : "None of its own: its workspaces serve those kept for every environment and the bundle's. Add some from GitHub below, or the agent saves one with environment_skill_save or installs one with environment_skill_install."}
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {skills.map((skill) => (
            <li key={skill.name} className="flex items-start justify-between gap-2">
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-mono text-sm">{skill.name}</span>
                <span className="line-clamp-2 text-xs break-words text-muted-foreground">
                  {skill.description}
                </span>
                <span className="text-xs text-muted-foreground">
                  {/* A Skill's time is read against the wall clock as the card renders. */}
                  {/* @effect-diagnostics-next-line globalDate:off */}
                  Saved {relativeTime(skill.savedAt, Date.now())}
                </span>
                {skill.source !== undefined && (
                  <a
                    href={skillSourceUrl(skill.source)}
                    target="_blank"
                    rel="noreferrer"
                    className="truncate font-mono text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                    title="Open this skill on GitHub at the commit it was installed at"
                  >
                    {skillSourceText(skill.source)}
                  </a>
                )}
              </span>
              <Button
                size="icon"
                variant="ghost"
                className="size-8 shrink-0"
                aria-label={`Remove ${skill.name}`}
                title={`Remove ${skill.name}`}
                onClick={() => {
                  forgetRemove(Atom.Reset);
                  setRemoving(skill.name);
                }}
              >
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {inherited.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Also from every environment: <span className="font-mono">{inherited.join(", ")}</span>
        </p>
      )}
      {overridden.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Overriding the one for every environment:{" "}
          <span className="font-mono">{overridden.join(", ")}</span>
        </p>
      )}
      {!everywhere && <AddSkillsForm id={id} />}
      <Dialog
        open={removing !== null}
        onClose={() => {
          setRemoving(null);
        }}
        dismissible={!removed.waiting}
        title={`Remove the ${removing ?? ""} skill?`}
      >
        {removing !== null && <RemoveSkillDialog id={id} name={removing} />}
      </Dialog>
    </div>
  );
};

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
 * Environment `id`'s Agent changes, newest first (`docs/spec.md` → Agent changes), each with the Session that made it,
 * a revert and a dismissal. A revert the Registry refuses (its field has changed since) says why.
 */
const AgentChangesSection = ({
  id,
  sessions,
}: {
  id: string;
  /** Every Session made in the Environment, archived ones included. */
  sessions: readonly SessionRecord[];
}) => {
  const loaded = useAtomValue(agentChangesAtom(id));
  const [reverted, revert] = useAtom(revertAgentChangeAtom(id));
  const [dismissed, dismiss] = useAtom(dismissAgentChangeAtom(id));
  const changes = loaded.pipe(AsyncResult.value, Option.getOrNull);
  const loadError = failureOf(loaded);

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-medium text-muted-foreground">Agent changes</h3>
      {changes === null ? (
        <p className="text-xs text-muted-foreground">{loadError ?? "Loading…"}</p>
      ) : changes.length === 0 ? (
        <p className="text-xs text-muted-foreground">The agent has changed nothing here.</p>
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

/**
 * What Workspace `id` holds that is not on the remote, read when the confirmation opens: what removing it loses.
 */
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
          it: their work stops and their IDs are retired.
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
      <a
        href={sessionPath(session.id)}
        className="truncate underline-offset-2 hover:underline"
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;

          event.preventDefault();
          navigate(sessionPath(session.id));
        }}
      >
        of {sessionTitle(session)}
      </a>
    )}
  </span>
);

/** A Workspace in an Environment's card: its branch and how much is in it, with the actions on it. */
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
    <li className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
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
      <VariablesSummary id={id} />
      <SecretsSection sectionKey={id} title="Secrets" empty="None kept for this environment." />
      <SkillsSection id={id} />
      <BuildStatus id={id} />
      <AgentChangesSection id={id} sessions={sessions} />
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
                owner={sessions.find((session) => session.id === workspace.subagent?.session)}
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
    <div className="relative min-h-0 flex-1 overflow-y-auto overscroll-y-contain">
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
          aria-label="For every environment"
          className="flex flex-col gap-2 rounded-lg border p-4"
        >
          <EveryVariablesSection />
          <p className="text-xs text-muted-foreground">
            A secret kept here or on an environment is used by reference in that environment's
            sessions, as one the agent asked for is, but never expires. Its value is not shown
            again, and is taken out of command output and of what the model is sent. An
            environment's own secret of the same name wins. A value that is not secret (an email, a
            URL) belongs in the variables above: a kept secret found on a container's disk stops its
            snapshot.
          </p>
          <SecretsSection
            sectionKey={EVERY_ENVIRONMENT}
            title="Secrets for every environment"
            empty="None kept for every environment."
          />
          <p className="text-xs text-muted-foreground">
            A skill kept here is served read-only in every environment's workspaces at their next
            readying. It steers every future session, so the agent's save or removal of one waits
            for your Approval in its session. An environment's own skill of the same name wins in
            that environment. Removing one here is your own change: it waits for nothing.
          </p>
          <SkillsSection id={EVERY_ENVIRONMENT} />
          <AgentChangesSection id={EVERY_ENVIRONMENT} sessions={sessions ?? []} />
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
