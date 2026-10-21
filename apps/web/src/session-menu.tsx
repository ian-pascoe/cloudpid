// @effect-diagnostics asyncFunction:off -- browser code in a React app with no Effect runtime: promises are the platform here.

import type { SessionRecord } from "@cloudpid/protocol";
import { Archive, ArchiveRestore, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "./components/ui/button.tsx";
import { Dialog, DialogActions } from "./components/ui/dialog.tsx";
import { Menu, MenuItem } from "./components/ui/menu.tsx";
import { sessionTitle } from "./sidebar.tsx";
import type { SessionActions as AllSessionActions } from "./session-actions.ts";

/** What a Session's menu does: archive, unarchive and delete, through the Session list. */
export type SessionActions = Pick<AllSessionActions, "archive" | "unarchive" | "delete">;

/**
 * Confirm deleting a Session: what goes (its conversations and history) and what stays (its files). Deleting a running
 * Session stops it first, which the dialog says.
 */
export const DeleteSessionDialog = ({
  session,
  workspaceName,
  open,
  onClose,
  onDeleted,
  deleteSession,
}: {
  session: SessionRecord;
  workspaceName: string;
  open: boolean;
  onClose: () => void;
  /** The Session is gone: leave its page if it is shown. */
  onDeleted: () => void;
  deleteSession: SessionActions["delete"];
}) => {
  const [deleting, setDeleting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const close = () => {
    if (deleting) return;

    setProblem(null);
    onClose();
  };

  const confirm = async () => {
    setDeleting(true);
    setProblem(null);

    const failure = await deleteSession(session.id);

    setDeleting(false);

    if (failure !== null) {
      setProblem(failure);

      return;
    }

    onClose();
    onDeleted();
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      dismissible={!deleting}
      title="Delete this session?"
      description={
        <>
          <span className="font-medium text-foreground">{sessionTitle(session)}</span> and its
          conversation, subagents and history are deleted for good. Files it wrote in the{" "}
          <span className="font-medium text-foreground">{workspaceName}</span> workspace stay.
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
        <Button variant="destructive" disabled={deleting} onClick={() => void confirm()}>
          {deleting ? "Deleting…" : "Delete session"}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

/**
 * A Session's "⋯" menu: archive or unarchive it, or delete it after a confirmation. A menu has no room for a failure, so
 * an archive or unarchive that failed goes to `onFailure`, for the surface it is on to show.
 */
export const SessionMenu = ({
  session,
  workspaceName,
  actions,
  onDeleted,
  onFailure,
  className,
}: {
  session: SessionRecord;
  workspaceName: string;
  actions: SessionActions;
  onDeleted: () => void;
  onFailure: (message: string) => void;
  className?: string;
}) => {
  const [deleting, setDeleting] = useState(false);
  const archived = session.archivedAt !== null;

  const run = (action: Promise<string | null>) => {
    void action.then((failure) => {
      if (failure !== null) onFailure(failure);
    });
  };

  return (
    <>
      <Menu label={`Actions for ${sessionTitle(session)}`} className={className}>
        {archived ? (
          <MenuItem
            onSelect={() => {
              run(actions.unarchive(session.id));
            }}
          >
            <ArchiveRestore aria-hidden />
            Unarchive
          </MenuItem>
        ) : (
          <MenuItem
            onSelect={() => {
              run(actions.archive(session.id));
            }}
          >
            <Archive aria-hidden />
            Archive
          </MenuItem>
        )}
        <MenuItem
          destructive
          onSelect={() => {
            setDeleting(true);
          }}
        >
          <Trash2 aria-hidden />
          Delete…
        </MenuItem>
      </Menu>
      <DeleteSessionDialog
        session={session}
        workspaceName={workspaceName}
        open={deleting}
        onClose={() => {
          setDeleting(false);
        }}
        onDeleted={onDeleted}
        deleteSession={actions.delete}
      />
    </>
  );
};
