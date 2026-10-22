// @effect-diagnostics globalDate:off preferEffectArray:off -- a list's relative times are read against the wall clock as it renders, and its rows are JSX lists over native arrays.

import { NEW_WORKSPACE, type SessionRecord } from "@cloudpid/protocol";
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import * as ScopedAtom from "@effect/atom-react/ScopedAtom";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import {
  ChevronDown,
  ChevronRight,
  FolderGit2,
  GitBranch,
  GitFork,
  Plus,
  Settings as SettingsIcon,
  X,
} from "lucide-react";
import { useId } from "react";
import { Button } from "./components/ui/button.tsx";
import { Menu, MenuItem } from "./components/ui/menu.tsx";
import { callOf } from "./calls.ts";
import { relativeTime } from "./format.ts";
import { cn } from "./lib/utils.ts";
import { navigate, SETTINGS_PATH, sessionPath, MACHINES_PATH } from "./router.ts";
import { listProblemAtom, noticeAtom } from "./app-state.ts";
import { groupCollapsedAtom, groupKey, type ListSection } from "./collapsed-groups.ts";
import { failureOf } from "./registry.ts";
import { useSessionActions } from "./session-actions.ts";
import { type SessionActions, SessionMenu } from "./session-menu.tsx";
import {
  createSessionAtom,
  currentSessionAtom,
  type PlaceInMachine,
  newSessionPlace,
  placeLabel,
  sessionListAtom,
  sessionsErrorAtom,
} from "./sessions.ts";
import {
  reposAtom,
  machineListAtom,
  machineNamesAtom,
  machinesErrorAtom,
  workspaceBranchesAtom,
  workspaceListAtom,
} from "./machines-state.ts";
import { groupByMachine, splitArchived, type MachineGroup } from "./machines.ts";

export const sessionTitle = (session: SessionRecord): string => session.title ?? "Untitled session";

/** Where a Session works, as its list item says: its repo, and its Workspace's branch when it has one of its own. */
const SessionPlaceNote = ({ session }: { session: SessionRecord }) => {
  const branches = useAtomValue(workspaceBranchesAtom);

  if (session.repo === null) return null;

  const branch = session.workspace === null ? undefined : branches[session.workspace];

  return (
    <span className="truncate font-mono">
      {branch === undefined ? session.repo : `${session.repo} · ${branch}`}
    </span>
  );
};

export const SessionLink = ({
  session,
  active,
  className,
}: {
  session: SessionRecord;
  active: boolean;
  className?: string;
}) => (
  <a
    href={sessionPath(session.id)}
    aria-current={active ? "page" : undefined}
    onClick={(event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;

      event.preventDefault();
      navigate(sessionPath(session.id));
    }}
    className={cn(
      "flex flex-col gap-0.5 rounded-md px-3 py-2 text-sm transition-colors hover:bg-accent",
      active && "bg-accent text-accent-foreground",
      className,
    )}
  >
    <span className="truncate font-medium">{sessionTitle(session)}</span>
    <span className="flex items-center gap-2 text-xs text-muted-foreground">
      <SessionPlaceNote session={session} />
      {session.status === "running" ? (
        <>
          <span className="pulse-dot size-1.5 rounded-full bg-success" aria-hidden />
          Running
        </>
      ) : (
        <span className="tabular shrink-0 whitespace-nowrap">
          {relativeTime(session.updatedAt, Date.now())}
        </span>
      )}
    </span>
  </a>
);

/**
 * A Session in the list, with its "⋯" menu at the right. On a screen with a pointer the button shows on hover or keyboard
 * focus (and while its menu is open); on a touch screen it always shows.
 */
const SessionItem = ({
  session,
  active,
  machineName,
  actions,
}: {
  session: SessionRecord;
  active: boolean;
  machineName: string;
  actions: SessionActions;
}) => (
  <li className="group relative">
    <SessionLink session={session} active={active} className="pr-10" />
    <SessionMenu
      session={session}
      machineName={machineName}
      actions={actions}
      className="absolute top-1.5 right-1.5 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 group-has-[:popover-open]:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
    />
  </li>
);

/**
 * A Machine's Sessions under a header that collapses them, kept per device. The header counts them and, collapsed,
 * shows whether one is running.
 */
const SessionGroup = ({
  group,
  section,
  activeId,
  actions,
}: {
  group: MachineGroup;
  section: ListSection;
  activeId: string | undefined;
  actions: SessionActions;
}) => {
  const [collapsed, setCollapsed] = useAtom(groupCollapsedAtom(groupKey(section, group.machine)));
  const listId = useId();
  const count = group.sessions.length;
  const showsRunning = collapsed && group.running;

  return (
    <section aria-label={group.name}>
      <h2>
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-controls={listId}
          aria-label={`${group.name}, ${count} ${count === 1 ? "session" : "sessions"}${showsRunning ? ", at least one running" : ""}`}
          onClick={() => {
            setCollapsed(!collapsed);
          }}
          className="flex w-full items-center gap-1.5 rounded-md px-3 py-1 text-left text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ChevronRight
            className={cn("size-3.5 shrink-0 transition-transform", !collapsed && "rotate-90")}
            aria-hidden
          />
          <span className="truncate">{group.name}</span>
          <span className="tabular shrink-0 font-normal" aria-hidden>
            {count}
          </span>
          {showsRunning && (
            <span
              className="pulse-dot size-1.5 shrink-0 rounded-full bg-success"
              title="A session is running"
              aria-hidden
            />
          )}
        </button>
      </h2>
      {!collapsed && (
        <ul id={listId} className="flex flex-col gap-0.5">
          {group.sessions.map((session) => (
            <SessionItem
              key={session.id}
              session={session}
              active={session.id === activeId}
              machineName={group.name}
              actions={actions}
            />
          ))}
        </ul>
      )}
    </section>
  );
};

/** Sessions grouped under their Machine's name, each group collapsible. */
const SessionGroups = ({
  groups,
  section,
  activeId,
  actions,
}: {
  groups: readonly MachineGroup[];
  section: ListSection;
  activeId: string | undefined;
  actions: SessionActions;
}) => (
  <div className="flex flex-col gap-3">
    {groups.map((group) => (
      <SessionGroup
        key={group.machine}
        group={group}
        section={section}
        activeId={activeId}
        actions={actions}
      />
    ))}
  </div>
);

/** A note in the New session menu, such as why a list is not there. */
const MenuNote = ({ children, indented = false }: { children: string; indented?: boolean }) => (
  <p
    role="none"
    className={cn("py-1 text-xs text-muted-foreground", indented ? "pr-2.5 pl-8" : "px-2.5")}
  >
    {children}
  </p>
);

/**
 * The repos of Machine `machine` in the New session menu: each starts a Session in a new Workspace of its own, and
 * below it in the repo's main checkout or in one of its Workspaces that exist, to share its files.
 */
const RepoItems = ({
  machine,
  disabled,
  start,
}: {
  machine: string;
  disabled: boolean;
  start: (place: PlaceInMachine) => void;
}) => {
  const listed = useAtomValue(reposAtom(machine));
  const workspaces = useAtomValue(workspaceListAtom) ?? [];
  const repos = listed.pipe(AsyncResult.value, Option.getOrNull);

  if (repos === null)
    return (
      <MenuNote indented>
        {AsyncResult.isFailure(listed) ? "Couldn't list repos" : "Loading repos…"}
      </MenuNote>
    );

  return repos.map((repo) => (
    <div key={repo} role="group" aria-label={repo}>
      <MenuItem
        disabled={disabled}
        onSelect={() => {
          start({ machine, repo, workspace: NEW_WORKSPACE });
        }}
        className="pl-8 text-xs"
      >
        <GitBranch aria-hidden />
        <span className="truncate font-mono">{repo}</span>
        <span className="ml-auto shrink-0 text-muted-foreground">new workspace</span>
      </MenuItem>
      <MenuItem
        disabled={disabled}
        onSelect={() => {
          start({ machine, repo });
        }}
        className="pl-12 text-xs text-muted-foreground"
      >
        <span className="truncate">main checkout</span>
      </MenuItem>
      {workspaces
        .filter((workspace) => workspace.machine === machine && workspace.repo === repo)
        .map((workspace) => (
          <MenuItem
            key={workspace.id}
            disabled={disabled}
            onSelect={() => {
              start({ machine, repo, workspace: workspace.id });
            }}
            className="pl-12 text-xs"
          >
            <GitFork aria-hidden />
            <span className="truncate font-mono">{workspace.branch}</span>
          </MenuItem>
        ))}
    </div>
  ));
};

/** Whether the New session menu is open: its repos are asked for only then. */
const PlacesOpen = ScopedAtom.make(() => Atom.make(false));

/**
 * The New session button: its main part starts a Session where the shown Session works, in a new Workspace of its repo
 * (the default Machine's root when none is shown); its chevron opens a menu of every Machine, each with its repos and
 * their Workspaces, to start one anywhere.
 */
const NewSessionButton = () => {
  const shown = useAtomValue(currentSessionAtom);
  const names = useAtomValue(machineNamesAtom);
  const branches = useAtomValue(workspaceBranchesAtom);
  const machines = useAtomValue(machineListAtom);
  const machinesError = useAtomValue(machinesErrorAtom);
  const created = useAtomValue(createSessionAtom);
  const createSession = useAtomSet(createSessionAtom);
  const [open, setOpen] = useAtom(PlacesOpen.use());
  const place = newSessionPlace(shown);
  const label = `New session in ${placeLabel(place, names, branches)}`;
  const creating = created.waiting;

  const start = (where: PlaceInMachine) => {
    createSession(callOf(where));
  };

  return (
    <div className="flex items-center">
      <Button
        size="sm"
        variant="outline"
        disabled={creating}
        title={label}
        aria-label={label}
        onClick={() => {
          start(place);
        }}
        className="rounded-r-none"
      >
        <Plus />
        New session
      </Button>
      <Menu
        label="New session in…"
        title="Choose where the session starts"
        icon={<ChevronDown className="size-4" aria-hidden />}
        disabled={creating}
        onOpenChange={setOpen}
        className="rounded-l-none border border-l-0 border-input text-foreground"
      >
        {machines === null ? (
          <MenuNote>{machinesError ?? "Loading…"}</MenuNote>
        ) : (
          machines.map((machine) => (
            <div key={machine.slug} role="group" aria-label={machine.name}>
              <MenuItem
                disabled={creating}
                onSelect={() => {
                  start({ machine: machine.slug });
                }}
              >
                <FolderGit2 aria-hidden />
                <span className="truncate">{machine.name}</span>
              </MenuItem>
              {open && <RepoItems machine={machine.slug} disabled={creating} start={start} />}
            </div>
          ))
        )}
      </Menu>
    </div>
  );
};

export const Sidebar = ({
  activeId,
  settingsActive,
  machinesActive,
  className,
}: {
  activeId: string | undefined;
  settingsActive: boolean;
  machinesActive: boolean;
  className?: string;
}) => {
  const sessions = useAtomValue(sessionListAtom);
  const [notice, setNotice] = useAtom(noticeAtom);
  const listError = useAtomValue(sessionsErrorAtom);
  const names = useAtomValue(machineNamesAtom);
  // Why the last new Session could not be created, here or by the composer's `/new`.
  const created = useAtomValue(createSessionAtom);
  const createError = failureOf(created);
  // An archive or unarchive from an item's menu that failed: shown with the list's own error.
  const problem = useAtomValue(listProblemAtom);
  const actions = useSessionActions(listProblemAtom);

  const { active, archived } = splitArchived(sessions ?? []);
  const error = problem ?? createError ?? listError;

  return (
    <nav aria-label="Sessions" className={cn("flex w-full flex-col border-r md:w-72", className)}>
      <div className="flex items-center justify-between gap-2 p-3">
        <h1 className="text-sm font-semibold">Sessions</h1>
        <PlacesOpen.Provider>
          <NewSessionButton />
        </PlacesOpen.Provider>
      </div>
      {notice !== null && (
        <div
          role="status"
          className="mx-3 mb-2 flex items-start gap-2 rounded-md bg-muted px-3 py-2 text-sm"
        >
          <span className="min-w-0 flex-1">{notice}</span>
          <button
            type="button"
            onClick={() => {
              setNotice(null);
            }}
            aria-label="Dismiss"
            className="-m-1 shrink-0 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        </div>
      )}
      {error !== null && (
        <p role="alert" className="mx-3 mb-2 text-sm whitespace-pre-wrap text-destructive">
          {error}
        </p>
      )}
      <div className="flex-1 overflow-y-auto px-2 pb-3">
        {sessions === null ? (
          <p className="px-3 py-2 text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="flex flex-col gap-4">
            {active.length === 0 ? (
              <p className="px-3 py-2 text-sm text-muted-foreground">
                {archived.length === 0 ? "No sessions yet." : "No sessions outside the archive."}
              </p>
            ) : (
              <SessionGroups
                groups={groupByMachine(active, names)}
                section="active"
                activeId={activeId}
                actions={actions}
              />
            )}
            {archived.length > 0 && (
              <details
                className="group/archived"
                open={archived.some((session) => session.id === activeId) ? true : undefined}
              >
                <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground select-none hover:bg-accent hover:text-foreground [&::-webkit-details-marker]:hidden">
                  <ChevronRight
                    className="size-3.5 transition-transform group-open/archived:rotate-90"
                    aria-hidden
                  />
                  Archived ({archived.length})
                </summary>
                <div className="mt-2">
                  <SessionGroups
                    groups={groupByMachine(archived, names)}
                    section="archived"
                    activeId={activeId}
                    actions={actions}
                  />
                </div>
              </details>
            )}
          </div>
        )}
      </div>
      <div className="flex flex-col gap-0.5 border-t p-2">
        <a
          href={MACHINES_PATH}
          aria-current={machinesActive ? "page" : undefined}
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;

            event.preventDefault();
            navigate(MACHINES_PATH);
          }}
          className={cn(
            "flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors hover:bg-accent",
            machinesActive && "bg-accent text-accent-foreground",
          )}
        >
          <FolderGit2 className="size-4" aria-hidden />
          Machines
        </a>
        <a
          href={SETTINGS_PATH}
          aria-current={settingsActive ? "page" : undefined}
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;

            event.preventDefault();
            navigate(SETTINGS_PATH);
          }}
          className={cn(
            "flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors hover:bg-accent",
            settingsActive && "bg-accent text-accent-foreground",
          )}
        >
          <SettingsIcon className="size-4" aria-hidden />
          Settings
        </a>
      </div>
    </nav>
  );
};
