// @effect-diagnostics preferEffectArray:off -- the JSX list of Subagent Workspaces is a native array.
import { MAX_TITLE_LENGTH, type SessionRecord, type WorkspaceRecord } from "@cloudpid/protocol";
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import * as ScopedAtom from "@effect/atom-react/ScopedAtom";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import { Archive, ArchiveRestore, GitFork, Pencil, Trash2 } from "lucide-react";
import { type Rename, saveTitleAtom, titleDraft } from "./chat/title-state.ts";
import { Button } from "./components/ui/button.tsx";
import { Dialog, DialogActions, DialogProblem } from "./components/ui/dialog.tsx";
import { Input } from "./components/ui/input.tsx";
import { Menu, MenuItem } from "./components/ui/menu.tsx";
import { settledFailureOf } from "./registry.ts";
import { sessionTitle } from "./sidebar.tsx";
import type { SessionActions as AllSessionActions } from "./session-actions.ts";
import {
  describeWorkspaceWork,
  subagentWorkspacesOf,
  workspaceListAtom,
  workspaceWorkAtom,
} from "./environments-state.ts";
import {
  deleteSessionAtom,
  lastInWorkspace,
  sameWorkspacePlace,
  sessionListAtom,
} from "./sessions.ts";

/**
 * What a Session's menu does besides delete: rename it, start another Session in its Workspace, archive and unarchive,
 * through the Session list.
 */
export type SessionActions = Pick<AllSessionActions, "rename" | "create" | "archive" | "unarchive">;

/** Whether a menu's delete dialog is open; each menu has its own, since a Session's page and its list item both have one. */
const DeleteOpen = ScopedAtom.make(() => Atom.make(false));

/** The title typed in a menu's rename dialog, or null while it is closed; each menu has its own, as for delete. */
const RenameDraft = ScopedAtom.make(titleDraft);

/**
 * Rename a Session: its title in a field, saved by Save or Return (outside an IME composition), the reason inline while
 * a save fails. A blank or unchanged title only closes it.
 */
const RenameSessionDialog = ({ rename }: { rename: Rename }) => {
  const draft = RenameDraft.use();
  const [typed, setTyped] = useAtom(draft);
  const saving_ = saveTitleAtom(draft);
  const [saved, save] = useAtom(saving_);
  const saving = saved.waiting;
  const problem = settledFailureOf(saved);

  const close = () => {
    if (saving) return;

    setTyped(null);
    save(Atom.Reset);
  };

  return (
    <Dialog open={typed !== null} onClose={close} dismissible={!saving} title="Rename session">
      <form
        onSubmit={(event) => {
          event.preventDefault();

          if (!saving) save(rename);
        }}
        className="flex flex-col gap-4"
      >
        <Input
          autoFocus
          aria-label="Session title"
          aria-invalid={problem !== null}
          value={typed ?? ""}
          maxLength={MAX_TITLE_LENGTH}
          disabled={saving}
          placeholder="Untitled session"
          onChange={(event) => {
            setTyped(event.target.value);
            save(Atom.Reset);
          }}
          onFocus={(event) => {
            event.currentTarget.select();
          }}
        />
        <DialogProblem problem={problem} />
        <DialogActions>
          <Button type="button" variant="outline" disabled={saving} onClick={close}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
};

/** A Subagent Workspace the Session's delete removes, named when it holds work that is not pushed. */
const SubagentWorkspaceLoss = ({ workspace }: { workspace: WorkspaceRecord }) => {
  const work = useAtomValue(workspaceWorkAtom(workspace.id));
  const agent = workspace.subagent?.agent ?? "";

  const said = AsyncResult.match(work, {
    onInitial: () => "reading what it has not pushed…",
    onFailure: () => "what it has not pushed could not be read",
    onSuccess: ({ value }) => (value.length === 0 ? null : describeWorkspaceWork(value)),
  });

  if (said === null) return null;

  return (
    <li>
      Subagent <span className="font-mono">{agent}</span> on{" "}
      <span className="font-mono">{workspace.branch}</span>: {said}
    </li>
  );
};

/**
 * The Session's Subagent Workspaces, which go with it: each that holds work not pushed is named, with that work.
 */
const SubagentWorkspacesLost = ({ session }: { session: SessionRecord }) => {
  const workspaces = subagentWorkspacesOf(useAtomValue(workspaceListAtom), session.id);

  if (workspaces.length === 0) return null;

  return (
    <div className="flex flex-col gap-1 text-sm">
      <p>
        Its {workspaces.length === 1 ? "Subagent Workspace is" : "Subagent Workspaces are"} removed
        with it, with what was not pushed:
      </p>
      <ul className="flex list-disc flex-col gap-1 pl-5 text-destructive">
        {workspaces.map((workspace) => (
          <SubagentWorkspaceLoss key={workspace.id} workspace={workspace} />
        ))}
      </ul>
    </div>
  );
};

/**
 * Confirm deleting a Session: what goes (its conversations and history) and what stays (its files), or, for the last
 * Session in its Workspace, that the Workspace goes too. Deleting a running Session stops it first, which the dialog
 * says. A list that has not answered counts as the last, so the dialog never promises files that may go.
 */
const DeleteSessionDialog = ({
  session,
  environmentName,
}: {
  session: SessionRecord;
  environmentName: string;
}) => {
  const [open, setOpen] = useAtom(DeleteOpen.use());
  const [deleted, remove] = useAtom(deleteSessionAtom(session.id));
  const last = lastInWorkspace(useAtomValue(sessionListAtom) ?? [], session);
  const deleting = deleted.waiting;
  const problem = settledFailureOf(deleted);

  const close = () => {
    if (!deleting) setOpen(false);
  };

  return (
    <Dialog
      // Once it is deleted the dialog is done, even before the list stops showing the Session.
      open={open && !(AsyncResult.isSuccess(deleted) && !deleting)}
      onClose={close}
      dismissible={!deleting}
      title="Delete this session?"
      description={
        <>
          <span className="font-medium text-foreground">{sessionTitle(session)}</span> and its
          conversation, subagents and history are deleted for good.{" "}
          {last ? (
            <>
              It is the last session in its{" "}
              <span className="font-medium text-foreground">{environmentName}</span> environment
              workspace, which is removed with it: uncommitted changes and unpushed commits are
              lost.
            </>
          ) : (
            <>
              Files it wrote in the{" "}
              <span className="font-medium text-foreground">{environmentName}</span> environment's
              workspace stay until the workspace is removed.
            </>
          )}
          {session.status === "running" && " It is running: everything it runs stops first."}
        </>
      }
    >
      {open && <SubagentWorkspacesLost session={session} />}
      <DialogProblem problem={problem} />
      <DialogActions>
        <Button variant="outline" disabled={deleting} onClick={close}>
          Cancel
        </Button>
        <Button variant="destructive" disabled={deleting} onClick={() => remove()}>
          {deleting ? "Deleting…" : "Delete session"}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

const Actions = ({
  session,
  environmentName,
  actions,
  className,
}: {
  session: SessionRecord;
  environmentName: string;
  actions: SessionActions;
  className?: string | undefined;
}) => {
  const setOpen = useAtomSet(DeleteOpen.use());
  const setTyped = useAtomSet(RenameDraft.use());
  // A delete that failed shows no more once the dialog is opened again.
  const forgetDelete = useAtomSet(deleteSessionAtom(session.id));
  const archived = session.archivedAt !== null;
  const current = session.title ?? "";

  return (
    <>
      <Menu label={`Actions for ${sessionTitle(session)}`} className={className}>
        <MenuItem
          onSelect={() => {
            setTyped(current);
          }}
        >
          <Pencil aria-hidden />
          Rename…
        </MenuItem>
        {!archived && (
          <MenuItem
            onSelect={() => {
              void actions.create(sameWorkspacePlace(session));
            }}
          >
            <GitFork aria-hidden />
            New session in this workspace
          </MenuItem>
        )}
        {archived ? (
          <MenuItem
            onSelect={() => {
              void actions.unarchive(session.id);
            }}
          >
            <ArchiveRestore aria-hidden />
            Unarchive
          </MenuItem>
        ) : (
          <MenuItem
            onSelect={() => {
              void actions.archive(session.id);
            }}
          >
            <Archive aria-hidden />
            Archive
          </MenuItem>
        )}
        <MenuItem
          destructive
          onSelect={() => {
            forgetDelete(Atom.Reset);
            setOpen(true);
          }}
        >
          <Trash2 aria-hidden />
          Delete…
        </MenuItem>
      </Menu>
      <DeleteSessionDialog session={session} environmentName={environmentName} />
      <RenameSessionDialog
        rename={{ current, save: (title) => actions.rename(session.id, title) }}
      />
    </>
  );
};

/**
 * A Session's "⋯" menu: rename it, start another Session in its Workspace, archive or unarchive it, or delete it after
 * a confirmation. A menu has no room for a failure, so a new Session, an archive or an unarchive that failed is reported
 * by `actions` to the surface the menu is on.
 */
export const SessionMenu = (props: {
  session: SessionRecord;
  environmentName: string;
  actions: SessionActions;
  className?: string | undefined;
}) => (
  <DeleteOpen.Provider>
    <RenameDraft.Provider>
      <Actions {...props} />
    </RenameDraft.Provider>
  </DeleteOpen.Provider>
);
