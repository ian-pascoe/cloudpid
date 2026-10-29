// @effect-diagnostics preferEffectArray:off -- JSX lists of sections, Skills and files are native arrays.

// The Installed tab of the Skills section of the Settings page (ADR-0026, docs/architecture/workspace.md → Installing from
// GitHub; docs/architecture/client-and-protocol.md → Settings page): the Skills the Scope the page shows keeps, Global's or
// an Environment's own, each with its marks, Update, Remove, the form that adds Skills from GitHub or a skills.sh search,
// a viewer of the files of a Skill with no Skill source, and a link to the Agent changes section, where the Skills' Agent
// changes are with their file diffs and Revert. Everything here is the owner's own change, so it waits for no Approval.

import {
  type EnvironmentSkill,
  type SkillFile,
  type SkillInstall,
  type SkillSource,
  skillSourceText,
} from "@cloudpid/protocol";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import { Download, RefreshCw, Search, Trash2 } from "lucide-react";
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import { type FormEvent, useState } from "react";
import { Button } from "./components/ui/button.tsx";
import { Dialog, DialogActions, DialogProblem } from "./components/ui/dialog.tsx";
import { Input } from "./components/ui/input.tsx";
import { InAppLink } from "./in-app-link.tsx";
import { relativeTime } from "./format.ts";
import { failureOf, settledFailureOf } from "./registry.ts";
import { settingsPath } from "./router.ts";
import { MarkedNames } from "./settings/parts.tsx";
import { useScopeName, useSettingsScope } from "./settings/scope.tsx";
import { GLOBAL } from "./environments.ts";
import {
  environmentSkillsAtom,
  installSkillsAtom,
  keptSkillFilesAtom,
  removeSkillAtom,
  searchSkillsAtom,
  skillDialogAtom,
  skillFilesDialogAtom,
  skillKey,
  skillSearchQueryAtom,
  skillSourceAtom,
  skillUpdateDialogAtom,
  updateSkillAtom,
} from "./skills-state.ts";
import {
  inheritedSkills,
  installOutcomeLines,
  skillPageOfSource,
  updateOutcomeLines,
} from "./skills.ts";

/** `files` with `SKILL.md` first, then the others as they came (by path). */
const skillMdFirst = (files: ReadonlyArray<SkillFile>): ReadonlyArray<SkillFile> => [
  ...files.filter((file) => file.path === "SKILL.md"),
  ...files.filter((file) => file.path !== "SKILL.md"),
];

/**
 * Confirm removing Skill `name` from Environment `id` (or `GLOBAL`: the Skills kept Global),
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
      {id === GLOBAL ? (
        <p className="text-sm">
          Each Environment's workspaces stop serving it at their next readying, except those of an
          environment that keeps its own skill of the same name. Sessions already running keep it in
          their skills list until their next context window.
        </p>
      ) : (
        <p className="text-sm">
          Its workspaces stop serving it at their next readying, and the skill of the same name kept
          at Global, if any, is served again. Sessions already running keep it in their skills list
          until their next context window.
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

/**
 * Confirm updating Skill `skill.name` of Environment `id` (or `GLOBAL`) to the latest commit of the ref it was
 * installed from, after saying what follows. It is the owner's own change, so it waits for no Approval, and it is no
 * agent change, so it has no revert; a Skill the agent edited since it was installed has the edits replaced.
 */
const UpdateSkillDialog = ({ id, skill }: { id: string; skill: EnvironmentSkill }) => {
  const [updated, update] = useAtom(updateSkillAtom(id));
  const setDialog = useAtomSet(skillUpdateDialogAtom(id));
  const busy = updated.waiting;
  const answer = updated.pipe(AsyncResult.value, Option.getOrNull);
  const modified = skill.modified === true;

  const submit = (event: FormEvent) => {
    event.preventDefault();

    if (busy || answer !== null) return;

    // The confirm is the owner's word to replace the edits.
    update({ name: skill.name, overwrite: modified });
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <p className="text-sm">
        {id === GLOBAL
          ? "Each Environment's workspaces serve the new files at their next readying, except those of an environment that keeps its own skill of the same name."
          : "Its workspaces serve the new files at their next readying."}{" "}
        Sessions already running keep the old description in their skills list until their next
        context window.
      </p>
      {modified && (
        <p className="text-sm">
          The agent edited this skill after it was installed. Updating replaces those edits with the
          files at the ref's latest commit.
        </p>
      )}
      <p className="text-sm">
        This cannot be undone: your update is not an agent change, so it has no revert, and a later
        revert of an earlier agent change to this skill is refused. To go back, ask the agent to
        install the earlier commit.
      </p>
      {answer !== null && (
        <ul className="flex flex-col gap-1 text-sm" aria-label="Update result">
          {updateOutcomeLines(answer.skills).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
      <DialogProblem problem={settledFailureOf(updated)} />
      <DialogActions>
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => {
            setDialog(null);
          }}
        >
          {answer === null ? "Cancel" : "Close"}
        </Button>
        {answer === null && (
          <Button type="submit" variant={modified ? "destructive" : "default"} disabled={busy}>
            {busy ? "Updating…" : modified ? "Replace edits and update" : "Update skill"}
          </Button>
        )}
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
 * The form that adds Skills to Environment `id` (or, with `GLOBAL`, to Global) from GitHub, on the
 * owner's word: a source (`owner/repo`, `owner/repo@skill` or a GitHub URL), or a search of skills.sh. A source that holds
 * several Skills lists them to tick.
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
          Add skills from GitHub{id === GLOBAL ? " at Global" : ""}
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
 * The files the Registry keeps for Skill `name` of Environment `id` (or `GLOBAL`), read-only, `SKILL.md` and
 * then the others by path: what a Skill with no Skill source has to show, as no repo holds it.
 */
const SkillFilesViewer = ({ id, name }: { id: string; name: string }) => {
  const loaded = useAtomValue(keptSkillFilesAtom(skillKey(id, name)));
  const setViewing = useAtomSet(skillFilesDialogAtom(id));
  const files = loaded.pipe(AsyncResult.value, Option.map(skillMdFirst), Option.getOrNull);
  const loadError = failureOf(loaded);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {files === null ? (
        <p className="text-sm text-muted-foreground">{loadError ?? "Loading the files…"}</p>
      ) : (
        <ul
          className="flex max-h-[60dvh] min-w-0 flex-col gap-3 overflow-y-auto"
          aria-label="Files"
        >
          {files.map((file) => (
            <li key={file.path} className="flex min-w-0 flex-col gap-1">
              <span className="font-mono text-xs break-all text-muted-foreground">{file.path}</span>
              <pre className="max-h-96 overflow-auto rounded bg-muted px-2 py-1 font-mono text-xs break-words whitespace-pre-wrap">
                {file.text}
              </pre>
            </li>
          ))}
        </ul>
      )}
      <DialogActions>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setViewing(null);
          }}
        >
          Close
        </Button>
      </DialogActions>
    </div>
  );
};

/**
 * Where an installed Skill came from, as a link to the Skill's page (its SKILL.md and files, read from GitHub at the ref it
 * was installed from); plain text for a Skill source whose repo is not one of GitHub's.
 */
const SourceLink = ({ skill, source }: { skill: EnvironmentSkill; source: SkillSource }) => {
  const scope = useSettingsScope();
  const href = skillPageOfSource(scope, skill.name, source);

  return href === null ? (
    <span className="truncate font-mono text-xs text-muted-foreground">
      {skillSourceText(source)}
    </span>
  ) : (
    <InAppLink
      href={href}
      className="truncate font-mono text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
      title="Open this skill's page: its SKILL.md and files"
    >
      {skillSourceText(source)}
    </InAppLink>
  );
};

/** The marks of a Skill: edited by the agent since it was installed, and behind its ref at its Skill source. */
export const SkillMarks = ({ skill }: { skill: EnvironmentSkill }) =>
  skill.modified === true || skill.updateAvailable === true ? (
    <span className="flex flex-wrap gap-1 text-xs">
      {skill.modified === true && (
        <span
          className="rounded border border-amber-500/60 px-1 text-amber-600 dark:text-amber-400"
          title="The agent edited this skill after it was installed. An update replaces the edits."
        >
          modified
        </span>
      )}
      {skill.updateAvailable === true && (
        <span
          className="rounded border border-sky-500/60 px-1 text-sky-600 dark:text-sky-400"
          title="Its folder changed at its Skill source, on the ref it was installed from."
        >
          update available
        </span>
      )}
    </span>
  ) : null;

/**
 * Update (a Skill with a Skill source only) and Remove of Skill `skill` of scope `id`: each opens its confirm, which
 * `SkillDialogs` of the same scope shows.
 */
export const SkillRowActions = ({ id, skill }: { id: string; skill: EnvironmentSkill }) => {
  const setRemoving = useAtomSet(skillDialogAtom(id));
  const forgetRemove = useAtomSet(removeSkillAtom(id));
  const setUpdating = useAtomSet(skillUpdateDialogAtom(id));
  const forgetUpdate = useAtomSet(updateSkillAtom(id));

  return (
    <>
      {skill.source !== undefined && (
        <Button
          size="icon"
          variant="ghost"
          className="size-8 shrink-0"
          aria-label={`Update ${skill.name}`}
          title={`Update ${skill.name}`}
          onClick={() => {
            forgetUpdate(Atom.Reset);
            setUpdating(skill.name);
          }}
        >
          <RefreshCw />
        </Button>
      )}
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
    </>
  );
};

/** The confirms Remove and Update of scope `id` open, for the Skills it keeps (`skills`, null while they load). */
export const SkillDialogs = ({
  id,
  skills,
}: {
  id: string;
  skills: ReadonlyArray<EnvironmentSkill> | null;
}) => {
  const [removing, setRemoving] = useAtom(skillDialogAtom(id));
  const removed = useAtomValue(removeSkillAtom(id));
  const [updating, setUpdating] = useAtom(skillUpdateDialogAtom(id));
  const updated = useAtomValue(updateSkillAtom(id));
  const updatingSkill = skills?.find((skill) => skill.name === updating);

  return (
    <>
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
      <Dialog
        open={updating !== null}
        onClose={() => {
          setUpdating(null);
        }}
        dismissible={!updated.waiting}
        title={`Update the ${updating ?? ""} skill?`}
      >
        {updatingSkill !== undefined && <UpdateSkillDialog id={id} skill={updatingSkill} />}
      </Dialog>
    </>
  );
};

/**
 * The Skills Environment `id` keeps (ADR-0026), or `GLOBAL` those kept Global: each one's
 * name, description and when it was saved, with its Skill source when it was installed from GitHub, and a removal
 * behind a confirmation. The agent saves them (those at Global only with your Approval) and installs them
 * for an Environment, and so does the owner's form; every Workspace of the Environment serves them read-only. An
 * Environment's section names the Skills it gets from Global, and which of its own win.
 */
export const SkillsSection = ({ id }: { id: string }) => {
  const loaded = useAtomValue(environmentSkillsAtom(id));
  const atGlobal = id === GLOBAL;
  const globalSkills = useAtomValue(environmentSkillsAtom(GLOBAL));
  const skills = loaded.pipe(AsyncResult.value, Option.getOrNull);
  const loadError = failureOf(loaded);
  const [viewing, setViewing] = useAtom(skillFilesDialogAtom(id));

  const { inherited, overridden } =
    atGlobal || skills === null
      ? { inherited: [], overridden: [] }
      : inheritedSkills(
          skills,
          globalSkills.pipe(
            AsyncResult.value,
            Option.getOrElse(() => []),
          ),
        );

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-medium text-muted-foreground">
        {atGlobal ? "Global skills" : "Skills"}
      </h3>
      {skills === null ? (
        <p className="text-xs text-muted-foreground">{loadError ?? "Loading…"}</p>
      ) : skills.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {atGlobal
            ? "None kept Global. Add some from GitHub below, or the agent saves one with environment_skill_save or installs one with environment_skill_install and the id *, and you approve it in its session."
            : "None of its own: its workspaces serve those kept Global. Add some from GitHub below, or the agent saves one with environment_skill_save or installs one with environment_skill_install."}
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {skills.map((skill) => (
            <li key={skill.name} className="flex items-start justify-between gap-2">
              <span className="flex min-w-0 flex-1 flex-col">
                {skill.source === undefined ? (
                  // A Skill with no Skill source (one the agent wrote or saved) has no page elsewhere: its files are
                  // the Registry's, shown read-only.
                  <button
                    type="button"
                    className="truncate text-left font-mono text-sm underline-offset-2 hover:underline"
                    title="View the files kept for this skill"
                    aria-label={`View the files of ${skill.name}`}
                    onClick={() => {
                      setViewing(skill.name);
                    }}
                  >
                    {skill.name}
                  </button>
                ) : (
                  <span className="truncate font-mono text-sm">{skill.name}</span>
                )}
                <span className="line-clamp-2 text-xs break-words text-muted-foreground">
                  {skill.description}
                </span>
                <span className="text-xs text-muted-foreground">
                  {/* A Skill's time is read against the wall clock as the card renders. */}
                  {/* @effect-diagnostics-next-line globalDate:off */}
                  Saved {relativeTime(skill.savedAt, Date.now())}
                </span>
                {skill.source !== undefined && <SourceLink skill={skill} source={skill.source} />}
                <SkillMarks skill={skill} />
              </span>
              <SkillRowActions id={id} skill={skill} />
            </li>
          ))}
        </ul>
      )}
      <MarkedNames kind="inherited" names={inherited} />
      <MarkedNames kind="overridden" names={overridden} />
      <AddSkillsForm id={id} />
      <SkillDialogs id={id} skills={skills} />
      <Dialog
        open={viewing !== null}
        onClose={() => {
          setViewing(null);
        }}
        title={`The ${viewing ?? ""} skill`}
        description="The files kept for it, read-only. It has no Skill source: the agent wrote or saved it."
        className="max-w-3xl"
      >
        {viewing !== null && <SkillFilesViewer id={id} name={viewing} />}
      </Dialog>
    </div>
  );
};

/**
 * The Installed tab: the Skills the Scope the page shows keeps (Global's, or the Environment's own with the ones it also
 * gets from Global), their forms, and the way to what the agent changed in them.
 */
export const InstalledTab = () => {
  const scope = useSettingsScope();
  const name = useScopeName(scope);

  return (
    <section aria-label={name} className="flex flex-col gap-4 rounded-lg border p-4">
      {scope === GLOBAL ? (
        <p className="text-xs text-muted-foreground">
          A skill kept here is served read-only in each Environment's workspaces at their next
          readying. It steers every future session, so the agent's save, install or removal of one
          waits for your Approval in its session. An Environment's own skill of the same name wins
          in that Environment. Adding or removing one here is your own change: it waits for nothing.
        </p>
      ) : null}
      <SkillsSection id={scope} />
      <p className="text-xs text-muted-foreground">
        What the agent changed in these skills, with Revert, is in{" "}
        <InAppLink
          href={settingsPath(scope, "agent-changes")}
          className="underline underline-offset-2 hover:text-foreground"
        >
          Agent changes
        </InAppLink>
        .
      </p>
    </section>
  );
};
