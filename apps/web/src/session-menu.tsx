import type { SessionRecord } from "@cloudpid/protocol";
import { useAtom, useAtomSet } from "@effect/atom-react";
import * as ScopedAtom from "@effect/atom-react/ScopedAtom";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import { Archive, ArchiveRestore, GitFork, Trash2 } from "lucide-react";
import { Button } from "./components/ui/button.tsx";
import { Dialog, DialogActions } from "./components/ui/dialog.tsx";
import { Menu, MenuItem } from "./components/ui/menu.tsx";
import { settledFailureOf } from "./registry.ts";
import { sessionTitle } from "./sidebar.tsx";
import type { SessionActions as AllSessionActions } from "./session-actions.ts";
import { deleteSessionAtom, sameWorkspacePlace } from "./sessions.ts";

/**
 * What a Session's menu does besides delete: start another Session in its Workspace, archive and unarchive, through the
 * Session list.
 */
export type SessionActions = Pick<AllSessionActions, "create" | "archive" | "unarchive">;

/** Whether a menu's delete dialog is open; each menu has its own, since a Session's page and its list item both have one. */
const DeleteOpen = ScopedAtom.make(() => Atom.make(false));

/**
 * Confirm deleting a Session: what goes (its conversations and history) and what stays (its files). Deleting a running
 * Session stops it first, which the dialog says.
 */
const DeleteSessionDialog = ({
  session,
  machineName,
}: {
  session: SessionRecord;
  machineName: string;
}) => {
  const [open, setOpen] = useAtom(DeleteOpen.use());
  const [deleted, remove] = useAtom(deleteSessionAtom(session.id));
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
          conversation, subagents and history are deleted for good. Files it wrote in the{" "}
          <span className="font-medium text-foreground">{machineName}</span> machine stay
          {session.workspace === null
            ? "."
            : ", but for its workspace's worktree when no other session is in it: that goes unless it holds uncommitted changes, and its branch stays."}
          {session.status === "running" && " It is running: everything it runs stops first."}
        </>
      }
    >
      {problem !== null && (
        <p role="alert" className="text-sm whitespace-pre-wrap text-destructive">
          {problem}
        </p>
      )}
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
  machineName,
  actions,
  className,
}: {
  session: SessionRecord;
  machineName: string;
  actions: SessionActions;
  className?: string | undefined;
}) => {
  const setOpen = useAtomSet(DeleteOpen.use());
  // A delete that failed shows no more once the dialog is opened again.
  const forgetDelete = useAtomSet(deleteSessionAtom(session.id));
  const archived = session.archivedAt !== null;

  return (
    <>
      <Menu label={`Actions for ${sessionTitle(session)}`} className={className}>
        {session.repo !== null && !archived && (
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
      <DeleteSessionDialog session={session} machineName={machineName} />
    </>
  );
};

/**
 * A Session's "⋯" menu: start another Session in its Workspace, archive or unarchive it, or delete it after a
 * confirmation. A menu has no room for a failure, so
 * an archive or unarchive that failed is reported by `actions` to the surface the menu is on.
 */
export const SessionMenu = (props: {
  session: SessionRecord;
  machineName: string;
  actions: SessionActions;
  className?: string | undefined;
}) => (
  <DeleteOpen.Provider>
    <Actions {...props} />
  </DeleteOpen.Provider>
);
