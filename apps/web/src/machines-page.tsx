// @effect-diagnostics preferEffectArray:off -- JSX lists of cards, repos and Sessions are native arrays.

import { INSTANCE_TYPES, type InstanceType } from "@cloudpid/config";
import {
  DEFAULT_MACHINE,
  MAX_MACHINE_NAME_LENGTH,
  type SessionRecord,
  type MachineRecord,
} from "@cloudpid/protocol";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import { ArrowLeft, Eraser, GitBranch, Pencil, Play, RotateCw, Trash2 } from "lucide-react";
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
  cloneRepoAtom,
  cloneSourceAtom,
  createMachineAtom,
  deleteTypedAtom,
  deleteMachineAtom,
  newMachineSlugAtom,
  removeRepoAtom,
  removeTypedAtom,
  reposAtom,
  resetTypedAtom,
  resetMachineAtom,
  restartContainerAtom,
  saveMachineAtom,
  machineDialogAtom,
  machineDraftAtom,
  machineListAtom,
  machineSettingsAtom,
  machinesErrorAtom,
  type MachineDialog,
} from "./machines-state.ts";
import {
  deleteConfirmed,
  idleMinutesProblem,
  ignorePatternsFrom,
  ignoreProblem,
  instanceLabel,
  slugProblem,
  sourceProblem,
  machineNameProblem,
} from "./machines.ts";

const NewMachineForm = () => {
  const [slug, setSlug] = useAtom(newMachineSlugAtom);
  const [created, create] = useAtom(createMachineAtom);
  const problem = slug === "" ? null : slugProblem(slug);

  const submit = (event: FormEvent) => {
    event.preventDefault();

    if (slug === "" || problem !== null) return;

    create(slug);
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-1.5">
      <label htmlFor="new-machine" className="text-sm font-medium">
        New machine
      </label>
      <div className="flex gap-2">
        <Input
          id="new-machine"
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
        <Button type="submit" disabled={created.waiting || slug === "" || problem !== null}>
          Create
        </Button>
      </div>
      {problem !== null && <p className="text-xs text-destructive">{problem}</p>}
    </form>
  );
};

const CloneForm = ({ slug }: { slug: string }) => {
  const [source, setSource] = useAtom(cloneSourceAtom(slug));
  // A clone can take a minute: the Container starts, and the repo is downloaded.
  const [cloned, clone] = useAtom(cloneRepoAtom(slug));
  const cloning = cloned.waiting;
  const problem = source.trim() === "" ? null : sourceProblem(source);
  const id = `clone-${slug}`;

  const submit = (event: FormEvent) => {
    event.preventDefault();

    if (source.trim() === "" || problem !== null || cloning) return;

    clone(source);
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-1.5">
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
          disabled={cloning}
          aria-invalid={problem !== null}
          className="flex-1 font-mono"
        />
        <Button
          type="submit"
          variant="outline"
          disabled={cloning || source.trim() === "" || problem !== null}
        >
          <GitBranch />
          {cloning ? "Cloning…" : "Clone"}
        </Button>
      </div>
      {problem !== null && <p className="text-xs text-destructive">{problem}</p>}
      {cloning && (
        <p role="status" className="text-xs text-muted-foreground">
          Cloning into /workspace. The first command of a Machine starts its Container, which takes
          a little while.
        </p>
      )}
    </form>
  );
};

/** The Container fields of the Edit dialog: size, idle time and extra paths, saved together with the name. */
const ContainerFields = ({
  slug,
  instance,
  idle,
  idleProblem,
  paths,
  pathsProblem,
  onInstance,
  onIdle,
  onPaths,
}: {
  slug: string;
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
            {instanceLabel(type)}
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
    <div className="flex flex-col gap-1.5">
      <label htmlFor={`paths-${slug}`} className="text-sm font-medium">
        More Container-only paths (one per line)
      </label>
      <textarea
        id={`paths-${slug}`}
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
          Kept on the Container, out of the Machine, like node_modules. Start with / (from
          /workspace) or **/ (at any depth); a line starting with ! keeps a path synced. What the
          Machine already holds there stays until it is deleted.
        </p>
      ) : (
        <p className="text-xs text-destructive">{pathsProblem}</p>
      )}
    </div>
    <p className="text-xs text-muted-foreground">
      These apply the next time the Container starts: a running one keeps what it started with. A
      saved disk larger than a smaller size's disk cannot be restored there, and one saved with
      other paths is not restored; the Container then starts from scratch.
    </p>
  </fieldset>
);

/** Edit a Machine: its name, and its Container's size, idle time and extra paths. Its slug never changes. */
const EditMachineDialog = ({
  machine,
  otherNames,
}: {
  machine: MachineRecord;
  otherNames: readonly string[];
}) => {
  const { slug } = machine;
  const loaded = useAtomValue(machineSettingsAtom(slug));
  // Ask for the settings again, after a failure to load them (one call to a cold Durable Object can fail).
  const retry = useAtomRefresh(machineSettingsAtom(slug));
  const [draft, setDraft] = useAtom(machineDraftAtom(slug));
  const [edited, save] = useAtom(saveMachineAtom(slug));
  const setDialog = useAtomSet(machineDialogAtom(slug));
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
  const nameProblem = machineNameProblem(name, otherNames);
  const idleProblem = saved === undefined ? null : idleMinutesProblem(idle);
  const pathsProblem = ignore === undefined ? null : ignoreProblem(ignore);
  const renamed = name.trim() !== machine.name;
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
        <label htmlFor={`name-${slug}`} className="text-sm font-medium">
          Name
        </label>
        <Input
          id={`name-${slug}`}
          value={name}
          maxLength={MAX_MACHINE_NAME_LENGTH}
          onChange={(event) => {
            setDraft((current) => ({ ...current, name: event.target.value }));
          }}
          autoComplete="off"
          data-1p-ignore
          aria-invalid={nameProblem !== null}
        />
        {nameProblem === null ? (
          <p className="text-xs text-muted-foreground">
            Its slug, <span className="font-mono">{slug}</span>, stays the same.
          </p>
        ) : (
          <p className="text-xs text-destructive">{nameProblem}</p>
        )}
      </div>
      {saved !== undefined && instance !== undefined ? (
        <ContainerFields
          slug={slug}
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

/** Confirm deleting a Machine by typing its slug, after saying everything that goes with it. */
const DeleteMachineDialog = ({
  machine,
  sessions,
}: {
  machine: MachineRecord;
  sessions: readonly SessionRecord[];
}) => {
  const { slug } = machine;
  const [typed, setTyped] = useAtom(deleteTypedAtom(slug));
  const [deleted, remove] = useAtom(deleteMachineAtom(slug));
  const setDialog = useAtomSet(machineDialogAtom(slug));
  const busy = deleted.waiting;
  const problem = settledFailureOf(deleted);
  const archived = sessions.filter((session) => session.archivedAt !== null).length;
  const confirmed = deleteConfirmed(slug, typed);

  const submit = (event: FormEvent) => {
    event.preventDefault();

    if (!confirmed || busy) return;

    remove();
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
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
        <label htmlFor={`confirm-${slug}`} className="text-sm">
          Type <span className="font-mono font-medium">{slug}</span> to confirm
        </label>
        <Input
          id={`confirm-${slug}`}
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
          {busy ? "Deleting…" : "Delete machine"}
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

/** Confirm resetting a Machine by typing its slug, after saying what goes and what stays. */
const ResetMachineDialog = ({
  machine,
  sessions,
}: {
  machine: MachineRecord;
  sessions: readonly SessionRecord[];
}) => {
  const { slug } = machine;
  const [typed, setTyped] = useAtom(resetTypedAtom(slug));
  const [reset, run] = useAtom(resetMachineAtom(slug));
  const setDialog = useAtomSet(machineDialogAtom(slug));
  const busy = reset.waiting;
  const confirmed = deleteConfirmed(slug, typed);
  const count = sessionCount(sessions);

  const submit = (event: FormEvent) => {
    event.preventDefault();

    if (!confirmed || busy) return;

    run();
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
        <li>
          {count === null
            ? "It has no sessions."
            : `${count}, with their conversations and history. Running ones stop first.`}
        </li>
        <li>Every repo and file in it, including work that was not pushed.</li>
        <li>Its Container and its saved disk.</li>
      </ul>
      <p className="text-sm text-muted-foreground">
        Its name, its slug and its Container settings stay. The next command starts a new Container.
      </p>
      <ConfirmField
        id={`reset-confirm-${slug}`}
        expected={slug}
        typed={typed}
        busy={busy}
        onTyped={setTyped}
      />
      {busy && (
        <p role="status" className="text-xs text-muted-foreground">
          Deleting its sessions, then its files. This can take a little while.
        </p>
      )}
      <DialogProblem problem={settledFailureOf(reset)} />
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
          {busy ? "Resetting…" : "Reset machine"}
        </Button>
      </DialogActions>
    </form>
  );
};

/** Confirm restarting a Machine's Container, after saying what it keeps and what it loses. */
const RestartContainerDialog = ({ machine }: { machine: MachineRecord }) => {
  const { slug } = machine;
  const [restarted, run] = useAtom(restartContainerAtom(slug));
  const setDialog = useAtomSet(machineDialogAtom(slug));
  const busy = restarted.waiting;

  const submit = (event: FormEvent) => {
    event.preventDefault();

    if (busy) return;

    run();
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

/** Confirm removing a repo by typing its name, after saying what goes with it. */
const RemoveRepoDialog = ({
  slug,
  repo,
  sessions,
}: {
  slug: string;
  repo: string;
  /** The Sessions bound to the repo, archived ones included. */
  sessions: readonly SessionRecord[];
}) => {
  const [typed, setTyped] = useAtom(removeTypedAtom(slug));
  const [removed, run] = useAtom(removeRepoAtom(slug));
  const setDialog = useAtomSet(machineDialogAtom(slug));
  const busy = removed.waiting;
  const confirmed = deleteConfirmed(repo, typed);
  const count = sessionCount(sessions);

  const submit = (event: FormEvent) => {
    event.preventDefault();

    if (!confirmed || busy) return;

    run(repo);
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
        <li>
          {count === null
            ? "It has no sessions."
            : `${count} started in it, with their conversations and history. Running ones stop first.`}
        </li>
        <li>Its files, including work that was not pushed.</li>
        <li>It is deleted on the Container, which starts if it is not running.</li>
      </ul>
      <ConfirmField
        id={`remove-confirm-${slug}`}
        expected={repo}
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
          {busy ? "Removing…" : "Remove repo"}
        </Button>
      </DialogActions>
    </form>
  );
};

const MachineCard = ({
  machine,
  otherNames,
  sessions,
  starting,
  onStart,
}: {
  machine: MachineRecord;
  /** The names of the other Machines, which this one cannot take. */
  otherNames: readonly string[];
  /** Every Session bound to the Machine, archived ones included. */
  sessions: readonly SessionRecord[];
  starting: boolean;
  onStart: (machine: string, repo?: string) => void;
}) => {
  const { slug } = machine;
  const listed = useAtomValue(reposAtom(slug));
  const cloned = useAtomValue(cloneRepoAtom(slug));
  // The Container's settings are asked for with the card, so the Edit dialog has them when it opens.
  useAtomMount(machineSettingsAtom(slug));
  const [dialog, setDialog] = useAtom(machineDialogAtom(slug));
  const edited = useAtomValue(saveMachineAtom(slug));
  const deleted = useAtomValue(deleteMachineAtom(slug));
  const reset = useAtomValue(resetMachineAtom(slug));
  const restarted = useAtomValue(restartContainerAtom(slug));
  const removed = useAtomValue(removeRepoAtom(slug));
  const forgetEdit = useAtomSet(saveMachineAtom(slug));
  const forgetDelete = useAtomSet(deleteMachineAtom(slug));
  const forgetReset = useAtomSet(resetMachineAtom(slug));
  const forgetRestart = useAtomSet(restartContainerAtom(slug));
  const forgetRemove = useAtomSet(removeRepoAtom(slug));
  const shown = sessions.filter((session) => session.archivedAt === null);
  const repos = listed.pipe(AsyncResult.value, Option.getOrNull);

  // A dialog's form is saving: the card holds it, so the dialog stays open until the request answers.
  const busy =
    edited.waiting || deleted.waiting || reset.waiting || restarted.waiting || removed.waiting;

  const removing = Predicate.hasProperty(dialog, "removeRepo") ? dialog.removeRepo : null;

  // A clone's failure shows until the next clone starts.
  const reposError = settledFailureOf(cloned) ?? failureOf(listed);

  const open = (next: MachineDialog) => {
    // A failure of an earlier save, delete, reset, restart or removal shows no more once a dialog is opened again.
    forgetEdit(Atom.Reset);
    forgetDelete(Atom.Reset);
    forgetReset(Atom.Reset);
    forgetRestart(Atom.Reset);
    forgetRemove(Atom.Reset);
    setDialog(next);
  };

  const close = () => {
    setDialog(null);
  };

  return (
    <section aria-label={machine.name} className="flex flex-col gap-4 rounded-lg border p-4">
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
          <h2 className="truncate text-sm font-semibold">{machine.name}</h2>
          {machine.name !== slug && (
            <span className="truncate font-mono text-xs text-muted-foreground">{slug}</span>
          )}
        </div>
        <Menu label={`Actions for the ${machine.name} machine`} className="-mt-1.5 -mr-1.5">
          <MenuItem
            onSelect={() => {
              open("edit");
            }}
          >
            <Pencil aria-hidden />
            Edit…
          </MenuItem>
          <MenuItem
            onSelect={() => {
              open("restart");
            }}
          >
            <RotateCw aria-hidden />
            Restart container…
          </MenuItem>
          <MenuItem
            destructive
            onSelect={() => {
              open("reset");
            }}
          >
            <Eraser aria-hidden />
            Reset…
          </MenuItem>
          {slug !== DEFAULT_MACHINE && (
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
          {(repos ?? []).map((repo) => (
            <li key={repo} className="flex items-center justify-between gap-2">
              <span className="truncate font-mono text-sm">/workspace/{repo}</span>
              <div className="flex items-center gap-1.5">
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-8"
                  aria-label={`Remove ${repo}`}
                  title={`Remove ${repo}`}
                  onClick={() => {
                    open({ removeRepo: repo });
                  }}
                >
                  <Trash2 />
                </Button>
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
              </div>
            </li>
          ))}
        </ul>
        {repos === null && reposError === null && (
          <p className="text-xs text-muted-foreground">Looking for repos…</p>
        )}
        {repos?.length === 0 && (
          <p className="text-xs text-muted-foreground">No repos yet. Clone one below.</p>
        )}
      </div>
      <CloneForm slug={slug} />
      {reposError !== null && (
        <p role="alert" className="text-sm whitespace-pre-wrap text-destructive">
          {reposError}
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
        title={`Edit ${machine.name}`}
      >
        <EditMachineDialog machine={machine} otherNames={otherNames} />
      </Dialog>
      <Dialog
        open={dialog === "delete"}
        onClose={close}
        dismissible={!busy}
        title={`Delete the ${machine.name} machine?`}
        description="Everything below is deleted for good. Its saved Container disk expires on its own within 30 days."
      >
        <DeleteMachineDialog machine={machine} sessions={sessions} />
      </Dialog>
      <Dialog
        open={dialog === "reset"}
        onClose={close}
        dismissible={!busy}
        title={`Reset the ${machine.name} machine?`}
        description="Everything below is deleted for good, and the machine starts over."
      >
        <ResetMachineDialog machine={machine} sessions={sessions} />
      </Dialog>
      <Dialog
        open={dialog === "restart"}
        onClose={close}
        dismissible={!busy}
        title={`Restart the ${machine.name} container?`}
      >
        <RestartContainerDialog machine={machine} />
      </Dialog>
      <Dialog
        open={removing !== null}
        onClose={close}
        dismissible={!busy}
        title={`Remove ${removing ?? ""}?`}
        description="Everything below is deleted for good."
      >
        {removing !== null && (
          <RemoveRepoDialog
            slug={slug}
            repo={removing}
            sessions={sessions.filter((session) => session.repo === removing)}
          />
        )}
      </Dialog>
    </section>
  );
};

/** The Machines page: create a Machine, clone repos into it, and start Sessions in a repo or at its root. */
export const MachinesPage = () => {
  const sessions = useAtomValue(sessionListAtom);
  const sessionsError = useAtomValue(sessionsErrorAtom);
  const machines = useAtomValue(machineListAtom);
  const listError = useAtomValue(machinesErrorAtom);
  const createdMachine = useAtomValue(createMachineAtom);
  const createSession = useAtomSet(createSessionAtom);
  // Starting a Session holds every Start button until the new Session is registered and opened.
  const starting = useAtomValue(createSessionAtom).waiting;
  const error = failureOf(createdMachine) ?? listError;

  const start = (machine: string, repo?: string) => {
    createSession(callOf(repo === undefined ? { machine } : { machine, repo }));
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
          <h1 className="text-lg font-semibold">Machines</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          A machine holds the files of one or more repos, shared by every session that works in it.
          A session started in a repo has its directory as the working directory.
        </p>
        <NewMachineForm />
        {(error ?? sessionsError) !== null && (
          <p role="alert" className="text-sm whitespace-pre-wrap text-destructive">
            {error ?? sessionsError}
          </p>
        )}
        {machines === null ? (
          error === null && <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="flex flex-col gap-4">
            {machines.map((machine) => (
              <MachineCard
                key={machine.slug}
                machine={machine}
                otherNames={machines
                  .filter((other) => other.slug !== machine.slug)
                  .map((other) => other.name)}
                sessions={(sessions ?? []).filter((session) => session.machine === machine.slug)}
                starting={starting}
                onStart={start}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
